"""Ask routes: /api/ask, /api/ask/poll, /api/ask/result and /api/ask/cancel, through demo mode's fake Genie and a stub that fails."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402
import dbx  # noqa: E402
import demo  # noqa: E402
import genie  # noqa: E402


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path)
    monkeypatch.setattr(demo, "GENIE_STEP_SECONDS", 0)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    monkeypatch.setitem(app_module.STATE, "genie", None)
    c = app_module.app.test_client()
    assert c.post("/api/connect", json={"profile": "demo"}).status_code == 200
    c.post("/api/warehouse", json={"id": "demo-wh-1"})
    return c


def ask(c, question, cid=None):
    body = {"question": question, **({"conversation_id": cid} if cid else {})}
    r = c.post("/api/ask", json=body)
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def poll(c, a):
    r = c.get("/api/ask/poll", query_string={"conversation_id": a["conversation_id"], "response_id": a["response_id"]})
    assert r.status_code == 200, r.get_json()
    return r.get_json()


def test_ask_then_poll_completes_with_sql_and_tables(client):
    a = ask(client, "How many orders are there?")
    assert a["status"] == "in_progress" and a["conversation_id"] and a["response_id"]
    p = poll(client, a)
    assert p["status"] == "completed" and "rows" in p["final_answer"]
    assert [q["sql"] for q in p["query_items"]] == ["SELECT COUNT(*) AS order_count FROM demo.sales.orders"]
    assert [t["name"] for t in p["tables"]] == ["demo.sales.orders"]
    assert p["deep_link"].endswith(a["conversation_id"])


def test_progress_comes_first_when_the_turn_is_slow(client, monkeypatch):
    monkeypatch.setattr(demo, "GENIE_STEP_SECONDS", 3600)
    a = ask(client, "How many orders?")
    p = poll(client, a)
    assert p["status"] == "in_progress" and len(p["progress_steps"]) == 1 and p["final_answer"] is None


def test_result_route_returns_the_query_result_shape(client):
    p = poll(client, a := ask(client, "revenue by status"))
    r = client.get("/api/ask/result", query_string={**a, "item_id": p["query_items"][0]["item_id"]}).get_json()
    assert [c["name"] for c in r["columns"]] == ["status", "revenue"]
    assert r["columns"][1]["type"] == "DECIMAL" and r["row_count"] == 3 and r["rows"][0][0] == "shipped"
    assert r["truncated"] is False and r["ready"] is True


def test_follow_up_stays_in_the_conversation(client):
    a = ask(client, "How many orders?")
    b = ask(client, "And revenue?", a["conversation_id"])
    assert b["conversation_id"] == a["conversation_id"] and b["response_id"] != a["response_id"]
    assert [t["name"] for t in poll(client, b)["tables"]] == ["demo.sales.v_daily_revenue", "demo.sales.orders"]
    assert app_module.STATE["genie"][1].turns[b["response_id"]]["plan"]["steps"][0].startswith("Thinking: continuing")


def test_the_simulated_failure(client):
    p = poll(client, ask(client, "please fail"))
    assert p["status"] == "failed" and p["error"] and p["final_answer"] is None and p["query_items"] == []


def test_cancel_ends_the_turn(client, monkeypatch):
    monkeypatch.setattr(demo, "SLOW_DELAY", 3600)
    a = ask(client, "demo_slow question")
    assert poll(client, a)["status"] == "in_progress"
    r = client.post("/api/ask/cancel", json={"conversation_id": a["conversation_id"]})
    assert r.status_code == 200 and r.get_json()["cancel_requested"] is True
    assert poll(client, a)["status"] == "incomplete"


def test_bad_requests_are_400(client):
    assert client.post("/api/ask", json={"question": ""}).status_code == 400
    assert client.post("/api/ask", json=["x"]).status_code == 400
    assert client.get("/api/ask/poll?conversation_id=c").status_code == 400
    assert client.get("/api/ask/result?conversation_id=c&response_id=r").status_code == 400
    assert client.post("/api/ask/cancel", json={}).status_code == 400
    assert client.post("/api/ask/cancel", data="[", content_type="application/json").status_code == 400


def test_unknown_ids_are_an_error_with_a_message(client):
    r = client.get("/api/ask/poll", query_string={"conversation_id": "nope", "response_id": "nope"})
    assert r.status_code == 502 and "Unknown" in r.get_json()["error"]


def test_the_warehouse_follows_the_session(client):
    ask(client, "q")
    assert app_module.STATE["genie"][1].warehouse_id == "demo-wh-1"
    client.post("/api/warehouse", json={"id": "demo-wh-2"})
    ask(client, "q")
    assert app_module.STATE["genie"][1].warehouse_id == "demo-wh-2"


def test_not_connected_is_the_usual_500(monkeypatch):
    monkeypatch.setitem(app_module.STATE, "ex", None)
    r = app_module.app.test_client().post("/api/ask", json={"question": "q"})
    assert r.status_code == 500 and "Not connected" in r.get_json()["error"]


class Refusing:
    warehouse_id = None

    def __init__(self, error):
        self.error = error

    def ask(self, *a):
        raise self.error


def test_genie_errors_keep_their_status_and_scrub_the_config_dump(client, monkeypatch):
    msg = "Genie One refused the request. Config: host=https://h, profile=p, token=zzz"
    stub = Refusing(genie.GenieError(msg, 403))
    monkeypatch.setitem(app_module.STATE, "genie", (app_module.STATE["ex"], stub))
    r = client.post("/api/ask", json={"question": "q"})
    assert r.status_code == 403
    assert r.get_json()["error"] == "Genie One refused the request."
    stub.error = genie.GenieError("The Genie One MCP server did not answer in time.", 502)
    assert client.post("/api/ask", json={"question": "q"}).status_code == 502


def test_nothing_about_the_question_or_answer_is_logged(client, tmp_path):
    a = ask(client, "a very identifiable question about orders")
    poll(client, a)
    log = (tmp_path / "calls.jsonl").read_text(encoding="utf-8")
    ops = [json.loads(line)["op"] for line in log.splitlines()]
    assert "genie.ask" in ops and "genie.poll" in ops
    assert "identifiable" not in log and "One row per order" not in log


def test_the_real_client_is_used_outside_demo_mode(monkeypatch):
    class Ex:
        w = object()
        warehouse_id = "wh7"

    monkeypatch.setattr(dbx, "DEMO", False)
    monkeypatch.setitem(app_module.STATE, "ex", Ex())
    monkeypatch.setitem(app_module.STATE, "genie", None)
    g = app_module.genie_client()
    assert isinstance(g, genie.GenieClient) and g.warehouse_id == "wh7" and g.w is Ex.w
    assert app_module.genie_client() is g
