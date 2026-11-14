"""The canvas tools: structural placement, auto tidy, the effect report, undo, and what each edit saves."""
import base64
import json

from databricks_explore import canvases
from databricks_explore import layout
from mcp_helpers import agent, connected, env, offline_agent  # noqa: F401


def boxes(canvas):
    return {w["id"]: (w["position"]["x"], w["position"]["y"], w["position"]["x"] + w["size"]["w"], w["position"]["y"] + w["size"]["h"])
            for w in canvas["windows"]}


def saved(name="d"):
    return canvases.load_canvas(name)


def shape(**kw):
    return {"type": "shape", "label": "A", **kw}


def test_canvas_tools_work_without_a_connection(offline_agent):
    assert "created canvas d" in offline_agent.ok("create_canvas", name="d")
    out = offline_agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0})])
    assert out.startswith("added a. revision 2; doctor score 100/100 (no issues)")
    assert saved()["version"] == 2 and saved()["profile"] is None


def test_create_canvas_is_empty_v2_and_refuses_a_taken_name(agent):
    agent.ok("create_canvas", name="d")
    assert saved() == {"version": 2, "name": "d", "profile": None, "windows": [], "edges": []}
    assert "already exists" in agent.fails("create_canvas", name="d")
    assert agent.fails("create_canvas", name="bad name!").startswith("name: ")
    assert agent.ok("list_canvases").splitlines() == ["1 canvas(es)", "d: 0 nodes, 0 connectors, revision 1"]


def test_structural_placement_right_of_below_and_inside(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 100, "y": 100}), {"type": "frame", "id": "f", "at": {"x": 600, "y": 600}}])
    agent.ok("add_nodes", name="d", nodes=[
        shape(id="b", label="B", place={"relation": "right_of", "anchor": "a", "gap": 60}),
        shape(id="c", label="C", place={"relation": "below", "anchor": "a", "gap": 30}),
        shape(id="g", label="G", place={"relation": "inside", "anchor": "f"})])
    b = boxes(saved())
    assert b["b"][0] == b["a"][2] + 60 and abs((b["b"][1] + b["b"][3]) / 2 - (b["a"][1] + b["a"][3]) / 2) <= 1
    assert b["c"][1] == b["a"][3] + 30
    assert b["f"][0] <= b["g"][0] and b["g"][2] <= b["f"][2] and b["f"][1] <= b["g"][1] and b["g"][3] <= b["f"][3]
    assert "Layout score" in agent.ok("get_canvas", name="d")


def test_nodes_added_together_with_one_placement_stack_and_a_later_node_can_anchor_on_an_earlier_one(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0})])
    agent.ok("add_nodes", name="d", nodes=[
        shape(id="b", place={"relation": "right_of", "anchor": "a"}),
        shape(id="c", place={"relation": "right_of", "anchor": "a"}),
        shape(id="d1", place={"relation": "right_of", "anchor": "b"})])
    b = boxes(saved())
    assert b["b"][0] == b["c"][0] > b["a"][2]          # b and c stack in a column right of a
    assert b["c"][1] > b["b"][1]
    assert b["d1"][0] > b["b"][2]                       # and d1 sits right of b's final place
    assert layout.doctor(saved())["score"] == 100


def test_no_placement_puts_a_node_below_the_content_and_the_first_at_the_origin(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a"), shape(id="b")])
    b = boxes(saved())
    assert b["a"][:2] == (0, 0) and b["b"][1] >= b["a"][3] and b["b"][0] == 0


def test_auto_tidy_clears_overlaps_unless_turned_off(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0})])
    out = agent.ok("add_nodes", name="d", nodes=[shape(id="b", at={"x": 10, "y": 10})])
    assert "moved 1 to clear overlaps" in out and "doctor score 100/100" in out
    b = boxes(saved())
    assert b["b"][0] >= b["a"][2] or b["b"][1] >= b["a"][3]
    out = agent.ok("add_nodes", name="d", nodes=[shape(id="c", at={"x": 10, "y": 10})], auto_tidy=False)
    assert "overlap" in out and "moved" not in out and boxes(saved())["c"][:2] == (10, 10)
    assert "overlap" in agent.ok("doctor", name="d")


