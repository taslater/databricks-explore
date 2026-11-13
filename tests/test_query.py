"""Query execution (A1): row cap, truncation flag, chunk reading, async poll and cancel, routes.

No Databricks connection. WorkspaceClient is replaced by a fake whose statement_execution
serves a configurable number of rows in chunks, using the real SDK response types.
"""
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402
import dbx  # noqa: E402
import sqltools  # noqa: E402
from databricks.sdk.service.sql import (  # noqa: E402
    ColumnInfo, ColumnInfoTypeName, ResultData, ResultManifest, ResultSchema,
    ServiceError, StatementResponse, StatementState, StatementStatus)

COLUMNS = [("id", ColumnInfoTypeName.LONG), ("name", ColumnInfoTypeName.STRING),
           ("amount", ColumnInfoTypeName.DECIMAL)]


class FakeStatements:
    """Stands in for WorkspaceClient().statement_execution.

    Serves `total_rows` rows in chunks of `chunk_size`. A statement ending in `LIMIT n` gets
    min(total_rows, n) rows, as the warehouse would return them.
    `pending_polls`: how many responses report RUNNING before the result is ready.
    `fail`: if set, the statement ends FAILED with this message.
    """

    def __init__(self, total_rows=20000, chunk_size=1000, pending_polls=0, fail=None):
        self.total_rows, self.chunk_size = total_rows, chunk_size
        self.pending_polls = pending_polls
        self.fail = fail
        self.executed = []      # dicts: statement, wait_timeout, parameters
        self.chunk_calls = []   # chunk indexes requested after the first response
        self.cancelled = []
        self.stmts = {}         # sid -> {"n", "polls_left", "canceled"}

    def _n(self, statement):
        m = re.search(r"LIMIT\s+(\d+)\s*$", statement, re.I)
        return min(self.total_rows, int(m.group(1))) if m else self.total_rows

    def _state(self, sid):
        st = self.stmts[sid]
        if st["canceled"]:
            return StatementState.CANCELED
        if st["polls_left"] > 0:
            st["polls_left"] -= 1
            return StatementState.RUNNING
        return StatementState.FAILED if self.fail else StatementState.SUCCEEDED

    def _manifest(self, n):
        cols = [ColumnInfo(name=name, position=i, type_name=t, type_text=t.value.lower())
                for i, (name, t) in enumerate(COLUMNS)]
        return ResultManifest(schema=ResultSchema(column_count=len(cols), columns=cols), total_row_count=n)

    def _chunk(self, sid, i):
        n = self.stmts[sid]["n"]
        lo = i * self.chunk_size
        hi = min(lo + self.chunk_size, n)
        data = [[str(k), f"name-{k}", f"{k}.50"] for k in range(lo, hi)]
        return ResultData(chunk_index=i, data_array=data, row_count=len(data), row_offset=lo,
                          next_chunk_index=i + 1 if hi < n else None)

    def _response(self, sid):
        state = self._state(sid)
        if state == StatementState.FAILED:
            return StatementResponse(statement_id=sid, status=StatementStatus(
                state=state, error=ServiceError(message=self.fail)))
        if state != StatementState.SUCCEEDED:
            return StatementResponse(statement_id=sid, status=StatementStatus(state=state))
        return StatementResponse(statement_id=sid, status=StatementStatus(state=state),
                                 manifest=self._manifest(self.stmts[sid]["n"]), result=self._chunk(sid, 0))

    def execute_statement(self, statement, warehouse_id, wait_timeout=None, parameters=None, **_):
        sid = f"stmt-{len(self.executed) + 1}"
        self.executed.append({"statement": statement, "wait_timeout": wait_timeout, "parameters": parameters or []})
        self.stmts[sid] = {"n": self._n(statement), "polls_left": self.pending_polls, "canceled": False}
        return self._response(sid)

    def get_statement(self, statement_id):
        return self._response(statement_id)

    def get_statement_result_chunk_n(self, statement_id, chunk_index):
        self.chunk_calls.append(chunk_index)
        return self._chunk(statement_id, chunk_index)

    def cancel_execution(self, statement_id):
        self.stmts[statement_id]["canceled"] = True
        self.cancelled.append(statement_id)


