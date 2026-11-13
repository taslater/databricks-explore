"""Mining and column-lineage routes, end to end through demo mode (fake workspace, no Databricks)."""
import time

import pytest

import app as app_module
import dbx
import demo
import demo_history


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    monkeypatch.setitem(app_module.STATE, "miner", None)
    monkeypatch.delenv("EXPLORER_DEMO_REDACTED", raising=False)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    c.post("/api/warehouse", json={"id": "demo-wh-1"})
    return c


def wait(client, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        s = client.get("/api/mining/status").json
        if s["state"] != "running":
            return s
        time.sleep(0.05)
    raise AssertionError("mining did not finish")


def mined(client, **body):
    assert client.post("/api/mining/runs", json=body).status_code == 202
    return wait(client)


def suggestions(client, **q):
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    return client.get(f"/api/relationships/suggestions?{qs}").json


# ---------- the demo history itself ----------

def test_demo_history_is_a_few_hundred_statements_by_several_users_with_the_hard_cases():
    rows = demo_history.history()
    assert 300 <= len(rows) <= 700 and len({r["executed_by"] for r in rows}) >= 5
    texts = " ".join(r["statement_text"] for r in rows)
    assert " USING (" in texts and "WITH recent AS" in texts and "orders o, demo.sales.returns r" in texts
    assert sum(1 for r in rows if r.get("redacted")) == 3
    assert [r["start_time"] for r in rows] == sorted(r["start_time"] for r in rows)


# ---------- plan ----------

def test_plan_shows_the_sql_and_the_window_and_runs_nothing(client):
    p = client.get("/api/mining/plan?window_days=7").json
    assert p["window_days"] == 7 and p["warehouse_id"] == "demo-wh-1" and p["incremental"] is False
    assert [q["name"] for q in p["queries"]] == ["query_history", "table_lineage"]
    assert "system.query.history" in p["queries"][0]["sql"] and p["queries"][0]["params"]["since"] == p["since"]
    assert client.get("/api/mining/status").json["state"] == "idle"
    assert suggestions(client)["edges"] == []


def test_plan_rejects_a_bad_window(client):
    for q in ("window_days=0", "window_days=abc", "window_days=999", "window_days=-3"):
        r = client.get(f"/api/mining/plan?{q}")
        assert r.status_code == 400 and "window_days" in r.json["error"]


# ---------- a run ----------

def test_a_run_proposes_joins_skips_the_declared_fk_and_reports_counts(client):
    s = mined(client, window_days=30)
    r = s["result"]
    assert s["state"] == "succeeded" and r["skipped_fk"] >= 1 and r["unparsed"] >= 3 and r["redacted_skipped"] >= 1
    assert r["with_joins"] > 100 and r["created"] == r["pairs"] and r["updated"] == 0
    got = suggestions(client)
    pairs = {(e["source"]["table"], e["source"]["column"], e["target"]["table"], e["target"]["column"]) for e in got["edges"]}
    assert ("demo.sales.order_items", "sku", "demo.sales.products", "sku") in pairs
    assert ("demo.hr.departments", "dept", "demo.hr.employees", "dept") in pairs
    assert ("demo.sales.customers", "customer_id", "demo.sales.orders", "customer_id") not in pairs  # a declared FK
    assert not any("system" in e["source"]["table"] for e in got["edges"])
    runs = [e["evidence"]["runs"] for e in got["edges"]]
    assert runs == sorted(runs, reverse=True) and got["counts"]["proposed"] == len(got["edges"])
    assert all(e["status"] == "proposed" and e["directed"] is False for e in got["edges"])
    assert all(len(e["evidence"]["sample_refs"]) <= 5 for e in got["edges"])


def test_a_second_run_is_incremental_and_adds_nothing_when_nothing_is_new(client):
    first = mined(client)["result"]
    plan = client.get("/api/mining/plan").json
    assert plan["incremental"] is True and plan["cursor"] == first["until"]
    before = {e["id"]: e["evidence"]["runs"] for e in suggestions(client)["edges"]}
    second = mined(client)["result"]
    assert second["statements"] == 0 and second["created"] == 0
    assert {e["id"]: e["evidence"]["runs"] for e in suggestions(client)["edges"]} == before


def test_a_full_remine_gives_the_same_counts_not_double(client):
    mined(client)
    before = {e["id"]: e["evidence"]["runs"] for e in suggestions(client)["edges"]}
    mined(client, full=True)
    assert {e["id"]: e["evidence"]["runs"] for e in suggestions(client)["edges"]} == before


def test_start_needs_a_warehouse_and_a_valid_window(client):
    r = client.post("/api/mining/runs", json={"window_days": 0})
    assert r.status_code == 400 and "window_days" in r.json["error"]
    assert client.post("/api/mining/runs", json=[1]).status_code == 400
    client.post("/api/warehouse", json={"id": ""})
    r = client.post("/api/mining/runs", json={})
    assert r.status_code == 400 and "warehouse" in r.json["error"]


def test_start_while_running_is_409(client, monkeypatch):
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0.4)
    assert client.post("/api/mining/runs", json={}).status_code == 202
    assert client.get("/api/mining/status").json["state"] == "running"
    r = client.post("/api/mining/runs", json={})
    assert r.status_code == 409
    assert wait(client)["state"] == "succeeded"


