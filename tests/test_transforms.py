"""What a flow edge does with its source: sqltools.transform_analysis per class of transform, and the routes and tools that carry it, through demo mode."""
import json

import pytest

from databricks_explore import app as app_module
from databricks_explore import dbx, demo, demo_lake, sqltools, transforms
from mcp_helpers import agent, connected, env  # noqa: F401

LAKE = demo_lake.LAKE
FACT, DATE, ORDERS_VIEW = f"{LAKE}.gold.fact_order_lines", f"{LAKE}.gold.dim_date", f"{LAKE}.silver.v_orders_current"


def facts_of(sql, source, **kw):
    """The edge transform of one source of a statement, with names qualified under c.s."""
    return sqltools.edge_transform(sqltools.transform_analysis(sql, "c", "s", **kw), f"c.s.{source}")


def test_a_group_by_marks_every_source_as_aggregated_and_a_join_marks_only_the_joined_one():
    sql = ("SELECT c.region, SUM(o.amount) AS total FROM orders o JOIN customers c ON o.customer_id = c.customer_id "
           "WHERE o.status = 'paid' AND c.active GROUP BY c.region")
    orders, customers = facts_of(sql, "orders"), facts_of(sql, "customers")
    for t in (orders, customers):
        assert t["aggregate"] == {"keys": ["region"], "functions": ["SUM"], "having": None}
    assert orders["driving"] and orders["joined"] is None and orders["glyphs"] == ["aggregate", "filter"]
    assert customers["joined"] == {"type": "inner", "keys": [{"column": "customer_id", "other": "c.s.orders.customer_id"}]}
    assert customers["glyphs"] == ["aggregate", "join"]  # two glyphs at most, by priority
    assert [f["sql"] for f in orders["filters"]] == ["o.status = 'paid'"] and [f["sql"] for f in customers["filters"]] == ["c.active"]


@pytest.mark.parametrize("sql, keys, glyphs", [
    ("SELECT * FROM x QUALIFY row_number() OVER (PARTITION BY k ORDER BY ts DESC) = 1", ["k"], ["dedupe"]),
    ("WITH r AS (SELECT *, row_number() OVER (PARTITION BY k, j ORDER BY ts) rn FROM x) SELECT * FROM r WHERE rn = 1", ["k", "j"], ["dedupe"]),
    ("SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY k ORDER BY ts) AS rn FROM x) t WHERE t.rn = 1", ["k"], ["dedupe"]),
])
def test_a_row_number_filter_is_a_dedupe_not_a_filter_or_a_window(sql, keys, glyphs):
    t = facts_of(sql, "x")
    assert t["dedupe"] == {"keys": keys} and t["glyphs"] == glyphs and t["filters"] == [] and t["window"] is False


def test_distinct_dedupes_and_a_window_function_is_not_an_aggregate():
    assert facts_of("CREATE TABLE a.b.t AS SELECT DISTINCT a, b FROM x", "x")["glyphs"] == ["dedupe"]
    t = facts_of("SELECT a, count(*) OVER (PARTITION BY b) AS n FROM x", "x")
    assert t["aggregate"] is None and t["window"] is True and t["glyphs"] == []


def test_a_global_aggregate_has_no_keys_and_having_is_kept():
    t = facts_of("SELECT count(*), max(a) FROM x", "x")
    assert t["aggregate"] == {"keys": [], "functions": ["COUNT", "MAX"], "having": None}
    assert facts_of("SELECT a, sum(b) FROM x GROUP BY a HAVING sum(b) > 1", "x")["aggregate"]["having"] == "SUM(b) > 1"


def test_union_branches_are_counted_and_except_filters_its_second_branch():
    sql = "SELECT a FROM t1 UNION ALL SELECT a FROM t2 UNION ALL SELECT a FROM t3"
    assert [facts_of(sql, t)["union"] for t in ("t1", "t2", "t3")] == [{"branches": 3}] * 3
    assert facts_of(sql, "t2")["glyphs"] == ["union"]
    assert facts_of("SELECT a FROM t1 EXCEPT SELECT a FROM t2", "t1")["glyphs"] == []
    assert facts_of("SELECT a FROM t1 EXCEPT SELECT a FROM t2", "t2")["filters"] == [{"kind": "anti", "sql": "EXCEPT"}]


