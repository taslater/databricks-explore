"""Saved graphs: names, revisions and conflicts, the trash, rename, and the /api/diagrams routes the page uses."""
import json

import pytest

from databricks_explore import dbx
from databricks_explore import graphs
from databricks_explore import relationships
from mcp_helpers import connected, env  # noqa: F401


def body(name="g", **extra):
    return {"name": name, "focus_schema": None, "nodes": [], "edges": [], **extra}


def test_names_as_typed_or_as_stored_reach_the_same_file(env):
    assert graphs.write_graph(body("Returns graph"))[0] == "Returns_graph"
    assert graphs.resolve("Returns graph") == graphs.resolve("Returns_graph") == graphs.resolve("returns_graph") == "Returns_graph"
    assert graphs.list_graphs() == ["Returns_graph"] and graphs.exists("Returns graph") and not graphs.exists("nope")
    with pytest.raises(graphs.GraphNotFound):
        graphs.load_graph("nope")
    for bad in ("", "   ", ".hidden", "x" * 200, None, 5):
        with pytest.raises(graphs.GraphInvalid):
            graphs.stem_of(bad)


def test_every_write_bumps_the_revision_and_records_who(env):
    assert graphs.write_graph(body()) == ("g", 1)
    assert graphs.revision_info("g") == {"name": "g", "revision": 1, "by": "ui"}
    assert graphs.write_graph(body(), by="agent") == ("g", 2)
    assert graphs.revision_info("g")["by"] == "agent"
    assert "revision" not in graphs.load_graph("g")  # the counter is not inside the file


def test_a_diagram_saved_before_revisions_is_revision_zero_and_its_next_save_is_one(env):
    (dbx.DIAGRAMS / "old.json").write_text(json.dumps(body("old", saved_at="x")))
    assert graphs.revision_info("old") == {"name": "old", "revision": 0, "by": None}
    assert graphs.write_graph(body("old"))[1] == 1


def test_expect_refuses_a_write_over_a_newer_revision(env):
    graphs.write_graph(body())
    graphs.write_graph(body(), by="agent")
    with pytest.raises(graphs.GraphConflict) as e:
        graphs.write_graph(body(), expect=1)
    assert e.value.info == {"name": "g", "revision": 2, "by": "agent"} and "saved by agent since revision 1" in str(e.value)
    assert graphs.write_graph(body(), expect=2) == ("g", 3)
    assert graphs.write_graph(body("fresh"), expect=7) == ("fresh", 1)  # the check applies only to a graph that exists


def test_validation_and_case_clash_and_create_only(env):
    for bad in ([], {"nodes": []}, {"name": "x", "nodes": 5}, {"name": "x", "edges": {}}):
        with pytest.raises(graphs.GraphInvalid):
            graphs.write_graph(bad)
    graphs.write_graph(body("Hours"))
    with pytest.raises(graphs.GraphInvalid, match="only by case"):
        graphs.write_graph(body("hours"))
    with pytest.raises(graphs.GraphInvalid, match="already exists"):
        graphs.write_graph(body("Hours"), create_only=True)


def test_the_server_time_wins_over_a_client_saved_at(env):
    graphs.write_graph(body(saved_at="1999-01-01"))
    assert graphs.load_graph("g")["saved_at"] != "1999-01-01"


def test_delete_keeps_a_trash_copy_and_the_counter(env, tmp_path):
    graphs.write_graph(body("a b"))
    trash = graphs.delete_graph("a b")
    assert not graphs.exists("a b") and (tmp_path / "diagrams" / ".trash" / trash).is_file() and graphs.list_graphs() == []
    assert graphs.write_graph(body("a b"))[1] == 2
    graphs.delete_graph("a b")
    assert len(list((tmp_path / "diagrams" / ".trash").glob("*.json"))) == 2


def test_rename_moves_the_file_and_continues_the_revision(env):
    graphs.write_graph(body("one"))
    graphs.write_graph(body("one"))
    assert graphs.rename_graph("one", "Two words") == ("Two_words", 3)
    assert graphs.list_graphs() == ["Two_words"] and graphs.load_graph("Two_words")["name"] == "Two words"
    graphs.write_graph(body("x"))
    with pytest.raises(graphs.GraphInvalid, match="already exists"):
        graphs.rename_graph("x", "Two words")
    with pytest.raises(graphs.GraphInvalid, match="only the case"):
        graphs.rename_graph("x", "X")
    with pytest.raises(graphs.GraphNotFound):
        graphs.rename_graph("nope", "y")


