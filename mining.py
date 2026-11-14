"""Query-history mining: join pairs and table usage from system.query.history, one explicit run at a time.

A run reads finished statements (and the tables each read, from system.access.table_lineage) for a time window
through the selected SQL warehouse, extracts the column pairs they join on (sqltools.join_pairs) and stores them
as `join_mined` edges with status "proposed". It never stores statement text or user names: only column names,
counts, dates and up to 5 statement ids per edge. The state that makes runs incremental (the last time mined, and
the usage summary) is a small JSON file next to the profile's relationship store.
"""
import json
import logging
import os
import threading
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from itertools import combinations

from pydantic import ValidationError

import dbx
import relationships
import sqltools

WINDOW_DAYS = 30
MAX_WINDOW_DAYS = 365  # system.query.history keeps a year
ROW_CAP = 5000  # statements read per run
SETTLE = timedelta(hours=1)  # history rows usually appear within an hour, so the newest hour is left for next time
TEXT_LIMIT = 100_000  # characters of statement text read; a longer statement will not parse and is counted as such
STATEMENT_TYPES = ("SELECT", "INSERT", "MERGE", "CREATE")
REDACTED = "<REDACTED>"
SAMPLE_REFS = 5
MAX_PAIR_TABLES = 25  # a statement that reads more tables than this adds none to the table-pair usage
KEEP_USAGE = 500  # usage rows kept per list between runs
HIDDEN_CATALOGS = ("system", "__databricks_internal")  # joins between Databricks' own tables are not the user's model


class MiningInvalid(ValueError):
    """The request cannot run (a bad window, no warehouse). Routes return HTTP 400."""


class MiningBusy(RuntimeError):
    """A run is already in progress. Routes return HTTP 409."""


class Redacted(RuntimeError):
    """The warehouse returned statement text as <REDACTED>, so there is nothing to mine."""


# ---------- the queries ----------

def _history_filter():
    types = ", ".join(f"'{t}'" for t in STATEMENT_TYPES)
    return (f"start_time >= CAST(:since AS TIMESTAMP) AND start_time < CAST(:until AS TIMESTAMP)\n"
            f"  AND execution_status = 'FINISHED' AND statement_type IN ({types})")


def history_sql(row_cap=ROW_CAP):
    """The statements to read: finished, SELECT-like, oldest first, capped."""
    return (f"SELECT statement_id, executed_by, start_time, left(statement_text, {TEXT_LIMIT}) AS statement_text\n"
            f"FROM system.query.history\nWHERE {_history_filter()}\n"
            f"ORDER BY start_time, statement_id\nLIMIT {int(row_cap)}")


def lineage_sql(row_cap=ROW_CAP):
    """The tables each of those statements read, by statement_id (SQL warehouse and serverless runs have one)."""
    return (f"WITH q AS (\n  SELECT statement_id FROM system.query.history\n  WHERE {_history_filter()}\n"
            f"  ORDER BY start_time, statement_id\n  LIMIT {int(row_cap)})\n"
            "SELECT DISTINCT l.statement_id, l.source_table_full_name\n"
            "FROM system.access.table_lineage l JOIN q ON l.statement_id = q.statement_id\n"
            "WHERE l.source_table_full_name IS NOT NULL\n"
            "  AND l.event_time >= CAST(:since AS TIMESTAMP) AND l.event_time < CAST(:until AS TIMESTAMP) + INTERVAL 1 DAY")


# ---------- time ----------

def _utcnow():
    return datetime.now(timezone.utc)


