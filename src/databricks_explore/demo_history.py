"""Demo mode's invented query history, table lineage and column lineage, as the warehouse's system tables return them.

Everything is invented and deterministic (the statements, users and their order never change; the timestamps are
anchored to the start of the current UTC day). `system_query` answers the SQL that mining.py and
Explorer.column_lineage send, filtering on the same parameters the real tables would.

Set EXPLORER_DEMO_REDACTED=1 (databricks-explore --demo --redacted) to make every statement_text read <REDACTED>, as it does
for a reader who is neither an account admin nor in databricks_pii_access. Without it, three rows are redacted, so
a run reports them as skipped.
"""
import os
import random
import re
from datetime import datetime, timedelta, timezone

USERS = ["ana.k@example.invalid", "ben.o@example.invalid", "chloe.m@example.invalid", "dev.p@example.invalid",
         "elif.s@example.invalid", "farid.n@example.invalid"]
REDACTED = "<REDACTED>"
LINEAGE_SEEN = "2026-11-10T08:00:00.000Z"

O, C, I, P = "demo.sales.orders", "demo.sales.customers", "demo.sales.order_items", "demo.sales.products"
R, S, E, D = "demo.sales.returns", "demo.sales.shipments", "demo.hr.employees", "demo.hr.departments"
T, V = "samples.nyctaxi.trips", "demo.sales.v_daily_revenue"
SYS = ["system.access.table_lineage", "system.query.history"]

# source table, source column, target table, target column
COLUMN_LINEAGE = [
    (O, "order_date", V, "order_date"), (O, "amount", V, "revenue"), (O, "order_id", V, "orders"),
    (T, "trip_id", "demo.metrics.wide_metrics", "id"), (T, "pickup_ts", "demo.metrics.wide_metrics", "event_ts"),
    (T, "distance_mi", "demo.metrics.wide_metrics", "metric_01_throughput_per_sec"),
    (T, "fare", "demo.metrics.wide_metrics", "metric_02_error_rate"),
]

# (count, user indexes, statement type, status, lineage tables or None for no lineage row, SQL with {date}/{email})
_SPECS = [
    (70, [0, 1, 2, 3, 4, 5], "SELECT", "FINISHED", [O, C],
     "SELECT o.order_id, c.name, o.amount FROM demo.sales.orders o JOIN demo.sales.customers c "
     "ON o.customer_id = c.customer_id WHERE c.email = '{email}' AND o.order_date >= '{date}'"),
    (60, [0, 1, 3], "SELECT", "FINISHED", [I, P],
     "SELECT i.order_id, p.category, SUM(i.qty * i.unit_price) AS revenue FROM demo.sales.order_items i "
     "INNER JOIN demo.sales.products p ON i.sku = p.sku WHERE p.list_price > 10 GROUP BY 1, 2"),
    (35, [1, 2, 4], "SELECT", "FINISHED", [O, R],
     "SELECT o.order_id, r.reason FROM demo.sales.orders o, demo.sales.returns r "
     "WHERE o.order_id = r.order_id AND r.returned_at > '{date}'"),
    (30, [0, 2, 5], "SELECT", "FINISHED", [O, C, S],
     "WITH recent AS (SELECT order_id AS oid, customer_id AS cid, amount FROM demo.sales.orders "
     "WHERE order_date >= '{date}'), shipped AS (SELECT * FROM demo.sales.shipments) "
     "SELECT c.name, recent.amount, s.carrier FROM recent JOIN demo.sales.customers c ON c.customer_id = recent.cid "
     "LEFT JOIN shipped s ON s.order_id = recent.oid"),
    (25, [1, 3], "SELECT", "FINISHED", [I, R],
     "SELECT * FROM demo.sales.order_items i LEFT JOIN demo.sales.returns r USING (order_id, line_no)"),
    (20, [0, 4], "SELECT", "FINISHED", [I, S],
     "SELECT i.order_id, i.units, s.carrier FROM (SELECT order_id, SUM(qty) AS units FROM demo.sales.order_items "
     "GROUP BY order_id) i JOIN demo.sales.shipments s ON s.order_id = i.order_id"),
    (22, [5, 2], "SELECT", "FINISHED", [E, D],
     "SELECT e.name, d.budget FROM demo.hr.employees e JOIN demo.hr.departments d ON e.dept = d.dept"),
    (8, [5], "SELECT", "FINISHED", [E, D],
     "SELECT d.dept, e.name AS manager FROM demo.hr.departments d JOIN demo.hr.employees e ON e.emp_id = d.manager_id"),
    (25, [1, 2, 3, 4], "SELECT", "FINISHED", [O, S],  # short names: the lineage rows say which tables they are
     "SELECT * FROM orders o JOIN shipments s ON s.order_id = o.order_id WHERE s.shipped_at >= '{date}'"),
    (6, [2], "SELECT", "FINISHED", None,  # a notebook run: no lineage row, short names cannot be resolved
     "SELECT * FROM orders o JOIN shipments s ON s.order_id = o.order_id"),
    (5, [3], "MERGE", "FINISHED", [I],
     "MERGE INTO demo.sales.returns t USING (SELECT order_id, line_no FROM demo.sales.order_items) s "
     "ON t.order_id = s.order_id AND t.line_no = s.line_no WHEN MATCHED THEN UPDATE SET t.reason = 'merged'"),
    (10, [0, 1], "SELECT", "FINISHED", [O, R],
     "SELECT * FROM demo.sales.orders o WHERE EXISTS (SELECT 1 FROM demo.sales.returns r WHERE r.order_id = o.order_id)"),
    (60, [0, 1, 2, 3, 4, 5], "SELECT", "FINISHED", [O],
     "SELECT count(*) FROM demo.sales.orders WHERE status = 'shipped' AND order_date >= '{date}'"),
    (25, [4, 5], "SELECT", "FINISHED", [T], "SELECT zone, avg(fare) FROM samples.nyctaxi.trips GROUP BY zone"),
    (20, [0, 2], "SELECT", "FINISHED", [V], "SELECT * FROM demo.sales.v_daily_revenue ORDER BY order_date DESC"),
    (4, [1], "SELECT", "FINISHED", [O, C],  # does not parse
     "SELECT o.order_id FROM demo.sales.orders o JOIN demo.sales.customers c ON (o.customer_id = c.customer_id"),
    (3, [3], "SELECT", "FINISHED", [O], "SELECT * FROM (SELECT * FROM demo.sales.orders"),
    (3, [2], "SELECT", "FINISHED", [O, C], "SELECT o.order_id FROM demo.sales.orders o LEFT JOIN demo.sales.customers c ON c.customer_id = o.customer_id WHERE"),
    (5, [4], "SELECT", "FINISHED", [O, C],  # unqualified columns, two tables: no way to know which side each is on
     "SELECT * FROM demo.sales.orders JOIN demo.sales.customers ON customer_id = lifetime_value"),
    (6, [1], "SELECT", "FAILED", [O, S],  # failed runs are not read
     "SELECT * FROM demo.sales.orders o JOIN demo.sales.shipments s ON s.shipped_at = o.order_ts"),
    (8, [0, 2], "SHOW", "FINISHED", None, "SHOW TABLES IN demo.sales"),
    (5, [0], "SELECT", "FINISHED", SYS,  # Databricks' own tables are not the user's data model
     "SELECT * FROM system.access.table_lineage l JOIN system.query.history h ON l.statement_id = h.statement_id"),
]
_REDACTED_ROWS = 3  # in an ordinary demo, this many rows read <REDACTED>
_DATES = ["2026-09-01", "2026-09-15", "2026-10-01", "2026-10-20"]
_EMAILS = ["jane.doe@example.invalid", "li.wei@example.invalid", "sam.o@example.invalid"]

