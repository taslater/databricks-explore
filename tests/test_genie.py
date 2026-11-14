"""genie.py: the MCP client against a fake HTTP layer, and the response shaping. No network."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import genie  # noqa: E402

HOST = "https://ws.example.invalid"


def rpc(result=None, error=None, rid=1):
    msg = {"jsonrpc": "2.0", "id": rid}
    msg.update({"error": error} if error else {"result": result})
    return json.dumps(msg)


def tool_result(sc, is_error=False):
    return {"content": [{"type": "text", "text": json.dumps(sc)}], "isError": is_error, "structuredContent": sc}


class FakeHttp:
    """Scripted server. `handler(body, headers)` returns (status, headers, text); every request is recorded."""

    def __init__(self, handler=None):
        self.sent = []
        self.handler = handler or self.default

    def __call__(self, url, headers, body, timeout):
        self.sent.append({"url": url, "headers": headers, "body": body, "timeout": timeout})
        return self.handler(body, headers)

    def default(self, body, headers):
        method = body.get("method")
        if method == "initialize":
            return 200, {"mcp-session-id": "sess-1"}, rpc({"protocolVersion": genie.PROTOCOL}, rid=body["id"])
        if method == "notifications/initialized":
            return 202, {}, ""
        name = body["params"]["name"]
        return 200, {}, rpc(tool_result({"tool": name, **body["params"]["arguments"]}), rid=body["id"])

    def methods(self):
        return [s["body"].get("method") for s in self.sent]


def client(http, warehouse_id="wh1"):
    w = SimpleNamespace(config=SimpleNamespace(host=HOST + "/", authenticate=lambda: {"Authorization": "Bearer t0k"}),
                        get_workspace_id=lambda: 42)
    return genie.GenieClient(w, warehouse_id=warehouse_id, post=http)


def session_handler(on_call):
    """A server that handles initialize and the initialized notification, and sends every tool call to on_call(body, headers)."""
    def handler(body, headers):
        if body.get("method") == "initialize":
            return 200, {"mcp-session-id": "s"}, rpc({}, rid=body["id"])
        if body.get("method") == "notifications/initialized":
            return 202, {}, ""
        return on_call(body, headers)
    return handler


# ---------------------------------------------------------------- protocol

def test_first_call_initializes_then_reuses_the_session():
    http = FakeHttp()
    c = client(http)
    c.ask("how many?")
    c.poll("c1", "r1")
    assert http.methods() == ["initialize", "notifications/initialized", "tools/call", "tools/call"]
    assert http.sent[0]["url"] == f"{HOST}{genie.SERVER_PATH}?o=42"
    assert "Mcp-Session-Id" not in http.sent[0]["headers"]
    for s in http.sent[1:]:
        assert s["headers"]["Mcp-Session-Id"] == "sess-1"
        assert s["headers"]["Authorization"] == "Bearer t0k"
        assert s["headers"]["MCP-Protocol-Version"] == genie.PROTOCOL
        assert s["timeout"] == genie.TIMEOUT


def test_ask_sends_question_conversation_and_warehouse_meta():
    http = FakeHttp()
    c = client(http)
    c.ask("q one")
    c.ask("q two", "conv-9")
    first, second = [s["body"]["params"] for s in http.sent if s["body"].get("method") == "tools/call"]
    assert first == {"name": "genie_ask", "arguments": {"question": "q one"}, "_meta": {"warehouse_id": "wh1"}}
    assert second["arguments"] == {"question": "q two", "conversation_id": "conv-9"}


def test_no_meta_without_a_warehouse():
    http = FakeHttp()
    client(http, warehouse_id=None).ask("q")
    assert "_meta" not in http.sent[-1]["body"]["params"]


def test_the_other_tools_use_their_own_names_and_arguments():
    http = FakeHttp()
    c = client(http)
    c.poll("c1", "r1")
    c.query_result("c1", "r1", "item-1")
    assert c.cancel("c1") == {"conversation_id": "c1", "cancel_requested": True}
    calls = [s["body"]["params"] for s in http.sent if s["body"].get("method") == "tools/call"]
    assert [(p["name"], p["arguments"]) for p in calls] == [
        ("genie_poll_response", {"conversation_id": "c1", "response_id": "r1"}),
        ("genie_get_query_result", {"conversation_id": "c1", "response_id": "r1", "item_id": "item-1"}),
        ("genie_cancel_response", {"conversation_id": "c1"})]


def test_session_expiry_reinitializes_and_retries_once():
    state = {"inits": 0}

    def handler(body, headers):
        if body.get("method") == "initialize":
            state["inits"] += 1
            return 200, {"mcp-session-id": f"sess-{state['inits']}"}, rpc({}, rid=body["id"])
        if body.get("method") == "notifications/initialized":
            return 202, {}, ""
        if headers.get("Mcp-Session-Id") == "sess-1":
            return 404, {}, "session not found"
        return 200, {}, rpc(tool_result({"status": "in_progress", "conversation_id": "c", "response_id": "r"}), rid=body["id"])

    http = FakeHttp(handler)
    out = client(http).ask("q")
    assert out["status"] == "in_progress" and state["inits"] == 2
    assert http.sent[-1]["headers"]["Mcp-Session-Id"] == "sess-2"


def test_a_session_error_inside_json_rpc_also_reinitializes():
    state = {"calls": 0}

    def on_call(body, headers):
        state["calls"] += 1
        if state["calls"] == 1:
            return 200, {}, rpc(error={"code": -32001, "message": "Session expired"}, rid=body["id"])
        return 200, {}, rpc(tool_result({"status": "completed"}), rid=body["id"])

    http = FakeHttp(session_handler(on_call))
    assert client(http).poll("c", "r")["status"] == "completed"
    assert http.methods().count("initialize") == 2


def test_a_session_that_keeps_expiring_gives_up_after_one_retry():
    http = FakeHttp(session_handler(lambda body, headers: (404, {}, "")))
    with pytest.raises(genie.GenieError, match="lost the session"):
        client(http).ask("q")
    assert http.methods().count("initialize") == 2


def test_event_stream_replies_are_read():
    def on_call(body, headers):
        sc = {"status": "completed", "conversation_id": "c", "response_id": "r", "final_answer": "hi"}
        return 200, {}, "event: message\ndata: " + rpc(tool_result(sc), rid=body["id"]) + "\n\n"

    assert client(FakeHttp(session_handler(on_call))).poll("c", "r")["final_answer"] == "hi"


def test_a_reply_with_only_text_content_is_parsed_as_json():
    def on_call(body, headers):
        text = json.dumps({"status": "in_progress", "conversation_id": "c", "response_id": "r"})
        return 200, {}, rpc({"content": [{"type": "text", "text": text}]}, rid=body["id"])

    assert client(FakeHttp(session_handler(on_call))).ask("q")["response_id"] == "r"


def test_an_empty_or_garbled_reply_is_an_error():
    with pytest.raises(genie.GenieError, match="empty reply"):
        client(FakeHttp(session_handler(lambda body, headers: (200, {}, "")))).ask("q")
    with pytest.raises(genie.GenieError, match="not JSON"):
        client(FakeHttp(session_handler(lambda body, headers: (200, {}, "{oops")))).ask("q")


# ---------------------------------------------------------------- errors

def failing(status, text=""):
    return FakeHttp(lambda body, headers: (status, {}, text))


@pytest.mark.parametrize("status", [401, 403])
def test_auth_failures_are_403_with_the_execute_hint(status):
    with pytest.raises(genie.GenieError) as e:
        client(failing(status, "nope")).ask("q")
    assert e.value.status == 403 and "EXECUTE on system.ai.genie_one_mcp" in str(e.value)


def test_missing_server_is_a_clear_502():
    with pytest.raises(genie.GenieError) as e:
        client(failing(404)).ask("q")
    assert e.value.status == 502 and "no Genie One MCP server" in str(e.value)


def test_rate_limit_is_429_and_other_http_errors_are_502_with_a_short_body():
    with pytest.raises(genie.GenieError) as e:
        client(failing(429)).ask("q")
    assert e.value.status == 429
    with pytest.raises(genie.GenieError) as e:
        client(failing(500, "x" * 1000)).ask("q")
    assert e.value.status == 502 and "HTTP 500" in str(e.value) and len(str(e.value)) < 400


def test_json_rpc_permission_error_is_403_and_others_are_502():
    def server(message):
        return FakeHttp(session_handler(lambda body, headers: (200, {}, rpc(error={"code": -32000, "message": message}, rid=body["id"]))))

    with pytest.raises(genie.GenieError) as e:
        client(server("User does not have EXECUTE on function system.ai.genie_one_mcp")).ask("q")
    assert e.value.status == 403
    with pytest.raises(genie.GenieError) as e:
        client(server("something broke")).ask("q")
    assert e.value.status == 502 and "something broke" in str(e.value)


def test_a_tool_error_result_is_raised():
    def on_call(body, headers):
        res = {"content": [{"type": "text", "text": "Conversation not found"}], "isError": True}
        return 200, {}, rpc(res, rid=body["id"])

    with pytest.raises(genie.GenieError, match="Conversation not found"):
        client(FakeHttp(session_handler(on_call))).poll("c", "r")


def test_an_initialize_error_is_raised():
    http = FakeHttp(lambda body, headers: (200, {}, rpc(error={"code": -32000, "message": "permission denied"}, rid=body["id"])))
    with pytest.raises(genie.GenieError) as e:
        client(http).ask("q")
    assert e.value.status == 403


def test_network_failures_are_502(monkeypatch):
    import requests

    def boom(*a, **k):
        raise requests.ConnectionError("dns failure with secret details")

    monkeypatch.setattr(genie.requests, "post", boom)
    with pytest.raises(genie.GenieError) as e:
        genie.default_post("https://x", {}, {}, 1)
    assert e.value.status == 502 and "ConnectionError" in str(e.value) and "secret" not in str(e.value)

    def slow(*a, **k):
        raise requests.Timeout()

    monkeypatch.setattr(genie.requests, "post", slow)
    with pytest.raises(genie.GenieError, match="did not answer in time"):
        genie.default_post("https://x", {}, {}, 1)


def test_default_post_lower_cases_response_headers(monkeypatch):
    resp = SimpleNamespace(status_code=200, headers={"Mcp-Session-Id": "abc"}, text="{}")
    monkeypatch.setattr(genie.requests, "post", lambda *a, **k: resp)
    assert genie.default_post("https://x", {}, {}, 1) == (200, {"mcp-session-id": "abc"}, "{}")


def test_an_unreadable_workspace_id_is_a_clear_error():
    def no_id():
        raise RuntimeError("no workspace")

    w = SimpleNamespace(config=SimpleNamespace(host=HOST, authenticate=dict), get_workspace_id=no_id)
    with pytest.raises(genie.GenieError, match="workspace id"):
        genie.GenieClient(w, post=FakeHttp()).ask("q")


def test_the_bearer_token_never_reaches_an_error_message():
    with pytest.raises(genie.GenieError) as e:
        client(failing(500, "boom")).ask("q")
    assert "t0k" not in str(e.value)


# ---------------------------------------------------------------- shaping and validation

ANSWER = ("The **orders** table has 0 rows. [ucstate_prod.shop.orders](https://h.example/explore/data/ucstate_prod/shop/orders?isDbOne=true&o=1) "
          "[Query Result](https://h.example/one/chat/threads/c#embed-query_1)\n"
          "Also https://h.example/explore/data/main/sales/items and again "
          "[x](https://h.example/explore/data/UCSTATE_PROD/shop/Orders) and [bad](https://h.example/explore/data/main/sales).")


def test_tables_are_parsed_in_order_without_repeats():
    got = genie.tables_from_markdown(ANSWER)
    assert [t["name"] for t in got] == ["ucstate_prod.shop.orders", "main.sales.items"]
    assert got[0]["url"].startswith("https://h.example/explore/data/ucstate_prod/shop/orders?isDbOne=true")
    assert genie.tables_from_markdown(None) == [] and genie.tables_from_markdown("no links") == []


def test_encoded_and_quoted_segments_are_cleaned():
    assert genie.tables_from_markdown("[t](https://h/explore/data/main/s%5Fx/%60t%60)")[0]["name"] == "main.s_x.t"


def test_shape_poll_for_a_completed_turn():
    sc = {"conversation_id": "c", "response_id": "r", "status": "completed", "deep_link": "https://h/one/chat/threads/c",
          "final_answer": ANSWER, "progress_steps": None,
          "query_items": [{"item_id": "i1", "sql": "SELECT 1"}, {"item_id": None, "sql": "x"}]}
    out = genie.shape_poll(sc)
    assert out["status"] == "completed" and out["progress_steps"] == [] and out["error"] is None
    assert out["query_items"] == [{"item_id": "i1", "sql": "SELECT 1"}]
    assert [t["name"] for t in out["tables"]][0] == "ucstate_prod.shop.orders"
    assert out["deep_link"].endswith("/c")


def test_shape_poll_keeps_the_error_only_for_a_turn_that_did_not_finish():
    assert genie.shape_poll({"status": "failed", "message": "bad table"})["error"] == "bad table"
    assert genie.shape_poll({"status": "in_progress", "message": "hm"})["error"] is None
    assert genie.shape_poll({})["status"] == "in_progress"


def test_shape_result_matches_the_query_result_shape():
    out = genie.shape_result({"item_id": "i1", "statement_state": "SUCCEEDED", "ready": True, "total_row_count": 5, "truncated": True,
                              "columns": [{"name": "n", "type_text": "BIGINT"}, {"name": "d", "type_text": "decimal(10,2)"}],
                              "rows": [["1", "2.50"]]})
    assert out["columns"] == [{"name": "n", "type": "BIGINT", "type_text": "BIGINT"},
                              {"name": "d", "type": "DECIMAL", "type_text": "decimal(10,2)"}]
    assert out["rows"] == [["1", "2.50"]] and out["row_count"] == 1 and out["total_row_count"] == 5
    assert out["truncated"] is True and out["statement_id"] == "i1" and out["ready"] is True and out["ms"] is None


def test_request_validation():
    assert genie.parse_ask({"question": "  hi  "}) == ("hi", None)
    assert genie.parse_ask({"question": "hi", "conversation_id": "c"}) == ("hi", "c")
    for bad in (None, [], {}, {"question": ""}, {"question": 3}, {"question": "x" * 4001}, {"question": "q", "conversation_id": 5}):
        with pytest.raises(genie.GenieInvalid):
            genie.parse_ask(bad)
    assert genie.parse_ids({"a": "1", "b": "2"}, "a", "b") == ("1", "2")
    with pytest.raises(genie.GenieInvalid, match="b: must be"):
        genie.parse_ids({"a": "1"}, "a", "b")
    with pytest.raises(genie.GenieInvalid):
        genie.parse_ids([], "a")


# ---------------------------------------------------------------- poll retry

POLL_SC = {"conversation_id": "c", "response_id": "r", "status": "in_progress"}


def flaky(failures):
    """A server whose poll answers each of `failures` (an HTTP status) before it succeeds."""
    queue = list(failures)

    def on_call(body, headers):
        if body["params"]["name"] == "genie_poll_response" and queue:
            return queue.pop(0), {}, "upstream trouble"
        return 200, {}, rpc(tool_result(POLL_SC), rid=body["id"])
    return FakeHttp(session_handler(on_call))


@pytest.fixture
def pauses(monkeypatch):
    slept = []
    monkeypatch.setattr(genie.time, "sleep", slept.append)
    return slept


def tool_calls(http):
    return [s for s in http.sent if s["body"].get("method") == "tools/call"]


@pytest.mark.parametrize("status", [500, 502, 503, 504])
def test_a_poll_that_got_a_5xx_is_tried_once_more_after_a_pause(status, pauses):
    http = flaky([status])
    assert client(http).poll("c", "r")["status"] == "in_progress"
    assert len(tool_calls(http)) == 2 and pauses == [genie.POLL_RETRY_PAUSE]


@pytest.mark.parametrize("exc", [pytest.param("connection", id="connection"), pytest.param("timeout", id="timeout")])
def test_a_poll_that_lost_the_connection_or_timed_out_is_tried_once_more(exc, pauses):
    import requests

    queue = [requests.ConnectionError("x") if exc == "connection" else requests.Timeout()]
    http = flaky([])

    def post(url, headers, body, timeout):
        if body.get("params", {}).get("name") == "genie_poll_response" and queue:
            try:
                raise queue.pop(0)
            except requests.Timeout:
                raise genie.GenieError("slow", 502, transient=True) from None
            except requests.RequestException:
                raise genie.GenieError("down", 502, transient=True) from None
        return http(url, headers, body, timeout)

    w = SimpleNamespace(config=SimpleNamespace(host=HOST, authenticate=lambda: {}), get_workspace_id=lambda: 1)
    assert genie.GenieClient(w, post=post).poll("c", "r")["status"] == "in_progress"
    assert pauses == [genie.POLL_RETRY_PAUSE]


def test_default_post_marks_network_failures_as_transient(monkeypatch):
    import requests

    for exc in (requests.ConnectionError("x"), requests.Timeout()):
        def boom(*a, _exc=exc, **k):
            raise _exc

        monkeypatch.setattr(genie.requests, "post", boom)
        with pytest.raises(genie.GenieError) as e:
            genie.default_post("https://x", {}, {}, 1)
        assert e.value.transient is True


def test_a_poll_is_retried_only_once(pauses):
    http = flaky([502, 502, 502])
    with pytest.raises(genie.GenieError) as e:
        client(http).poll("c", "r")
    assert e.value.status == 502 and "HTTP 502" in str(e.value)
    assert len(tool_calls(http)) == 2 and len(pauses) == 1


@pytest.mark.parametrize("status", [400, 401, 403, 429])
def test_a_poll_is_not_retried_for_a_refusal_or_a_client_error(status, pauses):
    http = flaky([status])
    with pytest.raises(genie.GenieError):
        client(http).poll("c", "r")
    assert len(tool_calls(http)) == 1 and pauses == []


def test_a_tool_error_in_a_poll_is_not_retried(pauses):
    http = FakeHttp(session_handler(lambda body, headers: (200, {}, rpc(tool_result({"message": "boom"}, is_error=True), rid=body["id"]))))
    with pytest.raises(genie.GenieError):
        client(http).poll("c", "r")
    assert len(tool_calls(http)) == 1 and pauses == []


def test_ask_result_and_cancel_are_never_retried(pauses):
    for call in (lambda c: c.ask("q"), lambda c: c.query_result("c", "r", "i"), lambda c: c.cancel("c")):
        http = FakeHttp(session_handler(lambda body, headers: (503, {}, "down")))
        with pytest.raises(genie.GenieError):
            call(client(http))
        assert len(tool_calls(http)) == 1
    assert pauses == []