@pytest.mark.parametrize("sql, kind", [
    ("SELECT * FROM o WHERE EXISTS (SELECT 1 FROM r WHERE r.id = o.id)", "semi"),
    ("SELECT * FROM o WHERE NOT EXISTS (SELECT 1 FROM r WHERE r.id = o.id)", "anti"),
    ("SELECT * FROM o WHERE o.id IN (SELECT id FROM r)", "semi"),
    ("SELECT * FROM o WHERE o.id NOT IN (SELECT id FROM r)", "anti"),
    ("SELECT * FROM o LEFT SEMI JOIN r ON r.id = o.id", "semi"),
    ("SELECT * FROM o LEFT ANTI JOIN r ON r.id = o.id", "anti"),
])
def test_a_table_that_only_decides_which_rows_stay_is_a_filter_not_a_lookup(sql, kind):
    r, o = facts_of(sql, "r"), facts_of(sql, "o")
    assert r["glyphs"] == ["filter"] and r["joined"] is None and r["driving"] is False
    assert [f["kind"] for f in r["filters"]] == [kind]
    assert o["glyphs"] == [] and o["driving"]  # the correlation is not a filter on o


def test_join_types_keys_and_a_comma_join_with_its_condition_in_where():
    sql = "SELECT * FROM a LEFT JOIN b ON a.k = b.k AND a.j = b.j JOIN c USING (k)"
    assert facts_of(sql, "b")["joined"]["type"] == "left" and [k["column"] for k in facts_of(sql, "b")["joined"]["keys"]] == ["k", "j"]
    assert facts_of(sql, "c")["joined"] == {"type": "inner", "keys": [{"column": "k", "other": None}]}  # USING after two tables names no partner
    assert facts_of("SELECT * FROM a JOIN c USING (k)", "c")["joined"]["keys"] == [{"column": "k", "other": "c.s.a.k"}]
    comma = "SELECT * FROM a, b WHERE a.id = b.id AND b.x > 3"
    assert facts_of(comma, "b")["joined"]["keys"] == [{"column": "id", "other": "c.s.a.id"}]
    assert [f["sql"] for f in facts_of(comma, "b")["filters"]] == ["b.x > 3"]  # the equality is the join, not a filter
    assert facts_of("SELECT * FROM a CROSS JOIN b", "b")["joined"] == {"type": "cross", "keys": []}


def test_a_source_below_a_subquery_or_cte_takes_what_the_outer_query_does_with_it():
    sql = ("WITH it AS (SELECT order_id, SUM(q) AS units FROM items GROUP BY order_id) "
           "SELECT * FROM it JOIN ship s ON s.order_id = it.order_id WHERE s.carrier = 'x'")
    items, ship = facts_of(sql, "items"), facts_of(sql, "ship")
    assert items["aggregate"]["keys"] == ["order_id"] and items["driving"] and items["glyphs"] == ["aggregate"]
    assert ship["aggregate"] is None and ship["joined"]["keys"] == [{"column": "order_id", "other": "c.s.items.order_id"}]
    assert ship["glyphs"] == ["join", "filter"]


def test_several_ctes_and_a_self_join_fold_into_one_table():
    sql = ("WITH a AS (SELECT * FROM x WHERE v > 1), b AS (SELECT * FROM x WHERE v < 0), "
           "c AS (SELECT k FROM y) SELECT * FROM a JOIN b ON a.k = b.k JOIN c ON c.k = a.k")
    x, y = facts_of(sql, "x"), facts_of(sql, "y")
    assert x["driving"] and x["joined"]["type"] == "inner" and {f["sql"] for f in x["filters"]} == {"v > 1", "v < 0"}
    assert y["joined"]["type"] == "inner" and y["filters"] == []


def test_merge_keeps_the_target_keys_and_actions_and_looks_through_the_using_query():
    sql = ("MERGE INTO a.b.t AS t USING (SELECT k, v FROM raw WHERE k IS NOT NULL) AS s ON t.k = s.k AND t.j = s.j "
           "WHEN MATCHED THEN UPDATE SET * WHEN NOT MATCHED THEN INSERT *")
    a = sqltools.transform_analysis(sql, "c", "s")
    assert a["statement"] == "merge" and a["target"] == "a.b.t"
    t = sqltools.edge_transform(a, "c.s.raw")
    assert t["merge"] == {"keys": ["k", "j"], "actions": ["update", "insert"]} and t["glyphs"] == ["filter"]
    plain = sqltools.edge_transform(sqltools.transform_analysis("MERGE INTO a.b.t t USING a.b.s s ON t.k = s.k WHEN MATCHED THEN DELETE", "c", "s"), "a.b.s")
    assert plain["merge"] == {"keys": ["k"], "actions": ["delete"]}


def test_create_and_insert_read_their_select_and_name_the_target():
    for sql, kind in (("CREATE OR REPLACE TABLE a.b.t AS SELECT * FROM x WHERE a = 1", "create"), ("INSERT INTO a.b.t SELECT * FROM x WHERE a = 1", "insert")):
        a = sqltools.transform_analysis(sql, "c", "s")
        assert (a["statement"], a["target"]) == (kind, "a.b.t") and sqltools.edge_transform(a, "c.s.x")["glyphs"] == ["filter"]


