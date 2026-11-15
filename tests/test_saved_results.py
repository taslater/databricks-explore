"""Saved results: the `result` and `view` fields of a query window, the caps, the hash and the routes the page uses."""
import copy
import json
from pathlib import Path

import pytest

from databricks_explore import app as app_module
from databricks_explore import canvases, sqltools
from mcp_helpers import connected, env  # noqa: F401

RESULT = {"columns": [{"name": "day", "type": "DATE", "type_text": "date"}, {"name": "hours", "type": "DECIMAL"}],
          "rows": [["2026-11-02", "8.5"], ["2026-11-03", None]], "row_count": 2, "truncated": False,
          "ran_at": "2026-11-14T10:00:00Z", "sql_hash": "3f2a9c01d4e7b856"}


def canvas_with(**window):
    return {"version": 2, "name": "evidence", "profile": None, "edges": [],
            "windows": [{"id": "w1", "type": "query", "title": "q", "position": {"x": 0, "y": 0}, "size": {"w": 500, "h": 300},
                         "sql": "SELECT 1", "collapsed": False, **window}]}


@pytest.fixture
def cdir(tmp_path, monkeypatch):
    d = tmp_path / "canvases"
    d.mkdir()
    monkeypatch.setattr(canvases, "CANVASES", d)
    return d


@pytest.fixture
def client(cdir):
    return app_module.app.test_client()


def test_a_saved_result_and_view_round_trip_unchanged(cdir):
    body = canvas_with(result=RESULT, view="chart")
    canvases.save_canvas(copy.deepcopy(body))
    assert canvases.load_canvas("evidence") == body


def test_a_saved_result_round_trips_through_the_routes(client):
    body = canvas_with(result=RESULT, view="results")
    assert client.post("/api/canvases", json=body).status_code == 200
    assert client.get("/api/canvases/evidence").get_json() == body


@pytest.mark.parametrize("label, change", [
    ("missing sql_hash", lambda r: r.pop("sql_hash")),
    ("rows are not strings", lambda r: r.update(rows=[[1, 2]])),
    ("negative row_count", lambda r: r.update(row_count=-1)),
    ("truncated is not a boolean", lambda r: r.update(truncated="no")),
    ("a column without a name", lambda r: r.update(columns=[{"type": "INT"}])),
    ("an unknown key", lambda r: r.update(extra=1)),
    ("501 rows", lambda r: r.update(rows=[["x", "y"]] * 501)),
])
def test_a_malformed_result_is_rejected(cdir, label, change):
    result = copy.deepcopy(RESULT)
    change(result)
    with pytest.raises(canvases.CanvasInvalid, match=r"windows\[0\]\.result"):
        canvases.save_canvas(canvas_with(result=result))


def test_view_must_be_results_or_chart(cdir):
    with pytest.raises(canvases.CanvasInvalid, match=r"windows\[0\]\.view"):
        canvases.save_canvas(canvas_with(view="map"))


def test_500_rows_are_accepted(cdir):
    result = {**RESULT, "rows": [["2026-11-02", "1"]] * 500, "row_count": 500}
    canvases.save_canvas(canvas_with(result=result))


def test_result_snapshot_keeps_everything_that_fits():
    snap = canvases.result_snapshot({"columns": [{"name": "a", "type": "INT", "type_text": "int"}], "rows": [["1"], [None]],
                                     "row_count": 2, "truncated": False}, "abc", ran_at="2026-11-14T10:00:00Z")
    assert snap == {"columns": [{"name": "a", "type": "INT", "type_text": "int"}], "rows": [["1"], [None]], "row_count": 2,
                    "truncated": False, "ran_at": "2026-11-14T10:00:00Z", "sql_hash": "abc"}
    canvases.save_canvas(canvas_with(result=snap))


def test_result_snapshot_caps_the_rows_and_says_so():
    rows = [[str(i)] for i in range(1200)]
    snap = canvases.result_snapshot({"columns": [{"name": "n", "type": "INT"}], "rows": rows, "row_count": 1200, "truncated": False}, "h")
    assert len(snap["rows"]) == canvases.MAX_RESULT_ROWS
    assert snap["row_count"] == 1200 and snap["truncated"] is True
    assert snap["rows"][-1] == ["499"]