def test_status_reports_progress_while_running(client, monkeypatch):
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0.3)
    client.post("/api/mining/runs", json={})
    s = client.get("/api/mining/status").json
    assert s["state"] == "running" and s["phase"] in ("history", "lineage") and s["plan"]["window_days"] == 30
    wait(client)


def test_redacted_text_blocks_the_run_with_a_clear_message(client, monkeypatch):
    monkeypatch.setenv("EXPLORER_DEMO_REDACTED", "1")
    s = mined(client)
    assert s["state"] == "blocked" and s["reason"] == "redacted" and "databricks_pii_access" in s["error"]
    assert suggestions(client)["edges"] == []
    assert client.get("/api/mining/plan").json["incremental"] is False  # the cursor did not move


# ---------- usage ----------

def test_usage_lists_top_tables_and_pairs_for_the_window(client):
    mined(client)
    u = client.get("/api/mining/usage?limit=3").json
    assert u["window"]["since"] < u["window"]["until"] and u["statements"] > 100
    assert len(u["tables"]) == 3 and u["tables"][0]["table"] == "demo.sales.orders"
    assert all(set(t) == {"table", "runs", "users"} for t in u["tables"])
    assert u["pairs"][0]["tables"] == ["demo.sales.customers", "demo.sales.orders"]
    assert not any("example.invalid" in str(v) for v in u.values())


def test_usage_before_any_run_is_empty_and_limit_is_validated(client):
    assert client.get("/api/mining/usage").json == {"window": None, "statements": 0, "tables": [], "pairs": []}
    for q in ("limit=0", "limit=x", "limit=101"):
        assert client.get(f"/api/mining/usage?{q}").status_code == 400


# ---------- reviewing suggestions ----------

def test_bulk_accept_and_reject(client):
    mined(client)
    edges = suggestions(client)["edges"]
    top, rest = [e["id"] for e in edges[:2]], [e["id"] for e in edges[2:4]]
    assert client.post("/api/relationships/bulk", json={"ids": top, "status": "accepted"}).json == {"updated": 2}
    assert client.post("/api/relationships/bulk", json={"ids": rest, "status": "rejected"}).json == {"updated": 2}
    got = suggestions(client, status="proposed")
    assert got["counts"] == {"proposed": len(edges) - 4, "accepted": 2, "rejected": 2}
    assert {e["id"] for e in suggestions(client, status="accepted")["edges"]} == set(top)
    # status survives another mining run
    mined(client, full=True)
    assert {e["id"] for e in suggestions(client, status="accepted")["edges"]} == set(top)


def test_bulk_errors(client):
    assert client.post("/api/relationships/bulk", json={"ids": ["e_nope"], "status": "accepted"}).status_code == 404
    assert client.post("/api/relationships/bulk", json={"ids": ["fk:a->b"], "status": "accepted"}).status_code == 400
    assert client.post("/api/relationships/bulk", json={"ids": [], "status": "accepted"}).status_code == 400
    assert client.get("/api/relationships/suggestions?status=derived").status_code == 400


# ---------- column level ----------

