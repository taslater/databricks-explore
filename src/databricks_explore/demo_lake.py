"""Demo mode's invented lakehouse, catalog demo_lake: raw files, cleaned tables and a star schema, shaped for graph work.

About 30 objects in three schemas. bronze: raw tables loaded from files (file upstreams in lineage; two PII columns tagged).
silver: CTAS, INSERT and MERGE tables, one written by a notebook with no SQL, and a chain of two pass-through views.
gold: a fact at order_id x line_no with foreign keys to four dimensions (one FK column nullable, one key composite, one
reference with orphans), a self-referencing dimension, a daily aggregate materialized view, a metric view, and a column
fed by a PII column that is not tagged. Lineage still names one edge that no longer holds (SUPERSEDED_EDGES) and one dropped
table (DROPPED). Owners are split across two groups.

Everything is invented, deterministic and generated here. Times are anchored to the current UTC hour, so which table is
late never changes. This module is plain data and small helpers: it imports nothing from demo.py (demo.py and
demo_history.py import it). The warehouse's answers (DESCRIBE DETAIL, DESCRIBE HISTORY, the relationship profile) are in
demo_lake_sql.py.

What the fake workspace serves from here:
  catalog, schemas, tables      TABLES (see table_info), view and metric-view definitions, owners, constraints, tags
  table lineage (REST)          lineage_items(table): job, notebook, pipeline and file upstreams
  system.access.table_lineage   lineage_rows(): one row per edge and run, with statement_id (none for notebook python and pipelines)
  system.query.history          statements(): the COPY INTO, CTAS, INSERT and MERGE text for those ids
  system.access.column_lineage  COLUMN_LINEAGE
"""
import json
import random
import re
import zlib
from datetime import datetime, timedelta, timezone

from databricks.sdk.service import catalog as uc

LAKE = "demo_lake"
CATALOGS = {LAKE: "Invented lakehouse: raw files to a star schema"}
OWNERS = {"bronze": "data-engineering", "silver": "data-engineering", "gold": "analytics"}
OWNER_OVERRIDES = {"silver.customers": "analytics", "gold.session_funnel": "data-engineering"}
JOBS = {"2001": "ingest_landing_files", "3001": "silver_refresh", "4001": "gold_build"}
READERS = {"gold.daily_revenue": ["d-revenue-0001"], "gold.fact_returns": ["d-returns-0002"]}  # tables read by dashboards
NOTEBOOKS = {"7001": "merge_customers", "7002": "refresh_returns"}
PIPELINES = {"pl-clicks-0001": "clickstream_to_silver", "pl-gold-0002": "gold_revenue_mv"}
PRINCIPALS = {"job": "svc-lakehouse@example.invalid", "notebook": "dev.p@example.invalid",
              "pipeline": "svc-pipelines@example.invalid"}
WORKSPACE_ID = "1111111111"
LANDING = "s3://demo-landing"
LAKE_ROOT = "s3://demo-lake"


def _c(spec):
    """Columns from 'name type [comment]' lines."""
    out = []
    for line in spec.strip().splitlines():
        parts = line.strip().split(None, 2)
        out.append((parts[0], parts[1], parts[2] if len(parts) > 2 else None))
    return out