def test_result_snapshot_caps_the_size_and_says_so():
    big = "x" * 5000
    rows = [[big] for _ in range(200)]  # 200 rows would be about a megabyte
    snap = canvases.result_snapshot({"columns": [{"name": "s", "type": "STRING"}], "rows": rows, "row_count": 200, "truncated": False}, "h")
    assert 0 < len(snap["rows"]) < 200 and snap["truncated"] is True
    assert len(json.dumps(snap["rows"])) <= canvases.MAX_RESULT_BYTES
    canvases.save_canvas(canvas_with(result=snap))


def test_a_run_that_was_itself_truncated_stays_truncated():
    snap = canvases.result_snapshot({"columns": [{"name": "n", "type": "INT"}], "rows": [["1"]], "row_count": 1, "truncated": True}, "h")
    assert snap["truncated"] is True and snap["rows"] == [["1"]]


def test_result_snapshot_turns_other_values_into_strings():
    snap = canvases.result_snapshot({"columns": [{"name": "n", "type": "INT"}], "rows": [[5], [None]], "row_count": 2, "truncated": None}, "h")
    assert snap["rows"] == [["5"], [None]] and snap["truncated"] is False


def test_the_schema_file_accepts_a_result_and_rejects_a_bad_one():
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((Path(__file__).resolve().parents[1] / "contracts" / "canvas.schema.json").read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    assert list(validator.iter_errors(canvas_with(result=RESULT, view="chart"))) == []
    assert list(validator.iter_errors(canvas_with(view="map")))
    assert list(validator.iter_errors(canvas_with(result={**RESULT, "rows": [["x"]] * 501})))
    assert list(validator.iter_errors(canvas_with(result={k: v for k, v in RESULT.items() if k != "sql_hash"})))


def test_agent_undo_restores_the_window_without_its_result(cdir):
    canvases.save_canvas(canvas_with())
    canvases.write_canvas(canvas_with(result=RESULT), by="agent", snapshot=True)
    assert canvases.load_canvas("evidence")["windows"][0]["result"] == RESULT
    canvases.undo_canvas("evidence")
    assert "result" not in canvases.load_canvas("evidence")["windows"][0]


# ---------- the hash ----------

def test_the_hash_ignores_outer_whitespace_and_trailing_semicolons():
    assert sqltools.sql_hash("SELECT 1") == sqltools.sql_hash("  SELECT 1;\n") == sqltools.sql_hash("SELECT 1 ;;")
    assert sqltools.sql_hash("SELECT 1") != sqltools.sql_hash("SELECT 2")
    assert len(sqltools.sql_hash("SELECT 1")) == 16


def test_window_refs_lists_titles_once_in_order():
    assert sqltools.window_refs("SELECT * FROM {{b}} JOIN {{a}} ON 1 JOIN {{b}} ON 2") == ["b", "a"]
    assert sqltools.window_refs("SELECT 1") == []


def test_hashes_route_expands_references(client):
    windows = {"base": "SELECT 1 AS x", "top": "SELECT * FROM {{base}}"}
    body = client.post("/api/query/hashes", json={"statements": ["SELECT * FROM {{base}}", "SELECT 2;"], "windows": windows}).get_json()
    expanded = sqltools.sql_hash(sqltools.expand_refs("SELECT * FROM {{base}}", windows))
    assert body == {"hashes": [expanded, sqltools.sql_hash("SELECT 2")]}


def test_hashes_route_gives_null_for_a_statement_that_cannot_expand(client):
    body = client.post("/api/query/hashes", json={"statements": ["SELECT * FROM {{nope}}", "SELECT 1"], "windows": {"a": "SELECT 1"}}).get_json()
    assert body["hashes"][0] is None and body["hashes"][1] == sqltools.sql_hash("SELECT 1")


def test_hashes_route_without_windows_hashes_the_text(client):
    assert client.post("/api/query/hashes", json={"statements": ["SELECT {{a}}"]}).get_json() == {"hashes": [sqltools.sql_hash("SELECT {{a}}")]}


def test_async_submit_returns_the_hash_of_the_expanded_sql(connected):
    windows = {"base": "SELECT 1 AS x"}
    body = connected.post("/api/query/async", json={"sql": "SELECT * FROM {{base}}", "windows": windows}).get_json()
    assert body["sql_hash"] == sqltools.sql_hash(sqltools.expand_refs("SELECT * FROM {{base}}", windows))
    assert body["statement_id"]
    plain = connected.post("/api/query/async", json={"sql": "SELECT 1;"}).get_json()
    assert plain["sql_hash"] == sqltools.sql_hash("SELECT 1")
