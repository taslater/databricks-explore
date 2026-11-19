"""Column trace: the bounded walk, what each hop does to its column, and the route and MCP tool, through demo mode."""
import json

import pytest

from databricks_explore import app as app_module
from databricks_explore import column_trace, dbx, demo, demo_lake, sqltools
from mcp_helpers import agent, connected, env  # noqa: F401

LAKE = demo_lake.LAKE
FACT, DAILY = f"{LAKE}.gold.fact_order_lines", f"{LAKE}.gold.daily_revenue"
LINES, RAW = f"{LAKE}.silver.order_lines", f"{LAKE}.bronze.raw_order_lines"


def row(src, sc, tgt, tc):
    return {"source_table_full_name": src, "source_column_name": sc, "target_table_full_name": tgt, "target_column_name": tc, "last_seen": "t"}


def rows_by_table(rows):
    """rows_of for walk(): the rows that touch a table at either end, as the system table is asked."""
    return lambda t: [r for r in rows if t.lower() in (r["source_table_full_name"].lower(), r["target_table_full_name"].lower())]


CHAIN = [row("a.s.t1", "x", "a.s.t2", "y"), row("a.s.t2", "y", "a.s.t3", "z"), row("a.s.t3", "z", "a.s.t4", "w"), row("a.s.t0", "q", "a.s.t1", "x")]


def ends(out):
    return [(h["hop"], h["side"], f"{h['source']['table'][-2:]}.{h['source']['column']}", f"{h['target']['table'][-2:]}.{h['target']['column']}") for h in out["hops"]]


def test_the_walk_follows_a_column_each_way_and_reports_hops_from_the_start():
    out = column_trace.walk(rows_by_table(CHAIN), "a.s.t2", "y", "both", 3)
    assert ends(out) == [(1, "up", "t1.x", "t2.y"), (1, "down", "t2.y", "t3.z"), (2, "up", "t0.q", "t1.x"), (2, "down", "t3.z", "t4.w")]
    assert [(n["table"][-2:], n["side"]) for n in out["nodes"]] == [("t2", "start"), ("t1", "up"), ("t3", "down"), ("t0", "up"), ("t4", "down")]
    up = column_trace.walk(rows_by_table(CHAIN), "a.s.t2", "Y", "upstream", 1)
    assert ends(up) == [(1, "up", "t1.x", "t2.y")] and not up["truncated"]  # names match ignoring case, depth bounds it


def test_a_cycle_ends_the_walk_and_a_column_that_merely_shares_a_table_is_not_followed():
    loop = [row("a.s.t1", "x", "a.s.t2", "y"), row("a.s.t2", "y", "a.s.t1", "x"), row("a.s.t2", "other", "a.s.t5", "n"), row("a.s.t1", "x", "a.s.t1", "x")]
    out = column_trace.walk(rows_by_table(loop), "a.s.t1", "x", "both", 6)
    assert sorted(ends(out)) == [(1, "down", "t1.x", "t2.y"), (1, "up", "t2.y", "t1.x")]  # each hop once, at its nearer side
    assert len(out["nodes"]) == 2


def test_the_table_cap_stops_the_walk_and_says_so_and_a_failing_table_is_an_error_not_a_crash():
    fan = [row("a.s.src", "c", f"a.s.t{i}", "c") for i in range(10)]
    out = column_trace.walk(rows_by_table(fan), "a.s.src", "c", "downstream", 2, node_cap=4)
    assert out["truncated"] and len({n["table"] for n in out["nodes"]}) == 4 and len(out["hops"]) == 3

    def broken(t):
        raise RuntimeError("PERMISSION_DENIED on " + t)
    out = column_trace.walk(broken, "a.s.t", "c", "both", 2)
    assert out["hops"] == [] and "PERMISSION_DENIED" in out["errors"][0]
    with pytest.raises(ValueError):
        column_trace.walk(broken, "a.s.t", "c", "sideways")


