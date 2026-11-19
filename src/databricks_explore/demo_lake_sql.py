"""Demo mode's warehouse answers for the lake (demo_lake.py): DESCRIBE DETAIL, DESCRIBE HISTORY, row counts and a relationship profile.

answer(low, statement, params) returns (columns, rows) for the statements it knows, None for the rest, and raises LookupError
for a table that does not exist or a statement the real warehouse refuses (DESCRIBE DETAIL on a view).

  DESCRIBE DETAIL <table>          one row: format, location, numFiles, sizeInBytes, clustering and partition columns
  DESCRIBE HISTORY <table> [LIMIT n]
                                   newest first, with job and notebook, operationMetrics (numOutputRows, MERGE's
                                   numTargetRows*), OPTIMIZE and VACUUM entries between the writes
  SELECT count(*) FROM <lake table>  the table's row count
  a relationship profile           any statement with a LEFT ANTI JOIN that names two tables: one row whose
                                   columns are the statement's own aliases, filled from what each alias says (see _value)

Tables outside demo_lake get a plain history (a nightly WRITE) so the same statements work on the older demo data.
The late table is demo_lake.silver.shipments. demo_lake.silver.customers is the table whose latest commit is an OPTIMIZE.
"""
import json
import random
import re
import zlib
from datetime import timedelta

import sqlglot

from . import demo_lake as lake

MB = 1024 * 1024
ENGINE = "Databricks-Runtime/17.3.x-photon-scala2.13"
GENERIC_JOB = ("9001", "demo_nightly")

HISTORY_COLUMNS = [("version", "LONG"), ("timestamp", "TIMESTAMP"), ("userId", "STRING"), ("userName", "STRING"),
                   ("operation", "STRING"), ("operationParameters", "MAP"), ("job", "STRUCT"), ("notebook", "STRUCT"),
                   ("clusterId", "STRING"), ("readVersion", "LONG"), ("isolationLevel", "STRING"),
                   ("isBlindAppend", "BOOLEAN"), ("operationMetrics", "MAP"), ("userMetadata", "STRING"),
                   ("engineInfo", "STRING")]
DETAIL_COLUMNS = [("format", "STRING"), ("id", "STRING"), ("name", "STRING"), ("description", "STRING"),
                  ("location", "STRING"), ("createdAt", "TIMESTAMP"), ("lastModified", "TIMESTAMP"),
                  ("partitionColumns", "ARRAY"), ("clusteringColumns", "ARRAY"), ("numFiles", "LONG"),
                  ("sizeInBytes", "LONG"), ("properties", "MAP"), ("minReaderVersion", "INT"),
                  ("minWriterVersion", "INT"), ("tableFeatures", "ARRAY")]
TYPE_TEXT = {"MAP": "map<string,string>", "STRUCT": "struct<>", "ARRAY": "array<string>"}


def _cols(pairs):
    return [{"name": n, "type": t, "type_text": TYPE_TEXT.get(t, t.lower())} for n, t in pairs]


def spec_of(full_name, tables):
    """(key, spec) for a table: the lake's own, or a generic nightly writer for the older demo tables. LookupError if absent."""
    if full_name not in tables:
        raise LookupError(f"[TABLE_OR_VIEW_NOT_FOUND] The table or view \x60{full_name}\x60 cannot be found. SQLSTATE: 42P01")
    kind = tables[full_name][0]
    if kind == "VIEW":
        raise LookupError(f"[EXPECT_TABLE_NOT_VIEW.NO_ALTERNATIVE] '{full_name}' is a view. DESCRIBE DETAIL and DESCRIBE "
                          "HISTORY are only supported for tables. SQLSTATE: 42809")
    if lake.is_lake(full_name):
        key = lake.short(full_name)
        return key, lake.SPEC[key]
    rows = tables[full_name][3]
    return full_name, dict(rows=rows, bpr=100, op="WRITE", mode="Overwrite", cadence_h=24, n=12, last_h=5,
                           writer=("job", GENERIC_JOB[0]))