_LOAD = "_source_file string\n_ingested_at timestamp"
COLUMNS = {
    "bronze.raw_orders": _c("order_id bigint\ncustomer_id bigint\nstore_id bigint\nregion_code string\norder_ts timestamp\n"
                            "status string\nchannel string\n" + _LOAD),
    "bronze.raw_order_lines": _c("order_id bigint\nline_no int\nsku string\nqty int\nunit_price decimal(10,2)\n"
                                 "discount_pct double\n" + _LOAD),
    "bronze.raw_customers": _c("customer_id bigint\nemail string Personal email address\nphone string Personal phone number\n"
                               "full_name string\ncountry string\nreferred_by bigint\ncreated_at timestamp\n" + _LOAD),
    "bronze.raw_products": _c("sku string\nproduct_name string\ncategory string\nlist_price decimal(10,2)\n" + _LOAD),
    "bronze.raw_returns": _c("return_id bigint\norder_id bigint\nline_no int\nreason string\nreturned_at timestamp\n" + _LOAD),
    "bronze.raw_shipments": _c("shipment_id bigint\norder_id bigint\ncarrier string\nshipped_at timestamp\n" + _LOAD),
    "bronze.raw_stores": _c("store_id bigint\nregion_code string\nstore_name string\ncity string\nopened_on date\n" + _LOAD),
    "bronze.raw_clickstream": _c("event_id bigint\nsession_id string\ncustomer_id bigint\nevent_type string\n"
                                 "event_ts timestamp\npage string\n_ingested_at timestamp"),
    "silver.orders": _c("order_id bigint One row per order\ncustomer_id bigint Null for guest checkouts\nstore_id bigint\n"
                        "region_code string\norder_ts timestamp\norder_date date\nstatus string\nchannel string"),
    "silver.order_lines": _c("order_id bigint\nline_no int\nsku string\nquantity int\nunit_price decimal(10,2)\n"
                             "discount_pct double"),
    "silver.customers": _c("customer_id bigint\nemail string Lower-cased\nfull_name string\ncountry string\n"
                           "referred_by_customer_id bigint\ncreated_at timestamp"),
    "silver.products": _c("sku string\nproduct_name string\ncategory string\nlist_price decimal(10,2)"),
    "silver.stores": _c("store_id bigint\nregion_code string\nstore_name string\ncity string\nopened_on date"),
    "silver.returns": _c("return_id bigint\norder_id bigint\nline_no int\nreason string\nreturned_at timestamp"),
    "silver.shipments": _c("shipment_id bigint\norder_id bigint\ncarrier string\nshipped_at timestamp"),
    "silver.sessions": _c("session_id string\ncustomer_id bigint\nstarted_at timestamp\nended_at timestamp\nevents int\n"
                          "pages_viewed int"),
    "silver.v_orders": _c("order_id bigint\ncustomer_id bigint\nstore_id bigint\nregion_code string\norder_date date\n"
                          "status string\nchannel string"),
    "silver.v_orders_current": _c("order_id bigint\ncustomer_id bigint\nstore_id bigint\nregion_code string\n"
                                  "order_date date\nstatus string\nchannel string"),
    "gold.dim_customer": _c("customer_id bigint\nemail_domain string Domain of the customer's email\nfull_name string\n"
                            "country string\nreferred_by_customer_id bigint Customer who referred this one\ncustomer_since date"),
    "gold.dim_product": _c("sku string\nproduct_name string\ncategory string\nlist_price decimal(10,2)"),
    "gold.dim_date": _c("date_key int yyyymmdd\ncalendar_date date\nyear int\nmonth int\nday_of_week string\nis_weekend boolean"),
    "gold.dim_store": _c("store_id bigint\nregion_code string\nstore_name string\ncity string"),
    "gold.fact_order_lines": _c("order_id bigint\nline_no int\ncustomer_id bigint Null for guest checkouts\nsku string\n"
                                "date_key int\nstore_id bigint\nregion_code string\nquantity int\nunit_price decimal(10,2)\n"
                                "discount_amount decimal(12,2)\nnet_amount decimal(12,2) Revenue after discount"),
    "gold.fact_returns": _c("return_id bigint\norder_id bigint\nline_no int\ndate_key int\nreason string\n"
                            "refund_amount decimal(12,2)"),
    "gold.fact_shipments": _c("shipment_id bigint\norder_id bigint\ndate_key int\ncarrier string\ndays_to_ship int"),
    "gold.daily_revenue": _c("order_date date\nstore_id bigint\nrevenue decimal(14,2)\norders bigint"),
    "gold.session_funnel": _c("day date\nsessions bigint\navg_events double"),
    "gold.revenue_metrics": _c("region_code string\norder_month date\nnet_revenue decimal(14,2)\nunits bigint\norder_count bigint"),
}
COMMENTS = {
    "bronze.raw_orders": "Order headers as landed from the order system's CSV export",
    "bronze.raw_order_lines": "Order lines as landed",
    "bronze.raw_customers": "Customer master files, with personal data",
    "bronze.raw_products": "Product catalog files",
    "bronze.raw_returns": "Returns as landed",
    "bronze.raw_shipments": "Shipment feed",
    "bronze.raw_stores": "Store master files",
    "bronze.raw_clickstream": "Web events from Auto Loader",
    "silver.orders": "Cleaned orders: tests removed, one row per order",
    "silver.order_lines": "Cleaned order lines",
    "silver.customers": "Customers, kept current with MERGE",
    "silver.products": "Latest row per product",
    "silver.stores": "Distinct stores",
    "silver.returns": "Returned order lines",
    "silver.shipments": "Shipments",
    "silver.sessions": "Web sessions",
    "silver.v_orders": "Orders without audit columns",
    "silver.v_orders_current": "Alias of v_orders for downstream readers",
    "gold.dim_customer": "Customer dimension",
    "gold.dim_product": "Product dimension",
    "gold.dim_date": "Calendar dimension",
    "gold.dim_store": "Store dimension, keyed by store and region",
    "gold.fact_order_lines": "One row per order line",
    "gold.fact_returns": "One row per returned order line",
    "gold.fact_shipments": "One row per shipment",
    "gold.daily_revenue": "Revenue and orders per day and store",
    "gold.session_funnel": "Sessions per day",
    "gold.revenue_metrics": "Revenue metric view over the order-line fact",
}
KINDS = {"gold.daily_revenue": "MATERIALIZED_VIEW", "silver.v_orders": "VIEW", "silver.v_orders_current": "VIEW",
         "gold.revenue_metrics": "VIEW"}
# Declared keys (informational, like Unity Catalog's).
PRIMARY_KEYS = {"silver.orders": ["order_id"], "silver.order_lines": ["order_id", "line_no"],
                "silver.customers": ["customer_id"], "silver.products": ["sku"],
                "silver.stores": ["store_id", "region_code"], "silver.returns": ["return_id"],
                "silver.shipments": ["shipment_id"],
                "gold.dim_customer": ["customer_id"], "gold.dim_product": ["sku"], "gold.dim_date": ["date_key"],
                "gold.dim_store": ["store_id", "region_code"],
                "gold.fact_order_lines": ["order_id", "line_no"], "gold.fact_returns": ["return_id"],
                "gold.fact_shipments": ["shipment_id"]}
