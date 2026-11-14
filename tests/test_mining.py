"""Query-history mining against a fake Explorer: plan, extraction, evidence, incremental runs, redaction, the Miner.

dbx.DATA points at tmp_path in every test, so the real data directory is never written.
"""
import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from databricks_explore import dbx
from databricks_explore import mining
from databricks_explore import relationships as rel

NOW = datetime(2026, 11, 13, 12, 0, tzinfo=timezone.utc)
O, C, S, I, P = ("demo.sales.orders", "demo.sales.customers", "demo.sales.shipments", "demo.sales.order_items",
                 "demo.sales.products")
Q_OS = "SELECT * FROM demo.sales.orders o JOIN demo.sales.shipments s ON s.order_id = o.order_id WHERE o.status = 'secret-literal'"
Q_OC = "SELECT * FROM demo.sales.orders o JOIN demo.sales.customers c ON o.customer_id = c.customer_id"
Q_IP = "SELECT * FROM demo.sales.order_items i JOIN demo.sales.products p ON i.sku = p.sku"
ADA, BOB = "ada@example.invalid", "bob@example.invalid"


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    return tmp_path


def stmt(n, text, user=ADA, day=1, lineage=None):
    """A history row: ids are s<n>, start times are Nov <day> 2026 plus n seconds."""
    when = datetime(2026, 11, day, 8, 0, n, tzinfo=timezone.utc)
    return {"statement_id": f"s{n}", "executed_by": user, "start_time": mining._z(when).replace("Z", ".000Z"),
            "statement_text": text, "lineage": lineage}


class FakeEx:
    """Stands in for dbx.Explorer: canned system-table answers and constraints."""

    def __init__(self, rows, fks=None, warehouse="wh", profile="dev", fail=None):
        self.rows, self.fks, self.warehouse_id, self.profile, self.fail = rows, fks or {}, warehouse, profile, fail
        self.queries = []

    def query(self, sql, params=None, max_rows=5000):
        self.queries.append((sql, dict(params or {})))
        if self.fail:
            raise RuntimeError(self.fail)
        if "table_lineage" in sql:
            cols = ["statement_id", "source_table_full_name"]
            rows = [[r["statement_id"], t] for r in self.rows[:max_rows] if r["lineage"] for t in r["lineage"]]
        else:
            cols = ["statement_id", "executed_by", "start_time", "statement_text"]
            cap = int(sql.rsplit("LIMIT", 1)[1])
            rows = [[r[c] for c in cols] for r in self.rows[:cap]]
        return {"columns": [{"name": c, "type": "STRING"} for c in cols], "rows": rows}

    def object(self, table):
        if table in self.fks:
            child, parent, cc, pc = self.fks[table]
            con = {"foreign_key_constraint": {"name": "fk", "child_columns": [cc], "parent_table": parent,
                                              "parent_columns": [pc]}}
            return {"data": {"table_constraints": [con]}}
        return {"data": {"table_constraints": []}}


def mine(ex, window=30, full=False, cap=5000, now=NOW):
    p = mining.plan(ex.profile, window, full, cap, now)
    return mining.run(ex, p)


def stored():
    with rel.open_store("dev") as s:
        return {(e.source.table, e.source.column, e.target.table, e.target.column): e for e in s.all_edges()}


# ---------- plan ----------

def test_first_plan_reads_the_window_and_leaves_the_newest_hour(data_dir):
    p = mining.plan("dev", 30, now=NOW)
    assert p["until"] == "2026-11-13T11:00:00Z" and p["since"] == "2026-10-14T11:00:00Z"
    assert p["incremental"] is False and p["cursor"] is None and p["row_cap"] == 5000
    assert [q["name"] for q in p["queries"]] == ["query_history", "table_lineage"]
    assert p["queries"][0]["params"] == {"since": p["since"], "until": p["until"]}


def test_the_sql_filters_to_finished_select_like_statements_and_caps_rows(data_dir):
    sql = mining.plan("dev", 7, row_cap=123, now=NOW)["queries"][0]["sql"]
    assert "system.query.history" in sql and "execution_status = 'FINISHED'" in sql
    assert "statement_type IN ('SELECT', 'INSERT', 'MERGE', 'CREATE')" in sql and sql.endswith("LIMIT 123")
    assert "table_lineage" in mining.plan("dev", 7, now=NOW)["queries"][1]["sql"]


@pytest.mark.parametrize("days", [0, -1, 366, 1.5, "30", True, None])
def test_a_bad_window_is_refused(data_dir, days):
    with pytest.raises(mining.MiningInvalid, match="window_days"):
        mining.plan("dev", days, now=NOW)


