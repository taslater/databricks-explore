"""Demo mode: a fake Databricks workspace with invented data, so every real route works offline.

dbx.py swaps `WorkspaceClient` for `FakeWorkspaceClient` when EXPLORER_DEMO=1 (`databricks-explore --demo`).
Nothing here talks to a network. Everything is invented and deterministic.

Magic words in SQL (matched anywhere in the statement, case-insensitive):
  demo_slow   stays RUNNING for DEMO_SLOW_SECONDS (to test Cancel)
  demo_error  fails with a table-not-found message
  demo_wide   a 60-column result
  demo_big    50,000 rows, so the row cap and the truncated badge show up
Otherwise the result follows the first demo table named in the SQL (orders when none is named).
The system tables system.query.history and system.access.table_lineage / column_lineage are answered by demo_history.py.
The information_schema tag tables (catalog_tags ... column_tags) answer with the few tags in TAGS.
"""
import json
import random
import re
import time
import zlib
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace

import sqlglot
from . import demo_history
from databricks.sdk.service import catalog as uc
from databricks.sdk.service import iam
from databricks.sdk.service import sql as sqlsvc

PROFILES = [{"name": "demo", "host": "https://demo.invalid", "auth_type": "demo"}]
WAREHOUSES = [("demo-wh-1", "Demo Serverless", sqlsvc.State.RUNNING),
              ("demo-wh-2", "Demo Pro", sqlsvc.State.STOPPED)]

NORMAL_DELAY = 0.5        # seconds an ordinary statement stays RUNNING, so the UI shows a timer
SLOW_DELAY = 45.0         # seconds a `demo_slow` statement stays RUNNING
CHUNK_ROWS = 1000         # rows per result chunk, so the chunked reader is exercised
BIG_ROWS = 50_000


class DemoError(Exception):
    """A statement the fake warehouse rejects (surfaces as a FAILED statement)."""


# ---------------------------------------------------------------- catalog

CATALOGS = {"demo": "Invented demo data", "samples": "Invented sample datasets"}

# name, type text, comment
ORDERS = [("order_id", "bigint", "Primary key"), ("customer_id", "bigint", "Customer who placed the order"),
          ("order_ts", "timestamp", None), ("order_date", "date", None), ("status", "string", None),
          ("amount", "decimal(12,2)", "Order total in dollars"), ("discount_pct", "double", None),
          ("is_gift", "boolean", None), ("notes", "string", "Free text, can be long"),
          ("tags", "array<string>", None), ("shipping", "struct<city:string,zip:string>", None)]
CUSTOMERS = [("customer_id", "bigint", "Primary key"), ("name", "string", None), ("email", "string", None),
             ("country", "string", None), ("signup_date", "date", None), ("lifetime_value", "decimal(24,6)", None)]
ITEMS = [("order_id", "bigint", None), ("line_no", "int", None), ("sku", "string", None),
         ("qty", "int", None), ("unit_price", "decimal(10,2)", None)]
REVENUE = [("order_date", "date", None), ("revenue", "decimal(14,2)", None), ("orders", "bigint", None)]
EMPLOYEES = [("emp_id", "bigint", "Primary key"), ("name", "string", None), ("dept", "string", None),
             ("salary", "decimal(10,2)", None), ("hired_at", "timestamp", None)]
WIDE = [("id", "bigint", None), ("event_ts", "timestamp", None)] + [
    (f"metric_{i:02d}_{['latency_ms', 'throughput_per_sec', 'error_rate', 'queue_depth'][i % 4]}",
     ["double", "bigint", "decimal(18,6)", "int"][i % 4], None) for i in range(1, 59)]
TRIPS = [("trip_id", "bigint", None), ("pickup_ts", "timestamp", None), ("dropoff_ts", "timestamp", None),
         ("distance_mi", "double", None), ("fare", "decimal(8,2)", None), ("zone", "string", None)]

PRODUCTS = [("sku", "string", "Stock keeping unit"), ("name", "string", None), ("category", "string", None),
            ("list_price", "decimal(10,2)", None)]
RETURNS = [("return_id", "bigint", "Primary key"), ("order_id", "bigint", None), ("line_no", "int", None),
           ("reason", "string", None), ("returned_at", "timestamp", None)]
SHIPMENTS = [("shipment_id", "bigint", "Primary key"), ("order_id", "bigint", None), ("carrier", "string", None),
             ("shipped_at", "timestamp", None)]
DEPARTMENTS = [("dept", "string", "Department name"), ("manager_id", "bigint", "Employee who runs it"),
               ("budget", "decimal(12,2)", None)]

