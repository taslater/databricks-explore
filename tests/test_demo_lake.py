"""Demo mode's invented lakehouse (demo_lake): shape, lineage, history and the warehouse's answers, through the real routes."""
import json
import statistics
from datetime import datetime

import pytest
import sqlglot

from databricks_explore import app as app_module
from databricks_explore import dbx, demo, demo_history, demo_lake, demo_lake_sql

LAKE = demo_lake.LAKE
FACT = f"{LAKE}.gold.fact_order_lines"


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


def sql(client, text, **params):
    out = client.post("/api/query", json={"sql": text, "params": params}).json
    return out if "error" in out else {**out, "records": [dict(zip([c["name"] for c in out["columns"]], r)) for r in out["rows"]]}


def obj(client, name):
    return client.get("/api/object", query_string={"name": name}).json["data"]


def ts(text):
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def test_three_schemas_and_about_thirty_objects(client):
    assert [s["name"] for s in client.get(f"/api/schemas?catalog={LAKE}").json["data"]] == ["bronze", "gold", "silver"]
    kinds = {}
    for schema in ("bronze", "silver", "gold"):
        for o in client.get(f"/api/objects?catalog={LAKE}&schema={schema}").json["data"]:
            kinds[f"{schema}.{o['name']}"] = o["type"]
    assert 26 <= len(kinds) <= 32
    assert kinds["gold.daily_revenue"] == "MATERIALIZED_VIEW" and kinds["silver.v_orders"] == "VIEW"
    assert kinds["gold.revenue_metrics"] == "VIEW"


def test_the_lake_stays_out_of_unscoped_lookups(client):
    hits = {h["full_name"] for h in client.get("/api/search?q=order").json["data"]}
    assert hits == {"demo.sales.orders", "demo.sales.order_items"}
    assert f"{LAKE}.gold.fact_order_lines" in {h["full_name"] for h in client.get(f"/api/search?q={LAKE}.gold.fact").json["data"]}


def test_owners_are_split_across_two_groups(client):
    owners = {t: obj(client, t)["owner"] for t in demo_lake.TABLES}
    assert set(owners.values()) == {"data-engineering", "analytics"}
    assert owners[FACT] == "analytics" and owners[f"{LAKE}.bronze.raw_orders"] == "data-engineering"


def test_the_fact_has_a_composite_key_and_four_references(client):
    info = obj(client, FACT)
    pk = [c["primary_key_constraint"]["child_columns"] for c in info["table_constraints"] if "primary_key_constraint" in c]
    assert pk == [["order_id", "line_no"]]
    fks = {c["foreign_key_constraint"]["parent_table"]: c["foreign_key_constraint"] for c in info["table_constraints"]
           if "foreign_key_constraint" in c}
    assert sorted(fks) == [f"{LAKE}.gold.{d}" for d in ("dim_customer", "dim_date", "dim_product", "dim_store")]
    assert fks[f"{LAKE}.gold.dim_store"]["child_columns"] == ["store_id", "region_code"]
    nullable = {c["name"]: c["nullable"] for c in info["columns"]}
    assert nullable["customer_id"] is True  # guest checkouts
    assert not nullable["sku"] and not nullable["date_key"] and not nullable["store_id"] and not nullable["order_id"]


def test_a_dimension_refers_to_itself(client):
    rel = client.get(f"/api/relations?name={LAKE}.gold.dim_customer").json
    selfs = [e for e in rel["edges"] if e["kind"] == "fk" and e["source"] == e["target"]]
    assert [e["child_columns"] for e in selfs] == [["referred_by_customer_id"]]


def test_views_are_real_sql_and_two_pass_through_views_chain(client):
    for short, text in demo_lake.VIEW_SQL.items():
        assert obj(client, f"{LAKE}.{short}")["view_definition"] == text
        sqlglot.parse_one(text, read="databricks")
    deps = lambda v: [d["table"]["table_full_name"] for d in obj(client, v)["view_dependencies"]["dependencies"]]  # noqa: E731
    assert deps(f"{LAKE}.silver.v_orders_current") == [f"{LAKE}.silver.v_orders"]
    assert deps(f"{LAKE}.silver.v_orders") == [f"{LAKE}.silver.orders"]
    assert "GROUP BY" in obj(client, f"{LAKE}.gold.daily_revenue")["view_definition"]
    metric = obj(client, demo_lake.METRIC_VIEW)
    assert metric["view_definition"].startswith("version: 1.1") and "SUM(net_amount)" in metric["view_definition"]