_cache = {}


def redacted_mode():
    """True when every statement_text should read <REDACTED> (EXPLORER_DEMO_REDACTED=1)."""
    return os.environ.get("EXPLORER_DEMO_REDACTED") == "1"


def _base():
    return datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)


def _fmt(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def history():
    """Every invented statement, oldest first: dicts with the columns of system.query.history and a `tables` list."""
    base = _base()
    if base in _cache:
        return _cache[base]
    r = random.Random(20261113)
    rows = []
    for count, users, kind, status, tables, sql in _SPECS:
        for _ in range(count):
            when = base - timedelta(hours=r.uniform(2, 38 * 24))
            rows.append({"executed_by": USERS[r.choice(users)], "start_time": when, "statement_type": kind,
                         "execution_status": status, "tables": tables,
                         "statement_text": sql.format(date=r.choice(_DATES), email=r.choice(_EMAILS))})
    rows.sort(key=lambda x: x["start_time"])
    for n, row in enumerate(rows, 1):
        row["statement_id"] = f"demo-hist-{n:04d}"
    for k in range(1, _REDACTED_ROWS + 1):  # a few, spread out
        rows[len(rows) * k // (_REDACTED_ROWS + 1)]["redacted"] = True
    _cache.clear()
    _cache[base] = rows
    return rows


def _param_time(params, name):
    return datetime.fromisoformat(str(params[name]).replace("Z", "+00:00"))


def _selected(low, params, cap):
    """The statements the history query's WHERE and LIMIT would return."""
    since, until = _param_time(params, "since"), _param_time(params, "until")
    types = re.search(r"statement_type in \(([^)]*)\)", low)
    wanted = set(re.findall(r"'(\w+)'", types.group(1))) if types else None
    rows = [x for x in history()
            if since <= x["start_time"] < until and x["execution_status"] == "FINISHED"
            and (wanted is None or x["statement_type"].lower() in {w.lower() for w in wanted})]
    return rows[:cap]


def system_query(low, params, cap):
    """(columns, rows) for a statement on system.query.history, system.access.table_lineage or column_lineage."""
    strs = lambda *names: [{"name": n, "type": "STRING"} for n in names]  # noqa: E731
    if "column_lineage" in low:
        t = (params or {}).get("t")
        hits = [c for c in COLUMN_LINEAGE if t in (c[0], c[2])]
        return (strs("source_table_full_name", "source_column_name", "target_table_full_name", "target_column_name",
                     "last_seen"), [[a, b, c, d, LINEAGE_SEEN] for a, b, c, d in hits])
    rows = _selected(low, params, cap)
    if "table_lineage" in low:
        return (strs("statement_id", "source_table_full_name"),
                [[x["statement_id"], t] for x in rows if x["tables"] for t in x["tables"]])
    redact_all = redacted_mode()
    return (strs("statement_id", "executed_by", "start_time", "statement_text"),
            [[x["statement_id"], x["executed_by"], _fmt(x["start_time"]),
              REDACTED if redact_all or x.get("redacted") else x["statement_text"]] for x in rows])
