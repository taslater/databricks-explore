"""run_window, run_all_windows, and chart and view on query windows: the gate, the saved result, undo, order, validation."""
import json

import pytest

from databricks_explore import canvases, sqltools
from databricks_explore.mcp_server import tools_canvas, tools_data
from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401

BAR = {"mark": "bar", "encoding": {"x": {"field": "order_id", "type": "quantitative"}, "y": {"field": "amount", "type": "quantitative"}}}


def saved(name="d"):
    return canvases.load_canvas(name)


def win(canvas, wid):
    return next(w for w in canvas["windows"] if w["id"] == wid)


@pytest.fixture
def canvas(agent):
    """A canvas d with a base window w1, a window w2 that references it and a lone window w3."""
    agent.ok("create_canvas", name="d")
    agent.ok("add_query_window", name="d", sql="SELECT * FROM demo.sales.orders", title="base", at={"x": 0, "y": 0})
    agent.ok("add_query_window", name="d", sql="SELECT * FROM {{base}}", title="top", at={"x": 800, "y": 0})
    agent.ok("add_query_window", name="d", sql="SELECT * FROM demo.sales.customers", title="lone", at={"x": 0, "y": 600})
    return agent


# ---------------------------------------------------------------- run_window

def test_run_window_saves_the_result_in_the_window(canvas):
    before = canvases.revision_info("d")["revision"]
    out = canvas.ok("run_window", name="d", id="w1", max_rows=3)
    assert out.splitlines()[0].startswith("columns: order_id bigint")
    assert f"saved in w1 (3 rows). revision {before + 1}; undo_canvas reverts it." in out
    r = win(saved(), "w1")["result"]
    assert [c["name"] for c in r["columns"]][:2] == ["order_id", "customer_id"] and r["columns"][0]["type"] == "LONG"
    assert len(r["rows"]) == 3 and r["row_count"] == 3 and r["sql_hash"] == sqltools.sql_hash("SELECT * FROM demo.sales.orders")
    assert r["ran_at"].endswith("Z")
    info = canvases.revision_info("d")
    assert info["revision"] == before + 1 and info["by"] == "agent" and info["snapshots"] >= 1


def test_the_saved_result_is_capped_at_500_rows_and_marked_truncated(canvas):
    canvas.ok("run_window", name="d", id="w1", max_rows=1000)
    r = win(saved(), "w1")["result"]
    assert len(r["rows"]) == canvases.MAX_RESULT_ROWS and r["row_count"] > canvases.MAX_RESULT_ROWS and r["truncated"] is True


def test_undo_canvas_reverts_a_run(canvas):
    canvas.ok("run_window", name="d", id="w1", max_rows=3)
    canvas.ok("undo_canvas", name="d")
    assert "result" not in win(saved(), "w1")


def test_run_window_expands_references_like_the_app(canvas):
    canvas.ok("run_window", name="d", id="w2", max_rows=2)
    titles = {"base": "SELECT * FROM demo.sales.orders", "top": "SELECT * FROM {{base}}"}
    expected = sqltools.sql_hash(sqltools.expand_refs("SELECT * FROM {{base}}", titles))
    assert win(saved(), "w2")["result"]["sql_hash"] == expected != sqltools.sql_hash("SELECT * FROM {{base}}")


def test_a_non_select_window_is_rejected_before_the_warehouse_and_nothing_is_saved(canvas, tmp_path):
    canvas.ok("add_query_window", name="d", sql="DROP TABLE demo.sales.orders", title="bad")
    before = canvases.revision_info("d")["revision"]
    assert canvas.fails("run_window", name="d", id="w4").startswith("Rejected:")
    assert canvases.revision_info("d")["revision"] == before and "result" not in win(saved(), "w4")
    assert "statement.execute" not in (tmp_path / "logs" / "calls.jsonl").read_text()


def test_the_gate_sees_the_referenced_windows_too(canvas):
    canvas.ok("add_query_window", name="d", sql="DELETE FROM demo.sales.orders", title="evil")
    canvas.ok("add_query_window", name="d", sql="SELECT * FROM {{evil}}", title="innocent")
    assert canvas.fails("run_window", name="d", id="w5").startswith("Rejected:")