def test_every_statement_parses_and_reads_the_tables_lineage_says():
    for sh, text in demo_lake.SQL.items():
        node = sqlglot.parse_one(text, read="databricks")
        read = {f"{t.catalog}.{t.db}.{t.name}" for t in node.find_all(sqlglot.exp.Table)} - {f"{LAKE}.{sh}"}
        assert read == {f"{LAKE}.{s}" for s in demo_lake.SOURCES.get(sh, [])}, sh


def test_lineage_has_every_kind_of_writer_and_file_upstreams(client):
    kinds, files = set(), []
    ex = app_module.STATE["ex"]
    for t in demo_lake.TABLES:
        assert client.get("/api/relations", query_string={"name": t}).json["errors"] == []  # file upstreams are tolerated
        for item in ex.lineage(t)["data"]["upstreams"]:
            kinds |= {k for k in ("jobInfos", "notebookInfos", "pipelineInfos") if k in item}
            if "fileInfo" in item:
                files.append((t, item["fileInfo"]))
    assert kinds == {"jobInfos", "notebookInfos", "pipelineInfos"}
    assert len(files) == 8
    assert [i["has_permission"] for t, i in files if t.endswith("raw_returns")] == [False]
    assert all(i["path"].startswith("s3://demo-landing/") for t, i in files if not t.endswith("raw_returns"))
    found = client.get(f"/api/relations?name={FACT}").json["edges"]
    edges = {(e["source"], e["target"]) for e in found if e["kind"] == "lineage"}
    assert edges == {(f"{LAKE}.silver.order_lines", FACT), (f"{LAKE}.silver.v_orders_current", FACT), (FACT, f"{LAKE}.gold.fact_returns")}
    # the materialized view reads the fact in its SQL, so that pair is one view-dependency edge (#19), not a lineage edge
    assert {(e["source"], e["target"]) for e in found if e["kind"] == "view_dep"} == {(FACT, f"{LAKE}.gold.daily_revenue")}
    assert not any(e.get("superseded") for e in found)


def test_one_lake_edge_is_superseded_and_one_neighbor_is_dropped(client):
    superseded, missing = set(), {}
    for t in demo_lake.TABLES:
        got = client.get("/api/relations", query_string={"name": t}).json
        superseded |= {e["id"] for e in got["edges"] if e.get("superseded")}
        missing.update({n["id"]: n["missing_reason"] for n in got["nodes"] if n.get("missing")})
        assert got["errors"] == [], t
    assert superseded == {f"lineage:{LAKE}.silver.orders<->{LAKE}.silver.v_orders_current"}
    assert missing == {f"{LAKE}.silver.sessions_v1": f"table `{LAKE}.silver.sessions_v1` does not exist"}


def test_table_lineage_rows_carry_statement_ids_and_text(client):
    got = sql(client, "SELECT * FROM system.access.table_lineage l JOIN system.query.history h ON l.statement_id = h.statement_id "
                      "WHERE l.target_table_full_name = :t", t=f"{LAKE}.silver.customers")
    rows = got["records"]
    assert {r["entity_type"] for r in rows} == {"NOTEBOOK"} and {r["entity_id"] for r in rows} == {"7001"}
    assert all(r["statement_id"].startswith("demo-lake-") and r["statement_text"].startswith("MERGE INTO") for r in rows)
    assert len(rows) == demo_lake.RUNS
    # a notebook's python and a pipeline wrote their tables with no statement
    for table, entity in ((f"{LAKE}.silver.returns", "NOTEBOOK"), (f"{LAKE}.silver.sessions", "PIPELINE")):
        rows = sql(client, "SELECT * FROM system.access.table_lineage WHERE target_table_full_name = :t", t=table)["records"]
        assert rows and {r["entity_type"] for r in rows} == {entity} and {r["statement_id"] for r in rows} == {None}
    files = sql(client, "SELECT * FROM system.access.table_lineage WHERE target_table_full_name = :t", t=f"{LAKE}.bronze.raw_orders")["records"]
    assert {(r["source_type"], r["source_table_full_name"], r["source_path"]) for r in files} == {("PATH", None, "s3://demo-landing/orders/")}