def test_an_edit_returns_the_score_and_a_short_excerpt(agent):
    agent.ok("create_canvas", name="d")
    out = agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0}), shape(id="b", label="B", at={"x": 300, "y": 0})])
    head, *rest = out.splitlines()
    assert "revision 2" in head and "doctor score 100/100" in head and "undo_canvas" in head
    assert rest[0].startswith('Canvas "d": 2 nodes') and len(rest) <= 14


def test_node_types_get_the_pages_defaults(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[
        {"type": "sticky", "id": "s1", "label": "hi"}, {"type": "text", "id": "t", "label": "T", "w": 200},
        {"type": "placeholder", "id": "p", "name": "dim_x", "columns": [{"name": "id", "type": "bigint", "key": "pk"}, {"name": "n"}]},
        {"type": "query", "sql": "SELECT 1", "title": "q"}, {"type": "note", "text": "# hi"},
        {"type": "table", "table": "demo.sales.orders"}, {"type": "shape", "shape": "cylinder", "id": "db", "label": "DB"}])
    c = saved()
    canvases.parse_canvas(c)
    by = {w["id"]: w for w in c["windows"]}
    assert by["s1"]["size"] == {"w": 160, "h": 160} and by["s1"]["fill"] == "#fef9c3"
    assert by["t"]["size"]["w"] == 200
    assert by["p"]["placeholder"]["name"] == "dim_x" and len(by["p"]["placeholder"]["id"]) == 36
    assert by["db"]["shape"] == "cylinder" and by["db"]["size"] == {"w": 100, "h": 120}
    q = next(w for w in c["windows"] if w["type"] == "query")
    assert q["id"] == "w1" and q["title"] == "q" and q["sql"] == "SELECT 1" and q["size"] == {"w": 760, "h": 520}
    assert {w["title"] for w in c["windows"] if w["type"] in ("note", "table")} == {"note", "orders"}


def test_bad_nodes_are_rejected_with_a_message_and_nothing_changes(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0})])
    before = saved()
    assert "already used" in agent.fails("add_nodes", name="d", nodes=[shape(id="a")])
    assert "needs sql" in agent.fails("add_nodes", name="d", nodes=[{"type": "query"}])
    assert "needs table" in agent.fails("add_nodes", name="d", nodes=[{"type": "table"}])
    assert "not on this canvas" in agent.fails("add_nodes", name="d", nodes=[shape(place={"relation": "below", "anchor": "zzz"})])
    assert "not both" in agent.fails("add_nodes", name="d", nodes=[shape(place={"relation": "below", "anchor": "a"}, at={"x": 1, "y": 1})])
    assert "must be one of" in agent.fails("add_nodes", name="d", nodes=[{"type": "triangle"}])
    assert "canvas not found" in agent.fails("add_nodes", name="nope", nodes=[shape()])
    assert saved() == before


