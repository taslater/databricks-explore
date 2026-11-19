"""Facts about a node itself: a self-referencing foreign key and a table loaded from files, as relations() and create_graph carry them."""
from databricks_explore import graphs
from mcp_helpers import agent, connected, env  # noqa: F401
from test_graph_correctness import info, item, workspace  # noqa: F401

P = "c.s.people"
LAKE_DIM, LAKE_RAW = "demo_lake.gold.dim_customer", "demo_lake.bronze.raw_orders"


def self_fk(parent=P):
    return {"foreign_key_constraint": {"name": "fk_mgr", "child_columns": ["manager_id"], "parent_table": parent, "parent_columns": ["person_id"]}}


def test_a_self_referencing_foreign_key_marks_the_node_with_its_columns(workspace):
    ex = workspace({P: {**info(P, "MANAGED"), "table_constraints": [self_fk()]}}, {})
    node = next(n for n in ex.relations(P)["nodes"] if n["id"] == P)
    assert node["self_ref"] is True
    assert node["self_ref_fks"] == [{"constraint": "fk_mgr", "columns": ["manager_id"], "parent_columns": ["person_id"]}]
    assert "self_ref_last_seen" not in node  # no lineage self-reference


def test_a_foreign_key_to_another_table_does_not_mark_the_node(workspace):
    other = "c.s.depts"
    ex = workspace({P: {**info(P, "MANAGED"), "table_constraints": [self_fk(other)]}, other: info(other, "MANAGED")}, {})
    assert not any(n.get("self_ref") or n.get("self_ref_fks") for n in ex.relations(P)["nodes"])


def test_a_lineage_self_reference_and_a_foreign_key_one_mark_both_facts(workspace):
    ex = workspace({P: {**info(P, "MANAGED"), "table_constraints": [self_fk()]}},
                   {P: {"upstreams": [item(P, ts="2026-11-15 10:42:00.0")]}})
    node = next(n for n in ex.relations(P)["nodes"] if n["id"] == P)
    assert node["self_ref"] and node["self_ref_last_seen"] == "2026-11-15 10:42:00.0" and len(node["self_ref_fks"]) == 1


def file_item(path, ok=True, ts="2026-11-14 12:00:00.0"):
    return {"fileInfo": {"path": path, "has_permission": ok, "storage_location": path, "lineage_timestamp": ts}}


def test_file_upstreams_are_listed_on_the_node_and_make_no_edge(workspace):
    t = "c.s.raw"
    ex = workspace({t: info(t, "MANAGED")}, {t: {"upstreams": [file_item("s3://b/in/"), file_item("", ok=False)]}})
    rel = ex.relations(t)
    assert rel["edges"] == [] and len(rel["nodes"]) == 1
    assert rel["nodes"][0]["files"] == [{"path": "", "readable": False, "last_seen": "2026-11-14 12:00:00.0"},
                                        {"path": "s3://b/in/", "readable": True, "last_seen": "2026-11-14 12:00:00.0"}]


def test_a_file_downstream_is_not_a_source_of_the_table(workspace):
    t = "c.s.raw"
    ex = workspace({t: info(t, "MANAGED")}, {t: {"downstreams": [file_item("s3://b/out/")]}})
    assert "files" not in ex.relations(t)["nodes"][0]


def test_the_demo_lake_has_a_self_referencing_dimension_and_tables_loaded_from_files(agent):
    agent.ok("create_graph", name="marks", tables=[LAKE_DIM, LAKE_RAW])
    nodes = {n["data"]["id"]: n["data"] for n in graphs.load_graph("marks")["nodes"]}
    dim, raw = nodes[LAKE_DIM], nodes[LAKE_RAW]
    assert dim["self_ref"] and dim["self_ref_fks"][0]["columns"] == ["referred_by_customer_id"]
    assert raw["files"] and raw["files"][0]["readable"] is True and "files" not in dim