def test_a_statement_with_no_table_has_no_sources_and_one_that_does_not_parse_raises():
    assert sqltools.transform_analysis("COPY INTO a.b.c FROM 's3://x/' FILEFORMAT = CSV")["sources"] == {}
    assert sqltools.edge_transform(sqltools.transform_analysis("SELECT 1 FROM x"), "c.s.other") is None
    with pytest.raises(ValueError, match="cannot parse"):
        sqltools.transform_analysis("SELECT * FROM (SELECT FROM")


def test_a_source_the_query_only_passes_through_has_a_transform_with_no_glyph():
    assert facts_of("SELECT a, b FROM x", "x")["glyphs"] == [] and facts_of("SELECT a, b FROM x", "x")["driving"]


def test_names_are_qualified_from_the_known_tables_when_one_fits():
    t = sqltools.edge_transform(sqltools.transform_analysis("SELECT * FROM orders WHERE a = 1", None, None, ["x.y.orders"]), "x.y.orders")
    assert t["glyphs"] == ["filter"]


def test_a_long_predicate_is_cut():
    t = facts_of("SELECT * FROM x WHERE a IN (" + ", ".join(str(i) for i in range(200)) + ")", "x")
    assert len(t["filters"][0]["sql"]) <= 160 and t["filters"][0]["sql"].endswith("…")


# ---------------------------------------------------------------- routes, through the demo lake

@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    c.post("/api/warehouse", json={"id": "demo-wh-1"})
    return c


def edge(i, source, target):
    return {"id": i, "source": source, "target": target}


def ask(client, *edges):
    return client.post("/api/edge-transforms", json={"edges": list(edges)}).get_json()


def test_the_demo_view_with_a_join_and_a_group_by_has_the_sigma_on_both_edges_and_the_join_on_the_lookup(client):
    daily = f"{LAKE}.gold.daily_revenue"
    out = ask(client, edge("fact", FACT, daily), edge("date", DATE, daily))
    fact, date = out["edges"]["fact"]["transform"], out["edges"]["date"]["transform"]
    assert fact["glyphs"] == ["aggregate"] and fact["driving"] and fact["aggregate"]["keys"] == ["order_date", "store_id"]
    assert date["glyphs"] == ["aggregate", "join"] and date["joined"]["keys"] == [{"column": "date_key", "other": f"{FACT}.date_key"}]
    assert out["origins"][daily]["kind"] == "view" and "GROUP BY" in out["origins"][daily]["sql"]


def test_a_table_has_no_transform_until_its_statement_is_read_and_then_gets_the_same_as_a_view(client):
    plan = client.post("/api/edge-transforms/plan", json={"tables": [FACT, f"{LAKE}.gold.daily_revenue", f"{LAKE}.gold.revenue_metrics"]}).get_json()
    assert [s["table"] for s in plan["statements"]] == [FACT] and "target_table_full_name = '" + FACT + "'" in plan["statements"][0]["sql"]
    assert {s["table"] for s in plan["skipped"]} == {f"{LAKE}.gold.daily_revenue", f"{LAKE}.gold.revenue_metrics"}
    first = ask(client, edge("lines", f"{LAKE}.silver.order_lines", FACT))
    assert first["edges"]["lines"] == {"transform": None, "note": "unread", "error": None}
    client.post("/api/warehouse", json={"id": None})
    assert client.post("/api/edge-transforms/read", json={"tables": [FACT]}).status_code == 400
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    assert client.post("/api/edge-transforms/read", json={"tables": [FACT]}).get_json() == {"read": [FACT], "skipped": [], "errors": {}}
    client.post("/api/warehouse", json={"id": None})  # the cache answers without a warehouse
    out = ask(client, edge("lines", f"{LAKE}.silver.order_lines", FACT), edge("orders", ORDERS_VIEW, FACT))
    assert out["edges"]["lines"]["transform"]["glyphs"] == [] and out["edges"]["lines"]["transform"]["driving"]
    orders = out["edges"]["orders"]["transform"]
    assert orders["glyphs"] == ["join", "filter"] and orders["filters"] == [{"kind": "where", "sql": "o.status <> 'cancelled'"}]
    assert orders["joined"]["keys"] == [{"column": "order_id", "other": f"{LAKE}.silver.order_lines.order_id"}]
    st = out["origins"][FACT]["statement"]
    assert st["id"].startswith("demo-lake-") and st["type"] == "CREATE" and "CREATE OR REPLACE TABLE" in out["origins"][FACT]["sql"]