def test_add_query_window_and_references(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_query_window", name="d", sql="SELECT * FROM demo.sales.orders", title="orders_q")
    out = agent.ok("add_query_window", name="d", sql="SELECT * FROM {{orders_q}} LIMIT 5", place={"relation": "right_of", "anchor": "w1"})
    assert "added query window w2" in out
    b = boxes(saved())
    assert b["w2"][0] > b["w1"][2]
    agent.ok("add_query_window", name="d", sql="SELECT 2", title="orders_q")  # a taken title gets a suffix
    assert [w["title"] for w in saved()["windows"]] == ["orders_q", "query", "orders_q_2"]


def test_update_nodes_changes_fields_renames_titles_and_respects_locks(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[{"type": "query", "sql": "SELECT 1", "title": "first", "at": {"x": 0, "y": 0}},
                                           {"type": "query", "sql": "SELECT * FROM {{first}}", "title": "second", "place": {"relation": "right_of", "anchor": "w1"}},
                                           shape(id="a", label="A", at={"x": 0, "y": 900}, locked=True)])
    out = agent.ok("update_nodes", name="d", updates=[{"id": "w1", "title": "base", "sql": "SELECT 2"}, {"id": "w2", "collapsed": True}])
    assert out.startswith("updated w1, w2")
    by = {w["id"]: w for w in saved()["windows"]}
    assert by["w1"]["title"] == "base" and by["w1"]["sql"] == "SELECT 2" and by["w2"]["sql"] == "SELECT * FROM {{base}}"
    assert by["w2"]["collapsed"] is True
    assert "is locked" in agent.fails("update_nodes", name="d", updates=[{"id": "a", "label": "x"}])
    agent.ok("update_nodes", name="d", updates=[{"id": "a", "locked": False, "label": "unlocked", "fill": "#ff0000"}])
    assert {w["id"]: w for w in saved()["windows"]}["a"]["label"] == "unlocked"
    assert "no node with id" in agent.fails("update_nodes", name="d", updates=[{"id": "zz", "label": "x"}])
    agent.ok("update_nodes", name="d", updates=[{"id": "a", "place": {"relation": "below", "anchor": "w1", "gap": 50}}])
    assert boxes(saved())["a"][1] == boxes(saved())["w1"][3] + 50 or boxes(saved())["a"][1] > boxes(saved())["w1"][3]


def test_update_a_placeholder_table(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[{"type": "placeholder", "id": "p", "name": "t1"}])
    agent.ok("update_nodes", name="d", updates=[{"id": "p", "name": "t2", "columns": [{"name": "k", "type": "int", "key": "pk"}]}])
    ph = saved()["windows"][0]["placeholder"]
    assert ph["name"] == "t2" and ph["columns"] == [{"name": "k", "type": "int", "key": "pk"}]


def test_remove_nodes_takes_their_connectors_along(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0}), shape(id="b", at={"x": 300, "y": 0}), shape(id="c", at={"x": 600, "y": 0})])
    agent.ok("connect", name="d", edges=[{"source": "a", "target": "b"}, {"source": "b", "target": "c"}, {"source": "a", "target": "c"}])
    out = agent.ok("remove_nodes", name="d", ids=["b"])
    assert out.startswith("removed b and 2 attached connector(s)")
    assert [e["id"] for e in saved()["edges"]] == ["c3"] and [w["id"] for w in saved()["windows"]] == ["a", "c"]
    assert "removed c3 and 0" in agent.ok("remove_nodes", name="d", ids=["c3"])
    assert "no node or connector" in agent.fails("remove_nodes", name="d", ids=["nope"])


def test_connect_one_or_many_and_sides_face_each_other(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0}), shape(id="b", at={"x": 400, "y": 0}), shape(id="c", at={"x": 0, "y": 400})])
    out = agent.ok("connect", name="d", source="a", target="b", label="orders", line="curve", dashed=True)
    assert out.startswith("connected a->b as c1")
    e = saved()["edges"][0]
    assert (e["source"], e["target"], e["label"], e["line"], e["dashed"], e["arrow_end"]) == ("a", "b", "orders", "curve", True, True)
    assert (e["source_handle"], e["target_handle"]) == ("r", "l")
    agent.ok("connect", name="d", source="b", target="c")  # c is below-left: sides re-picked to face
    e2 = saved()["edges"][1]
    assert e2["id"] == "c2" and (e2["source_handle"], e2["target_handle"]) != ("r", "l")
    assert "not a node" in agent.fails("connect", name="d", source="a", target="zz")
    assert "not both" in agent.fails("connect", name="d", source="a", target="b", edges=[{"source": "a", "target": "b"}])
    assert "needs source and target" in agent.fails("connect", name="d")
    explicit = agent.ok("connect", name="d", source="a", target="c", source_handle="b", target_handle="t")
    assert (saved()["edges"][2]["source_handle"], saved()["edges"][2]["target_handle"]) == ("b", "t")
    assert "edge_through_node" not in explicit


def test_arrange_layered_grid_and_place(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id=i, label=i.upper(), at={"x": 0, "y": 0}) for i in "abcd"], auto_tidy=False)
    agent.ok("connect", name="d", edges=[{"source": "a", "target": "b"}, {"source": "a", "target": "c"}, {"source": "b", "target": "d"}, {"source": "c", "target": "d"}])
    out = agent.ok("arrange", name="d", mode="layered", direction="LR", gap=30)
    assert out.startswith("arranged (layered): 4 node(s) moved") or out.startswith("arranged (layered)")
    b = boxes(saved())
    assert b["a"][2] < b["b"][0] and b["b"][2] < b["d"][0] and b["a"][2] < b["c"][0]
    assert layout.doctor(saved())["score"] >= 90
    assert "grid" in agent.ok("arrange", name="d", mode="grid", cols=2, ids=["a", "b", "c", "d"])
    assert boxes(saved())["c"][1] > boxes(saved())["a"][1]
    agent.ok("arrange", name="d", mode="place", ids=["d"], relation="below", anchor="a", gap=50)
    assert boxes(saved())["d"][1] >= boxes(saved())["a"][3] + 50
    assert "unknown ids" in agent.fails("arrange", name="d", mode="row", ids=["zz"])
    assert "must be one of" in agent.fails("arrange", name="d", mode="spiral")