# full name -> (table type, columns, comment, row count)
TABLES = {
    "demo.sales.products": ("MANAGED", PRODUCTS, "Product catalog", 300),
    "demo.sales.returns": ("MANAGED", RETURNS, "Returned order lines", 400),
    "demo.sales.shipments": ("MANAGED", SHIPMENTS, "Shipments per order", 2500),
    "demo.hr.departments": ("MANAGED", DEPARTMENTS, "Departments", 5),
    "demo.sales.orders": ("MANAGED", ORDERS, "Customer orders", 3000),
    "demo.sales.customers": ("MANAGED", CUSTOMERS, "Customer master", 800),
    "demo.sales.order_items": ("MANAGED", ITEMS, "Order lines", 4000),
    "demo.sales.v_daily_revenue": ("VIEW", REVENUE, "Daily revenue rollup", 240),
    "demo.hr.employees": ("MANAGED", EMPLOYEES, "Staff", 120),
    "demo.metrics.wide_metrics": ("MANAGED", WIDE, "60-column telemetry table", 800),
    "samples.nyctaxi.trips": ("EXTERNAL", TRIPS, "Sample trips", 2500),
    "samples.tpch.lineitem": ("MANAGED", ITEMS, "Sample order lines", 3000),
}
# child table, parent table, child column, parent column
FOREIGN_KEYS = [("demo.sales.orders", "demo.sales.customers", "customer_id", "customer_id"),
                ("demo.sales.order_items", "demo.sales.orders", "order_id", "order_id")]
# Tables whose primary key is not just the first column: an order line is keyed by its order and its line number.
COMPOSITE_KEYS = {"demo.sales.order_items": ["order_id", "line_no"], "samples.tpch.lineitem": ["order_id", "line_no"]}
VIEW_DEPS = {"demo.sales.v_daily_revenue": ["demo.sales.orders"]}
# upstream table, downstream table, producing job id
LINEAGE = [("demo.sales.orders", "demo.sales.v_daily_revenue", "1001"),
           ("samples.nyctaxi.trips", "demo.metrics.wide_metrics", "1002")]
LINEAGE_SEEN = "2026-11-10T08:00:00.000Z"
# Unity Catalog tags: scope, catalog, schema, table, column, tag name, tag value (an empty value is a bare label)
TAGS = [("catalog", "demo", None, None, None, "environment", "sandbox"),
        ("schema", "demo", "sales", None, None, "domain", "sales"),
        ("table", "demo", "sales", "orders", None, "domain", "sales"),
        ("table", "demo", "sales", "customers", None, "domain", "sales"),
        ("table", "demo", "sales", "orders", None, "certified", ""),
        ("table", "demo", "hr", "employees", None, "sensitivity", "confidential"),
        ("column", "demo", "sales", "customers", "email", "pii", "email"),
        ("column", "demo", "sales", "customers", "name", "pii", "name"),
        ("column", "demo", "hr", "employees", "salary", "sensitivity", "confidential")]


def _type_name(type_text):
    base = re.split(r"[(<]", type_text)[0].upper()
    return {"BIGINT": "LONG"}.get(base, base)


def _table_info(full_name):
    if full_name not in TABLES:
        raise LookupError(f"[TABLE_OR_VIEW_NOT_FOUND] {full_name}")
    kind, cols, comment, _ = TABLES[full_name]
    c, s, n = full_name.split(".")
    constraints = [uc.TableConstraint(primary_key_constraint=uc.PrimaryKeyConstraint(
        name=f"pk_{n}", child_columns=COMPOSITE_KEYS.get(full_name, [cols[0][0]])))] if kind == "MANAGED" and n != "wide_metrics" else []
    constraints += [uc.TableConstraint(foreign_key_constraint=uc.ForeignKeyConstraint(
        name=f"fk_{cn}_{pn}", child_columns=[cc], parent_table=pt, parent_columns=[pc]))
        for ct, pt, cc, pc in FOREIGN_KEYS if ct == full_name for cn, pn in [(n, pt.split(".")[2])]]
    deps = VIEW_DEPS.get(full_name)
    return uc.TableInfo(
        name=n, catalog_name=c, schema_name=s, full_name=full_name, comment=comment,
        table_type=uc.TableType.VIEW if kind == "VIEW" else uc.TableType[kind],
        columns=[uc.ColumnInfo(name=cn, type_text=tt, type_name=uc.ColumnTypeName[_type_name(tt)],
                               position=i, comment=cm, nullable=i > 0) for i, (cn, tt, cm) in enumerate(cols)],
        table_constraints=constraints or None,
        view_dependencies=uc.DependencyList(dependencies=[
            uc.Dependency(table=uc.TableDependency(table_full_name=d)) for d in deps]) if deps else None)


