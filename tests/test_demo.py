"""Demo mode: the fake workspace serves catalogs and runs queries through the real routes."""
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import app as app_module  # noqa: E402
import dbx  # noqa: E402
import demo  # noqa: E402


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setattr(demo, "SLOW_DELAY", 3600)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    c.post("/api/warehouse", json={"id": "demo-wh-1"})
    return c


def test_fake_profile_and_warehouses(client):
    assert [p["name"] for p in client.get("/api/profiles").json["profiles"]] == ["demo"]
    assert client.get("/api/session").json == {"profile": "demo", "warehouse_id": "demo-wh-1"}
    assert [w["name"] for w in client.get("/api/warehouses").json] == ["Demo Serverless", "Demo Pro (stopped)"]


def test_catalogs_schemas_objects_and_columns(client):
    assert [c["name"] for c in client.get("/api/catalogs").json["data"]] == ["demo", "samples"]
    assert [s["name"] for s in client.get("/api/schemas?catalog=demo").json["data"]] == ["hr", "metrics", "sales"]
    objs = client.get("/api/objects?catalog=demo&schema=sales").json["data"]
    assert {o["name"]: o["type"] for o in objs}["v_daily_revenue"] == "VIEW"
    info = client.get("/api/object?name=demo.sales.orders").json["data"]
    assert [c["name"] for c in info["columns"]][:2] == ["order_id", "customer_id"]
    fks = [c["foreign_key_constraint"] for c in info["table_constraints"] if "foreign_key_constraint" in c]
    assert fks[0]["parent_table"] == "demo.sales.customers"


def test_relations_include_fk_and_lineage(client):
    rel = client.get("/api/relations?name=demo.sales.orders").json
    assert sorted(e["kind"] for e in rel["edges"]) == ["fk", "lineage"]
    assert rel["errors"] == []


def test_query_runs_through_the_real_route(client):
    out = client.post("/api/query", json={"sql": "SELECT * FROM demo.sales.orders"}).json
    assert out["row_count"] == 3000 and out["truncated"] is False
    assert [c["type"] for c in out["columns"]][:6] == ["LONG", "LONG", "TIMESTAMP", "DATE", "STRING", "DECIMAL"]
    assert any(None in r for r in out["rows"])  # NULLs exist
    assert any("" in r for r in out["rows"])    # and empty strings, which are different


def test_query_honors_limit(client):
    out = client.post("/api/query", json={"sql": "SELECT * FROM demo.sales.orders LIMIT 7"}).json
    assert out["row_count"] == 7


def test_big_result_is_truncated_at_the_row_cap(client):
    out = client.post("/api/query", json={"sql": "SELECT * FROM demo_big", "max_rows": 5000}).json
    assert out["row_count"] == 5000 and out["truncated"] is True


def test_wide_result_has_sixty_columns(client):
    out = client.post("/api/query", json={"sql": "SELECT * FROM demo_wide"}).json
    assert len(out["columns"]) == 60


def test_error_magic_word_fails_with_a_message(client):
    r = client.post("/api/query", json={"sql": "SELECT * FROM demo_error"})
    assert r.status_code == 500 and "TABLE_OR_VIEW_NOT_FOUND" in r.json["error"]


def test_async_slow_query_can_be_canceled(client):
    sid = client.post("/api/query/async", json={"sql": "SELECT * FROM demo_slow"}).json["statement_id"]
    assert client.get(f"/api/query/{sid}").json["state"] in ("PENDING", "RUNNING")
    client.delete(f"/api/query/{sid}")
    assert client.get(f"/api/query/{sid}").json["state"] == "CANCELED"


def test_async_query_succeeds_with_chunked_rows(client):
    sid = client.post("/api/query/async", json={"sql": "SELECT * FROM demo.sales.orders"}).json["statement_id"]
    st = client.get(f"/api/query/{sid}").json
    assert st["state"] == "SUCCEEDED" and st["row_count"] == 3000


def test_search_uses_the_fake_information_schema(client):
    hits = client.get("/api/search?q=order").json["data"]
    assert {h["full_name"] for h in hits} == {"demo.sales.orders", "demo.sales.order_items"}


def _data_dir_name(tmp_path, **env):
    full = {**os.environ, "EXPLORER_DEMO": "", "EXPLORER_DATA_DIR": "", **env}
    out = subprocess.run([sys.executable, "-c", "import dbx; print(dbx.DATA)"], cwd=ROOT,
                         capture_output=True, text=True, env=full)
    return Path(out.stdout.strip())


def test_data_dir_defaults_and_env_var(tmp_path):
    assert _data_dir_name(tmp_path) == ROOT / "data"
    assert _data_dir_name(tmp_path, EXPLORER_DEMO="1") == ROOT / "data-demo"
    custom = tmp_path / "custom-data"
    assert _data_dir_name(tmp_path, EXPLORER_DATA_DIR=str(custom)) == custom


def test_tag_suggestions_work_in_demo_mode(client, monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    plan = client.get("/api/concepts/suggest/plan").json
    assert "system.information_schema.table_tags" in plan["queries"][0]["sql"]
    run = client.post("/api/concepts/suggest/run").json
    names = sorted(c["name"] for c in run["created"])
    assert names == ["certified", "domain=sales", "environment=sandbox", "pii=email", "pii=name",
                     "sensitivity=confidential"]
    pii = client.get("/api/concepts?q=pii=email").json["concepts"][0]
    assert pii["status"] == "draft" and pii["provenance"]["origin"] == "uc_tag" and pii["link_count"] == 1
    assert len(client.post("/api/concepts/suggest/run").json["updated"]) == 6