def test_two_statements_in_one_window_are_rejected(canvas):
    canvas.ok("update_nodes", name="d", updates=[{"id": "w3", "sql": "SELECT 1; SELECT 2"}])
    assert "2 statements" in canvas.fails("run_window", name="d", id="w3")


def test_run_window_names_the_problem_for_a_bad_id_a_wrong_type_and_a_bad_reference(canvas):
    assert "no node with id 'zz'" in canvas.fails("run_window", name="d", id="zz")
    canvas.ok("add_nodes", name="d", nodes=[{"type": "sticky", "id": "s1", "label": "x", "at": {"x": 2000, "y": 0}}])
    assert "s1 is a sticky, not a query window" in canvas.fails("run_window", name="d", id="s1")
    canvas.ok("update_nodes", name="d", updates=[{"id": "w3", "sql": "SELECT * FROM {{nowhere}}"}])
    assert "cannot expand" in canvas.fails("run_window", name="d", id="w3")


def test_a_failing_or_slow_statement_saves_nothing(canvas):
    canvas.ok("update_nodes", name="d", updates=[{"id": "w3", "sql": "SELECT * FROM demo_error"}])
    assert "TABLE_OR_VIEW_NOT_FOUND" in canvas.fails("run_window", name="d", id="w3")
    canvas.ok("update_nodes", name="d", updates=[{"id": "w3", "sql": "SELECT 'demo_slow'"}])
    assert "Timed out after 1s" in canvas.fails("run_window", name="d", id="w3", timeout_s=1)
    assert "result" not in win(saved(), "w3")


def test_run_window_needs_a_connection(offline_agent):
    offline_agent.ok("create_canvas", name="d")
    offline_agent.ok("add_query_window", name="d", sql="SELECT 1")
    assert "connect a profile in the app first" in offline_agent.fails("run_window", name="d", id="w1")
    assert "connect a profile in the app first" in offline_agent.fails("run_all_windows", name="d")


# ---------------------------------------------------------------- run_all_windows

def record(monkeypatch):
    """The order the warehouse sees: ('submit', sql) and ('done', sql) in the order they happen."""
    events, by_sid = [], {}
    submit, wait = tools_data.submit_read_only, tools_data.await_statement

    def spy_submit(ctx, statement, max_rows):
        sid = submit(ctx, statement, max_rows)
        by_sid[sid] = statement
        events.append(("submit", statement))
        return sid

    def spy_wait(e, sid, deadline, timeout):
        out = wait(e, sid, deadline, timeout)
        events.append(("done", by_sid[sid]))
        return out
    monkeypatch.setattr(tools_data, "submit_read_only", spy_submit)
    monkeypatch.setattr(tools_data, "await_statement", spy_wait)
    return events


def test_run_all_windows_runs_a_window_after_the_windows_it_references(canvas, monkeypatch):
    events = record(monkeypatch)
    out = canvas.ok("run_all_windows", name="d", max_rows=5)
    base = "SELECT * FROM demo.sales.orders"
    top = sqltools.expand_refs("SELECT * FROM {{base}}", {"base": base})
    assert events.index(("done", base)) < events.index(("submit", top))  # top waits for base to finish
    assert [e for e in events if e[0] == "submit"][:2] == [("submit", base), ("submit", "SELECT * FROM demo.sales.customers")]  # a level runs together
    lines = out.splitlines()
    assert [l.split(":")[0] for l in lines[:3]] == ["w1 base", "w3 lone", "w2 top"]
    assert all(": ok, " in l for l in lines[:3]) and lines[-1].startswith("saved 3 of 3 results. revision ")
    assert all("result" in win(saved(), i) for i in ("w1", "w2", "w3"))


def test_run_all_windows_is_one_undo(canvas):
    canvas.ok("run_all_windows", name="d", max_rows=2)
    canvas.ok("undo_canvas", name="d")
    assert not any("result" in w for w in saved()["windows"])