# ---------------------------------------------------------------- data

STATUSES = ["shipped", "pending", "cancelled", "returned", "processing"]
CITIES = ["Zurich", "Sao Paulo", "Reykjavik", "Portland", "Osaka", "Nairobi", "Hamburg"]
COUNTRIES = ["US", "DE", "BR", "JP", "KE", "IS"]
DEPTS = ["Finance", "Support", "Logistics", "Engineering", "Marketing"]
NOTES = ["", "Leave at door", "Caller said: \"ring first\", then hung up.\nSecond line of the note.",
         "Gift wrap, include a card that reads: happy birthday from everyone at the front desk. "
         "Please sign for it on delivery between 9 and 5 and do not leave it in the lobby. " * 2,
         "tab\tseparated\tnote", "O'Brien's order; 100% rush", "plain note"]
BIG_DECIMAL = "99999999999999999999.123456789012"


def _fmt_ts(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _cell(name, type_text, i, r, first):
    """One invented cell as the warehouse would return it: a string, or None for NULL."""
    base = re.split(r"[(<]", type_text)[0].lower()
    if not first and r.random() < 0.05:
        return None
    if base in ("bigint", "int"):
        if first:
            return str(100000 + i)
        return str(r.randint(1, 800) if name.endswith("_id") else r.randint(-5, 5000))
    if base == "decimal":
        if name == "lifetime_value" and i == 7:
            return BIG_DECIMAL
        scale = int(type_text.split(",")[1].rstrip(")"))
        return f"{r.lognormvariate(4.2, 1.1):.{scale}f}"
    if base == "double":
        return str(round(r.random() * 0.3, 4)) if "pct" in name else f"{r.gauss(100, 30):.6f}"
    if base == "boolean":
        return r.choice(["true", "false"])
    if base == "date":
        return (date(2026, 1, 1) + timedelta(days=r.randint(0, 300))).isoformat()
    if base == "timestamp":
        dt = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=r.randint(0, 300 * 86400))
        if r.random() < 0.4:
            dt = dt.replace(microsecond=r.randint(0, 999) * 1000)
        return _fmt_ts(dt)
    if base == "array":
        return json.dumps(r.sample(["a", "b", "vip", "promo"], r.randint(0, 3)))
    if base == "struct":
        return json.dumps({"city": r.choice(CITIES), "zip": str(r.randint(10000, 99999))})
    if name == "status":
        return r.choice(STATUSES)
    if name == "notes":
        return r.choice(NOTES)
    if name == "email":
        return f"user{i + 1}@example.invalid"
    if name == "name":
        return f"Customer {i + 1} {r.choice(['Holdings', 'Trading Co', 'and Sons', 'International Partners'])}"
    if name == "country":
        return r.choice(COUNTRIES)
    if name == "dept":
        return r.choice(DEPTS)
    if name == "zone":
        return r.choice(CITIES)
    return f"{name}_{r.randint(1, 50)}"


def table_rows(full_name, n):
    """n invented rows of a demo table as (columns, rows). Deterministic per table."""
    cols = TABLES[full_name][1]
    r = random.Random(zlib.crc32(full_name.encode()))
    rows = [[_cell(cn, tt, i, r, k == 0) for k, (cn, tt, _) in enumerate(cols)] for i in range(n)]
    return [{"name": cn, "type": _type_name(tt), "type_text": tt} for cn, tt, _ in cols], rows


def _daily_revenue(n):
    r = random.Random(1)
    cols = [{"name": "order_date", "type": "DATE"}, {"name": "status", "type": "STRING"},
            {"name": "revenue", "type": "DECIMAL"}, {"name": "orders", "type": "LONG"}]
    rows = [[(date(2026, 7, 1) + timedelta(days=d)).isoformat(), st, f"{r.uniform(2000, 90000):.2f}",
             str(r.randint(20, 400))] for d in range(120) for st in ("shipped", "pending", "returned")]
    return cols, rows[:n]


def _literal_select(sql):
    """A FROM-less SELECT of literals: one row with the aliases the query chose. Falls back to a canned row."""
    try:
        node = sqlglot.parse_one(sql, read="databricks")
        cols, row = [], []
        for e in node.expressions:
            lit = e.this if isinstance(e, sqlglot.exp.Alias) else e
            if isinstance(lit, sqlglot.exp.Literal):
                kind = "STRING" if lit.is_string else ("INT" if lit.is_int else "DOUBLE")
                cols.append({"name": e.alias_or_name or f"col{len(cols) + 1}", "type": kind})
                row.append(lit.name)
            else:
                raise ValueError("not a literal")
        return cols, [row]
    except Exception:
        return ([{"name": "one", "type": "INT"}, {"name": "pi", "type": "DOUBLE"}, {"name": "s", "type": "STRING"}],
                [["1", "3.14159", "hello"]])