def test_a_bad_row_cap_is_refused(data_dir):
    with pytest.raises(mining.MiningInvalid, match="row_cap"):
        mining.plan("dev", 30, row_cap=0, now=NOW)


def test_a_later_plan_is_incremental_from_the_cursor_and_full_starts_over(data_dir):
    mine(FakeEx([stmt(1, Q_OS)]))
    later = NOW + timedelta(days=2)
    p = mining.plan("dev", 7, now=later)
    assert p["incremental"] is True and p["since"] == "2026-11-13T11:00:00Z" and p["cursor"] == p["since"]
    full = mining.plan("dev", 7, full=True, now=later)
    assert full["incremental"] is False and full["since"] == "2026-11-08T11:00:00Z"


# ---------- extraction and evidence ----------

def test_pairs_are_stored_as_proposed_undirected_join_mined_edges(data_dir):
    rows = [stmt(1, Q_OS, ADA, lineage=[O, S]), stmt(2, Q_OS, BOB, lineage=[O, S]), stmt(3, Q_OS, ADA, lineage=[O, S])]
    result = mine(FakeEx(rows))
    assert result["statements"] == 3 and result["with_joins"] == 3 and result["created"] == 1
    edge = stored()[(O, "order_id", S, "order_id")]
    assert (edge.kind, edge.status, edge.directed, edge.note) == ("join_mined", "proposed", False, "")
    assert edge.provenance.origin == "query_history" and edge.provenance.source_ref == "s3"
    ev = edge.evidence
    assert (ev.runs, ev.users, ev.first_seen, ev.last_seen) == (3, 2, "2026-11-01", "2026-11-01")
    assert ev.sample_refs == ["s3", "s2", "s1"]


def test_at_most_five_sample_refs_newest_first(data_dir):
    rows = [stmt(n, Q_OS, lineage=[O, S]) for n in range(1, 9)]
    mine(FakeEx(rows))
    assert stored()[(O, "order_id", S, "order_id")].evidence.sample_refs == ["s8", "s7", "s6", "s5", "s4"]


def test_first_and_last_seen_span_the_days(data_dir):
    mine(FakeEx([stmt(1, Q_OS, day=3), stmt(2, Q_OS, day=9), stmt(3, Q_OS, day=5)]))
    ev = stored()[(O, "order_id", S, "order_id")].evidence
    assert (ev.first_seen, ev.last_seen) == ("2026-11-03", "2026-11-09")


def test_no_statement_text_or_user_is_stored_anywhere(data_dir):
    mine(FakeEx([stmt(1, Q_OS, ADA, lineage=[O, S]), stmt(2, Q_OS, BOB)]))
    blob = " ".join(p.read_bytes().decode("latin-1") for p in data_dir.rglob("*") if p.is_file())
    assert "secret-literal" not in blob and "SELECT" not in blob and "ada@" not in blob and "bob@" not in blob
    assert "bob" not in blob.lower().replace("bobo", "")


def test_short_names_are_qualified_from_lineage_and_dropped_without_it(data_dir):
    short = "SELECT * FROM orders o JOIN shipments s ON s.order_id = o.order_id"
    result = mine(FakeEx([stmt(1, short, lineage=[O, S]), stmt(2, short, lineage=None)]))
    assert result["no_lineage"] == 1 and result["with_joins"] == 1
    assert stored()[(O, "order_id", S, "order_id")].evidence.runs == 1


def test_statements_that_do_not_parse_are_counted_and_the_rest_still_mined(data_dir):
    rows = [stmt(1, "SELECT * FROM (SELECT * FROM demo.sales.orders"), stmt(2, Q_OS), stmt(3, "SELECT 1")]
    result = mine(FakeEx(rows))
    assert (result["statements"], result["unparsed"], result["parsed"], result["with_joins"]) == (3, 1, 2, 1)


def test_databricks_own_tables_are_not_mined(data_dir):
    sys_join = "SELECT * FROM system.access.table_lineage l JOIN system.query.history h ON l.statement_id = h.statement_id"
    result = mine(FakeEx([stmt(1, sys_join, lineage=["system.access.table_lineage", "system.query.history"])]))
    assert result["pairs"] == 0 and stored() == {}
    assert mining.usage_summary("dev")["tables"] == []


def test_declared_foreign_keys_are_not_suggestions(data_dir):
    fks = {O: (O, C, "customer_id", "customer_id")}
    result = mine(FakeEx([stmt(1, Q_OC, lineage=[O, C]), stmt(2, Q_OS, lineage=[O, S])], fks=fks))
    assert result["skipped_fk"] == 1 and result["pairs"] == 1
    assert list(stored()) == [(O, "order_id", S, "order_id")]