def test_query_history_by_statement_id_has_the_text_and_mining_never_sees_it(client):
    rows = [r for r in demo_lake.statements() if r["target"] == f"{LAKE}.gold.fact_order_lines"]
    ids = [r["statement_id"] for r in rows]
    got = sql(client, "SELECT statement_id, statement_text FROM system.query.history WHERE statement_id = :sid", sid=ids[-1])["records"]
    assert len(got) == 1 and got[0]["statement_text"].startswith("CREATE OR REPLACE TABLE demo_lake.gold.fact_order_lines")
    many = sql(client, "SELECT * FROM system.query.history WHERE statement_id IN (:a, :b)", a=ids[0], b=ids[1])["records"]
    assert {r["statement_id"] for r in many} == set(ids[:2])
    assert not any(h["statement_id"].startswith("demo-lake-") for h in demo_history.history())
    assert {r["statement_type"] for r in demo_lake.statements()} == {"COPY", "CREATE", "INSERT", "MERGE"}


def test_column_lineage_covers_the_facts_measures_and_the_pii_path(client):
    rows = sql(client, "SELECT * FROM system.access.column_lineage WHERE target_table_full_name = :t OR source_table_full_name = :t",
               t=FACT)["records"]
    into_net = {(r["source_table_full_name"].split(".")[-1], r["source_column_name"]) for r in rows
                if r["target_table_full_name"] == FACT and r["target_column_name"] == "net_amount"}
    assert into_net == {("order_lines", "quantity"), ("order_lines", "unit_price"), ("order_lines", "discount_pct")}
    cols = demo_history.COLUMN_LINEAGE
    assert (f"{LAKE}.bronze.raw_customers", "email", f"{LAKE}.silver.customers", "email") in cols
    assert (f"{LAKE}.silver.customers", "email", f"{LAKE}.gold.dim_customer", "email_domain") in cols
    ex = app_module.STATE["ex"]
    tagged = lambda t: set(ex.tags(t)["data"]["columns"])  # noqa: E731
    assert tagged(f"{LAKE}.bronze.raw_customers") == {"email", "phone"}
    assert tagged(f"{LAKE}.silver.customers") == {"email"}
    assert tagged(f"{LAKE}.gold.dim_customer") == set()  # fed by a PII column, not tagged


def test_history_late_table_and_the_optimize_table():
    def data_writes(table):
        sh = demo_lake.short(table)
        return [ts(h["timestamp"]) for h in demo_lake_sql.history_rows(sh, demo_lake.SPEC[sh])
                if h["operation"] not in ("OPTIMIZE", "VACUUM START", "VACUUM END")]

    now, late = demo_lake.anchor(), []
    for table in (f"{LAKE}.{s}" for s in demo_lake.SPEC):
        writes = sorted(data_writes(table))
        gaps = [(b - a).total_seconds() / 3600 for a, b in zip(writes[-11:], writes[-10:])]
        since = (now - writes[-1]).total_seconds() / 3600
        if since > 2 * statistics.median(gaps) and since > 1:
            late.append(table)
    assert late == [demo_lake.LATE_TABLE]


