"""Relationship profile: the SQL for single and composite keys, the ends and sentences from numbers, the kept evidence, the routes and the MCP tool on the demo lakehouse."""
import pytest
import sqlglot

from databricks_explore import app as app_module
from databricks_explore import cardinality, dbx, demo_lake, relprofile
from databricks_explore.mcp_server.sqlguard import check_read_only
from mcp_helpers import agent, connected, env  # noqa: F401

LAKE = demo_lake.LAKE
FACT, PRODUCT, CUSTOMER, STORE = (f"{LAKE}.gold.{t}" for t in ("fact_order_lines", "dim_product", "dim_customer", "dim_store"))
ROW = dict(a_rows=1000, a_null_rows=0, a_distinct_keys=90, b_rows=100, b_distinct_keys=100, b_repeated_keys=0, orphan_rows=0, orphan_keys=0,
           unused_keys=0, max_fanout=40, p95_fanout=20)


def profile(**over):
    return relprofile.make("shop.sales.orders", "shop.sales.customers", [("customer_id", "id")], "SELECT 1", {**ROW, **over}, "2026-11-18T10:00:00+00:00")


def end_names(p):
    src, tgt = relprofile.ends(p)
    return src["end"], tgt["end"]


# ---------------------------------------------------------------- the statement

def test_the_statement_for_one_key_groups_both_sides_and_anti_joins_each_way():
    sql = relprofile.build_sql("shop.sales.orders", "shop.sales.customers", [("customer_id", "id")])
    assert "FROM `shop`.`sales`.`orders` WHERE `customer_id` IS NOT NULL GROUP BY `customer_id`" in sql
    assert "FROM `shop`.`sales`.`customers` WHERE `id` IS NOT NULL GROUP BY `id`" in sql
    assert "count_if(`customer_id` IS NULL) AS a_null_rows" in sql
    assert sql.count("LEFT ANTI JOIN") == 2 and "ON a.k0 = b.k0)" in sql
    assert [e.alias_or_name for e in sqlglot.parse_one(sql, read="databricks").selects] == list(relprofile.NUMBERS)


def test_a_composite_key_compares_every_column_and_a_null_in_any_of_them_is_a_null_key():
    sql = relprofile.build_sql("s.c.lines", "s.c.orders", [("order_id", "id"), ("line_no", "line")])
    assert "WHERE `order_id` IS NOT NULL AND `line_no` IS NOT NULL GROUP BY `order_id`, `line_no`" in sql
    assert "WHERE `id` IS NOT NULL AND `line` IS NOT NULL GROUP BY `id`, `line`" in sql
    assert "count_if(`order_id` IS NULL OR `line_no` IS NULL) AS a_null_rows" in sql
    assert "ON a.k0 = b.k0 AND a.k1 = b.k1)" in sql
    sqlglot.parse_one(sql, read="databricks")


def test_a_name_with_a_backtick_is_quoted_and_the_statement_passes_the_read_only_gate():
    sql = relprofile.build_sql("s.c.t", "s.c.u", [("we`ird", "id")])
    assert "`we``ird`" in sql
    assert check_read_only(sql)


# ---------------------------------------------------------------- ends and sentences from numbers

def test_a_unique_target_with_every_key_used_and_no_gaps_is_exactly_one_and_one_or_more():
    assert end_names(profile()) == ("one_many", "one")


def test_nulls_or_orphans_allow_zero_and_unused_keys_make_the_source_end_zero_or_more():
    assert end_names(profile(a_null_rows=5)) == ("one_many", "zero_one")
    assert end_names(profile(orphan_rows=7, orphan_keys=2)) == ("one_many", "zero_one")
    assert end_names(profile(unused_keys=3)) == ("zero_many", "one")


def test_a_target_that_is_not_a_key_is_many_at_both_ends():
    p = profile(b_rows=130, b_repeated_keys=214)
    assert end_names(p) == ("one_many", "one_many")
    assert relprofile.not_a_key_sentence(p) == "not a key: 214 id values appear more than once in customers"
    assert end_names(profile(b_repeated_keys=2, a_null_rows=1, unused_keys=1)) == ("zero_many", "zero_many")
    assert relprofile.not_a_key_sentence(profile()) is None


def test_the_ends_are_a_profile_basis_and_say_when_they_were_measured():
    src, tgt = relprofile.ends(profile(unused_keys=4))
    assert src["basis"] == tgt["basis"] == "profile"
    assert "measured 2026-11-18" in tgt["why"] and "4 keys of customers are not used" in src["why"]


def test_the_orphan_sentence_gives_a_share_rows_and_keys():
    p = profile(a_rows=282_000, orphan_rows=3_410, orphan_keys=212)
    assert relprofile.orphan_sentence(p) == "1.2% of orders (3,410 rows, 212 keys) have no match in customers"
    assert relprofile.orphan_sentence(profile()) is None
    assert relprofile.percent(1, 10_000_000) == "<0.1%" and relprofile.percent(30, 100) == "30%" and relprofile.percent(0, 0) == "0%"