def test_an_unreadable_table_does_not_stop_the_run(data_dir):
    ex = FakeEx([stmt(1, Q_OC, lineage=[O, C])])
    ex.object = lambda t: (_ for _ in ()).throw(RuntimeError("no access"))
    result = mine(ex)
    assert result["created"] == 1 and result["fk_unreadable_tables"] == 2


# ---------- repeated runs ----------

def test_accepted_and_rejected_edges_keep_their_status_and_note_while_evidence_grows(data_dir):
    rows = [stmt(1, Q_OS, ADA), stmt(2, Q_IP, ADA)]
    mine(FakeEx(rows))
    with rel.open_store("dev") as s:
        ids = {(e.source.table, e.target.table): e.id for e in s.all_edges()}
        s.patch(ids[(O, S)], "accepted", "yes")
        s.patch(ids[(I, P)], "rejected")
    later = NOW + timedelta(days=1)
    more = [stmt(5, Q_OS, BOB, day=12), stmt(6, Q_OS, BOB, day=12), stmt(7, Q_IP, BOB, day=12)]
    result = mine(FakeEx(more), now=later)
    assert (result["created"], result["updated"]) == (0, 2)
    edges = stored()
    ok, no = edges[(O, "order_id", S, "order_id")], edges[(I, "sku", P, "sku")]
    assert (ok.status, ok.note, ok.id) == ("accepted", "yes", ids[(O, S)])
    assert no.status == "rejected"
    assert (ok.evidence.runs, ok.evidence.users, ok.evidence.last_seen) == (3, 1, "2026-11-12")
    assert ok.evidence.sample_refs[:2] == ["s6", "s5"] and ok.evidence.first_seen == "2026-11-01"


def test_a_full_remine_replaces_the_evidence_it_finds(data_dir):
    mine(FakeEx([stmt(n, Q_OS) for n in range(1, 6)]))
    mine(FakeEx([stmt(9, Q_OS)]), full=True, now=NOW + timedelta(days=1))
    ev = stored()[(O, "order_id", S, "order_id")].evidence
    assert (ev.runs, ev.sample_refs) == (1, ["s9"])


def test_the_cursor_moves_to_until_and_is_stored_per_profile(data_dir):
    result = mine(FakeEx([stmt(1, Q_OS)]))
    state = mining.load_state("dev")
    assert state["cursor"] == result["until"] == "2026-11-13T11:00:00Z" and state["cursor_ids"] == []
    assert mining.load_state("other") == {}


def test_when_the_cap_is_hit_the_cursor_stops_at_the_last_row_and_the_rest_is_read_next(data_dir):
    rows = [stmt(n, Q_OS) for n in range(1, 7)]
    first = mine(FakeEx(rows), cap=4)
    assert first["capped"] is True and first["statements"] == 4
    cursor = mining.load_state("dev")["cursor"]
    assert cursor == "2026-11-01T08:00:04Z"
    ids = mining.load_state("dev")["cursor_ids"]
    assert ids == ["s4"]
    # The next run asks from the cursor; the row at the cursor itself comes back and is not counted twice.
    second = mine(FakeEx(rows[3:]), cap=4, now=NOW + timedelta(hours=3))
    assert second["statements"] == 2 and second["capped"] is False
    assert stored()[(O, "order_id", S, "order_id")].evidence.runs == 6


# ---------- redaction ----------

def test_redacted_text_stops_the_run_and_changes_nothing(data_dir):
    rows = [stmt(n, mining.REDACTED) for n in range(1, 5)]
    with pytest.raises(mining.Redacted, match="4 of 4"):
        mine(FakeEx(rows))
    assert stored() == {} and mining.load_state("dev") == {}


def test_a_few_redacted_rows_are_skipped_and_counted(data_dir):
    rows = [stmt(1, mining.REDACTED), stmt(2, Q_OS), stmt(3, Q_OS), stmt(4, Q_OS)]
    result = mine(FakeEx(rows))
    assert result["redacted_skipped"] == 1 and result["with_joins"] == 3


def test_an_empty_history_is_a_clean_run(data_dir):
    result = mine(FakeEx([]))
    assert result["statements"] == 0 and result["pairs"] == 0 and mining.load_state("dev")["cursor"]


# ---------- usage summary ----------