def column_edges(client, table, **q):
    qs = "&".join(f"{k}={v}" for k, v in q.items())
    return client.get(f"/api/relationships?table={table}&level=column&{qs}").json


def test_column_level_returns_column_lineage_and_stored_column_edges(client):
    mined(client)
    out = column_edges(client, "demo.sales.orders")
    lineage = [e for e in out["edges"] if e["kind"] == "lineage" and e["source"]["column"]]
    assert {(e["source"]["column"], e["target"]["column"]) for e in lineage} == {
        ("order_date", "order_date"), ("amount", "revenue"), ("order_id", "orders")}
    assert all(e["status"] == "derived" and e["provenance"]["origin"] == "unity_catalog:column_lineage" for e in lineage)
    joins = [e for e in out["edges"] if e["kind"] == "join_mined"]
    assert joins and all(e["source"]["column"] and e["target"]["column"] for e in joins)
    fks = [e for e in out["edges"] if e["kind"] == "fk"]
    assert {(e["source"]["column"], e["target"]["column"]) for e in fks} == {("customer_id", "customer_id")}
    assert out["errors"] == []


def test_table_level_is_unchanged_by_column_lineage(client):
    out = client.get("/api/relationships?table=demo.sales.orders").json
    assert not any(e["provenance"]["origin"].endswith("column_lineage") for e in out["edges"])


def test_column_level_without_a_warehouse_says_so_and_the_rest_still_loads(client):
    client.post("/api/warehouse", json={"id": ""})
    out = column_edges(client, "demo.sales.orders")
    assert any(e["kind"] == "fk" for e in out["edges"])
    assert len(out["errors"]) == 1 and out["errors"][0].startswith("column_lineage:") and "warehouse" in out["errors"][0]


def test_cached_column_lineage_is_used_without_a_warehouse(client):
    assert any(e["source"]["column"] for e in column_edges(client, "demo.sales.orders")["edges"] if e["kind"] == "lineage")
    client.post("/api/warehouse", json={"id": ""})
    out = column_edges(client, "demo.sales.orders")
    assert out["errors"] == [] and any(e["kind"] == "lineage" and e["source"]["column"] for e in out["edges"])


def test_column_lineage_access_error_is_reported_not_raised(client, monkeypatch):
    monkeypatch.setattr(demo_history, "COLUMN_LINEAGE", [])
    out = column_edges(client, "demo.sales.v_daily_revenue")
    assert out["errors"] == [] and not any(e["source"]["column"] for e in out["edges"] if e["kind"] == "lineage")

    def deny(*a, **k):
        raise RuntimeError("[INSUFFICIENT_PERMISSIONS] no SELECT on system.access.column_lineage")
    monkeypatch.setattr(app_module.STATE["ex"], "sql", deny)
    out = column_edges(client, "demo.sales.orders", refresh=1)
    assert "INSUFFICIENT_PERMISSIONS" in out["errors"][0] and out["edges"]


def test_column_lineage_is_one_cached_query_and_refresh_rereads_it(client):
    def reads():
        log = (dbx.LOGS / "calls.jsonl").read_text()
        return log.count("system.access.column_lineage")
    column_edges(client, "demo.sales.orders")
    assert reads() == 1
    column_edges(client, "demo.sales.orders")
    assert reads() == 1
    column_edges(client, "demo.sales.orders", refresh=1)
    assert reads() == 2


def test_a_bad_level_is_400(client):
    assert client.get("/api/relationships?table=demo.sales.orders&level=nope").status_code == 400


def test_system_tables_in_demo_filter_like_the_real_ones(client):
    ex = app_module.STATE["ex"]
    sql = "SELECT * FROM system.query.history WHERE start_time >= CAST(:since AS TIMESTAMP) AND start_time < CAST(:until AS TIMESTAMP) "
    sql += "AND execution_status = 'FINISHED' AND statement_type IN ('SELECT') LIMIT 7"
    got = ex.query(sql, {"since": "2000-01-01T00:00:00Z", "until": "2999-01-01T00:00:00Z"}, max_rows=100)
    assert len(got["rows"]) == 7
    none = ex.query(sql, {"since": "2000-01-01T00:00:00Z", "until": "2000-01-02T00:00:00Z"}, max_rows=100)
    assert none["rows"] == []