def test_tidy_and_doctor(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0}), shape(id="b", at={"x": 20, "y": 10}),
                                           shape(id="c", at={"x": 500, "y": 3})], auto_tidy=False)
    report = agent.ok("doctor", name="d")
    assert report.startswith("score ") and "error overlap a,b" in report and "[fix: tidy rules=overlaps" in report
    parsed = json.loads(agent.ok("doctor", name="d", format="json"))
    assert parsed["score"] < 100 and parsed["issues"]
    out = agent.ok("tidy", name="d", rules=["overlaps"])
    assert out.startswith("tidied:") and "->" in out.splitlines()[0]
    assert "error overlap" not in agent.ok("doctor", name="d")
    assert "must be one of" in agent.fails("tidy", name="d", rules=["nonsense"])


def test_get_canvas_describe_and_json(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0})])
    assert agent.ok("get_canvas", name="d").startswith('Canvas "d": 1 nodes')
    assert json.loads(agent.ok("get_canvas", name="d", format="json")) == saved()
    assert "canvas not found" in agent.fails("get_canvas", name="nope")


def test_render_canvas_returns_a_png_image(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0}), shape(id="b", label="B", at={"x": 300, "y": 0})])
    agent.ok("connect", name="d", source="a", target="b")
    r = agent.rpc("tools/call", {"name": "render_canvas", "arguments": {"name": "d", "width": 600, "highlight": "issues"}})
    content = r.get_json()["result"]["content"]
    assert [c["type"] for c in content] == ["image", "text"] and content[0]["mimeType"] == "image/png"
    png = base64.b64decode(content[0]["data"])
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) < 200_000
    assert "2 nodes, 1 connectors" in content[1]["text"]
    assert agent.ok("render_canvas", name="d", highlight=["a"])  # a list of ids is fine too


def test_every_agent_write_is_undoable_and_undo_goes_back_one_change_at_a_time(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[shape(id="a", at={"x": 0, "y": 0})])
    one = saved()
    agent.ok("add_nodes", name="d", nodes=[shape(id="b", at={"x": 300, "y": 0})])
    agent.ok("connect", name="d", source="a", target="b")
    agent.ok("update_nodes", name="d", updates=[{"id": "a", "label": "renamed"}])
    assert canvases.revision_info("d") == {"name": "d", "revision": 5, "by": "agent", "snapshots": 4}
    out = agent.ok("undo_canvas", name="d")
    assert out.startswith("undone. revision 6; 3 earlier agent change(s)")
    assert saved()["edges"] and saved()["windows"][0]["label"] == "A"
    agent.ok("undo_canvas", name="d")
    agent.ok("undo_canvas", name="d")
    assert saved() == one
    assert canvases.revision_info("d")["by"] == "undo"
    agent.ok("undo_canvas", name="d")  # back to the empty canvas
    assert saved()["windows"] == []
    assert "nothing to undo" in agent.fails("undo_canvas", name="d")


def test_agent_edits_keep_a_version_1_canvas_valid_and_move_it_to_version_2(agent, connected):
    v1 = {"version": 1, "name": "old", "profile": "demo", "windows": [
        {"id": "w1", "type": "query", "title": "q", "position": {"x": 0, "y": 0}, "size": {"w": 500, "h": 300}, "sql": "SELECT 1", "collapsed": False}]}
    assert connected.post("/api/canvases", json=v1).status_code == 200
    agent.ok("add_nodes", name="old", nodes=[{"type": "sticky", "label": "note to self", "place": {"relation": "right_of", "anchor": "w1"}}])
    c = saved("old")
    assert c["version"] == 2 and c["profile"] == "demo" and [w["id"] for w in c["windows"]] == ["w1", "s1"]