def test_run_all_windows_goes_on_past_a_rejected_or_failed_window_and_names_what_it_skipped(canvas):
    canvas.ok("add_query_window", name="d", sql="DROP TABLE demo.sales.orders", title="bad")
    canvas.ok("add_query_window", name="d", sql="SELECT * FROM demo_error", title="broken")
    canvas.ok("add_query_window", name="d", sql="SELECT * FROM {{loop_b}}", title="loop_a")
    canvas.ok("add_query_window", name="d", sql="SELECT * FROM {{loop_a}}", title="loop_b")
    canvas.ok("add_query_window", name="d", sql="  ", title="empty")
    out = canvas.ok("run_all_windows", name="d", max_rows=2)
    assert "w4 bad: not run: Rejected:" in out
    assert "w5 broken: failed: " in out and "TABLE_OR_VIEW_NOT_FOUND" in out
    assert "w6 loop_a: skipped (reference cycle)" in out and "w7 loop_b: skipped (reference cycle)" in out
    assert "w8 empty: skipped (no SQL)" in out
    assert out.splitlines()[-1].startswith("saved 3 of 5 results")
    assert [i for i in ("w1", "w2", "w3", "w4", "w5") if "result" in win(saved(), i)] == ["w1", "w2", "w3"]


def test_run_all_windows_with_nothing_to_run_is_an_error(agent):
    agent.ok("create_canvas", name="d")
    assert "no query window with SQL to run" in agent.fails("run_all_windows", name="d")
    agent.ok("add_query_window", name="d", sql=" ")
    assert "w1 no SQL" in agent.fails("run_all_windows", name="d")


def test_when_every_window_fails_nothing_is_written(canvas):
    for i in ("w1", "w2", "w3"):
        canvas.ok("update_nodes", name="d", updates=[{"id": i, "sql": "SELECT * FROM demo_error"}])
    before = canvases.revision_info("d")["revision"]
    out = canvas.ok("run_all_windows", name="d")
    assert out.splitlines()[-1] == "nothing saved." and canvases.revision_info("d")["revision"] == before


def test_run_levels_groups_by_dependency_in_canvas_order():
    def q(i, title, sql):
        return {"id": i, "type": "query", "title": title, "sql": sql}
    levels, skipped = tools_canvas.run_levels([q("a", "a", "{{c}} {{b}}"), q("b", "b", "{{c}}"), q("c", "c", "SELECT 1"), q("d", "d", "SELECT 2"),
                                               {"id": "n", "type": "note", "title": "n", "text": "hi"}, q("e", "e", ""), q("x", "x", "{{x}}")])
    assert [[w["id"] for w in level] for level in levels] == [["c", "d"], ["b"], ["a"]]
    assert [(w["id"], why) for w, why in skipped] == [("e", "no SQL"), ("x", "reference cycle")]


# ---------------------------------------------------------------- chart and view

def test_a_chart_and_view_can_be_given_when_adding_a_window(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_query_window", name="d", sql="SELECT * FROM demo.sales.orders", chart=BAR, view="chart")
    w = win(saved(), "w1")
    assert w["chart"] == {"vega_lite": BAR} and w["view"] == "chart"


def test_update_nodes_sets_changes_and_removes_a_chart(canvas):
    canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "chart": BAR, "view": "chart"}])
    assert win(saved(), "w1")["chart"] == {"vega_lite": BAR}
    canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "view": "results"}])
    assert win(saved(), "w1")["view"] == "results" and "chart" in win(saved(), "w1")
    canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "chart": None}])
    assert "chart" not in win(saved(), "w1")


def test_a_spec_needs_a_mark_or_a_layer_and_is_an_object(agent):
    agent.ok("create_canvas", name="d")
    for bad in ({}, {"encoding": {}}, {"data": {"values": []}}):
        assert "an object with mark or layer" in agent.fails("add_query_window", name="d", sql="SELECT 1", chart=bad)
    assert "chart" in agent.fails("add_query_window", name="d", sql="SELECT 1", chart="bar")  # not an object: the input schema says so
    agent.ok("add_query_window", name="d", sql="SELECT 1", chart={"layer": [{"mark": "bar"}]})
    assert saved()["windows"][0]["chart"] == {"vega_lite": {"layer": [{"mark": "bar"}]}}


def test_view_chart_needs_a_chart_and_view_must_be_a_known_tab(canvas):
    assert "view chart needs a chart on w1" in canvas.fails("update_nodes", name="d", updates=[{"id": "w1", "view": "chart"}])
    assert "view" in canvas.fails("update_nodes", name="d", updates=[{"id": "w1", "view": "map"}])
    assert "view chart needs a chart" in canvas.fails("add_query_window", name="d", sql="SELECT 1", view="chart")
    assert "view" not in win(saved(), "w1")  # nothing was written by the refused calls