def test_describe_history_and_detail_through_sql(client):
    hist = sql(client, f"DESCRIBE HISTORY {demo_lake.OPTIMIZE_LAST_TABLE} LIMIT 50")["records"]
    assert 20 <= len(hist) <= 50
    assert hist[0]["operation"] == "OPTIMIZE" and hist[1]["operation"] == "MERGE" and hist[0]["version"] == str(len(hist) - 1)
    merge = json.loads(hist[1]["operationMetrics"])
    assert {"numTargetRowsInserted", "numTargetRowsUpdated", "numTargetRowsDeleted"} <= set(merge) and "numOutputRows" in merge
    assert json.loads(hist[1]["notebook"]) == {"notebookId": "7001"} and hist[1]["job"] is None
    assert "numOutputRows" not in json.loads(hist[0]["operationMetrics"])
    orders = sql(client, f"describe history \x60{LAKE}\x60.\x60silver\x60.\x60orders\x60 limit 2")["records"]
    assert json.loads(orders[0]["operationMetrics"])["numOutputRows"] == "12100000"
    assert json.loads(orders[0]["job"])["jobName"] == "silver_refresh"
    late = sql(client, f"DESCRIBE HISTORY {demo_lake.LATE_TABLE} LIMIT 1")["records"][0]
    assert (demo_lake.anchor() - ts(late["timestamp"])).days == 6
    detail = sql(client, f"DESCRIBE DETAIL {FACT}")["records"]
    assert len(detail) == 1 and detail[0]["format"] == "delta" and json.loads(detail[0]["clusteringColumns"]) == ["date_key"]
    assert int(detail[0]["sizeInBytes"]) > 1_000_000_000 and int(detail[0]["numFiles"]) > 1
    assert "is a view" in sql(client, f"DESCRIBE DETAIL {LAKE}.silver.v_orders")["error"]
    assert "TABLE_OR_VIEW_NOT_FOUND" in sql(client, f"DESCRIBE HISTORY {LAKE}.gold.nope")["error"]
    old = sql(client, "DESCRIBE HISTORY demo.sales.orders LIMIT 3")["records"]
    assert len(old) == 3 and old[0]["operation"] == "WRITE"


def test_row_counts(client):
    assert sql(client, f"SELECT count(*) AS n FROM {LAKE}.silver.orders")["records"] == [{"n": "12100000"}]
    # a select over a lake table returns invented rows with the table's columns
    got = sql(client, f"SELECT sku, list_price FROM {LAKE}.gold.dim_product LIMIT 5")
    assert [c["name"] for c in got["columns"]] == ["sku", "list_price"] and got["row_count"] == 5


PROFILE = """SELECT count(*) AS a_rows, count_if(f.{k} IS NULL) AS a_null_rows, approx_count_distinct(f.{k}) AS a_distinct_keys,
       count(*) FILTER (WHERE p.{k} IS NULL) AS orphan_rows, count(DISTINCT f.{k}) AS orphan_keys
FROM {a} f LEFT ANTI JOIN {b} p ON f.{k} = p.{k}"""


def test_a_profile_statement_gets_orphans_for_one_reference_and_none_for_the_rest(client):
    def profile(a, b, k):
        return sql(client, PROFILE.format(a=f"{LAKE}.gold.{a}", b=f"{LAKE}.gold.{b}", k=k))["records"][0]
    orphans = profile("fact_order_lines", "dim_product", "sku")
    assert (orphans["orphan_rows"], orphans["orphan_keys"], orphans["a_rows"]) == ("223204", "212", "18600000")
    nulls = profile("fact_order_lines", "dim_customer", "customer_id")
    assert nulls["orphan_rows"] == "0" and int(nulls["a_null_rows"]) > 1_000_000
    assert profile("fact_order_lines", "dim_date", "date_key")["orphan_rows"] == "0"
    # a pair with no invented numbers is clean, sized from the tables
    clean = profile("fact_returns", "dim_date", "date_key")
    assert clean["orphan_rows"] == "0" and clean["a_rows"] == "880000"


def test_the_profile_fills_whatever_aliases_the_statement_chose(client):
    got = sql(client, f"SELECT count(*) AS child_rows, 1 AS orphan_distinct_keys, 2 AS unused_keys, 3 AS p95_rows_per_key, 4 AS max_rows_per_key "
                      f"FROM {FACT} c LEFT ANTI JOIN {LAKE}.gold.dim_product pr ON c.sku = pr.sku")["records"][0]
    assert got == {"child_rows": "18600000", "orphan_distinct_keys": "212", "unused_keys": "41",
                   "p95_rows_per_key": "14800", "max_rows_per_key": "91220"}


def test_the_lake_is_deterministic():
    assert demo_lake.statements() == demo_lake.statements()
    assert demo_lake.lineage_rows() == demo_lake.lineage_rows()
    assert [x["statement_id"] for x in demo_lake.statements()][:2] == ["demo-lake-0001", "demo-lake-0002"]