def test_the_cardinality_of_a_profile_carries_the_profile_and_one_sentence():
    c = relprofile.as_cardinality(profile(orphan_rows=10, orphan_keys=3, a_null_rows=2))
    assert c["profile"]["orphan_rows"] == 10 and c["target"]["end"] == "zero_one"
    assert "2 rows of orders have a null key." in c["sentence"] and "have no match in customers." in c["sentence"]


def test_a_missing_number_is_an_error():
    with pytest.raises(ValueError, match="no orphan_rows"):
        relprofile.make("a.b.c", "a.b.d", [("k", "k")], "x", {k: v for k, v in ROW.items() if k != "orphan_rows"}, "now")


# ---------------------------------------------------------------- keys to profile

def joins(*keys):
    return {"table": "a.b.c", "joins": [{"table": "a.b.d", "keys": list(keys)}]}


def key(source, *pairs, status="derived"):
    return {"pairs": [{"here": h, "there": t} for h, t in pairs], "source": source, "status": status}


def test_the_key_comes_from_the_edges_own_kind_else_foreign_key_first_and_never_a_rejected_one():
    j = joins(key("mined", ("m", "m")), key("fk", ("f", "f")), key("manual", ("x", "x"), status="rejected"))
    assert relprofile.key_pairs("fk", j, "a.b.d") == [("f", "f")]
    assert relprofile.key_pairs("join_mined", j, "a.b.d") == [("m", "m")]
    assert relprofile.key_pairs("manual", j, "a.b.d") is None  # the only manual key was rejected
    assert relprofile.key_pairs(None, j, "a.b.d") == [("f", "f")]
    assert relprofile.key_pairs("fk", j, "a.b.zzz") is None and relprofile.key_pairs("fk", None, "a.b.d") is None


def test_plan_edges_skips_what_has_no_key_is_not_a_reference_or_cannot_be_read():
    obj = lambda t: {} if "gone" not in t else None
    j = lambda t: joins(key("fk", ("k", "k")))
    edges = [{"id": "ok", "kind": "fk", "source": "a.b.c", "target": "a.b.d"}, {"id": "flow", "kind": "lineage", "source": "a.b.c", "target": "a.b.d"},
             {"id": "self", "kind": "fk", "source": "a.b.c", "target": "a.b.C"}, {"id": "gone", "kind": "fk", "source": "a.b.c", "target": "a.b.gone"},
             {"id": "nokey", "kind": "manual", "source": "a.b.c", "target": "a.b.d"}]
    specs, skipped = relprofile.plan_edges(edges, obj, j)
    assert [s["id"] for s in specs] == ["ok"] and specs[0]["pairs"] == [["k", "k"]] and "LEFT ANTI JOIN" in specs[0]["sql"]
    assert {s["id"]: s["reason"] for s in skipped}.keys() == {"flow", "self", "gone", "nokey"}


# ---------------------------------------------------------------- evidence kept with its date

def test_a_profile_round_trips_through_its_file_and_replaces_the_ends_in_for_edges(env):
    p = profile()
    relprofile.put("demo", "fk", "shop.sales.orders", "shop.sales.customers", p)
    assert relprofile.get("demo", "fk", "SHOP.sales.orders", "shop.sales.customers") == p  # names compare without regard to case
    assert relprofile.get("demo", "join_mined", "shop.sales.orders", "shop.sales.customers") is None
    assert relprofile.get("other", "fk", "shop.sales.orders", "shop.sales.customers") is None
    edges = [{"id": "e1", "kind": "fk", "source": "shop.sales.orders", "target": "shop.sales.customers"}]
    out = cardinality.for_edges(edges, lambda t: None, lambda t: None, relprofile.lookup("demo"))
    assert out["e1"]["profile"] == p and out["e1"]["target"]["basis"] == "profile"
    assert cardinality.for_edges(edges, lambda t: None, lambda t: None) == {"e1": None}


def test_a_file_that_is_not_json_reads_as_no_profiles(env):
    path = relprofile.path("demo")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("[1, 2", encoding="utf-8")
    assert relprofile.load("demo") == {}


# ---------------------------------------------------------------- routes, on the demo lakehouse

def edge(i, a, b, kind="fk"):
    return {"id": i, "kind": kind, "source": a, "target": b}


def run(client, *edges):
    return client.post("/api/relationships/profile/run", json={"edges": list(edges)})