def test_chart_and_view_belong_to_query_windows(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[{"type": "note", "text": "hi", "at": {"x": 0, "y": 0}}])
    assert "belong to query windows" in agent.fails("update_nodes", name="d", updates=[{"id": "w1", "chart": BAR}])
    assert "belong to query windows" in agent.fails("add_nodes", name="d", nodes=[{"type": "sticky", "label": "x", "chart": BAR}])


def test_a_chart_reading_a_column_the_result_lacks_gets_a_note(canvas):
    canvas.ok("run_window", name="d", id="w1", max_rows=3)
    ok = canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "chart": BAR}])
    assert "note:" not in ok
    out = canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "chart": {"mark": "bar", "encoding": {"x": {"field": "nope", "type": "nominal"}}}}])
    assert "w1's chart reads nope, not a column of its saved result (columns: " in out
    layered = {"layer": [{"mark": "bar", "encoding": {"x": {"field": "order_id"}, "x2": {"field": "missing"}}}, {"mark": "rule", "encoding": {"x": {"field": "order_id"}}}]}
    assert "reads missing" in canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "chart": layered}])
    computed = {"mark": "bar", "transform": [{"calculate": "1", "as": "one"}], "encoding": {"x": {"field": "one"}}}
    assert "note:" not in canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "chart": computed}])


def test_the_tool_descriptions_give_two_chart_examples_that_pass_the_check(agent):
    tools = {t["name"]: t for t in agent.rpc("tools/list").get_json()["result"]["tools"]}
    for tool in ("add_query_window", "update_nodes", "add_nodes"):
        props = tools[tool]["inputSchema"]["properties"]
        props = props["updates"]["items"]["properties"] if tool == "update_nodes" else props["nodes"]["items"]["properties"] if tool == "add_nodes" else props
        assert "chart" in props and props["view"]["enum"] == ["results", "chart"]
    desc = tools["add_query_window"]["inputSchema"]["properties"]["chart"]["description"]
    assert '"x2"' in desc and '"rule"' in desc and '"bar"' in desc
    for example in (tools_canvas.BAR_EXAMPLE, tools_canvas.RANGE_EXAMPLE):
        assert example in desc
        assert tools_canvas._chart_spec(json.loads(example))


def test_run_tools_are_listed_as_writes_with_the_gate_in_their_description(agent):
    tools = {t["name"]: t for t in agent.rpc("tools/list").get_json()["result"]["tools"]}
    for name in ("run_window", "run_all_windows"):
        assert tools[name]["annotations"]["readOnlyHint"] is False
        assert "read-only gate" in tools[name]["description"] and "undo_canvas" in tools[name]["description"]
        assert "\n" not in tools[name]["description"]


# ---------------------------------------------------------------- reading a canvas with results

def test_get_canvas_lists_saved_results_and_marks_a_stale_one(canvas):
    assert "Saved results" not in canvas.ok("get_canvas", name="d")
    canvas.ok("run_window", name="d", id="w1", max_rows=3)
    canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "chart": BAR, "view": "chart"}])
    out = canvas.ok("get_canvas", name="d")
    assert "Saved results:" in out and "w1 'base': 3 rows, ran " in out
    assert "matches its SQL, chart bar, opens on chart" in out
    canvas.ok("update_nodes", name="d", updates=[{"id": "w1", "sql": "SELECT 1"}])
    assert "SQL differs from what ran (stale)" in canvas.ok("get_canvas", name="d")


def test_get_canvas_json_cuts_saved_rows_unless_asked_for_them_all(canvas):
    canvas.ok("run_window", name="d", id="w1", max_rows=50)
    short = json.loads(canvas.ok("get_canvas", name="d", format="json"))
    r = win(short, "w1")["result"]
    assert len(r["rows"]) == tools_canvas.RESULT_ROWS_IN_JSON and r["rows_omitted"] == 45 and r["row_count"] == 50
    full = json.loads(canvas.ok("get_canvas", name="d", format="json", full_results=True))
    assert len(win(full, "w1")["result"]["rows"]) == 50 and "rows_omitted" not in win(full, "w1")["result"]
    assert len(win(saved(), "w1")["result"]["rows"]) == 50  # reading never changes the file