NOT_NULL = {"gold.fact_order_lines": {"sku", "date_key", "store_id", "region_code"}}
# child, child columns, parent, parent columns (schema.table names)
FOREIGN_KEYS = [
    ("silver.order_lines", ["order_id"], "silver.orders", ["order_id"]),
    ("gold.fact_order_lines", ["customer_id"], "gold.dim_customer", ["customer_id"]),   # nullable: guest checkouts
    ("gold.fact_order_lines", ["sku"], "gold.dim_product", ["sku"]),                    # the data has orphans
    ("gold.fact_order_lines", ["date_key"], "gold.dim_date", ["date_key"]),
    ("gold.fact_order_lines", ["store_id", "region_code"], "gold.dim_store", ["store_id", "region_code"]),  # composite
    ("gold.fact_returns", ["order_id", "line_no"], "gold.fact_order_lines", ["order_id", "line_no"]),
    ("gold.fact_returns", ["date_key"], "gold.dim_date", ["date_key"]),
    ("gold.fact_shipments", ["date_key"], "gold.dim_date", ["date_key"]),
    ("gold.dim_customer", ["referred_by_customer_id"], "gold.dim_customer", ["customer_id"]),  # self-reference
]
# Unity Catalog tags: scope, schema, table, column, tag name, value (catalog is always demo_lake)
_TAGS = [("schema", "bronze", None, None, "layer", "bronze"), ("schema", "silver", None, None, "layer", "silver"),
         ("schema", "gold", None, None, "layer", "gold"),
         ("column", "bronze", "raw_customers", "email", "pii", "email"),
         ("column", "bronze", "raw_customers", "phone", "pii", "phone"),
         ("column", "silver", "customers", "email", "pii", "email")]
_TAGS += [("table", "gold", t, None, "domain", "sales") for t in
          ("fact_order_lines", "fact_returns", "fact_shipments", "dim_customer", "dim_product", "daily_revenue")]
TAGS = [(s, LAKE, sc, t, c, tag, v) for s, sc, t, c, tag, v in _TAGS]

# Views, the materialized view and the metric view: the definitions tables.get returns.
VIEW_SQL = {
    "silver.v_orders": "SELECT order_id, customer_id, store_id, region_code, order_date, status, channel\n"
                       "FROM demo_lake.silver.orders",
    "silver.v_orders_current": "SELECT order_id, customer_id, store_id, region_code, order_date, status, channel\n"
                               "FROM demo_lake.silver.v_orders",
    "gold.daily_revenue": "SELECT d.calendar_date AS order_date, f.store_id, SUM(f.net_amount) AS revenue,\n"
                          "       COUNT(DISTINCT f.order_id) AS orders\n"
                          "FROM demo_lake.gold.fact_order_lines f\n"
                          "JOIN demo_lake.gold.dim_date d ON f.date_key = d.date_key\n"
                          "GROUP BY d.calendar_date, f.store_id",
}
VIEW_DEPS = {"silver.v_orders": ["silver.orders"], "silver.v_orders_current": ["silver.v_orders"],
             "gold.daily_revenue": ["gold.fact_order_lines", "gold.dim_date"],
             "gold.revenue_metrics": ["gold.fact_order_lines"]}
METRIC_VIEW = f"{LAKE}.gold.revenue_metrics"
METRIC_VIEW_YAML = """version: 1.1
source: demo_lake.gold.fact_order_lines
dimensions:
  - name: region_code
    expr: region_code
  - name: order_month
    expr: date_trunc('month', to_date(cast(date_key AS STRING), 'yyyyMMdd'))
measures:
  - name: net_revenue
    expr: SUM(net_amount)
  - name: units
    expr: SUM(quantity)
  - name: order_count
    expr: COUNT(DISTINCT order_id)
"""
METRIC_VIEW_KINDS = {"region_code": "dimension", "order_month": "dimension", "net_revenue": "measure",
                     "units": "measure", "order_count": "measure"}