class FakeWS:
    def __init__(self, statements):
        self.statement_execution = statements
        self.config = SimpleNamespace(host="https://fake.example.net")


@pytest.fixture
def make_explorer(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "LOGS", tmp_path)            # keep the real data/logs/calls.jsonl untouched
    monkeypatch.setattr(dbx.time, "sleep", lambda s: None)  # no 1s poll waits in tests

    def make(**kw):
        stmts = FakeStatements(**kw)
        monkeypatch.setattr(dbx, "WorkspaceClient", lambda profile=None: FakeWS(stmts))
        ex = dbx.Explorer("test")
        ex.warehouse_id = "wh1"
        return ex, stmts
    return make


# ---------- sqltools.wrap_limit ----------

def test_wrap_limit_wraps_query_with_max_rows_plus_one():
    wrapped, can = sqltools.wrap_limit("SELECT a FROM t", 5000)
    assert can is True
    assert wrapped.startswith("SELECT * FROM (SELECT a FROM t)")
    assert wrapped.endswith("LIMIT 5001")


@pytest.mark.parametrize("sql", ["SELECT * FROM t WHERE ((", "SHOW TABLES", "SELECT 1; SELECT 2", ""])
def test_wrap_limit_passes_through_unparseable_or_non_query(sql):
    assert sqltools.wrap_limit(sql, 5000) == (sql, False)


# ---------- dbx.Explorer.query (sync) ----------

def test_20k_rows_returns_5000_and_truncated_true(make_explorer):
    ex, st = make_explorer(total_rows=20000, chunk_size=1000)
    out = ex.query("SELECT id, name, amount FROM big", max_rows=5000)
    assert out["row_count"] == 5000
    assert len(out["rows"]) == 5000
    assert out["truncated"] is True
    assert st.executed[0]["statement"] == sqltools.wrap_limit("SELECT id, name, amount FROM big", 5000)[0]
    assert out["rows"][0] == ["0", "name-0", "0.50"]
    assert out["columns"] == [{"name": "id", "type": "LONG"}, {"name": "name", "type": "STRING"},
                              {"name": "amount", "type": "DECIMAL"}]
    assert isinstance(out["ms"], int)
    assert out["statement_id"] == "stmt-1"


def test_exactly_max_rows_is_not_truncated(make_explorer):
    ex, _ = make_explorer(total_rows=5000, chunk_size=1000)
    out = ex.query("SELECT * FROM t", max_rows=5000)
    assert out["row_count"] == 5000
    assert out["truncated"] is False


def test_fewer_rows_than_cap_is_not_truncated(make_explorer):
    ex, _ = make_explorer(total_rows=4999, chunk_size=1000)
    out = ex.query("SELECT * FROM t", max_rows=5000)
    assert out["row_count"] == 4999
    assert out["truncated"] is False


def test_reads_every_chunk_when_under_cap(make_explorer):
    ex, st = make_explorer(total_rows=2500, chunk_size=1000)
    out = ex.query("SELECT * FROM t", max_rows=5000)
    assert st.chunk_calls == [1, 2]
    assert out["row_count"] == 2500
    assert out["rows"][-1][0] == "2499"


def test_stops_reading_chunks_once_cap_is_passed(make_explorer):
    ex, st = make_explorer(total_rows=20000, chunk_size=1000)
    out = ex.query("SELECT * FROM t", max_rows=1500)
    assert st.chunk_calls == [1]          # chunk 0 came with the response; chunk 1 reaches 2000 rows
    assert out["row_count"] == 1500
    assert out["truncated"] is True