def _parse_ts(value):
    """A warehouse or ISO timestamp as an aware UTC datetime. Raises ValueError."""
    text = str(value).strip().replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _z(dt):
    """UTC ISO text with a Z, with microseconds only when there are some."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S" + (".%f" if dt.microsecond else "") + "Z")


# ---------- state (per profile, next to the relationship store) ----------

def state_path(profile):
    """data/relationships/<profile>.mining.json."""
    return dbx.DATA / "relationships" / f"{dbx.safe(profile)}.mining.json"


def load_state(profile):
    """The mining state for a profile: cursor, last run and usage. Empty when nothing was mined yet."""
    try:
        return json.loads(state_path(profile).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_state(profile, state):
    path = state_path(profile)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    os.replace(tmp, path)


# ---------- plan ----------

def plan(profile, window_days=WINDOW_DAYS, full=False, row_cap=ROW_CAP, now=None):
    """What a run would do, without running anything: the time window and the SQL, with its parameters.

    The first run (or `full`) reads the last `window_days` days. A later run is incremental: it starts where the
    last one stopped and `window_days` does not apply. The newest hour is left out, since rows may not be in yet.
    """
    if isinstance(window_days, bool) or not isinstance(window_days, int) or not 1 <= window_days <= MAX_WINDOW_DAYS:
        raise MiningInvalid(f"window_days: must be a whole number from 1 to {MAX_WINDOW_DAYS}")
    if isinstance(row_cap, bool) or not isinstance(row_cap, int) or row_cap < 1:
        raise MiningInvalid("row_cap: must be a positive whole number")
    state = load_state(profile)
    until = ((now or _utcnow()) - SETTLE).replace(microsecond=0)
    cursor = None
    if state.get("cursor") and not full:
        try:
            cursor = _parse_ts(state["cursor"])
        except ValueError:
            cursor = None
    since = min(cursor or until - timedelta(days=window_days), until)
    params = {"since": _z(since), "until": _z(until)}
    return {
        "since": params["since"], "until": params["until"], "window_days": window_days,
        "incremental": cursor is not None, "cursor": _z(cursor) if cursor else None, "row_cap": row_cap,
        "queries": [{"name": "query_history", "sql": history_sql(row_cap), "params": params},
                    {"name": "table_lineage", "sql": lineage_sql(row_cap), "params": params}],
    }


# ---------- the run ----------

class _Pair:
    """Evidence for one column pair while a run is reading statements."""

    def __init__(self):
        self.runs = 0
        self.users = set()
        self.first = self.last = None
        self.refs = deque(maxlen=SAMPLE_REFS)
        self.together = defaultdict(int)  # composite key (its column pairs) -> statements that joined on it

    def add(self, sid, user, day):
        self.runs += 1
        if user:
            self.users.add(user)
        self.first = day if self.first is None or day < self.first else self.first
        self.last = day if self.last is None or day > self.last else self.last
        if sid not in self.refs:
            self.refs.append(sid)


def _rows(result):
    names = [c["name"] for c in result["columns"]]
    return [dict(zip(names, r)) for r in result["rows"]]


def _read_names(tables):
    """Tables that count as the user's own: three-part names outside the Databricks catalogs."""
    return {t.lower() for t in tables if t and t.count(".") == 2 and t.split(".")[0].lower() not in HIDDEN_CATALOGS}


def _declared_fks(ex, table):
    """Column pairs declared as foreign keys on a table, as keys. Empty when the table cannot be read."""
    try:
        info = ex.object(table)["data"]
    except Exception:
        return None
    out = set()
    for con in info.get("table_constraints") or []:
        fk = con.get("foreign_key_constraint")
        if not fk:
            continue
        for child, parent in zip(fk.get("child_columns") or [], fk.get("parent_columns") or []):
            out.add(_key(table, child, fk["parent_table"], parent))
    return out


def _key(t1, c1, t2, c2):
    a, b = (t1.lower(), c1.lower()), (t2.lower(), c2.lower())
    return (*a, *b) if a <= b else (*b, *a)


def run(ex, p, progress=lambda phase, done=0, total=0: None):
    """Execute a plan: read, extract, check foreign keys, store. Returns the result counts.

    Raises Redacted when the statement text is hidden from this reader, before anything is stored or the
    cursor moves. Any warehouse error propagates (insufficient privileges on the system tables, for one).
    """
    quiet = logging.getLogger("sqlglot")  # it warns about every statement it falls back to a Command for
    level, quiet.level = quiet.level, logging.ERROR
    try:
        return _run(ex, p, progress)
    finally:
        quiet.level = level