def test_routes_save_revision_conflict_rename_and_delete(connected):
    c = connected
    assert c.post("/api/diagrams", json=body("Returns graph")).get_json() == {"saved": "Returns_graph", "revision": 1}
    assert c.get("/api/diagrams").get_json() == ["Returns_graph"]
    assert c.get("/api/diagrams/Returns graph").get_json()["name"] == "Returns graph"
    assert c.get("/api/diagrams/Returns_graph/revision").get_json() == {"name": "Returns_graph", "revision": 1, "by": "ui"}
    graphs.write_graph(body("Returns graph"), by="agent")
    r = c.post("/api/diagrams", json=body("Returns graph"), headers={"X-Base-Revision": "1"})
    assert r.status_code == 409 and r.get_json()["revision"] == 2 and r.get_json()["by"] == "agent" and "error" in r.get_json()
    assert c.post("/api/diagrams", json=body("Returns graph"), headers={"X-Base-Revision": "2"}).get_json()["revision"] == 3
    assert c.post("/api/diagrams", json=body("Returns graph"), headers={"X-Base-Revision": "x"}).status_code == 400
    assert c.post("/api/diagrams", json=body("Returns graph")).get_json()["revision"] == 4  # no header: unchecked, as before
    assert c.post("/api/diagrams", json={"nodes": []}).status_code == 400
    assert c.get("/api/diagrams/nope").status_code == 404 and c.get("/api/diagrams/nope/revision").status_code == 404
    assert c.post("/api/diagrams/Returns_graph/rename", json={}).status_code == 400
    r = c.post("/api/diagrams/Returns_graph/rename", json={"new_name": "Sales"})
    assert r.get_json() == {"renamed": "Sales", "revision": 5}
    assert c.post("/api/diagrams/Sales/rename", json={"new_name": "Sales"}).status_code == 400
    r = c.delete("/api/diagrams/Sales")
    assert r.get_json()["deleted"] == "Sales" and r.get_json()["trash"].startswith("Sales.")
    assert c.delete("/api/diagrams/Sales").status_code == 404 and c.get("/api/diagrams").get_json() == []


def test_the_layout_flows_left_to_right_and_stacks_unconnected_parts():
    sizes = {"a": (100, 40), "b": (100, 40), "c": (100, 40), "d": (100, 40), "e": (100, 40)}
    at = graphs.layout_positions(sizes, [("a", "b", "lineage"), ("b", "c", "view_dep"), ("d", "a", "fk")])
    assert at["a"][0] < at["b"][0] < at["c"][0]
    assert at["d"][0] == at["a"][0] and at["d"][1] != at["a"][1]  # a reference joins its partner's column
    assert at["e"][1] > max(at[i][1] for i in "abcd")  # a part with no edge is a band below
    assert graphs.layout_positions(sizes, [("a", "b", "lineage"), ("b", "a", "lineage")])["b"][0] > 0  # a cycle still lays out


def test_only_flow_edges_set_the_rank_and_every_kind_has_a_family():
    from databricks_explore.edge_families import FAMILY_OF, family_of
    assert family_of("lineage") == family_of("view_dep") == "flow" and family_of("join_mined") == "reference"
    assert family_of("sketch") == family_of("concept_link") == "meaning" and family_of("nope") is None
    assert set(FAMILY_OF) == set(relationships.Kind.__args__)  # a new kind must pick a family
    sizes = {i: (100, 40) for i in "abc"}
    for kind in ("fk", "join_mined", "manual", "sketch"):
        at = graphs.layout_positions(sizes, [("a", "b", "lineage"), ("c", "b", kind)])
        assert at["b"][0] > at["a"][0] and at["c"][0] == at["b"][0], kind


def test_adapt_merges_lineage_both_ways_into_one_bidir_edge():
    def rel(s, t, seen):
        return {"id": f"lineage:{s}->{t}", "kind": "lineage", "source": {"table": s}, "target": {"table": t}, "status": "derived",
                "evidence": {"last_seen": seen}, "provenance": {"origin": "x"}}
    [e] = graphs.graph_edges([rel("a.b.c", "a.b.d", "2026-01-01"), rel("a.b.d", "a.b.c", "2026-02-01")])
    assert e["id"] == "lineage:a.b.c<->a.b.d" and e["bidir"] and e["last_seen"] == "2026-02-01"
    assert e["patch_ids"] == ["lineage:a.b.c->a.b.d", "lineage:a.b.d->a.b.c"]