def test_unparseable_sql_is_sent_unchanged_with_truncated_null(make_explorer):
    ex, st = make_explorer(total_rows=20000, chunk_size=1000)
    sql = "SELECT * FROM t WHERE (("
    out = ex.query(sql, max_rows=5000)
    assert st.executed[0]["statement"] == sql
    assert out["truncated"] is None
    assert out["row_count"] == 5000       # still capped client-side


def test_non_query_statement_is_sent_unchanged_with_truncated_null(make_explorer):
    ex, st = make_explorer(total_rows=3, chunk_size=1000)
    out = ex.query("SHOW TABLES", max_rows=5000)
    assert st.executed[0]["statement"] == "SHOW TABLES"
    assert out["truncated"] is None


def test_params_are_sent_as_named_strings(make_explorer):
    ex, st = make_explorer(total_rows=1)
    ex.query("SELECT * FROM t WHERE x > :min", params={"min": 8}, max_rows=10)
    p = st.executed[0]["parameters"]
    assert [(i.name, i.value) for i in p] == [("min", "8")]


def test_failed_sync_statement_raises_with_databricks_message(make_explorer):
    ex, _ = make_explorer(fail="TABLE_OR_VIEW_NOT_FOUND: nope")
    with pytest.raises(RuntimeError, match="TABLE_OR_VIEW_NOT_FOUND"):
        ex.query("SELECT * FROM nope", max_rows=5)


def test_max_rows_must_be_at_least_one(make_explorer):
    ex, _ = make_explorer(total_rows=1)
    with pytest.raises(ValueError):
        ex.query("SELECT 1", max_rows=0)


def test_no_warehouse_raises(make_explorer):
    ex, _ = make_explorer(total_rows=1)
    ex.warehouse_id = None
    with pytest.raises(RuntimeError, match="No SQL warehouse"):
        ex.query("SELECT 1")


def test_logged_sql_is_truncated_to_400_chars(make_explorer, tmp_path):
    ex, _ = make_explorer(total_rows=1)
    sql = "SELECT " + ", ".join(f"c{i}" for i in range(300)) + " FROM t"
    ex.query(sql, max_rows=5)
    entries = [json.loads(line) for line in (tmp_path / "calls.jsonl").read_text(encoding="utf-8").splitlines()]
    execute = [e for e in entries if e["op"] == "statement.execute"]
    assert len(execute) == 1
    assert execute[0]["statement"] == " ".join(sql.split())[:400]
    assert len(execute[0]["statement"]) == 400


# ---------- async: run, poll, cancel ----------

def test_async_polls_running_then_succeeds(make_explorer):
    ex, st = make_explorer(total_rows=3, pending_polls=2)
    sid = ex.query_async("SELECT * FROM t", max_rows=10)
    assert st.executed[0]["wait_timeout"] == "0s"
    assert sid == "stmt-1"

    running = ex.query_status(sid)
    assert running["state"] == "RUNNING"
    assert running["rows"] == [] and running["columns"] == []
    assert running["row_count"] == 0 and running["truncated"] is None
    assert running["ms"] is None and running["error"] is None

    done = ex.query_status(sid)
    assert done["state"] == "SUCCEEDED"
    assert done["row_count"] == 3 and done["truncated"] is False
    assert done["columns"][0] == {"name": "id", "type": "LONG"}
    assert isinstance(done["ms"], int) and done["error"] is None


def test_async_failure_is_reported_in_state_not_raised(make_explorer):
    ex, _ = make_explorer(total_rows=3, fail="PARSE_SYNTAX_ERROR at 1")
    sid = ex.query_async("SELECT FROM", max_rows=10)
    st = ex.query_status(sid)
    assert st["state"] == "FAILED"
    assert st["error"] == "PARSE_SYNTAX_ERROR at 1"
    assert st["rows"] == [] and st["row_count"] == 0


