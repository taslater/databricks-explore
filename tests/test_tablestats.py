"""Size and freshness: the write filter, cadence and lateness, the row-count fallbacks, and the routes through demo mode."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from databricks_explore import app as app_module
from databricks_explore import dbx
from databricks_explore import demo
from databricks_explore import tablestats as ts

NOW = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)


def entry(hours_ago, op="WRITE", rows=None, mode=None, **extra):
    at = (NOW - timedelta(hours=hours_ago)).isoformat()
    return {"timestamp": at, "operation": op, "userName": "u", "operationMetrics": json.dumps({"numOutputRows": str(rows)} if rows is not None else {}),
            "operationParameters": json.dumps({"mode": mode} if mode else {}), **extra}


def test_only_data_changes_are_writes():
    history = [entry(1, "OPTIMIZE"), entry(2, "VACUUM END"), entry(3, "SET TBLPROPERTIES"), entry(4, "SET TAG"), entry(5, "MERGE"),
               entry(6, "WRITE"), entry(7, "UPDATE"), entry(8, "DELETE"), entry(9, "STREAMING UPDATE"), entry(10, "COPY INTO"),
               entry(11, "CREATE OR REPLACE TABLE AS SELECT"), entry(12, "CREATE TABLE AS SELECT"), entry(13, "REPLACE TABLE AS SELECT"),
               entry(14, "TRUNCATE"), entry(15, "CREATE TABLE"), entry(16, "RESTORE")]
    assert [w["operation"] for w in ts.data_writes(history)] == [
        "MERGE", "WRITE", "UPDATE", "DELETE", "STREAMING UPDATE", "COPY INTO", "CREATE OR REPLACE TABLE AS SELECT",
        "CREATE TABLE AS SELECT", "REPLACE TABLE AS SELECT", "TRUNCATE"]


def test_a_write_keeps_who_wrote_it_and_what_it_replaced():
    h = entry(2, "WRITE", rows=500, mode="Overwrite", job=json.dumps({"jobId": "7", "jobName": "nightly"}), notebook=None)
    (w,) = ts.data_writes([h])
    assert (w["rows"], w["replaces"], w["job"], w["job_id"], w["notebook"], w["user"]) == (500, True, "nightly", "7", None, "u")
    (a,) = ts.data_writes([entry(2, "WRITE", rows=5, mode="Append", notebook=json.dumps({"notebookId": "9"}))])
    assert (a["replaces"], a["notebook"]) == (False, "9")


def test_a_job_write_without_a_job_name_is_named_by_its_id():
    # as DESCRIBE HISTORY returned it live for a notebook task of a job: jobName and triggerType are null
    live = json.dumps({"jobName": None, "jobOwnerId": None, "workspaceId": "7474647601842271", "jobId": "1096488465001547",
                       "jobRunId": "536826605476176", "runId": "83314497053508", "triggerType": None})
    (w,) = ts.data_writes([entry(1, "WRITE", rows=1, mode="Append", job=live)])
    assert (w["job"], w["job_id"]) == ("1096488465001547", "1096488465001547")


def writes_every(hours, count, last_hours_ago, op="WRITE"):
    return ts.data_writes([entry(last_hours_ago + i * hours, op) for i in range(count)])


def test_cadence_is_the_median_gap_of_the_latest_writes():
    assert ts.cadence_seconds(writes_every(24, 10, 3)) == 24 * 3600
    uneven = ts.data_writes([entry(h) for h in (1, 2, 3, 30, 31, 32, 33)])  # gaps 1,1,27,1,1,1: the median is 1 hour
    assert ts.cadence_seconds(uneven) == 3600
    assert ts.cadence_seconds(writes_every(24, 2, 3)) is None  # two writes are one gap: no rhythm yet
    old = ts.data_writes([entry(1 + i) for i in range(10)] + [entry(500 + 100 * i) for i in range(5)])
    assert ts.cadence_seconds(old) == 3600  # only the latest 10 count


def test_late_means_over_twice_the_cadence_and_over_an_hour():
    day = 24 * 3600
    assert not ts.is_late(2 * day, day) and ts.is_late(2 * day + 1, day)
    assert not ts.is_late(1800, 60)  # twice a one-minute cadence, but under an hour
    assert ts.is_late(3601, 60)
    assert not ts.is_late(10 * day, None)  # no cadence, no lateness


def test_rows_come_from_the_latest_write_that_replaced_the_table_when_nothing_changed_it_since():
    replace = ts.data_writes([entry(1, "CREATE OR REPLACE TABLE AS SELECT", rows=900), entry(25, "CREATE OR REPLACE TABLE AS SELECT", rows=800)])
    assert ts.row_count(replace) == 900
    overwrite = ts.data_writes([entry(1, "WRITE", rows=70, mode="Overwrite")])
    assert ts.row_count(overwrite) == 70
    complete = ts.data_writes([{**entry(1, "STREAMING UPDATE", rows=3), "operationParameters": json.dumps({"outputMode": "Complete"})}])
    assert ts.row_count(complete) == 3
    appended_since = ts.data_writes([entry(1, "MERGE", rows=40), entry(25, "CREATE TABLE AS SELECT", rows=900)])
    assert ts.row_count(appended_since) is None
    assert ts.row_count(ts.data_writes([entry(1, "WRITE", rows=5, mode="Append")])) is None
    assert ts.row_count([]) is None
    assert ts.row_count(ts.data_writes([entry(1, "CREATE TABLE AS SELECT")])) is None  # no numOutputRows


def cached(history, size=1000):
    return {"fetched_at": "2026-11-18T11:00:00+00:00", "data": {"bytes": size, "files": 2, "clustering": ["a"], "partitioning": [],
                                                                  "writes": ts.data_writes(history), "history_error": None}}


def test_summarize_does_not_count_an_optimize_as_a_fresh_write():
    # a table written daily whose last commit is an OPTIMIZE 2 hours ago: its last write is still 60 hours old, so it is late
    history = [entry(2, "OPTIMIZE")] + [entry(60 + 24 * i, "MERGE", rows=10) for i in range(8)]
    s = ts.summarize(cached(history), NOW)
    assert s["late"] is True and s["last_write"]["operation"] == "MERGE" and s["last_write"]["at"] == (NOW - timedelta(hours=60)).isoformat(timespec="seconds")
    on_time = ts.summarize(cached([entry(2, "OPTIMIZE")] + [entry(5 + 24 * i, "MERGE", rows=10) for i in range(8)]), NOW)
    assert on_time["late"] is False and on_time["cadence_seconds"] == 24 * 3600
    assert len(on_time["writes"]) == 8 and on_time["writes"][-1]["at"] > on_time["writes"][0]["at"]  # oldest first, for the strip


def test_summarize_with_no_writes_says_nothing_is_late():
    s = ts.summarize(cached([entry(1, "OPTIMIZE")]), NOW)
    assert (s["late"], s["last_write"], s["rows"], s["cadence_seconds"]) == (False, None, None, None) and s["bytes"] == 1000


def test_skip_reasons():
    assert ts.skip_reason({"table_type": "MANAGED", "data_source_format": "DELTA"}) is None
    # live on dbx-free: DESCRIBE DETAIL on a materialized view fails with EXPECT_TABLE_NOT_VIEW; a streaming table reads fine
    assert "materialized" in ts.skip_reason({"table_type": "MATERIALIZED_VIEW"})
    assert ts.skip_reason({"table_type": "STREAMING_TABLE"}) is None
    assert "view" in ts.skip_reason({"table_type": "VIEW"})
    assert "metric" in ts.skip_reason({"table_type": "METRIC_VIEW"})
    assert "not a Delta" in ts.skip_reason({"table_type": "EXTERNAL", "data_source_format": "CSV"})


def test_the_statements_quote_each_name_part_and_cap_the_history():
    d, h = ts.statements("demo_lake.silver.orders")
    assert d["sql"] == "DESCRIBE DETAIL `demo_lake`.`silver`.`orders`"
    assert h["sql"] == "DESCRIBE HISTORY `demo_lake`.`silver`.`orders` LIMIT 50"


def test_the_history_failing_keeps_the_size():
    def sql(statement):
        if "HISTORY" in statement:
            raise RuntimeError("no access to history")
        return [{"sizeInBytes": "2048", "numFiles": "3", "clusteringColumns": '["a"]', "partitionColumns": "[]"}]
    data = ts.read(sql, "c.s.t")
    assert (data["bytes"], data["files"], data["clustering"], data["writes"]) == (2048, 3, ["a"], []) and "no access" in data["history_error"]
    with pytest.raises(RuntimeError):
        ts.read(lambda s: (_ for _ in ()).throw(RuntimeError("nope")), "c.s.t")


# ---------- through demo mode ----------

LAKE = "demo_lake"


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    return c


def facts(client, *tables):
    return client.post("/api/node-facts", json={"tables": [f"{LAKE}.{t}" for t in tables]}).get_json()["facts"]


def test_the_grain_of_the_demo_lake_comes_from_keys_and_definitions(client):
    f = facts(client, "silver.orders", "silver.order_lines", "gold.daily_revenue", "gold.revenue_metrics", "bronze.raw_orders", "silver.v_orders")
    label = lambda t: (f[f"{LAKE}.{t}"]["grain"] or {}).get("label")
    assert label("silver.orders") == "per order_id" and label("silver.order_lines") == "per order_id × line_no"
    assert label("gold.daily_revenue") == "per order_date × store_id"
    assert f[f"{LAKE}.gold.daily_revenue"]["grain"]["basis"] == "group_by"
    assert label("gold.revenue_metrics") is None and label("bronze.raw_orders") is None and label("silver.v_orders") is None


def test_facts_never_query_and_leave_placeholders_out(client):
    out = client.post("/api/node-facts", json={"tables": ["ph:new", f"{LAKE}.silver.orders", "not.enough"]}).get_json()["facts"]
    assert list(out) == [f"{LAKE}.silver.orders"] and out[f"{LAKE}.silver.orders"]["stats"] is None
    assert client.post("/api/node-facts", json={"tables": "x"}).status_code == 400


def test_the_plan_lists_the_statements_and_skips_views(client):
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    names = [f"{LAKE}.{t}" for t in ("silver.orders", "silver.v_orders", "gold.revenue_metrics", "gold.daily_revenue")]
    plan = client.post("/api/table-stats/plan", json={"tables": names}).get_json()
    assert [s["sql"] for s in plan["statements"] if s["name"] == "history"] == [f"DESCRIBE HISTORY `{LAKE}`.`silver`.`orders` LIMIT 50"]
    # daily_revenue is a materialized view: live, DESCRIBE DETAIL on one fails with EXPECT_TABLE_NOT_VIEW
    assert {s["table"] for s in plan["skipped"]} == {f"{LAKE}.silver.v_orders", f"{LAKE}.gold.revenue_metrics", f"{LAKE}.gold.daily_revenue"}


def test_reading_needs_a_warehouse_then_caches_and_the_demo_has_one_late_table(client):
    names = [f"{LAKE}.{t}" for t in ("silver.shipments", "silver.customers", "silver.orders", "silver.v_orders")]
    assert client.post("/api/table-stats/read", json={"tables": names}).status_code == 400
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    out = client.post("/api/table-stats/read", json={"tables": names}).get_json()
    assert out["errors"] == {} and [s["table"] for s in out["skipped"]] == [f"{LAKE}.silver.v_orders"]
    stats = {t: f["stats"] for t, f in out["facts"].items()}
    assert [t for t, s in stats.items() if s["late"]] == [f"{LAKE}.silver.shipments"]
    customers = stats[f"{LAKE}.silver.customers"]  # its latest commit is an OPTIMIZE, which is not a write
    assert customers["last_write"]["operation"] != "OPTIMIZE" and not customers["late"]
    orders = stats[f"{LAKE}.silver.orders"]
    assert orders["rows"] == 12_100_000 and orders["bytes"] > 0 and abs(orders["cadence_seconds"] - 24 * 3600) < 3600
    assert stats[f"{LAKE}.silver.customers"]["rows"] is None  # merged into: the rows are not in any write
    # the cache answers without a warehouse, with its date
    client.post("/api/warehouse", json={"id": None})
    again = facts(client, "silver.shipments")[f"{LAKE}.silver.shipments"]["stats"]
    assert again["late"] is True and again["fetched_at"]


def test_a_table_that_cannot_be_read_is_skipped_with_the_reason_and_a_failing_statement_is_reported(client, monkeypatch):
    client.post("/api/warehouse", json={"id": "demo-wh-1"})
    out = client.post("/api/table-stats/read", json={"tables": [f"{LAKE}.silver.orders", f"{LAKE}.silver.no_such_table"]}).get_json()
    assert list(out["facts"]) == [f"{LAKE}.silver.orders"]
    assert [s["table"] for s in out["skipped"]] == [f"{LAKE}.silver.no_such_table"] and "cannot read" in out["skipped"][0]["reason"]
    monkeypatch.setattr(dbx.Explorer, "sql", lambda self, statement, **p: (_ for _ in ()).throw(RuntimeError("PERMISSION_DENIED")))
    bad = client.post("/api/table-stats/read", json={"tables": [f"{LAKE}.silver.products"]}).get_json()
    assert "PERMISSION_DENIED" in bad["errors"][f"{LAKE}.silver.products"] and bad["facts"][f"{LAKE}.silver.products"]["stats"] is None
