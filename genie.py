"""Genie One over MCP: a small JSON-RPC client for ask, poll, query result and cancel, plus the response shaping."""
import json
import re
import threading
import time
from urllib.parse import unquote

import requests

PROTOCOL = "2025-06-18"
SERVER_PATH = "/ai-gateway/mcp-services/system.ai.genie_one_mcp"
CLIENT_INFO = {"name": "databricks-explore", "version": "0"}
TIMEOUT = 60                      # seconds for one HTTP call; every tool call returns quickly (the browser polls)
MAX_QUESTION = 4000
POLL_RETRY_PAUSE = 0.5            # seconds before the one retry of a poll that failed in transit
MAX_ERROR = 300                   # characters of an upstream error body kept in a message

_PERMISSION = re.compile(r"permission|EXECUTE|denied|forbidden|not authorized|unauthorized", re.I)
_SESSION = re.compile(r"session", re.I)
# https://<host>/explore/data/<catalog>/<schema>/<table>[?query][#fragment], as Genie writes them in its answers
_TABLE_URL = re.compile(r"https?://[^/\s)\]>\"']+/explore/data/([^/\s?#)\]>\"']+)/([^/\s?#)\]>\"']+)/([^/\s?#)\]>\"']+)[^\s)\]>\"']*")
_AGENT_COMMENT = re.compile(r"<!--.*?-->", re.S)


class GenieError(Exception):
    """Genie could not be reached or refused. `status` is the HTTP status the route returns (403, 429 or 502).
    `transient` marks a failure in transit (HTTP 5xx, no connection, timeout) that may work on a second try."""

    def __init__(self, message, status=502, transient=False):
        super().__init__(message)
        self.status = status
        self.transient = transient


class GenieInvalid(ValueError):
    """A request body or query the ask routes cannot use (route returns HTTP 400)."""


# ---------------------------------------------------------------- validation

def _text(value, name, limit=None):
    if not isinstance(value, str) or not value.strip():
        raise GenieInvalid(f"{name}: must be a non-empty string")
    if limit and len(value) > limit:
        raise GenieInvalid(f"{name}: at most {limit} characters")
    return value.strip()


def parse_ask(body):
    """(question, conversation_id or None) from a POST /api/ask body."""
    if not isinstance(body, dict):
        raise GenieInvalid("(root): body must be a JSON object")
    cid = body.get("conversation_id")
    return _text(body.get("question"), "question", MAX_QUESTION), (_text(cid, "conversation_id") if cid else None)


def parse_ids(source, *names):
    """The named non-empty string ids from a query string or body."""
    if not hasattr(source, "get"):
        raise GenieInvalid("(root): body must be a JSON object")
    return tuple(_text(source.get(n), n) for n in names)


# ---------------------------------------------------------------- shaping

def tables_from_markdown(markdown):
    """Tables an answer links to, as [{"name": "cat.sch.tbl", "url": ...}], first mention first, no repeats."""
    seen, out = set(), []
    for m in _TABLE_URL.finditer(markdown or ""):
        parts = [unquote(g).strip("`") for g in m.groups()]
        name = ".".join(parts)
        if all(parts) and name.lower() not in seen:
            seen.add(name.lower())
            out.append({"name": name, "url": m.group(0)})
    return out


def shape_ask(sc):
    """The ask response: ids and the first status."""
    return {"conversation_id": sc.get("conversation_id"), "response_id": sc.get("response_id"),
            "status": sc.get("status") or "in_progress"}


def shape_poll(sc):
    """One poll, in the shape the page reads. `tables` is parsed from the answer's links."""
    status = sc.get("status") or "in_progress"
    answer = sc.get("final_answer")
    items = [{"item_id": q.get("item_id"), "sql": q.get("sql") or ""} for q in (sc.get("query_items") or []) if q.get("item_id")]
    return {"conversation_id": sc.get("conversation_id"), "response_id": sc.get("response_id"), "status": status,
            "deep_link": sc.get("deep_link"), "final_answer": answer,
            "progress_steps": [str(s) for s in (sc.get("progress_steps") or [])],
            "query_items": items, "tables": tables_from_markdown(answer),
            "error": str(sc.get("error") or sc.get("message")) if status in ("failed", "incomplete") and (sc.get("error") or sc.get("message")) else None}