def test_cancel_calls_cancel_execution_and_reports_canceled(make_explorer):
    ex, st = make_explorer(total_rows=20000, pending_polls=5)
    sid = ex.query_async("SELECT * FROM big", max_rows=5000)
    assert ex.query_cancel(sid) == {"statement_id": sid, "cancel_requested": True}
    assert st.cancelled == [sid]
    after = ex.query_status(sid)
    assert after["state"] == "CANCELED"
    assert after["error"] is None and after["rows"] == []


def test_unknown_statement_id_raises(make_explorer):
    ex, _ = make_explorer(total_rows=1)
    with pytest.raises(RuntimeError, match="Unknown statement_id"):
        ex.query_status("does-not-exist")


# ---------- routes ----------

@pytest.fixture
def client(make_explorer, monkeypatch):
    ex, st = make_explorer(total_rows=20000, chunk_size=1000)
    monkeypatch.setitem(app_module.STATE, "ex", ex)
    return app_module.app.test_client(), st


def test_post_query_returns_capped_result(client):
    c, st = client
    r = c.post("/api/query", json={"sql": "SELECT * FROM big", "max_rows": 100})
    assert r.status_code == 200
    body = r.get_json()
    assert body["row_count"] == 100 and body["truncated"] is True
    assert set(body) == {"statement_id", "columns", "rows", "row_count", "truncated", "ms"}


def test_post_query_expands_windows_before_running(client, monkeypatch):
    c, st = client
    calls = []

    def fake_expand(sql, windows):
        calls.append((sql, windows))
        return "SELECT 1 AS x"
    monkeypatch.setattr(sqltools, "expand_refs", fake_expand)
    r = c.post("/api/query", json={"sql": "SELECT * FROM {{w1}}", "max_rows": 1,
                                   "windows": {"w1": "SELECT 1 AS x"}})
    assert r.status_code == 200
    assert calls == [("SELECT * FROM {{w1}}", {"w1": "SELECT 1 AS x"})]
    assert st.executed[0]["statement"].startswith("SELECT * FROM (SELECT 1 AS x)")


def test_post_query_without_windows_does_not_expand(client, monkeypatch):
    c, st = client

    def must_not_run(sql, windows):
        raise AssertionError("expand_refs called without windows")
    monkeypatch.setattr(sqltools, "expand_refs", must_not_run)
    r = c.post("/api/query", json={"sql": "SELECT 1 AS x", "max_rows": 1})
    assert r.status_code == 200


def test_expansion_error_goes_through_error_handler(client, monkeypatch):
    c, _ = client

    def boom(sql, windows):
        raise ValueError("cycle: a -> b -> a")
    monkeypatch.setattr(sqltools, "expand_refs", boom)
    r = c.post("/api/query", json={"sql": "SELECT 1", "windows": {"a": "SELECT {{b}}"}})
    assert r.status_code == 500
    assert r.get_json() == {"error": "cycle: a -> b -> a"}


def test_no_connection_returns_500_error_json(client, monkeypatch):
    c, _ = client
    monkeypatch.setitem(app_module.STATE, "ex", None)
    r = c.post("/api/query", json={"sql": "SELECT 1"})
    assert r.status_code == 500
    assert "error" in r.get_json()


def test_async_routes_run_poll_and_cancel(client):
    c, st = client
    r = c.post("/api/query/async", json={"sql": "SELECT * FROM big", "max_rows": 50})
    assert r.status_code == 200
    sid = r.get_json()["statement_id"]

    poll = c.get(f"/api/query/{sid}").get_json()
    assert poll["state"] == "SUCCEEDED"
    assert poll["row_count"] == 50 and poll["truncated"] is True and poll["error"] is None

    cancel = c.delete(f"/api/query/{sid}")
    assert cancel.status_code == 200
    assert cancel.get_json() == {"statement_id": sid, "cancel_requested": True}
    assert st.cancelled == [sid]