def _project(sql, cols, rows):
    """Honors a plain column list (`SELECT a, b AS c FROM t`) over a table's columns. Anything else passes through."""
    try:
        node = sqlglot.parse_one(sql, read="databricks")
        if not isinstance(node, sqlglot.exp.Select) or node.args.get("with_"):
            return cols, rows
        names = [c["name"] for c in cols]
        picks = []  # (source index, output name)
        for e in node.expressions:
            inner = e.this if isinstance(e, sqlglot.exp.Alias) else e
            if isinstance(inner, sqlglot.exp.Star):
                picks += list(enumerate(names))
            elif isinstance(inner, sqlglot.exp.Column) and inner.name in names:
                picks.append((names.index(inner.name), e.alias_or_name))
            else:
                return cols, rows
        return ([{**cols[i], "name": n} for i, n in picks],
                [[r[i] for i, _ in picks] for r in rows])
    except Exception:
        return cols, rows


def result_for(statement, params=None):
    """(columns, rows) for any SQL. Raises DemoError for the `demo_error` magic word."""
    low = " ".join(statement.split()).lower()
    if "demo_error" in low:
        raise DemoError("[TABLE_OR_VIEW_NOT_FOUND] The table or view `demo_error` cannot be found. "
                        "Verify the spelling and correctness of the schema and catalog. SQLSTATE: 42P01; line 1, pos 14")
    limits = [int(x) for x in re.findall(r"\blimit\s+(\d+)", low)]
    cap = min(limits) if limits else None
    wrapped = re.match(r"^select \* from \((.*)\) limit \d+$", low)  # the row-cap wrapper the Explorer adds
    wrapped_sql = None
    if wrapped:
        low = wrapped.group(1)
        inner = re.match(r"^\s*select\s+\*\s+from\s+\((.*)\)\s+limit\s+\d+\s*$", statement, re.I | re.S)
        wrapped_sql = inner.group(1) if inner else low
    if re.search(r"\bsystem\.(query\.history|access\.(table|column)_lineage)\b", low):
        return demo_history.system_query(low, params, cap or 5000)
    if re.search(r"\binformation_schema\.(catalog|schema|table|column)_tags\b", low):
        cols = [{"name": k, "type": "STRING"} for k in
                ("scope", "catalog_name", "schema_name", "table_name", "column_name", "tag_name", "tag_value")]
        return cols, [list(t) for t in TAGS][: cap or len(TAGS)]
    if "information_schema.tables" in low:
        q = str((params or {}).get("q", "")).lower()
        hits = [(f.split(".")[0], f.split(".")[1], f.split(".")[2], "VIEW" if v[0] == "VIEW" else "BASE TABLE")
                for f, v in sorted(TABLES.items()) if q in f.split(".")[2]]
        cols = [{"name": k, "type": "STRING"} for k in ("table_catalog", "table_schema", "table_name", "table_type")]
        return cols, [list(h) for h in hits][: cap or 300]
    if re.match(r"^(create|insert|drop|alter|use|set|optimize|vacuum|grant|merge|update|delete|truncate)\b", low):
        return [], []
    if re.match(r"^select\s+[\d'\"(]", low) and " from " not in low:
        return _literal_select(statement if not wrapped else wrapped_sql)
    if "demo_big" in low:
        cols, rows = table_rows("demo.sales.orders", min(cap or BIG_ROWS, BIG_ROWS))
        return cols, rows
    if "demo_wide" in low:
        return table_rows("demo.metrics.wide_metrics", min(cap or 800, 800))
    if re.search(r"group\s+by|count\(", low):
        cols, rows = _daily_revenue(cap or 360)
        return cols, rows
    table = next((t for t in TABLES if t in low), None) or next(
        (t for t in TABLES if re.search(rf"\b{t.split('.')[2]}\b", low)), "demo.sales.orders")
    cols, rows = table_rows(table, min(cap or TABLES[table][3], TABLES[table][3]))
    return _project(wrapped_sql or statement, cols, rows)


# ---------------------------------------------------------------- fake SDK surface