def _writer_json(kind, ident, rnd):
    if kind == "job":
        name = lake.JOBS.get(ident, GENERIC_JOB[1])
        run = str(10**12 + rnd.randint(0, 10**9))
        return (json.dumps({"jobId": ident, "jobName": name, "jobRunId": run, "runId": run, "jobOwnerId": "1001",
                            "triggerType": "cron"}), None)
    if kind == "notebook":
        return None, json.dumps({"notebookId": ident})
    return None, None


def _metrics(spec, op, k, rows_k, rnd):
    """operationMetrics of one write, as strings like the real map."""
    bpr, files = spec["bpr"], max(1, rows_k * spec["bpr"] // (128 * MB))
    if op == "MERGE":
        src = rnd.randint(900, 1500)
        upd, ins = int(src * 0.8), src - int(src * 0.8)
        return {"numSourceRows": str(src), "numTargetRowsInserted": str(ins), "numTargetRowsUpdated": str(upd),
                "numTargetRowsDeleted": "0", "numTargetRowsCopied": str(rnd.randint(20_000, 60_000)),
                "numOutputRows": str(ins + upd), "numTargetFilesAdded": str(rnd.randint(2, 6)),
                "numTargetFilesRemoved": str(rnd.randint(2, 6))}
    if op == "STREAMING UPDATE":
        return {"numAddedFiles": "1", "numRemovedFiles": "0", "numOutputRows": str(rows_k),
                "numOutputBytes": str(rows_k * bpr), "numAddedBytes": str(rows_k * bpr)}
    return {"numFiles": str(files), "numOutputRows": str(rows_k), "numOutputBytes": str(rows_k * bpr)}


def _params(spec, op):
    if op == "MERGE":
        return {"predicate": '["(t.customer_id = s.customer_id)"]', "matchedPredicates": '[{"actionType":"update"}]',
                "notMatchedPredicates": '[{"actionType":"insert"}]'}
    if op == "WRITE":
        return {"mode": spec.get("mode", "Append"), "statsOnLoad": "false", "partitionBy": "[]"}
    if op == "COPY INTO":
        return {}
    if op == "STREAMING UPDATE":
        return {"outputMode": "Append", "queryId": "demo-query", "epochId": "0"}
    return {"partitionBy": "[]", "clusterBy": "[]", "description": "null", "isManaged": "true", "properties": "{}"}


def history_rows(key, spec):
    """DESCRIBE HISTORY of a table, newest first, as dicts keyed by HISTORY_COLUMNS names."""
    rnd = random.Random(zlib.crc32(("h" + key).encode()))
    kind, ident = spec["writer"]
    user = lake.PRINCIPALS[kind]
    op, entries = spec["op"], []
    for k, when in enumerate(lake.write_times(key, spec)):
        rows_k = spec.get("append") or round(spec["rows"] * (1 - 0.012 * (spec["n"] - 1 - k)))
        entries.append((when, op, rows_k, k))
        if k % 7 == 6 and k < spec["n"] - 1:  # maintenance now and then; none of it adds data
            entries.append((when + timedelta(minutes=40), "OPTIMIZE", 0, k))
        if k % 14 == 13 and k < spec["n"] - 1:
            entries.append((when + timedelta(minutes=55), "VACUUM START", 0, k))
            entries.append((when + timedelta(minutes=56), "VACUUM END", 0, k))
    if spec.get("optimize_last"):
        entries.append((lake.anchor() - timedelta(hours=3), "OPTIMIZE", 0, spec["n"]))
    entries.sort(key=lambda e: e[0])
    out = []
    for version, (when, operation, rows_k, k) in enumerate(entries):
        data = operation == op
        job, notebook = _writer_json(kind, ident, rnd)
        if operation == "OPTIMIZE":
            metrics = {"numRemovedFiles": "14", "numAddedFiles": "2", "numRemovedBytes": str(40 * MB), "numAddedBytes": str(38 * MB)}
            params, user_name, job, notebook, blind = {"predicate": "[]", "auto": "false"}, user, None, None, False
        elif operation == "VACUUM START":
            metrics = {"numFilesToDelete": "31", "sizeOfDataToDelete": str(90 * MB)}
            params, user_name, job, notebook, blind = {"retentionCheckEnabled": "true", "specifiedRetentionMillis": "604800000"}, user, None, None, False
        elif operation == "VACUUM END":
            metrics, params, user_name, job, notebook, blind = {"numDeletedFiles": "31", "numVacuumedDirectories": "1"}, {"status": "COMPLETED"}, user, None, None, False
        else:
            metrics, params, user_name = _metrics(spec, op, k, rows_k, rnd), _params(spec, op), user
            blind = op in ("COPY INTO", "STREAMING UPDATE") or (op == "WRITE" and spec.get("mode", "Append") == "Append")
        out.append({"version": str(version), "timestamp": lake.fmt(when), "userId": "1001" if kind == "job" else "1002",
                    "userName": user_name, "operation": operation, "operationParameters": json.dumps(params),
                    "job": job if data else None, "notebook": notebook if data else None,
                    "clusterId": "0101-demo-serverless", "readVersion": str(max(version - 1, 0)),
                    "isolationLevel": "WriteSerializable", "isBlindAppend": "true" if blind else "false",
                    "operationMetrics": json.dumps(metrics), "userMetadata": None, "engineInfo": ENGINE})
    return out[::-1]


def detail_row(full_name, key, spec, tables):
    """The one row of DESCRIBE DETAIL."""
    last = max(h["timestamp"] for h in history_rows(key, spec))
    size = spec["rows"] * spec["bpr"]
    return [{"format": "delta", "id": f"demo-{zlib.crc32(full_name.encode()):08x}-0000-4000-8000-000000000000",
             "name": full_name, "description": tables[full_name][2],
             "location": f"{lake.LAKE_ROOT}/{key.replace('.', '/')}", "createdAt": lake.fmt(lake.write_times(key, spec)[0]),
             "lastModified": last, "partitionColumns": json.dumps(spec.get("partition", [])),
             "clusteringColumns": json.dumps(spec.get("cluster", [])),
             "numFiles": str(max(1, size // (110 * MB))), "sizeInBytes": str(size), "properties": "{}",
             "minReaderVersion": "1", "minWriterVersion": "2", "tableFeatures": json.dumps(["appendOnly", "invariants"])}]


def _table_arg(text):
    return text.replace("\x60", "").strip().rstrip(";").lower()


# ---------------------------------------------------------------- relationship profile
# a_ is the referencing side (the child table), b_ the referenced side. Keys are measured on the child's key columns.
PROFILES = {
    ("demo_lake.gold.fact_order_lines", "demo_lake.gold.dim_product"):
        dict(a_distinct=3_583, b_distinct=3_412, orphan_rows=223_204, orphan_keys=212, unused_keys=41, max_fanout=91_220, p95_fanout=14_800),
    ("demo_lake.gold.fact_order_lines", "demo_lake.gold.dim_customer"):
        dict(a_nulls=1_860_000, a_distinct=1_775_320, b_distinct=1_904_511, orphan_rows=0, orphan_keys=0, unused_keys=129_191, max_fanout=212, p95_fanout=31),
    ("demo_lake.gold.fact_order_lines", "demo_lake.gold.dim_date"):
        dict(a_distinct=1_980, b_distinct=4_018, orphan_rows=0, orphan_keys=0, unused_keys=2_038, max_fanout=48_000, p95_fanout=12_400),
    ("demo_lake.gold.fact_order_lines", "demo_lake.gold.dim_store"):
        dict(a_distinct=214, b_distinct=214, orphan_rows=0, orphan_keys=0, unused_keys=0, max_fanout=402_000, p95_fanout=190_000),
    ("demo_lake.gold.fact_returns", "demo_lake.gold.fact_order_lines"):
        dict(a_distinct=880_000, b_distinct=18_600_000, orphan_rows=0, orphan_keys=0, unused_keys=17_720_000, max_fanout=1, p95_fanout=1),
    ("demo_lake.gold.dim_customer", "demo_lake.gold.dim_customer"):
        dict(a_nulls=1_650_000, a_distinct=211_000, b_distinct=1_904_511, orphan_rows=0, orphan_keys=0, unused_keys=1_693_511, max_fanout=58, p95_fanout=3),
}


def _truth(a, b, rows_of):
    """The numbers for A -> B: the invented ones for the lake's references, a clean one-to-many for any other pair."""
    ra, rb = rows_of(a), rows_of(b)
    base = dict(a_rows=ra, b_rows=rb, a_nulls=0, a_distinct=min(ra, rb), b_distinct=rb, orphan_rows=0, orphan_keys=0,
                unused_keys=max(rb - min(ra, rb), 0), max_fanout=max(ra // max(rb, 1), 1) * 3, p95_fanout=max(ra // max(rb, 1), 1))
    return base | PROFILES.get((a, b), {})


def _value(alias, t):
    """The number a profile column holds, chosen by what its alias says (orphan, unused, repeated, null, distinct, p95, max, rows)."""
    n = alias.lower()
    b_side = bool(re.search(r"(^b_|_b$|parent|referenced|ref_|target|dim_|_to_)", n))
    if "orphan" in n:
        return t["orphan_keys"] if re.search(r"key|distinct", n) else t["orphan_rows"]
    if "unused" in n:
        return t["unused_keys"]
    if "repeat" in n or "dup" in n:
        return 0  # the lake's referenced keys are all unique
    if "p95" in n or "percentile" in n:
        return t["p95_fanout"]
    if "max" in n or "fan" in n:
        return t["max_fanout"]
    if "null" in n:
        return t["a_nulls"]
    if "distinct" in n or "keys" in n:
        return t["b_distinct"] if b_side else t["a_distinct"]
    return t["b_rows"] if b_side else t["a_rows"]


def _profile(statement, low, tables, rows_of):
    named = sorted((low.find(t), t) for t in tables if t in low)
    names = [t for _, t in named if _ >= 0]
    if len(names) == 1 and (names[0], names[0]) in PROFILES:
        names = [names[0], names[0]]
    if len(names) < 2:
        return None
    truth = _truth(names[0], names[1], rows_of)
    try:
        aliases = [e.alias_or_name for e in sqlglot.parse_one(statement, read="databricks").selects]
    except Exception:
        aliases = []
    aliases = [a for a in aliases if a] or ["a_rows", "a_null_rows", "a_distinct_keys", "b_rows", "b_distinct_keys",
                                           "orphan_rows", "orphan_keys", "unused_keys", "max_fanout", "p95_fanout"]
    return ([{"name": a, "type": "LONG"} for a in aliases], [[str(_value(a, truth)) for a in aliases]])


def answer(low, statement, params, tables):
    """(columns, rows) for the lake's statements, None for any other. See the module docstring."""
    flat = low.replace("\x60", "")
    m = re.match(r"^(?:describe|desc)\s+(detail|history)\s+([\w.\-]+)(?:\s+limit\s+(\d+))?\s*;?$", flat)
    if m:
        full = _table_arg(m.group(2))
        key, spec = spec_of(full, tables)
        if m.group(1) == "detail":
            return _cols(DETAIL_COLUMNS), [[r[c] for c, _ in DETAIL_COLUMNS] for r in detail_row(full, key, spec, tables)]
        rows = history_rows(key, spec)[: int(m.group(3)) if m.group(3) else None]
        return _cols(HISTORY_COLUMNS), [[r[c] for c, _ in HISTORY_COLUMNS] for r in rows]
    c = re.match(r"^select\s+count\((?:\*|1)\)(?:\s+as\s+(\w+))?\s+from\s+([\w.]+)\s*;?$", flat)
    if c and lake.is_lake(c.group(2)):
        return [{"name": c.group(1) or "count(1)", "type": "LONG"}], [[str(lake.ROWS[c.group(2)])]]
    if re.search(r"anti\s+join", flat):
        return _profile(statement, flat, tables, lambda t: lake.ROWS.get(t) or tables[t][3])
    return None