def test_the_plan_shows_the_sql_and_never_runs_it(connected):
    out = connected.post("/api/relationships/profile/plan", json={"edges": [edge("a", FACT, PRODUCT), edge("l", FACT, CUSTOMER, "lineage")]}).get_json()
    assert [s["id"] for s in out["statements"]] == ["a"] and out["statements"][0]["pairs"] == [["sku", "sku"]]
    assert "LEFT ANTI JOIN" in out["statements"][0]["sql"] and out["warehouse_id"] == "demo-wh-1"
    assert [s["id"] for s in out["skipped"]] == ["l"]
    assert relprofile.load("demo") == {}


def test_profiling_a_relationship_with_orphans_keeps_the_numbers_and_the_ends(connected):
    out = run(connected, edge("sku", FACT, PRODUCT)).get_json()
    p = out["profiles"]["sku"]
    assert (p["orphan_rows"], p["orphan_keys"], p["a_rows"], p["unused_keys"]) == (223_204, 212, 18_600_000, 41)
    assert p["b_repeated_keys"] == 0 and p["pairs"] == [["sku", "sku"]] and p["measured_at"] and p["sql_hash"]
    assert out["errors"] == {} and out["cardinality"]["sku"]["target"]["end"] == "zero_one"
    # a fresh read of the ends, with no warehouse, carries the profile: the saved graph shows it without running again
    connected.post("/api/warehouse", json={"id": None})
    again = connected.post("/api/relationships/cardinality", json={"edges": [edge("sku", FACT, PRODUCT)]}).get_json()["cardinality"]["sku"]
    assert again["profile"] == p and again["target"]["basis"] == "profile"


def test_a_clean_relationship_has_no_orphans_and_the_nulls_make_the_end_zero_or_one(connected):
    out = run(connected, edge("store", FACT, STORE), edge("cust", FACT, CUSTOMER)).get_json()["profiles"]
    assert out["store"]["orphan_rows"] == 0 and out["store"]["a_null_rows"] == 0
    assert out["cust"]["orphan_rows"] == 0 and out["cust"]["a_null_rows"] > 1_000_000
    ends = connected.post("/api/relationships/cardinality", json={"edges": [edge("store", FACT, STORE), edge("cust", FACT, CUSTOMER)]}).get_json()["cardinality"]
    assert (ends["store"]["source"]["end"], ends["store"]["target"]["end"]) == ("one_many", "one")  # the composite key
    assert (ends["cust"]["source"]["end"], ends["cust"]["target"]["end"]) == ("zero_many", "zero_one")


def test_running_needs_a_warehouse_and_reports_a_failing_statement_per_edge(connected, monkeypatch):
    connected.post("/api/warehouse", json={"id": None})
    assert run(connected, edge("sku", FACT, PRODUCT)).status_code == 400
    connected.post("/api/warehouse", json={"id": "demo-wh-1"})
    monkeypatch.setattr(dbx.Explorer, "sql", lambda self, statement, **p: (_ for _ in ()).throw(RuntimeError("PERMISSION_DENIED")))
    out = run(connected, edge("sku", FACT, PRODUCT)).get_json()
    assert out["profiles"] == {} and "PERMISSION_DENIED" in out["errors"]["sku"] and relprofile.load("demo") == {}


def test_bad_bodies_are_refused(connected):
    for body in ({"edges": "x"}, {"edges": [{"id": 1}]}, {"edges": [edge(str(i), FACT, PRODUCT) for i in range(relprofile.MAX_EDGES + 1)]}):
        assert connected.post("/api/relationships/profile/plan", json=body).status_code == 400


# ---------------------------------------------------------------- the MCP tool

def test_the_tool_plans_without_confirm_and_measures_with_it(agent, connected):
    plan = agent.ok("profile_relationship", source=FACT, target=PRODUCT)
    assert plan.startswith("Nothing ran.") and "LEFT ANTI JOIN" in plan and relprofile.load("demo") == {}
    out = agent.ok("profile_relationship", source=FACT, target=PRODUCT, confirm=True)
    assert "orphans: 223,204 rows, 212 keys" in out and "1.2% of fact_order_lines (223,204 rows, 212 keys) have no match in dim_product" in out
    assert relprofile.get("demo", "fk", FACT, PRODUCT)["orphan_keys"] == 212
    # get_graph reports the measured ends and the orphans from then on
    agent.ok("create_graph", name="Star", tables=[FACT, PRODUCT])
    assert "have no match in dim_product" in agent.ok("get_graph", name="Star")


def test_the_tool_refuses_what_it_cannot_profile_and_needs_a_warehouse(agent, connected):
    assert "no usable key" in agent.fails("profile_relationship", source=PRODUCT, target=CUSTOMER)
    connected.post("/api/warehouse", json={"id": None})
    assert "No SQL warehouse" in agent.fails("profile_relationship", source=FACT, target=PRODUCT, confirm=True)
    by = {t["name"]: t for t in agent.rpc("tools/list").get_json()["result"]["tools"]}
    assert not by["profile_relationship"]["annotations"]["readOnlyHint"]