@pytest.mark.parametrize("select, column, klass, agg", [
    ("SELECT a AS b FROM t", "b", "ref", None),
    ("SELECT CAST(a AS INT) AS b FROM t", "b", "cast", None),
    ("SELECT SUM(a) AS b FROM t GROUP BY c", "b", "agg", "sum"),
    ("SELECT COUNT(DISTINCT a) AS b FROM t", "b", "agg", "count"),
    ("SELECT ROUND(SUM(a) / 2, 2) AS b FROM t", "b", "agg", "sum"),
    ("SELECT CASE WHEN a > 1 THEN 'x' ELSE 'y' END AS b FROM t", "b", "case", None),
    ("SELECT lower(a) AS b FROM t", "b", "func", None),
    ("SELECT a * 2 AS b FROM t", "b", "func", None),
    ("SELECT row_number() OVER (PARTITION BY a ORDER BY c) AS b FROM t", "b", "func", None),
    ("CREATE TABLE x.y.z AS SELECT lower(a) AS b FROM t", "b", "func", None),
    ("INSERT INTO x.y.z SELECT a, count(*) AS b FROM t GROUP BY a", "b", "agg", "count"),
    ("MERGE INTO x.y.z AS t USING (SELECT lower(a) AS b FROM s) AS s ON t.b = s.b WHEN MATCHED THEN UPDATE SET *", "b", "func", None),
    ("SELECT a AS b FROM t1 UNION ALL SELECT c AS b FROM t2", "b", "ref", None),
])
def test_each_kind_of_expression_has_its_class(select, column, klass, agg):
    found = sqltools.column_expressions(select, "c", "s")[column]
    assert (found["class"], found["agg"]) == (klass, agg)


def test_an_insert_names_its_outputs_by_position():
    # live on dbx-free: INSERT INTO orders SELECT o.o_orderkey, o.o_custkey, ... FROM samples.tpch.orders o names no output order_id or customer_id
    sql = "INSERT INTO c.s.orders SELECT o.o_orderkey, CAST(o.o_totalprice AS DECIMAL(18,2)), 'x' FROM samples.tpch.orders o"
    by_table = sqltools.column_expressions(sql, "c", "s", target_columns=["order_id", "total_price", "status"])
    assert {k: v["class"] for k, v in by_table.items()} == {"order_id": "ref", "total_price": "cast", "status": "func"}
    by_list = sqltools.column_expressions("INSERT INTO c.s.orders (status, order_id) SELECT 'x', o.o_orderkey FROM samples.tpch.orders o", "c", "s",
                                          target_columns=["order_id", "total_price", "status"])
    assert {k: v["class"] for k, v in by_list.items()} == {"status": "func", "order_id": "ref"}
    assert list(sqltools.column_expressions(sql, "c", "s", target_columns=["a", "b"])) == ["o_orderkey", "o_totalprice", "x"]  # not as many: its own names
    assert "o_orderkey" in sqltools.column_expressions(sql, "c", "s")


def test_a_star_names_no_column_and_sql_with_no_query_gives_nothing():
    assert sqltools.column_expressions("SELECT *, t.* FROM t") == {}
    assert sqltools.column_expressions("COPY INTO a.b.c FROM 's3://x/' FILEFORMAT = CSV") == {}
    with pytest.raises(ValueError):
        sqltools.column_expressions("SELECT FROM (")


def test_a_plain_column_is_equals_or_an_arrow_by_the_names_at_the_two_ends():
    expressions = {"b": {"class": "ref", "agg": None, "sql": "a"}, "s": {"class": "agg", "agg": "sum", "sql": "SUM(a)"}}
    hop = lambda sc, tc: {"source": {"column": sc}, "target": {"column": tc}}  # noqa: E731
    assert column_trace.classify(hop("b", "b"), expressions)["label"] == "="
    assert column_trace.classify(hop("a", "b"), expressions)["label"] == "→"
    assert column_trace.classify(hop("a", "s"), expressions) == {"class": "agg", "label": "Σ sum", "expr": "SUM(a)", "note": None}
    assert column_trace.classify(hop("a", "zz"), expressions)["note"] == "not_select"
    assert column_trace.classify(hop("a", "b"), None)["note"] == "unparsed"


# ---------------------------------------------------------------- the route, through the demo lake

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


def trace(client, table, column, direction="upstream", depth=4):
    r = client.get("/api/column-trace", query_string={"table": table, "column": column, "direction": direction, "depth": depth})
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def by_pair(out):
    return {(f"{h['source']['table'].split('.', 1)[1]}.{h['source']['column']}", h["target"]["column"]): h for h in out["hops"]}