def shape_result(sc):
    """A query result in the Result shape of POST /api/query (contracts/api.md section 3), so the results grid reads it."""
    cols = []
    for c in sc.get("columns") or []:
        text = c.get("type_text")
        base = re.split(r"[(<\s]", (text or "").strip())[0].upper() or None
        cols.append({"name": c.get("name"), "type": c.get("type") or base, "type_text": text})
    rows = [list(r) for r in (sc.get("rows") or [])]
    return {"statement_id": sc.get("item_id"), "state": sc.get("statement_state"), "ready": bool(sc.get("ready")),
            "columns": cols, "rows": rows, "row_count": len(rows), "total_row_count": sc.get("total_row_count"),
            "truncated": bool(sc.get("truncated")), "ms": None}


# ---------------------------------------------------------------- transport

def default_post(url, headers, body, timeout):
    """POST a JSON body. Returns (status, response headers with lower-case keys, body text). Network failures are GenieError."""
    try:
        r = requests.post(url, headers=headers, data=json.dumps(body), timeout=timeout)
    except requests.Timeout:
        raise GenieError("The Genie One MCP server did not answer in time. Try again.", 502, transient=True) from None
    except requests.RequestException as e:
        raise GenieError(f"Could not reach the Genie One MCP server: {type(e).__name__}. Check the connection and the profile.", 502, transient=True) from None
    return r.status_code, {k.lower(): v for k, v in r.headers.items()}, r.text


def _snippet(text):
    return " ".join(str(text).split())[:MAX_ERROR]


def _permission_message(detail=""):
    base = ("Genie One refused the request. Your user needs EXECUTE on system.ai.genie_one_mcp, "
            "and the workspace needs Genie One turned on.")
    return f"{base} ({_snippet(detail)})" if detail else base


def _classify(message):
    """GenieError for an error message from the server: 403 when it reads like a permission problem, else 502."""
    return GenieError(_permission_message(message), 403) if _PERMISSION.search(message) else GenieError(_snippet(message) or "Genie failed.", 502)


def _parse_body(text, rpc_id):
    """The JSON-RPC message in a response body: plain JSON, or an event stream with the message in a data line."""
    text = (text or "").strip()
    if not text:
        return None
    if text.startswith(("{", "[")):
        data = json.loads(text)
        return data if isinstance(data, dict) else next((m for m in data if m.get("id") == rpc_id), None)
    found = None
    for line in text.splitlines():
        if line.startswith("data:"):
            try:
                msg = json.loads(line[5:].strip())
            except ValueError:
                continue
            if isinstance(msg, dict) and (msg.get("id") == rpc_id or found is None):
                found = msg
    return found