def _run(ex, p, progress):
    since, until, cap = p["since"], p["until"], p["row_cap"]
    state = load_state(ex.profile)
    skip_ids = set(state.get("cursor_ids") or []) if p["incremental"] else set()
    q_hist, q_lin = p["queries"]

    progress("history")
    history = _rows(ex.query(q_hist["sql"], q_hist["params"], max_rows=cap))
    capped = len(history) >= cap
    redacted = sum(1 for r in history if (r.get("statement_text") or "").strip() == REDACTED)
    if history and redacted * 2 >= len(history):
        raise Redacted(f"statement_text came back as {REDACTED} for {redacted} of {len(history)} statements")
    rows = [r for r in history if r["statement_id"] not in skip_ids]

    progress("lineage")
    lineage = defaultdict(set)
    if rows:
        for r in _rows(ex.query(q_lin["sql"], q_lin["params"], max_rows=cap * 50)):
            lineage[r["statement_id"]].add(r["source_table_full_name"])

    pairs = defaultdict(_Pair)
    users_by_table, runs_by_table = defaultdict(set), defaultdict(int)
    users_by_pair, runs_by_pair = defaultdict(set), defaultdict(int)
    parsed = with_joins = unparsed = redacted_skipped = no_lineage = 0
    for i, r in enumerate(rows):
        progress("extract", i, len(rows))
        text, sid, user = r.get("statement_text") or "", r["statement_id"], r.get("executed_by")
        if text.strip() == REDACTED or not text.strip():
            redacted_skipped += 1
            continue
        read = _read_names(lineage.get(sid, ()))
        no_lineage += not lineage.get(sid)
        try:
            found, composites = sqltools.join_analysis(text, known=lineage.get(sid))
            if not read:
                read = _read_names(_safe_tables(text))
        except ValueError:
            unparsed += 1
            continue
        parsed += 1
        day = str(r["start_time"])[:10]
        for t in read:
            runs_by_table[t] += 1
            if user:
                users_by_table[t].add(user)
        if 2 <= len(read) <= MAX_PAIR_TABLES:
            for a, b in combinations(sorted(read), 2):
                runs_by_pair[(a, b)] += 1
                if user:
                    users_by_pair[(a, b)].add(user)
        mine = [j for j in found if not {j.left_table.split(".")[0], j.right_table.split(".")[0]} & set(HIDDEN_CATALOGS)]
        with_joins += bool(mine)
        for j in mine:
            pairs[_key(j.left_table, j.left_column, j.right_table, j.right_column)].add(sid, user, day)
        for keys in composites:
            members = [_key(*k) for k in keys]
            if all(k in pairs for k in members):  # all of them, so none is in a Databricks catalog
                columns = tuple((k[1], k[3]) for k in members)
                for k in members:
                    pairs[k].together[columns] += 1
    progress("extract", len(rows), len(rows))

    # Pairs that are declared foreign keys are not suggestions.
    tables = sorted({t for k in pairs for t in (k[0], k[2])})
    declared, unreadable = set(), 0
    for i, t in enumerate(tables):
        progress("foreign_keys", i, len(tables))
        fks = _declared_fks(ex, t)
        if fks is None:
            unreadable += 1
        else:
            declared |= fks
    skipped_fk = sum(1 for k in pairs if k in declared)

    progress("save")
    fetched = dbx.now()
    edges, invalid = [], 0
    for k, ev in pairs.items():
        if k in declared:
            continue
        try:
            edges.append(relationships.Edge(
                kind="join_mined", directed=False, status="proposed",
                source=relationships.Endpoint(table=k[0], column=k[1]),
                target=relationships.Endpoint(table=k[2], column=k[3]),
                provenance=relationships.Provenance(origin="query_history", source_ref=ev.refs[-1], fetched_at=fetched),
                evidence=relationships.Evidence(runs=ev.runs, users=len(ev.users), first_seen=ev.first, last_seen=ev.last,
                                                sample_refs=list(reversed(ev.refs)), together=_together(ev))))
        except ValidationError:
            invalid += 1
    with relationships.open_store(ex.profile) as store:
        created, updated = store.upsert_mined(edges, replace=not p["incremental"] and bool(state.get("cursor")))

    usage = _merge_usage(state.get("usage"), p, len(rows), runs_by_table, users_by_table, runs_by_pair, users_by_pair)
    if capped and history:
        stop = history[-1]["start_time"]
        cursor, cursor_ids = _z(_parse_ts(stop)), [r["statement_id"] for r in history if r["start_time"] == stop]
    else:
        cursor, cursor_ids = until, []
    result = {"statements": len(rows), "parsed": parsed, "with_joins": with_joins, "unparsed": unparsed,
              "redacted_skipped": redacted_skipped, "no_lineage": no_lineage, "pairs": len(edges),
              "skipped_fk": skipped_fk, "fk_unreadable_tables": unreadable, "invalid": invalid,
              "created": created, "updated": updated, "capped": capped, "since": since,
              "until": cursor if capped else until, "finished_at": dbx.now()}
    _save_state(ex.profile, {"cursor": cursor, "cursor_ids": cursor_ids, "last_run": result, "usage": usage})
    return result


def _together(ev):
    """The composite keys a pair was part of, most runs first."""
    top = sorted(ev.together.items(), key=lambda kv: (-kv[1], kv[0]))[:relationships.MAX_TOGETHER]
    return [relationships.Together(columns=list(cols), runs=n) for cols, n in top]