class _Statements:
    """Stands in for WorkspaceClient().statement_execution, using the real SDK response types."""

    def __init__(self):
        self.stmts = {}

    def _delay(self, statement):
        return SLOW_DELAY if "demo_slow" in statement.lower() else NORMAL_DELAY

    def _state(self, st):
        if st["canceled"]:
            return sqlsvc.StatementState.CANCELED
        if time.monotonic() - st["t0"] < st["delay"]:
            return sqlsvc.StatementState.RUNNING
        return sqlsvc.StatementState.FAILED if st["error"] else sqlsvc.StatementState.SUCCEEDED

    def _manifest(self, st):
        cols = [sqlsvc.ColumnInfo(name=c["name"], position=i, type_name=sqlsvc.ColumnInfoTypeName[c["type"]],
                                  type_text=c.get("type_text") or c["type"].lower()) for i, c in enumerate(st["cols"])]
        return sqlsvc.ResultManifest(schema=sqlsvc.ResultSchema(column_count=len(cols), columns=cols),
                                     total_row_count=len(st["rows"]))

    def _chunk(self, sid, i):
        rows = self.stmts[sid]["rows"]
        lo, hi = i * CHUNK_ROWS, min((i + 1) * CHUNK_ROWS, len(rows))
        return sqlsvc.ResultData(chunk_index=i, data_array=rows[lo:hi], row_count=hi - lo, row_offset=lo,
                                 next_chunk_index=i + 1 if hi < len(rows) else None)

    def _response(self, sid):
        st = self.stmts[sid]
        state = self._state(st)
        if state == sqlsvc.StatementState.FAILED:
            return sqlsvc.StatementResponse(statement_id=sid, status=sqlsvc.StatementStatus(
                state=state, error=sqlsvc.ServiceError(message=st["error"])))
        if state != sqlsvc.StatementState.SUCCEEDED:
            return sqlsvc.StatementResponse(statement_id=sid, status=sqlsvc.StatementStatus(state=state))
        return sqlsvc.StatementResponse(statement_id=sid, status=sqlsvc.StatementStatus(state=state),
                                        manifest=self._manifest(st), result=self._chunk(sid, 0))

    def execute_statement(self, statement, warehouse_id, wait_timeout=None, parameters=None, **_):
        params = {p.name: p.value for p in (parameters or [])}
        try:
            cols, rows, error = (*result_for(statement, params), None)
        except DemoError as e:
            cols, rows, error = [], [], str(e)
        sid = f"demo-stmt-{len(self.stmts) + 1}"
        self.stmts[sid] = {"cols": cols, "rows": rows, "error": error, "canceled": False,
                           "t0": time.monotonic(), "delay": self._delay(statement)}
        wait = float(re.sub(r"\D", "", wait_timeout or "0") or 0)
        if wait:  # the real service holds the call open for up to wait_timeout
            time.sleep(min(wait, self.stmts[sid]["delay"]))
        return self._response(sid)

    def get_statement(self, statement_id):
        return self._response(statement_id)

    def get_statement_result_chunk_n(self, statement_id, chunk_index):
        return self._chunk(statement_id, chunk_index)

    def cancel_execution(self, statement_id):
        self.stmts[statement_id]["canceled"] = True


class _Catalogs:
    def list(self):
        return [uc.CatalogInfo(name=n, comment=c, catalog_type=uc.CatalogType.MANAGED_CATALOG)
                for n, c in CATALOGS.items()]


class _Schemas:
    def list(self, catalog_name):
        names = sorted({f.split(".")[1] for f in TABLES if f.startswith(catalog_name + ".")})
        return [uc.SchemaInfo(name=n, catalog_name=catalog_name, comment=f"Invented {n} schema") for n in names]


class _Tables:
    def list(self, catalog_name, schema_name):
        return [_table_info(f) for f in sorted(TABLES) if f.startswith(f"{catalog_name}.{schema_name}.")]

    def get(self, full_name):
        return _table_info(full_name)


class _Warehouses:
    def list(self):
        return [sqlsvc.EndpointInfo(id=i, name=n, state=s) for i, n, s in WAREHOUSES]


class _CurrentUser:
    def me(self):
        return iam.User(user_name="demo.user@example.invalid")


class _ApiClient:
    def do(self, method, path, body=None, **_):
        """Only the table-lineage endpoint exists."""
        name = (body or {}).get("table_name")
        ups, downs = [], []
        for up, down, job in LINEAGE:
            for target, other, bucket in ((down, up, ups), (up, down, downs)):
                if name == target:
                    c, s, n = other.split(".")
                    bucket.append({"tableInfo": {"catalog_name": c, "schema_name": s, "name": n,
                                                 "table_type": TABLES[other][0], "lineage_timestamp": LINEAGE_SEEN},
                                   "jobInfos": [{"job_id": job, "workspace_id": "1111111111",
                                                 "lineage_timestamp": LINEAGE_SEEN}]})
        return {"upstreams": ups, "downstreams": downs}