def test_a_table_written_by_a_notebook_says_so_and_a_redacted_statement_says_that(client, monkeypatch):
    returns = f"{LAKE}.silver.returns"
    client.post("/api/edge-transforms/read", json={"tables": [returns]})
    out = ask(client, edge("r", f"{LAKE}.bronze.raw_returns", returns))
    assert out["edges"]["r"] == {"transform": None, "note": "no_sql", "error": None}
    assert out["origins"][returns]["writer"] == {"type": "notebook", "id": "7002"}
    monkeypatch.setenv("EXPLORER_DEMO_REDACTED", "1")
    client.post("/api/edge-transforms/read", json={"tables": [FACT]})
    out = ask(client, edge("l", f"{LAKE}.silver.order_lines", FACT))
    assert out["edges"]["l"]["note"] == "redacted" and out["origins"][FACT]["statement"]["redacted"] is True


def test_the_aggregating_ctas_and_a_metric_view_and_unparseable_sql(client, monkeypatch):
    funnel = f"{LAKE}.gold.session_funnel"
    client.post("/api/edge-transforms/read", json={"tables": [funnel]})
    t = ask(client, edge("s", f"{LAKE}.silver.sessions", funnel))["edges"]["s"]["transform"]
    assert t["glyphs"] == ["aggregate"] and t["aggregate"]["functions"] == ["COUNT", "AVG"]
    metrics = f"{LAKE}.gold.revenue_metrics"
    assert ask(client, edge("m", FACT, metrics))["edges"]["m"]["note"] == "metric_view"
    monkeypatch.setattr(transforms, "_analysis", transforms._analysis.__wrapped__)
    monkeypatch.setattr(dbx.Explorer, "cached_write_statement", lambda self, t: {"fetched_at": "x", "data": {"statement": {"id": "s1", "sql": "SELECT * FROM (SELECT FROM"}}})
    bad = ask(client, edge("b", f"{LAKE}.silver.order_lines", FACT))["edges"]["b"]
    assert bad["transform"] is None and bad["note"] == "unparsed" and "cannot parse" in bad["error"]


def test_the_routes_check_their_input(client):
    assert client.post("/api/edge-transforms", json={"edges": [{"id": 1}]}).status_code == 400
    assert client.post("/api/edge-transforms", json={"edges": [edge(str(i), "a.b.c", "a.b.d") for i in range(401)]}).status_code == 400
    assert client.post("/api/edge-transforms/read", json={"tables": "x"}).status_code == 400
    placeholder = client.post("/api/edge-transforms", json={"edges": [edge("p", "ph:x", FACT)]}).get_json()
    assert placeholder["edges"] == {}


def test_a_failing_statement_is_reported_and_leaves_the_cache_as_it_was(client, monkeypatch):
    monkeypatch.setattr(dbx.Explorer, "sql", lambda self, statement, **p: (_ for _ in ()).throw(RuntimeError("PERMISSION_DENIED")))
    out = client.post("/api/edge-transforms/read", json={"tables": [FACT]}).get_json()
    assert out["read"] == [] and "PERMISSION_DENIED" in out["errors"][FACT]


# ---------------------------------------------------------------- the MCP tools

def test_get_graph_and_lineage_carry_the_transform_of_each_flow_edge(agent, connected):
    daily = f"{LAKE}.gold.daily_revenue"
    connected.post("/api/edge-transforms", json={"edges": [edge("e", FACT, daily)]})  # reads tables.get, so the definition is cached
    graph = agent.ok("create_graph", name="rev", tables=[FACT, DATE, daily])
    assert "view_dep" in graph
    j = json.loads(agent.ok("get_graph", name="rev", format="json"))
    by = {(e["source"], e["target"]): e for e in j["edges"]}
    assert by[(FACT, daily)]["transform"]["glyphs"] == ["aggregate"] and by[(DATE, daily)]["transform"]["glyphs"] == ["aggregate", "join"]
    text = agent.ok("get_graph", name="rev")
    assert f"{DATE} -> {daily}" in text and "[aggregates by order_date, store_id (SUM, COUNT), joined inner on date_key]" in text
    walk = agent.ok("lineage", table=daily, direction="upstream", depth=1)
    assert "[aggregates by order_date, store_id (SUM, COUNT)]" in walk and "joined inner on date_key" in walk
    assert json.loads(agent.ok("lineage", table=daily, direction="upstream", depth=1, format="json"))["edges"][0]["transform"]["glyphs"]


def test_summary_words():
    t = facts_of("SELECT c.r, count(*) FROM a JOIN c ON a.k = c.k GROUP BY c.r", "c")
    assert transforms.summary(t) == "aggregates by r (COUNT), joined inner on k"
    assert transforms.summary(facts_of("SELECT a FROM x", "x")) == ""