def test_a_view_column_has_its_class_at_once_and_a_tables_waits_for_its_statement_to_be_read(client):
    out = trace(client, DAILY, "revenue")
    assert out["unread"] == [FACT, LINES]
    top = by_pair(out)[("gold.fact_order_lines.net_amount", "revenue")]
    assert (top["label"], top["expr"], top["hop"], top["side"]) == ("Σ sum", "SUM(f.net_amount)", 1, "up")  # a view's SQL is known
    assert by_pair(out)[("silver.order_lines.quantity", "net_amount")]["class"] is None and by_pair(out)[("silver.order_lines.quantity", "net_amount")]["note"] == "unread"
    assert client.post("/api/edge-transforms/read", json={"tables": out["unread"]}).get_json()["errors"] == {}
    out = trace(client, DAILY, "revenue")
    pairs = by_pair(out)
    assert out["unread"] == []  # both statements were read
    assert {k: v["label"] for k, v in pairs.items() if k[1] == "net_amount"} == {
        ("silver.order_lines.quantity", "net_amount"): "ƒ", ("silver.order_lines.unit_price", "net_amount"): "ƒ", ("silver.order_lines.discount_pct", "net_amount"): "ƒ"}
    assert pairs[("silver.order_lines.quantity", "net_amount")]["expr"] == "l.quantity * l.unit_price * (1 - l.discount_pct)"
    qty = by_pair(out)[("bronze.raw_order_lines.qty", "quantity")]
    assert (qty["label"], qty["hop"]) == ("→", 3)  # INSERT ... SELECT qty AS quantity: renamed
    assert out["tables"] == [DAILY, FACT, LINES, RAW]


def test_downstream_names_the_dashboards_that_read_the_ends_and_a_cast_and_a_same_name_column_are_told_apart(client):
    client.post("/api/edge-transforms/read", json={"tables": [FACT, f"{LAKE}.silver.orders"]})
    out = trace(client, f"{LAKE}.silver.v_orders_current", "order_date", "downstream", 2)
    assert by_pair(out)[("silver.v_orders_current.order_date", "date_key")]["label"] == "cast"
    both = trace(client, FACT, "net_amount", "both", 3)
    assert [(r["kind"], r["id"], r["table"]) for r in both["readers"]] == [("dashboard", "d-revenue-0001", DAILY), ("dashboard", "d-returns-0002", f"{LAKE}.gold.fact_returns")]
    assert trace(client, FACT, "net_amount", "upstream", 1)["readers"] == []  # only the downstream ends have readers


def test_the_route_checks_its_input(client):
    get = lambda **q: client.get("/api/column-trace", query_string=q)  # noqa: E731
    assert get(table=DAILY).status_code == 400 and get(column="revenue").status_code == 400
    assert get(table=DAILY, column="nope").status_code == 400 and "no column nope" in get(table=DAILY, column="nope").get_json()["error"]
    assert get(table=DAILY, column="revenue", direction="sideways").status_code == 400
    assert get(table="ph:abc", column="x").status_code == 400
    assert get(table=DAILY, column="REVENUE").get_json()["column"] == "revenue"  # the table's own spelling


# ---------------------------------------------------------------- the MCP tool

def test_trace_column_lists_the_hops_with_their_classes_and_what_is_unread(agent, connected):
    out = agent.ok("trace_column", table=DAILY, column="revenue", direction="upstream", depth=1)
    assert "trace of " + DAILY + ".revenue, upstream, depth 1: 1 other table(s), 1 hop(s)" in out
    assert f"hop 1 up {FACT}.net_amount -> [Σ sum] -> {DAILY}.revenue  SUM(f.net_amount)" in out
    deeper = agent.ok("trace_column", table=DAILY, column="revenue", direction="upstream", depth=3)
    assert "-> [unknown (unread)] ->" in deeper and "have no class yet" in deeper
    j = json.loads(agent.ok("trace_column", table=FACT, column="net_amount", format="json"))
    assert j["unread"] and j["readers"][0]["id"] == "d-revenue-0001" and {h["side"] for h in j["hops"]} == {"up", "down"}
    assert "dashboard d-revenue-0001 reads " + DAILY in agent.ok("trace_column", table=FACT, column="net_amount", direction="downstream")


def test_trace_column_adds_the_traced_tables_to_a_saved_graph_and_checks_its_input(agent, connected):
    agent.ok("create_graph", name="rev", tables=[DAILY])
    out = agent.ok("trace_column", table=DAILY, column="revenue", direction="upstream", depth=2, graph="rev")
    assert f"added to the graph: {FACT}, {LINES}" in out
    tables = {n["table"] for n in json.loads(agent.ok("get_graph", name="rev", format="json"))["nodes"]}
    assert tables == {DAILY, FACT, LINES}
    assert "every table is already on it" in agent.ok("trace_column", table=DAILY, column="revenue", direction="upstream", depth=2, graph="rev")
    assert "no column nope" in agent.fails("trace_column", table=DAILY, column="nope")
    agent.fails("trace_column", table=DAILY, column="revenue", graph="missing")
    assert "placeholder" in agent.fails("trace_column", table="ph:abc", column="x")