class FakeWorkspaceClient:
    """Stands in for databricks.sdk.WorkspaceClient. The profile name is ignored."""

    def __init__(self, profile=None):
        self.config = SimpleNamespace(host=PROFILES[0]["host"])
        self.current_user = _CurrentUser()
        self.warehouses = _Warehouses()
        self.catalogs = _Catalogs()
        self.schemas = _Schemas()
        self.tables = _Tables()
        self.api_client = _ApiClient()
        self.statement_execution = _Statements()

    def get_workspace_id(self):
        return 1111111111


# ---------------------------------------------------------------- fake Genie One (the Ask tab)
# Stands in for genie.GenieClient when EXPLORER_DEMO=1. Canned answers, picked by words in the question:
#   revenue            revenue by status, from a view
#   customer, country  customers per country
#   demo_error, fail   the turn ends `failed`
#   demo_slow          stays in progress for SLOW_DELAY seconds (to test Cancel)
# Anything else counts orders. A follow-up in the same conversation gets one extra progress step.
from . import genie  # noqa: E402  (kept with the Genie code so this block can be appended on its own)

GENIE_STEP_SECONDS = 1.2
GENIE_HOST = "https://demo.invalid"


def _genie_table_link(full_name):
    return f"[{full_name}]({GENIE_HOST}/explore/data/{full_name.replace('.', '/')}?isDbOne=true&utm_source=one-chat)"


def _genie_plan(question):
    """The canned plan for a question: progress steps, SQL, result columns and rows, answer text, or failed=True."""
    q = question.lower()
    if "demo_error" in q or "fail" in q:
        return {"failed": True, "steps": ["Thinking: I'll look for the table you mean.",
                                          "Thinking: running the query on the warehouse."]}
    if "revenue" in q:
        sql = "SELECT status, SUM(revenue) AS revenue FROM demo.sales.v_daily_revenue\nGROUP BY status ORDER BY revenue DESC"
        cols = [("status", "string"), ("revenue", "decimal(14,2)")]
        rows = [["shipped", "3120450.75"], ["pending", "1984210.10"], ["returned", "402318.40"]]
        answer = (f"**Shipped** orders bring in the most revenue, about **$3.12M**. The numbers come from "
                  f"{_genie_table_link('demo.sales.v_daily_revenue')}, a view over {_genie_table_link('demo.sales.orders')}.\n\n"
                  "- Pending: $1.98M\n- Returned: $0.40M\n\nThe view groups revenue by day and status.")
        tables = ["demo.sales.v_daily_revenue"]
    elif "customer" in q or "country" in q:
        sql = "SELECT country, COUNT(*) AS customers FROM demo.sales.customers\nGROUP BY country ORDER BY customers DESC"
        cols = [("country", "string"), ("customers", "bigint")]
        rows = [["US", "412"], ["DE", "233"], ["JP", "187"], ["BR", "96"]]
        answer = (f"Most customers are in the **US** (412), then Germany (233). Source: "
                  f"{_genie_table_link('demo.sales.customers')}.\n\n"
                  "| country | customers |\n| --- | --- |\n| US | 412 |\n| DE | 233 |\n| JP | 187 |\n| BR | 96 |")
        tables = ["demo.sales.customers"]
    else:
        sql = "SELECT COUNT(*) AS order_count FROM demo.sales.orders"
        cols = [("order_count", "bigint")]
        rows = [[str(TABLES["demo.sales.orders"][3])]]
        answer = (f"The {_genie_table_link('demo.sales.orders')} table has **{rows[0][0]} rows**. "
                  "It is described as \"One row per order\".")
        tables = ["demo.sales.orders"]
    steps = ["Thinking: I'll find the table that matches your question.",
             f"Thinking: I found {', '.join(tables)}. I'll write a query for it.",
             "Thinking: the query ran, so I can answer now."]
    return {"failed": False, "steps": steps, "sql": sql, "cols": cols, "rows": rows, "answer": answer}