# ---------------------------------------------------------------- physical facts
# rows: the table's row count; bpr: bytes per row; op: what its data writes are; cadence_h and n: hours between
# writes and how many are in the history; last_h: hours since the last data write; writer: (kind, id);
# append: rows added per write, for tables that are only appended to (their total is not in any write).
# optimize_last: a maintenance OPTIMIZE after the last write. cluster/partition: Delta layout.
SPEC = {
    "bronze.raw_orders": dict(rows=12_400_000, bpr=90, op="COPY INTO", cadence_h=24, n=30, last_h=5, writer=("job", "2001"), append=41_000),
    "bronze.raw_order_lines": dict(rows=31_900_000, bpr=70, op="COPY INTO", cadence_h=24, n=30, last_h=5, writer=("job", "2001"), append=105_000),
    "bronze.raw_customers": dict(rows=1_904_511, bpr=160, op="COPY INTO", cadence_h=24, n=30, last_h=5, writer=("job", "2001"), append=2_600),
    "bronze.raw_products": dict(rows=3_412, bpr=140, op="COPY INTO", cadence_h=168, n=20, last_h=60, writer=("job", "2001"), append=40),
    "bronze.raw_returns": dict(rows=880_000, bpr=75, op="COPY INTO", cadence_h=24, n=30, last_h=5, writer=("job", "2001"), append=2_900),
    "bronze.raw_shipments": dict(rows=9_800_000, bpr=80, op="COPY INTO", cadence_h=24, n=30, last_h=5, writer=("job", "2001"), append=32_000),
    "bronze.raw_stores": dict(rows=214, bpr=120, op="COPY INTO", cadence_h=168, n=20, last_h=100, writer=("job", "2001"), append=3),
    "bronze.raw_clickstream": dict(rows=240_000_000, bpr=110, op="STREAMING UPDATE", cadence_h=1, n=50, last_h=1, writer=("pipeline", "pl-clicks-0001"), append=400_000, partition=["event_type"]),
    "silver.orders": dict(rows=12_100_000, bpr=95, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=4, writer=("job", "3001")),
    "silver.order_lines": dict(rows=31_200_000, bpr=65, op="WRITE", cadence_h=24, n=30, last_h=4, writer=("job", "3001"), append=105_000),
    "silver.customers": dict(rows=1_904_511, bpr=150, op="MERGE", cadence_h=24, n=30, last_h=20, writer=("notebook", "7001"), optimize_last=True),
    "silver.products": dict(rows=3_412, bpr=140, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=4, writer=("job", "3001")),
    "silver.stores": dict(rows=214, bpr=120, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=4, writer=("job", "3001")),
    "silver.returns": dict(rows=880_000, bpr=70, op="WRITE", mode="Overwrite", cadence_h=24, n=30, last_h=12, writer=("notebook", "7002")),
    "silver.shipments": dict(rows=9_800_000, bpr=75, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=148, writer=("job", "3001")),  # the late table
    "silver.sessions": dict(rows=41_000_000, bpr=60, op="STREAMING UPDATE", cadence_h=1, n=50, last_h=1, writer=("pipeline", "pl-clicks-0001"), append=55_000),
    "gold.dim_customer": dict(rows=1_904_511, bpr=90, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001")),
    "gold.dim_product": dict(rows=3_412, bpr=110, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001")),
    "gold.dim_date": dict(rows=4_018, bpr=40, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001")),
    "gold.dim_store": dict(rows=214, bpr=100, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001")),
    "gold.fact_order_lines": dict(rows=18_600_000, bpr=100, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001"), cluster=["date_key"]),
    "gold.fact_returns": dict(rows=880_000, bpr=60, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001")),
    "gold.fact_shipments": dict(rows=9_800_000, bpr=50, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001")),
    "gold.daily_revenue": dict(rows=428_000, bpr=40, op="WRITE", mode="Overwrite", cadence_h=24, n=30, last_h=2, writer=("pipeline", "pl-gold-0002")),
    "gold.session_funnel": dict(rows=1_450, bpr=40, op="CREATE OR REPLACE TABLE AS SELECT", cadence_h=24, n=30, last_h=3, writer=("job", "4001")),
}
LATE_TABLE = f"{LAKE}.silver.shipments"
OPTIMIZE_LAST_TABLE = f"{LAKE}.silver.customers"
# The cap on rows a SELECT returns, so the demo grid stays light.
_SELECT_ROWS = 2000

TABLES = {}  # full name -> (table type, columns, comment, rows), the shape demo.TABLES uses
for _short, _cols in COLUMNS.items():
    _full = f"{LAKE}.{_short}"
    _rows = SPEC.get(_short, {}).get("rows", 1_000)
    TABLES[_full] = (KINDS.get(_short, "MANAGED"), _cols, COMMENTS[_short], min(_rows, _SELECT_ROWS))
ROWS = {f"{LAKE}.{k}": v["rows"] for k, v in SPEC.items()}
ROWS[METRIC_VIEW] = ROWS[f"{LAKE}.gold.fact_order_lines"]


def short(full_name):
    """schema.table of a demo_lake name."""
    return full_name.split(".", 1)[1]


def is_lake(full_name):
    return full_name in TABLES


def table_info(full_name):
    """The uc.TableInfo tables.get returns for a demo_lake object."""
    kind, cols, comment, _ = TABLES[full_name]
    sh = short(full_name)
    schema, name = sh.split(".")
    pk = PRIMARY_KEYS.get(sh) if kind == "MANAGED" else None
    constraints = [uc.TableConstraint(primary_key_constraint=uc.PrimaryKeyConstraint(name=f"pk_{name}", child_columns=pk))] if pk else []
    for ch, ccols, parent, pcols in FOREIGN_KEYS:
        if ch == sh:
            constraints.append(uc.TableConstraint(foreign_key_constraint=uc.ForeignKeyConstraint(
                name=f"fk_{name}_{'_'.join(ccols)}", child_columns=ccols, parent_table=f"{LAKE}.{parent}", parent_columns=pcols)))
    not_null = set(pk or []) | NOT_NULL.get(sh, set())
    deps = VIEW_DEPS.get(sh)
    info = uc.TableInfo(
        name=name, catalog_name=LAKE, schema_name=schema, full_name=full_name, comment=comment,
        owner=OWNER_OVERRIDES.get(sh, OWNERS[schema]),
        table_type=uc.TableType[kind],
        data_source_format=None if kind == "VIEW" else uc.DataSourceFormat.DELTA,
        storage_location=None if kind == "VIEW" else f"{LAKE_ROOT}/{schema}/{name}",
        columns=[uc.ColumnInfo(name=cn, type_text=tt, type_name=uc.ColumnTypeName[_type_name(tt)], position=i,
                               comment=cm, nullable=cn not in not_null) for i, (cn, tt, cm) in enumerate(cols)],
        table_constraints=constraints or None,
        view_definition=VIEW_SQL.get(sh) or (METRIC_VIEW_YAML if full_name == METRIC_VIEW else None),
        view_dependencies=uc.DependencyList(dependencies=[
            uc.Dependency(table=uc.TableDependency(table_full_name=f"{LAKE}.{d}")) for d in deps]) if deps else None)
    if full_name == METRIC_VIEW:
        for col in info.columns:
            col.type_json = json.dumps({"name": col.name, "nullable": True,
                                        "metadata": {"metric_view.type": METRIC_VIEW_KINDS[col.name]}})
    return info


def _type_name(type_text):
    base = re.split(r"[(<]", type_text)[0].upper()
    return {"BIGINT": "LONG"}.get(base, base)


# ---------------------------------------------------------------- time and writes

def anchor():
    """The current UTC hour: every time here is this minus a fixed offset."""
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


def fmt(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def write_times(sh, spec=None):
    """The data writes of a table (oldest first), as datetimes. The last is exactly last_h hours before the anchor."""
    spec = spec or SPEC[sh]
    r = random.Random(zlib.crc32(sh.encode()))
    now, n = anchor(), spec["n"]
    return [now - timedelta(hours=spec["last_h"] + (n - 1 - k) * spec["cadence_h"]
                            + (0 if k == n - 1 else r.uniform(-0.3, 0.3) * min(spec["cadence_h"], 3)),
                            minutes=r.randint(0, 9) if k < n - 1 else 0) for k in range(n)]


# ---------------------------------------------------------------- statements (system.query.history)

COPY = "COPY INTO demo_lake.bronze.{t} FROM '" + LANDING + "/{p}/' FILEFORMAT = CSV FORMAT_OPTIONS ('header' = 'true')"
SQL = {
    "bronze.raw_orders": COPY.format(t="raw_orders", p="orders"),
    "bronze.raw_order_lines": COPY.format(t="raw_order_lines", p="order_lines"),
    "bronze.raw_customers": COPY.format(t="raw_customers", p="customers"),
    "bronze.raw_products": COPY.format(t="raw_products", p="products"),
    "bronze.raw_returns": COPY.format(t="raw_returns", p="returns"),
    "bronze.raw_shipments": COPY.format(t="raw_shipments", p="shipments"),
    "bronze.raw_stores": COPY.format(t="raw_stores", p="stores"),
    "silver.orders": """CREATE OR REPLACE TABLE demo_lake.silver.orders AS
SELECT order_id, customer_id, store_id, region_code, order_ts, CAST(order_ts AS DATE) AS order_date,
       lower(status) AS status, channel
FROM demo_lake.bronze.raw_orders
WHERE order_id IS NOT NULL AND status <> 'TEST'
QUALIFY row_number() OVER (PARTITION BY order_id ORDER BY _ingested_at DESC) = 1""",
    "silver.order_lines": """INSERT INTO demo_lake.silver.order_lines
SELECT DISTINCT order_id, line_no, sku, qty AS quantity, unit_price, coalesce(discount_pct, 0.0) AS discount_pct
FROM demo_lake.bronze.raw_order_lines
WHERE qty > 0 AND _ingested_at >= date_sub(current_date(), 2)""",
    "silver.customers": """MERGE INTO demo_lake.silver.customers AS t
USING (
  SELECT customer_id, lower(email) AS email, full_name, country, referred_by AS referred_by_customer_id, created_at
  FROM demo_lake.bronze.raw_customers
  WHERE customer_id IS NOT NULL
  QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY _ingested_at DESC) = 1
) AS s
ON t.customer_id = s.customer_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *""",
    "silver.products": """CREATE OR REPLACE TABLE demo_lake.silver.products AS
SELECT sku, product_name, category, list_price
FROM demo_lake.bronze.raw_products
QUALIFY row_number() OVER (PARTITION BY sku ORDER BY _ingested_at DESC) = 1""",
    "silver.stores": """CREATE OR REPLACE TABLE demo_lake.silver.stores AS
SELECT DISTINCT store_id, region_code, store_name, city, opened_on
FROM demo_lake.bronze.raw_stores""",
    "silver.shipments": """CREATE OR REPLACE TABLE demo_lake.silver.shipments AS
SELECT shipment_id, order_id, carrier, shipped_at
FROM demo_lake.bronze.raw_shipments
WHERE shipped_at IS NOT NULL""",
    "gold.fact_order_lines": """CREATE OR REPLACE TABLE demo_lake.gold.fact_order_lines AS
SELECT l.order_id, l.line_no, o.customer_id, l.sku,
       CAST(date_format(o.order_date, 'yyyyMMdd') AS INT) AS date_key,
       o.store_id, o.region_code, l.quantity, l.unit_price,
       l.quantity * l.unit_price * l.discount_pct AS discount_amount,
       l.quantity * l.unit_price * (1 - l.discount_pct) AS net_amount
FROM demo_lake.silver.order_lines AS l
JOIN demo_lake.silver.v_orders_current AS o ON o.order_id = l.order_id
WHERE o.status <> 'cancelled'""",
    "gold.dim_customer": """CREATE OR REPLACE TABLE demo_lake.gold.dim_customer AS
SELECT customer_id, split(email, '@')[1] AS email_domain, full_name, country, referred_by_customer_id,
       CAST(created_at AS DATE) AS customer_since
FROM demo_lake.silver.customers""",
    "gold.dim_product": """CREATE OR REPLACE TABLE demo_lake.gold.dim_product AS
SELECT sku, product_name, category, list_price
FROM demo_lake.silver.products""",
    "gold.dim_date": """CREATE OR REPLACE TABLE demo_lake.gold.dim_date AS
SELECT CAST(date_format(d, 'yyyyMMdd') AS INT) AS date_key, d AS calendar_date, year(d) AS year, month(d) AS month,
       date_format(d, 'EEEE') AS day_of_week, dayofweek(d) IN (1, 7) AS is_weekend
FROM (SELECT explode(sequence(DATE'2020-01-01', DATE'2030-12-31')) AS d)""",
    "gold.dim_store": """CREATE OR REPLACE TABLE demo_lake.gold.dim_store AS
SELECT store_id, region_code, store_name, city
FROM demo_lake.silver.stores""",
    "gold.fact_returns": """CREATE OR REPLACE TABLE demo_lake.gold.fact_returns AS
SELECT r.return_id, r.order_id, r.line_no, CAST(date_format(r.returned_at, 'yyyyMMdd') AS INT) AS date_key,
       r.reason, f.net_amount AS refund_amount
FROM demo_lake.silver.returns AS r
JOIN demo_lake.gold.fact_order_lines AS f ON f.order_id = r.order_id AND f.line_no = r.line_no""",
    "gold.fact_shipments": """CREATE OR REPLACE TABLE demo_lake.gold.fact_shipments AS
SELECT s.shipment_id, s.order_id, CAST(date_format(s.shipped_at, 'yyyyMMdd') AS INT) AS date_key, s.carrier,
       datediff(s.shipped_at, o.order_date) AS days_to_ship
FROM demo_lake.silver.shipments AS s
LEFT JOIN demo_lake.silver.v_orders_current AS o ON o.order_id = s.order_id""",
    "gold.session_funnel": """CREATE OR REPLACE TABLE demo_lake.gold.session_funnel AS
SELECT CAST(started_at AS DATE) AS day, count(*) AS sessions, avg(events) AS avg_events
FROM demo_lake.silver.sessions
GROUP BY CAST(started_at AS DATE)""",
}
# Tables written with no SQL statement: a notebook's python, and pipelines (silver.returns, silver.sessions,
# bronze.raw_clickstream, gold.daily_revenue).
RUNS = 3  # the last few runs of each statement are in the history, each with its own statement_id

# Sources of each table, from its SQL or definition: (source table or None, file path or None). Files first.
FILES = {"bronze.raw_orders": "orders", "bronze.raw_order_lines": "order_lines", "bronze.raw_customers": "customers",
         "bronze.raw_products": "products", "bronze.raw_returns": "returns", "bronze.raw_shipments": "shipments",
         "bronze.raw_stores": "stores", "bronze.raw_clickstream": "clickstream"}
# Table lineage: target -> source tables (the pass-through views and the metric view carry view dependencies, not lineage events)
SOURCES = {
    "silver.orders": ["bronze.raw_orders"], "silver.order_lines": ["bronze.raw_order_lines"],
    "silver.customers": ["bronze.raw_customers"], "silver.products": ["bronze.raw_products"],
    "silver.stores": ["bronze.raw_stores"], "silver.returns": ["bronze.raw_returns"],
    "silver.shipments": ["bronze.raw_shipments"], "silver.sessions": ["bronze.raw_clickstream"],
    "gold.fact_order_lines": ["silver.order_lines", "silver.v_orders_current"],
    "gold.dim_customer": ["silver.customers"], "gold.dim_product": ["silver.products"], "gold.dim_store": ["silver.stores"],
    "gold.fact_returns": ["silver.returns", "gold.fact_order_lines"],
    "gold.fact_shipments": ["silver.shipments", "silver.v_orders_current"],
    "gold.daily_revenue": ["gold.fact_order_lines", "gold.dim_date"],
    "gold.session_funnel": ["silver.sessions"],
}
LINEAGE_EDGES = [(f"{LAKE}.{s}", f"{LAKE}.{t}") for t, srcs in SOURCES.items() for s in srcs]
# Edges the REST lineage API still returns that no longer hold (#19): v_orders_current once read silver.orders directly,
# before it was repointed at v_orders, so its view dependencies no longer name silver.orders.
SUPERSEDED_EDGES = [(f"{LAKE}.silver.orders", f"{LAKE}.silver.v_orders_current")]
# Objects lineage still names that were dropped (#20): (existing table, direction, dropped table). tables.get says not found.
DROPPED = [(f"{LAKE}.silver.sessions", "downstreams", f"{LAKE}.silver.sessions_v1")]


def _writer_info(kind, ident, when):
    """What a lineage item says about its producer."""
    ts = fmt(when)
    if kind == "job":
        return "jobInfos", {"job_id": ident, "workspace_id": WORKSPACE_ID, "lineage_timestamp": ts}
    if kind == "notebook":
        return "notebookInfos", {"notebook_id": ident, "workspace_id": WORKSPACE_ID, "lineage_timestamp": ts}
    return "pipelineInfos", {"pipeline_id": ident, "workspace_id": WORKSPACE_ID, "lineage_timestamp": ts}


def _last_write(sh):
    return write_times(sh)[-1]


def lineage_items(full_name):
    """(upstreams, downstreams) item lists as the table-lineage REST API returns them for one demo_lake table.

    The writer of the target is on every item (jobInfos, notebookInfos or pipelineInfos). A file upstream is an item with
    fileInfo and no tableInfo; one of them has its path hidden, as the API does without permission."""
    if full_name not in TABLES:
        return [], []
    sh = short(full_name)
    ups, downs = [], []

    def item(other_full, target_sh):
        c, s, n = other_full.split(".")
        if target_sh not in SPEC:  # a view: lineage records who read it, not a writer
            return {"tableInfo": {"catalog_name": c, "schema_name": s, "name": n, "table_type": TABLES[other_full][0],
                                  "lineage_timestamp": fmt(anchor() - timedelta(days=3))}}
        when = _last_write(target_sh)
        key, info = _writer_info(*SPEC[target_sh]["writer"], when)
        return {"tableInfo": {"catalog_name": c, "schema_name": s, "name": n, "table_type": TABLES[other_full][0],
                              "lineage_timestamp": fmt(when)}, key: [info]}

    for up, down in LINEAGE_EDGES + SUPERSEDED_EDGES:
        if down == full_name:
            ups.append(item(up, sh))
        if up == full_name:
            downs.append(item(down, short(down)))
    for table, direction, gone in DROPPED:
        if table == full_name:
            c, s, n = gone.split(".")
            (ups if direction == "upstreams" else downs).append({"tableInfo": {
                "catalog_name": c, "schema_name": s, "name": n, "table_type": "TABLE", "lineage_timestamp": fmt(_last_write(sh) - timedelta(days=30))}})
    for ident in READERS.get(sh, []):  # a dashboard that reads the table, with no table built from it
        downs.append({"dashboardV3Infos": [{"dashboard_id": ident, "workspace_id": WORKSPACE_ID, "lineage_timestamp": fmt(_last_write(sh))}]})
    if sh in FILES:
        when = _last_write(sh)
        key, info = _writer_info(*SPEC[sh]["writer"], when)
        hidden = sh == "bronze.raw_returns"
        ups.insert(0, {"fileInfo": {"path": "" if hidden else f"{LANDING}/{FILES[sh]}/", "has_permission": not hidden,
                                    "storage_location": "" if hidden else f"{LANDING}/{FILES[sh]}/",
                                    "securable_type": "", "lineage_timestamp": fmt(when)}, key: [info]})
    return ups, downs


def statements():
    """Every invented write statement of the lake, oldest first: dicts with the columns of system.query.history.

    Keys: statement_id, executed_by, start_time (datetime), statement_type, execution_status, statement_text, target
    (full table name), entity_type and entity_id (the job or notebook that ran it)."""
    out = []
    for sh, text in SQL.items():
        kind, ident = SPEC[sh]["writer"]
        stype = text.split(None, 1)[0].upper()  # COPY, CREATE, INSERT or MERGE
        for when in write_times(sh)[-RUNS:]:
            out.append({"executed_by": PRINCIPALS[kind], "start_time": when - timedelta(minutes=6), "statement_type": stype,
                        "execution_status": "FINISHED", "statement_text": text, "target": f"{LAKE}.{sh}",
                        "entity_type": kind.upper(), "entity_id": ident})
    out.sort(key=lambda x: (x["start_time"], x["target"]))
    for n, row in enumerate(out, 1):
        row["statement_id"] = f"demo-lake-{n:04d}"
    return out


def lineage_rows():
    """Rows of system.access.table_lineage for the lake, one per edge and run.

    source_type is TABLE or PATH (a file upstream: source_table_full_name is None, source_path set). statement_id is None
    for what no SQL statement wrote (a notebook's python, a pipeline). Oldest first."""
    by_target = {}
    for s in statements():
        by_target.setdefault(s["target"], []).append(s)
    rows = []
    for sh, spec in SPEC.items():
        target = f"{LAKE}.{sh}"
        kind, ident = spec["writer"]
        sources = [(f"{LAKE}.{s}", None) for s in SOURCES.get(sh, [])]
        if sh in FILES:
            sources.insert(0, (None, f"{LANDING}/{FILES[sh]}/"))
        runs = by_target.get(target) or [None] * RUNS
        times = write_times(sh)[-len(runs):]
        for run, when in zip(runs, times):
            for src, path in sources:
                rows.append({"statement_id": run["statement_id"] if run else None, "source_type": "TABLE" if src else "PATH",
                             "source_table_full_name": src, "source_path": path, "target_table_full_name": target,
                             "target_type": "TABLE", "entity_type": kind.upper(), "entity_id": ident,
                             "created_by": PRINCIPALS[kind], "event_time": when,
                             "executed_by": run["executed_by"] if run else None,
                             "statement_text": run["statement_text"] if run else None,
                             "statement_type": run["statement_type"] if run else None})
    rows.sort(key=lambda x: (x["event_time"], x["target_table_full_name"], x["source_table_full_name"] or ""))
    return rows


# ---------------------------------------------------------------- column lineage
# source table, source column, target table, target column
def _cl(src, dst, cols, renames=None):
    renames = renames or {}
    return [(f"{LAKE}.{src}", c, f"{LAKE}.{dst}", renames.get(c, c)) for c in cols]


COLUMN_LINEAGE = (
    _cl("bronze.raw_orders", "silver.orders", ["order_id", "customer_id", "store_id", "region_code", "order_ts", "status", "channel"])
    + [(f"{LAKE}.bronze.raw_orders", "order_ts", f"{LAKE}.silver.orders", "order_date")]
    + _cl("bronze.raw_order_lines", "silver.order_lines", ["order_id", "line_no", "sku", "qty", "unit_price", "discount_pct"], {"qty": "quantity"})
    + _cl("bronze.raw_customers", "silver.customers", ["customer_id", "email", "full_name", "country", "created_at"])
    + _cl("bronze.raw_customers", "silver.customers", ["referred_by"], {"referred_by": "referred_by_customer_id"})
    + _cl("bronze.raw_products", "silver.products", ["sku", "product_name", "category", "list_price"])
    + _cl("bronze.raw_stores", "silver.stores", ["store_id", "region_code", "store_name", "city", "opened_on"])
    + _cl("silver.orders", "silver.v_orders", ["order_id", "customer_id", "store_id", "region_code", "order_date", "status", "channel"])
    + _cl("silver.v_orders", "silver.v_orders_current", ["order_id", "customer_id", "store_id", "region_code", "order_date", "status", "channel"])
    # the fact and its measures
    + _cl("silver.order_lines", "gold.fact_order_lines", ["order_id", "line_no", "sku", "quantity", "unit_price"])
    + _cl("silver.v_orders_current", "gold.fact_order_lines", ["customer_id", "store_id", "region_code"])
    + [(f"{LAKE}.silver.v_orders_current", "order_date", f"{LAKE}.gold.fact_order_lines", "date_key")]
    + _cl("silver.order_lines", "gold.fact_order_lines", ["quantity", "unit_price", "discount_pct"], {"quantity": "discount_amount", "unit_price": "discount_amount", "discount_pct": "discount_amount"})
    + _cl("silver.order_lines", "gold.fact_order_lines", ["quantity", "unit_price", "discount_pct"], {"quantity": "net_amount", "unit_price": "net_amount", "discount_pct": "net_amount"})
    # dimensions, with the PII column's path into an untagged column
    + _cl("silver.customers", "gold.dim_customer", ["customer_id", "full_name", "country", "referred_by_customer_id"])
    + [(f"{LAKE}.silver.customers", "email", f"{LAKE}.gold.dim_customer", "email_domain"),
       (f"{LAKE}.silver.customers", "created_at", f"{LAKE}.gold.dim_customer", "customer_since")]
    + _cl("silver.products", "gold.dim_product", ["sku", "product_name", "category", "list_price"])
    + _cl("silver.stores", "gold.dim_store", ["store_id", "region_code", "store_name", "city"])
    # the other facts and the aggregates
    + _cl("silver.returns", "gold.fact_returns", ["return_id", "order_id", "line_no", "reason"])
    + [(f"{LAKE}.gold.fact_order_lines", "net_amount", f"{LAKE}.gold.fact_returns", "refund_amount"),
       (f"{LAKE}.silver.returns", "returned_at", f"{LAKE}.gold.fact_returns", "date_key")]
    + _cl("silver.shipments", "gold.fact_shipments", ["shipment_id", "order_id", "carrier"])
    + [(f"{LAKE}.silver.shipments", "shipped_at", f"{LAKE}.gold.fact_shipments", "date_key"),
       (f"{LAKE}.silver.shipments", "shipped_at", f"{LAKE}.gold.fact_shipments", "days_to_ship"),
       (f"{LAKE}.silver.v_orders_current", "order_date", f"{LAKE}.gold.fact_shipments", "days_to_ship")]
    + [(f"{LAKE}.gold.dim_date", "calendar_date", f"{LAKE}.gold.daily_revenue", "order_date"),
       (f"{LAKE}.gold.fact_order_lines", "store_id", f"{LAKE}.gold.daily_revenue", "store_id"),
       (f"{LAKE}.gold.fact_order_lines", "net_amount", f"{LAKE}.gold.daily_revenue", "revenue"),
       (f"{LAKE}.gold.fact_order_lines", "order_id", f"{LAKE}.gold.daily_revenue", "orders"),
       (f"{LAKE}.silver.sessions", "started_at", f"{LAKE}.gold.session_funnel", "day"),
       (f"{LAKE}.silver.sessions", "session_id", f"{LAKE}.gold.session_funnel", "sessions"),
       (f"{LAKE}.silver.sessions", "events", f"{LAKE}.gold.session_funnel", "avg_events")]
)