def test_an_agent_write_changes_the_revision_the_page_polls(agent, connected):
    agent.ok("create_canvas", name="d")
    assert connected.get("/api/canvases/d/revision").get_json()["by"] == "agent"
    connected.post("/api/canvases", json=saved())
    assert connected.get("/api/canvases/d/revision").get_json() == {"name": "d", "revision": 2, "by": "ui", "snapshots": 0}
    agent.ok("add_nodes", name="d", nodes=[shape(id="a")])
    r = connected.get("/api/canvases/d/revision").get_json()
    assert r["revision"] == 3 and r["by"] == "agent" and r["snapshots"] == 1


def test_add_nodes_sizes_a_sketch_node_to_its_label_unless_w_is_given(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[
        {"type": "shape", "shape": "cylinder", "id": "a", "label": "samples.tpch.orders", "at": {"x": 0, "y": 0}},
        {"type": "shape", "shape": "cylinder", "id": "b", "label": "samples.tpch.orders", "w": 100, "at": {"x": 0, "y": 400}},
        {"type": "shape", "shape": "cylinder", "id": "c", "label": "x", "at": {"x": 0, "y": 800}},
        {"type": "shape", "id": "d", "label": " ".join(["wrapping"] * 14), "at": {"x": 0, "y": 1200}}])
    sizes = {w["id"]: (w["size"]["w"], w["size"]["h"]) for w in saved()["windows"]}
    assert 100 < sizes["a"][0] < layout.MAX_FIT_W and sizes["a"][1] == 120
    assert sizes["b"] == (100, 120)  # w given: the agent's size stands, overflow and all
    assert sizes["c"] == (100, 120)  # fits already: the default stays
    assert sizes["d"][0] == layout.MAX_FIT_W and sizes["d"][1] > 80
    assert not any(i["kind"] == "label_overflow" and i["nodes"] != ["b"] for i in layout.doctor(saved())["issues"])


def test_tidy_tool_offers_fit_labels_and_place_labels(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[
        {"type": "shape", "id": "a", "label": "A", "at": {"x": 0, "y": 0}}, {"type": "shape", "id": "b", "label": "B", "at": {"x": 300, "y": 0}}])
    agent.ok("connect", name="d", edges=[{"source": "a", "target": "b", "label": "first"}, {"source": "a", "target": "b", "label": "second"}])
    assert "label_collision" in agent.ok("doctor", name="d") and "[fix: tidy rules=place_labels" in agent.ok("doctor", name="d")
    assert "tidied: 1 change(s)" in agent.ok("tidy", name="d", rules=["place_labels"])
    assert "label_collision" not in agent.ok("doctor", name="d")
    assert saved()["edges"][1]["label_offset"] != 0
    agent.ok("update_nodes", name="d", updates=[{"id": "a", "label": "a label that is much too long for this box", "w": 60}])
    assert "[fix: tidy rules=fit_labels ids=a]" in agent.ok("doctor", name="d")
    agent.ok("tidy", name="d", rules=["fit_labels"])
    assert "label_overflow" not in agent.ok("doctor", name="d")


def test_place_right_of_top_aligns_by_default_and_takes_align(agent):
    agent.ok("create_canvas", name="d")
    agent.ok("add_nodes", name="d", nodes=[{"type": "sticky", "id": "s", "label": "note", "w": 160, "h": 160, "at": {"x": 0, "y": 300}} ])
    agent.ok("add_nodes", name="d", nodes=[
        {"type": "query", "id": "q", "sql": "select 1", "place": {"relation": "right_of", "anchor": "s"}},
        {"type": "shape", "id": "c", "label": "C", "h": 40, "place": {"relation": "left_of", "anchor": "s", "align": "center"}}])
    b = boxes(saved())
    assert b["q"][0] == b["s"][2] + 40 and b["q"][1] == b["s"][1]          # beside the sticky, tops equal
    assert abs((b["c"][1] + b["c"][3]) / 2 - (b["s"][1] + b["s"][3]) / 2) <= 1  # align: center still works
    agent.ok("update_nodes", name="d", updates=[{"id": "q", "place": {"relation": "right_of", "anchor": "s", "align": "end"}}])
    assert boxes(saved())["q"][3] == boxes(saved())["s"][3]