class GenieClient:
    """Talks to the Genie One MCP server as the connected user. One MCP session is reused until the server drops it."""

    def __init__(self, w, warehouse_id=None, post=default_post, timeout=TIMEOUT):
        self.w = w
        self.warehouse_id = warehouse_id    # sent in _meta with every tool call; the page's selected warehouse
        self._post = post
        self._timeout = timeout
        self._session = None
        self._next_id = 0
        self._lock = threading.Lock()

    # ---- plumbing
    def url(self):
        """The MCP endpoint of the connected workspace."""
        try:
            wid = self.w.get_workspace_id()
        except Exception as e:
            raise GenieError(f"Could not read the workspace id: {_snippet(e)}", 502) from None
        return f"{self.w.config.host.rstrip('/')}{SERVER_PATH}?o={wid}"

    def _headers(self):
        h = dict(self.w.config.authenticate())  # a fresh bearer token each call; never logged or returned
        h.update({"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                  "MCP-Protocol-Version": PROTOCOL})
        if self._session:
            h["Mcp-Session-Id"] = self._session
        return h

    def _send(self, body):
        """(status, headers, text) of one POST; an HTTP error is turned into a GenieError except 404, which the caller handles."""
        status, headers, text = self._post(self.url(), self._headers(), body, self._timeout)
        if status in (401, 403):
            raise GenieError(_permission_message(), 403)
        if status == 429:
            raise GenieError("Genie is rate limited right now. Wait a moment and try again.", 429)
        if status >= 400 and status != 404:
            raise GenieError(f"The Genie One MCP server answered HTTP {status}: {_snippet(text)}", 502, transient=status >= 500)
        return status, headers, text

    def _rpc_id(self):
        self._next_id += 1
        return self._next_id

    def _initialize(self):
        self._session = None
        rid = self._rpc_id()
        status, headers, text = self._send({"jsonrpc": "2.0", "id": rid, "method": "initialize",
                                            "params": {"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": CLIENT_INFO}})
        if status == 404:
            raise GenieError("This workspace has no Genie One MCP server (system.ai.genie_one_mcp). It may not be enabled here.", 502)
        msg = _parse_body(text, rid)
        if msg and msg.get("error"):
            raise _classify(str(msg["error"].get("message", msg["error"])))
        self._session = headers.get("mcp-session-id")
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _call(self, name, args, retry=True):
        with self._lock:
            if not self._session:
                self._initialize()
        rid = self._rpc_id()
        params = {"name": name, "arguments": args}
        if self.warehouse_id:
            params["_meta"] = {"warehouse_id": self.warehouse_id}
        status, _, text = self._send({"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": params})
        msg = None
        try:
            msg = _parse_body(text, rid) if status != 404 else None
        except ValueError:
            raise GenieError("The Genie One MCP server sent a reply that is not JSON.", 502) from None
        expired = status == 404 or (msg and msg.get("error") and _SESSION.search(str(msg["error"].get("message", ""))))
        if expired and retry:  # the server forgot the session: start a new one and send the call once more
            with self._lock:
                self._session = None
            return self._call(name, args, retry=False)
        if status == 404:
            raise GenieError("The Genie One MCP server lost the session. Ask again.", 502)
        if msg is None:
            raise GenieError("The Genie One MCP server sent an empty reply.", 502)
        if msg.get("error"):
            raise _classify(str(msg["error"].get("message", msg["error"])))
        result = msg.get("result") or {}
        sc = result.get("structuredContent")
        if sc is None:
            content = _AGENT_COMMENT.sub("", "".join(c.get("text", "") for c in result.get("content") or []))
            try:
                sc = json.loads(content)
            except ValueError:
                sc = {"message": content.strip()}
        if result.get("isError"):
            raise _classify(str(sc.get("message") or sc.get("error") or json.dumps(sc)))
        return sc

    # ---- the four tools
    def ask(self, question, conversation_id=None):
        """Start a turn (or a follow-up in `conversation_id`). Returns ids and the status."""
        args = {"question": question}
        if conversation_id:
            args["conversation_id"] = conversation_id
        return shape_ask(self._call("genie_ask", args))

    def poll(self, conversation_id, response_id):
        """One upstream poll, shaped by shape_poll. A transient failure (HTTP 5xx, no connection, timeout) is tried
        once more after a short pause; only poll does this, because the page polls again anyway and a repeated ask,
        result or cancel is not harmless."""
        args = {"conversation_id": conversation_id, "response_id": response_id}
        try:
            sc = self._call("genie_poll_response", args)
        except GenieError as e:
            if not e.transient:
                raise
            time.sleep(POLL_RETRY_PAUSE)
            sc = self._call("genie_poll_response", args)
        return shape_poll(sc)

    def query_result(self, conversation_id, response_id, item_id):
        """The rows of one SQL item, in the Result shape."""
        return shape_result(self._call("genie_get_query_result", {"conversation_id": conversation_id,
                                                                  "response_id": response_id, "item_id": item_id}))

    def cancel(self, conversation_id):
        """Stop the in-flight turn of a conversation."""
        self._call("genie_cancel_response", {"conversation_id": conversation_id})
        return {"conversation_id": conversation_id, "cancel_requested": True}