class FakeGenie:
    """Same four calls as genie.GenieClient, answered from canned plans, with progress that advances over time."""

    def __init__(self):
        self.warehouse_id = None
        self.convs = {}       # conversation id -> turns asked
        self.turns = {}       # response id -> {conv, plan, t0, delay, canceled}

    def ask(self, question, conversation_id=None):
        """Start a turn. A conversation id that was never issued here starts a new conversation."""
        cid = conversation_id if conversation_id in self.convs else f"demo-conv-{len(self.convs) + 1}"
        self.convs[cid] = self.convs.get(cid, 0) + 1
        rid = f"demo-resp-{len(self.turns) + 1}"
        plan = _genie_plan(question)
        if self.convs[cid] > 1:
            plan["steps"] = [f"Thinking: continuing the conversation (question {self.convs[cid]})."] + plan["steps"]
        delay = SLOW_DELAY if "demo_slow" in question.lower() else GENIE_STEP_SECONDS * len(plan["steps"])
        self.turns[rid] = {"conv": cid, "plan": plan, "t0": time.monotonic(), "delay": delay, "canceled": False}
        return {"conversation_id": cid, "response_id": rid, "status": "in_progress"}

    def _turn(self, conversation_id, response_id):
        t = self.turns.get(response_id)
        if not t or t["conv"] != conversation_id:
            raise genie.GenieError("Unknown conversation or response.", 502)
        return t

    def poll(self, conversation_id, response_id):
        """One poll: more progress steps each time, then completed (or failed) once the delay has passed. Like the real server, a finished poll carries no steps."""
        t = self._turn(conversation_id, response_id)
        plan, elapsed = t["plan"], time.monotonic() - t["t0"]
        sc = {"conversation_id": conversation_id, "response_id": response_id,
              "deep_link": f"{GENIE_HOST}/one/chat/threads/{conversation_id}"}
        if t["canceled"]:
            return genie.shape_poll({**sc, "status": "incomplete", "progress_steps": plan["steps"][:1]})
        if elapsed < t["delay"]:
            shown = min(len(plan["steps"]), int(elapsed / max(GENIE_STEP_SECONDS, 1e-6)) + 1)
            return genie.shape_poll({**sc, "status": "in_progress", "progress_steps": plan["steps"][:shown]})
        if plan["failed"]:
            return genie.shape_poll({**sc, "status": "failed",
                                     "message": "The query could not run: the table Genie picked does not exist."})
        return genie.shape_poll({**sc, "status": "completed", "final_answer": plan["answer"],
                                 "query_items": [{"item_id": f"{response_id}-item-1", "sql": plan["sql"]}]})

    def query_result(self, conversation_id, response_id, item_id):
        """The canned rows of the turn's one SQL item."""
        t = self._turn(conversation_id, response_id)
        if item_id != f"{response_id}-item-1" or t["plan"]["failed"]:
            raise genie.GenieError("Unknown query item.", 502)
        plan = t["plan"]
        return genie.shape_result({"item_id": item_id, "statement_state": "SUCCEEDED", "ready": True,
                                   "columns": [{"name": n, "type_text": tt} for n, tt in plan["cols"]],
                                   "rows": plan["rows"], "total_row_count": len(plan["rows"]), "truncated": False})

    def cancel(self, conversation_id):
        """Mark every turn of the conversation canceled."""
        for t in self.turns.values():
            if t["conv"] == conversation_id:
                t["canceled"] = True
        return {"conversation_id": conversation_id, "cancel_requested": True}

# ---------------------------------------------------------------- ontology import fakes (domains, pages, a metric view, certification)
# Genie Ontology domains and pages over REST, one metric view whose YAML the tables API returns, and the certification tag.

METRIC_VIEW = "demo.sales.sales_metrics"
# Like the real tables API, the YAML it returns has lost display_name, comment and synonyms. Those come from the
# warehouse: DESCRIBE TABLE EXTENDED <view> AS JSON (METRIC_VIEW_META below).
METRIC_VIEW_YAML = """version: 1.1
source: demo.sales.orders
dimensions:
  - name: order_month
    expr: date_trunc('month', order_date)
  - name: status
    expr: status
measures:
  - name: total_revenue
    expr: SUM(amount)
  - name: order_count
    expr: COUNT(1)
"""
METRIC_VIEW_COLUMNS = [("order_month", "date", "Calendar month in which the order was placed"),
                       ("status", "string", "Fulfillment status of the order"),
                       ("total_revenue", "decimal(14,2)", "Sum of order amounts in dollars"),
                       ("order_count", "bigint", "Number of orders")]
# column -> (metric_view.type, display_name or None, synonyms)
METRIC_VIEW_META = {"order_month": ("dimension", "Order month", ["month", "period"]),
                    "status": ("dimension", None, []),
                    "total_revenue": ("measure", "Total revenue", ["sales", "turnover"]),
                    "order_count": ("measure", "Order count", [])}
TABLES[METRIC_VIEW] = ("VIEW", METRIC_VIEW_COLUMNS, "Sales metric view", 240)