def _safe_tables(text):
    """Fully qualified table names a statement reads, or none when sqlglot cannot say."""
    try:
        return sqltools.tables_read(text)
    except ValueError:
        return []


# ---------- usage summary ----------

def _top(counts, users, keep):
    rows = sorted(((k, c, len(users.get(k, ()))) for k, c in counts.items()), key=lambda x: (-x[1], -x[2], x[0]))
    return rows[:keep]


def _merge_usage(old, p, statements, runs_by_table, users_by_table, runs_by_pair, users_by_pair):
    """The usage summary kept in state. Counts of an incremental run are added to the earlier ones, with the
    larger of the two distinct-user counts (users are not kept, so across runs that is a lower bound)."""
    tables = {t: [r, u] for t, r, u in _top(runs_by_table, users_by_table, KEEP_USAGE)}
    pairs = {"\t".join(k): [r, u] for k, r, u in _top(runs_by_pair, users_by_pair, KEEP_USAGE)}
    since = p["since"]
    if p["incremental"] and old:
        for mine, theirs in ((tables, old.get("tables", {})), (pairs, old.get("pairs", {}))):
            for k, (r, u) in theirs.items():
                a = mine.get(k, [0, 0])
                mine[k] = [a[0] + r, max(a[1], u)]
        since = old.get("since", since)
        statements += old.get("statements", 0)

    def keep(d):
        return dict(sorted(d.items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))[:KEEP_USAGE])
    return {"since": since, "until": p["until"], "statements": statements, "tables": keep(tables), "pairs": keep(pairs)}


def usage_summary(profile, limit=10):
    """Top tables by runs and distinct users, and top table pairs read together, for the mined window."""
    u = load_state(profile).get("usage")
    if not u:
        return {"window": None, "statements": 0, "tables": [], "pairs": []}
    return {"window": {"since": u["since"], "until": u["until"]}, "statements": u["statements"],
            "tables": [{"table": t, "runs": r, "users": n} for t, (r, n) in list(u["tables"].items())[:limit]],
            "pairs": [{"tables": k.split("\t"), "runs": r, "users": n} for k, (r, n) in list(u["pairs"].items())[:limit]]}


# ---------- one run at a time, in the background ----------

_IDLE = {"state": "idle", "phase": None, "progress": {"done": 0, "total": 0}, "started_at": None, "finished_at": None,
         "plan": None, "result": None, "error": None, "reason": None}

class Miner:
    """Runs mining in a thread for one connection and reports progress. One run at a time."""

    def __init__(self, explorer):
        self.ex = explorer
        self.lock = threading.Lock()
        self._status = _IDLE

    def start(self, window_days=WINDOW_DAYS, full=False, row_cap=ROW_CAP, background=True, now=None):
        """Start a run. MiningInvalid for a bad request or no warehouse, MiningBusy when one is running."""
        with self.lock:
            if self._status["state"] == "running":
                raise MiningBusy("a mining run is already in progress")
            if not self.ex.warehouse_id:
                raise MiningInvalid("pick a SQL warehouse: mining reads the system tables through it")
            p = plan(self.ex.profile, window_days, full, row_cap, now)
            self._status = {**_IDLE, "state": "running", "phase": "history", "started_at": dbx.now(), "plan": _summary(p)}
        if background:
            threading.Thread(target=self._work, args=(p,), daemon=True).start()
        else:
            self._work(p)
        return self.status()

    def _progress(self, phase, done=0, total=0):
        with self.lock:
            self._status.update(phase=phase, progress={"done": done, "total": total})

    def _work(self, p):
        try:
            result = run(self.ex, p, self._progress)
            end = {"state": "succeeded", "result": result}
        except Redacted as e:
            end = {"state": "blocked", "reason": "redacted", "error": (
                f"{e}. Query text is only readable by an account admin or a member of databricks_pii_access, "
                "so nothing was mined and nothing was stored.")}
        except Exception as e:  # warehouse errors, missing access to the system tables
            end = {"state": "failed", "error": dbx.clean_error(e)}
        with self.lock:
            self._status.update(end, phase=None, finished_at=dbx.now())

    def status(self):
        """The current or latest run in this process, with the last stored run from an earlier one."""
        with self.lock:
            out = dict(self._status)
        out["last_run"] = load_state(self.ex.profile).get("last_run")
        return out


def _summary(p):
    return {k: p[k] for k in ("since", "until", "window_days", "incremental", "row_cap")}