def test_usage_counts_runs_and_distinct_users_for_tables_and_pairs(data_dir):
    rows = [stmt(1, Q_OS, ADA, lineage=[O, S]), stmt(2, Q_OS, BOB, lineage=[O, S]),
            stmt(3, "SELECT * FROM demo.sales.orders", ADA, lineage=[O]), stmt(4, Q_OC, ADA, lineage=[O, C])]
    mine(FakeEx(rows))
    u = mining.usage_summary("dev", 10)
    assert u["statements"] == 4 and u["window"]["until"] == "2026-11-13T11:00:00Z"
    assert u["tables"][0] == {"table": O, "runs": 4, "users": 2}
    assert {"tables": [O, S], "runs": 2, "users": 2} in u["pairs"] and {"tables": [C, O], "runs": 1, "users": 1} in u["pairs"]
    assert len(mining.usage_summary("dev", 1)["tables"]) == 1


def test_usage_falls_back_to_the_sql_when_a_statement_has_no_lineage(data_dir):
    mine(FakeEx([stmt(1, Q_OS, lineage=None)]))
    assert {t["table"] for t in mining.usage_summary("dev")["tables"]} == {O, S}


def test_incremental_usage_adds_runs_and_keeps_the_larger_user_count(data_dir):
    mine(FakeEx([stmt(1, Q_OS, ADA, lineage=[O, S]), stmt(2, Q_OS, BOB, lineage=[O, S])]))
    mine(FakeEx([stmt(3, Q_OS, ADA, day=12, lineage=[O, S])]), now=NOW + timedelta(days=1))
    u = mining.usage_summary("dev")
    assert u["statements"] == 3 and u["tables"][0] == {"table": O, "runs": 3, "users": 2}
    assert u["window"]["since"] == "2026-10-14T11:00:00Z"


def test_a_summary_before_any_run_is_empty(data_dir):
    assert mining.usage_summary("dev") == {"window": None, "statements": 0, "tables": [], "pairs": []}


# ---------- the Miner ----------

def test_miner_runs_and_reports(data_dir):
    ex = FakeEx([stmt(1, Q_OS, lineage=[O, S])])
    m = mining.Miner(ex)
    assert m.status()["state"] == "idle" and m.status()["last_run"] is None
    out = m.start(30, now=NOW, background=False)
    assert out["state"] == "succeeded" and out["result"]["created"] == 1 and out["finished_at"]
    assert out["phase"] is None and out["plan"]["window_days"] == 30
    assert m.status()["last_run"]["created"] == 1
    assert ["table_lineage" in q[0] for q in ex.queries] == [False, True]


def test_miner_background_run_finishes(data_dir):
    m = mining.Miner(FakeEx([stmt(1, Q_OS)]))
    m.start(30, now=NOW)
    for _ in range(100):
        if m.status()["state"] != "running":
            break
        time.sleep(0.02)
    assert m.status()["state"] == "succeeded"


def test_miner_reports_redacted_as_blocked_with_a_message(data_dir):
    m = mining.Miner(FakeEx([stmt(n, mining.REDACTED) for n in range(1, 4)]))
    out = m.start(30, now=NOW, background=False)
    assert out["state"] == "blocked" and out["reason"] == "redacted"
    assert "databricks_pii_access" in out["error"] and "nothing was mined" in out["error"]


def test_miner_reports_a_warehouse_error_as_failed(data_dir):
    m = mining.Miner(FakeEx([], fail="[INSUFFICIENT_PERMISSIONS] no SELECT on system.query.history"))
    out = m.start(30, now=NOW, background=False)
    assert out["state"] == "failed" and "INSUFFICIENT_PERMISSIONS" in out["error"]


def test_miner_needs_a_warehouse_and_runs_one_at_a_time(data_dir):
    with pytest.raises(mining.MiningInvalid, match="warehouse"):
        mining.Miner(FakeEx([], warehouse=None)).start(30, now=NOW)
    m = mining.Miner(FakeEx([]))
    m._status = {**mining._IDLE, "state": "running"}
    with pytest.raises(mining.MiningBusy):
        m.start(30, now=NOW)


def test_progress_phases_are_reported_in_order(data_dir):
    seen = []
    p = mining.plan("dev", 30, now=NOW)
    mining.run(FakeEx([stmt(1, Q_OS, lineage=[O, S])]), p, lambda phase, done=0, total=0: seen.append(phase))
    order = list(dict.fromkeys(seen))
    assert order == ["history", "lineage", "extract", "foreign_keys", "save"]


def test_state_file_survives_a_corrupt_write(data_dir):
    mining.state_path("dev").parent.mkdir(parents=True)
    mining.state_path("dev").write_text("{nope", encoding="utf-8")
    assert mining.load_state("dev") == {}
    assert json.loads(json.dumps(mining.plan("dev", 30, now=NOW)))["incremental"] is False