def _metric_view_describe():
    """The one JSON string DESCRIBE TABLE EXTENDED ... AS JSON returns for the metric view."""
    columns = []
    for name, type_text, comment in METRIC_VIEW_COLUMNS:
        _, label, synonyms = METRIC_VIEW_META[name]
        meta = ({"display_name": label} if label else {}) | ({"synonyms": synonyms} if synonyms else {})
        columns.append({"name": name, "type": {"name": type_text.split("(")[0]}, "nullable": True, "comment": comment,
                        **({"metadata": meta} if meta else {})})
    return json.dumps({"table_name": "sales_metrics", "catalog_name": "demo", "schema_name": "sales",
                       "columns": columns, "comment": "Sales metric view", "view_text": METRIC_VIEW_YAML})

ONTOLOGY_DOMAINS = [
    {"domain_id": "d-sales", "tag_key": "sales", "display_name": "Sales", "description": "Orders and customers"},
    {"domain_id": "d-people", "tag_key": "people", "description": "Staff and departments"}]
ONTOLOGY_PAGES = [
    {"name": "knowledge/pages/customer", "domain": "domains/d-sales", "display_name": "Customer",
     "description": "A person or company that has placed at least one order.",
     "body": "## Notes\n\nA customer is identified by `customer_id`.\nGuests who never create an account are not customers.",
     "synonyms": ["client", "buyer"], "state": "PUBLISHED"},
    {"name": "knowledge/pages/active-customer", "domain": "domains/d-sales", "display_name": "Active customer",
     "description": "A customer with an order in the last 90 days.", "body": "", "synonyms": ["recent buyer"],
     "state": "DRAFT"},
    {"name": "knowledge/pages/headcount", "domain": "domains/d-people", "display_name": "Headcount",
     "description": "Employees on the payroll at the end of a month.", "body": "", "synonyms": [], "state": "PUBLISHED"}]
ONTOLOGY_PAGE_SIZE = 2  # so the importer has to follow next_page_token
# scope, catalog, schema, table, column, value of the system.certification_status tag
CERTIFICATION = [("table", "demo", "sales", "orders", None, "certified"),
                 ("table", "demo", "sales", "customers", None, "certified"),
                 ("table", "demo", "sales", "v_daily_revenue", None, "deprecated"),
                 ("table", "demo", "sales", "sales_metrics", None, "certified"),
                 ("column", "demo", "sales", "customers", "email", "certified"),
                 ("column", "demo", "sales", "orders", "discount_pct", "deprecated")]
TAGS.extend((s, c, sc, t, col, "system.certification_status", v) for s, c, sc, t, col, v in CERTIFICATION)

_table_info_before_ontology = _table_info
_api_do_before_ontology = _ApiClient.do
_result_for_before_ontology = result_for


def _table_info(full_name):  # noqa: F811 - wraps the function above; the fake tables API looks it up by name
    """The table's info, with the metric view's YAML as its view_definition and each column's metric_view.type metadata."""
    info = _table_info_before_ontology(full_name)
    if full_name == METRIC_VIEW:
        info.view_definition = METRIC_VIEW_YAML
        for col in info.columns:
            col.type_json = json.dumps({"name": col.name, "nullable": True, "metadata": {
                "metric_view.type": METRIC_VIEW_META[col.name][0]}})
    return info


def _ontology_page(items, query, key):
    start = int((query or {}).get("page_token") or 0)
    out = {key: items[start:start + ONTOLOGY_PAGE_SIZE]}
    if start + ONTOLOGY_PAGE_SIZE < len(items):
        out["next_page_token"] = str(start + ONTOLOGY_PAGE_SIZE)
    return out


def _api_do_with_ontology(self, method, path, body=None, query=None, **kw):
    if path == "/api/2.0/domains":
        return {"domains": ONTOLOGY_DOMAINS}
    if path == "/api/2.0/knowledge/pages":
        return _ontology_page(ONTOLOGY_PAGES, query, "pages")
    return _api_do_before_ontology(self, method, path, body, **kw)


_ApiClient.do = _api_do_with_ontology


def result_for(statement, params=None):  # noqa: F811 - wraps the function above; the fake warehouse looks it up by name
    """(columns, rows) as before, plus the metric view list and the certification tag rows."""
    low = " ".join(statement.split()).lower()
    if low == "describe table extended `demo`.`sales`.`sales_metrics` as json":
        return [{"name": "json_metadata", "type": "STRING"}], [[_metric_view_describe()]]
    if "table_type = 'metric_view'" in low:
        cols = [{"name": k, "type": "STRING"} for k in ("table_catalog", "table_schema", "table_name")]
        return cols, [METRIC_VIEW.split(".")]
    if "where tag_name = 'system.certification_status'" in low:
        cols = [{"name": k, "type": "STRING"} for k in
                ("scope", "catalog_name", "schema_name", "table_name", "column_name", "tag_value")]
        return cols, [list(r) for r in CERTIFICATION]
    return _result_for_before_ontology(statement, params)
