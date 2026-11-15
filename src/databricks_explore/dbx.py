"""Databricks access + local JSON cache. Every remote call is logged to calls.jsonl in the data folder's logs/."""
import configparser, json, os, re, subprocess, time
from datetime import datetime, timezone
from pathlib import Path

from databricks.sdk import WorkspaceClient
from platformdirs import user_data_path
from databricks.sdk.service.sql import StatementParameterListItem, StatementState

from . import demo
from . import sqltools


def default_data_dir(demo: bool = False) -> Path:
    """The per-user data folder (never inside the installed package). Demo mode gets a demo/ folder under it."""
    base = user_data_path("databricks-explore", appauthor=False)
    return base / "demo" if demo else base


DEMO = os.environ.get("EXPLORER_DEMO") == "1"  # fake workspace with invented data (databricks-explore --demo)
# Everything the app writes lives here. Demo mode gets its own folder so demo canvases never mix with real ones.
DATA = Path(os.environ.get("EXPLORER_DATA_DIR") or default_data_dir(DEMO))
if DEMO:
    WorkspaceClient = demo.FakeWorkspaceClient  # the one hook: Explorer builds its client from this name
CACHE, LOGS, DIAGRAMS = DATA / "cache", DATA / "logs", DATA / "diagrams"
for d in (CACHE, LOGS, DIAGRAMS):
    d.mkdir(parents=True, exist_ok=True)

# Column lineage for one table, either end. One row per column pair; event_time is reduced to the latest.
COLUMN_LINEAGE_SQL = """SELECT source_table_full_name, source_column_name, target_table_full_name, target_column_name,
       max(event_time) AS last_seen
FROM system.access.column_lineage
WHERE (target_table_full_name = :t OR source_table_full_name = :t)
  AND source_table_full_name IS NOT NULL AND target_table_full_name IS NOT NULL
  AND source_column_name IS NOT NULL AND target_column_name IS NOT NULL
GROUP BY 1, 2, 3, 4
ORDER BY last_seen DESC
LIMIT 5000"""

# Unity Catalog tags of one table and of its columns, read from the table's own catalog. Same column shape as the other tag queries.
TABLE_TAGS_SQL = """SELECT 'table' AS scope, catalog_name, schema_name, table_name, CAST(NULL AS STRING) AS column_name, tag_name, tag_value
FROM {catalog}.information_schema.table_tags
WHERE schema_name = :sch AND table_name = :tbl
UNION ALL
SELECT 'column', catalog_name, schema_name, table_name, column_name, tag_name, tag_value
FROM {catalog}.information_schema.column_tags
WHERE schema_name = :sch AND table_name = :tbl
LIMIT 2000"""

# Tables and columns carrying one tag, across the metastore (or one catalog); {value} and {catalog} add the optional filters.
FIND_BY_TAG_SQL = """SELECT 'table' AS scope, catalog_name, schema_name, table_name, CAST(NULL AS STRING) AS column_name, tag_name, tag_value
FROM system.information_schema.table_tags
WHERE tag_name = :tag{filters}
UNION ALL
SELECT 'column', catalog_name, schema_name, table_name, column_name, tag_name, tag_value
FROM system.information_schema.column_tags
WHERE tag_name = :tag{filters}
LIMIT {limit}"""

# What the lineage API returns per upstream/downstream, besides tableInfo
ENTITY_KEYS = {"jobInfos": "job", "notebookInfos": "notebook", "pipelineInfos": "pipeline",
               "dashboardV3Infos": "dashboard", "queryInfos": "query", "fileInfo": "file"}


_CONFIG_DUMP = re.compile(r"\s*\bConfig:\s*\w+=.*", re.S)


def _type_of(col):
    """Manifest type name. The SDK enum lacks newer types (TIMESTAMP_NTZ, VARIANT), so fall back to type_text's base name."""
    if col.type_name:
        return col.type_name.value
    base = re.split(r"[(<\s]", (col.type_text or "").strip())[0].upper()
    return base or None


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def is_internal(name):
    """MV/streaming-table backing tables, e.g. __materialization_mat_<uuid>_<mv>_1. Not user-readable."""
    return name.split(".")[-1].startswith("__")


def clean_error(message):
    """Error text for the UI: drops the SDK's trailing "Config: host=..., profile=..." dump and anything after it."""
    return _CONFIG_DUMP.sub("", str(message)).rstrip()


def safe(s):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", s)


def log(entry):
    with open(LOGS / "calls.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": now(), **entry}, default=str) + "\n")


# ---------- profiles / auth ----------

def cfg_path():
    return Path(os.environ.get("DATABRICKS_CONFIG_FILE", Path.home() / ".databrickscfg"))


def list_profiles():
    if DEMO:
        return demo.PROFILES
    cp = configparser.ConfigParser()
    cp.read(cfg_path())
    out = []
    for name in cp.sections() + (["DEFAULT"] if cp.defaults() else []):
        if name.startswith("__") and name.endswith("__"):
            continue  # tool settings such as [__settings__], not a workspace profile
        sec = cp[name]
        out.append({"name": name, "host": sec.get("host", ""), "auth_type": sec.get("auth_type", "")})
    return out


def cli_login(profile):
    """Opens the browser for U2M OAuth. Blocks until the user finishes (or 3 min)."""
    t = time.time()
    r = subprocess.run(["databricks", "auth", "login", "--profile", profile],
                       capture_output=True, text=True, timeout=180)
    log({"op": "cli auth login", "profile": profile, "ms": int((time.time() - t) * 1000),
         "ok": r.returncode == 0, "stderr": r.stderr[-500:]})
    if r.returncode != 0:
        raise RuntimeError(r.stderr or r.stdout)


class Explorer:
    def __init__(self, profile):
        self.profile = profile
        self.w = WorkspaceClient(profile=profile)
        self.root = CACHE / safe(profile)
        self.warehouse_id = None
        self.workspace_id = None
        self.jobs = {}  # async statement_id -> {max_rows, can_detect, t0}; lives only as long as the process

    def whoami(self):
        me = self._call("current_user.me", lambda: self.w.current_user.me().as_dict())
        try:
            self.workspace_id = str(self.w.get_workspace_id())
        except Exception:
            pass
        return {"user": me.get("userName"), "host": self.w.config.host, "workspace_id": self.workspace_id}

    # ---- generic helpers ----
    def _call(self, op, fn, **args):
        t = time.time()
        try:
            res = fn()
            n = len(res) if isinstance(res, list) else None
            log({"op": op, "profile": self.profile, **args, "ms": int((time.time() - t) * 1000), "ok": True, "count": n})
            return res
        except Exception as e:
            log({"op": op, "profile": self.profile, **args, "ms": int((time.time() - t) * 1000), "ok": False, "error": str(e)[:500]})
            raise

    def _cached(self, rel, fetch, refresh):
        p = self.root / rel
        if p.exists() and not refresh:
            return json.loads(p.read_text(encoding="utf-8"))
        payload = {"fetched_at": now(), "data": fetch()}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
        return payload

    @staticmethod
    def _dir(full_name):
        c, s, _ = full_name.split(".", 2)
        return f"{safe(c)}/{safe(s)}"

    # ---- SQL warehouse (optional; only used for search-everything) ----
    def warehouses(self):
        return self._call("warehouses.list", lambda: [
            {"id": w.id, "name": w.name, "state": w.state.value if w.state else None}
            for w in self.w.warehouses.list()])

    def sql(self, statement, **params):
        if not self.warehouse_id:
            raise RuntimeError("No SQL warehouse selected.")

        def run():
            r = self.w.statement_execution.execute_statement(
                statement=statement, warehouse_id=self.warehouse_id, wait_timeout="30s",
                parameters=[StatementParameterListItem(name=k, value=str(v)) for k, v in params.items()])
            while r.status.state in (StatementState.PENDING, StatementState.RUNNING):
                time.sleep(1)
                r = self.w.statement_execution.get_statement(r.statement_id)
            if r.status.state != StatementState.SUCCEEDED:
                raise RuntimeError(r.status.error.message if r.status.error else r.status.state.value)
            cols = [c.name for c in r.manifest.schema.columns]
            return [dict(zip(cols, row)) for row in ((r.result and r.result.data_array) or [])]
        return self._call("sql", run, statement=" ".join(statement.split())[:400], params=params)

    # ---- query execution (A1): sync and async, row-capped, typed columns. Contract: contracts/api.md §3 ----
    def _elapsed(self, t0):
        return int((time.time() - t0) * 1000)

    def _submit(self, sql, params, max_rows, wait):
        max_rows = int(max_rows)
        if max_rows < 1:
            raise ValueError("max_rows must be at least 1.")
        if not self.warehouse_id:
            raise RuntimeError("No SQL warehouse selected.")
        wrapped, can_detect = sqltools.wrap_limit(sql, max_rows)
        se = self.w.statement_execution
        r = self._call("statement.execute", lambda: se.execute_statement(
                statement=wrapped, warehouse_id=self.warehouse_id, wait_timeout=wait,
                parameters=[StatementParameterListItem(name=k, value=str(v)) for k, v in (params or {}).items()]),
            statement=" ".join(sql.split())[:400], params=params or {}, max_rows=max_rows,
            limit_wrapped=can_detect)
        return r, max_rows, can_detect

    def _await(self, r):
        """Polls until the statement leaves PENDING/RUNNING. Every poll is a logged call."""
        sid = r.statement_id
        while r.status.state in (StatementState.PENDING, StatementState.RUNNING):
            time.sleep(1)
            r = self._call("statement.get", lambda: self.w.statement_execution.get_statement(sid), statement_id=sid)
        return r

    def _collect(self, r, max_rows, can_detect):
        """Column types from the manifest; rows from the first chunk and then every further chunk,
        stopping once max_rows + 1 rows are seen (or the result ends). Trims to max_rows."""
        sid = r.statement_id
        cols = [{"name": c.name, "type": _type_of(c), "type_text": c.type_text or None}
                for c in ((r.manifest and r.manifest.schema and r.manifest.schema.columns) or [])]
        rows = list((r.result and r.result.data_array) or [])
        nxt = r.result.next_chunk_index if r.result else None
        while nxt is not None and len(rows) <= max_rows:
            chunk = self._call("statement.result_chunk",
                               lambda i=nxt: self.w.statement_execution.get_statement_result_chunk_n(sid, i),
                               statement_id=sid, chunk_index=nxt)
            rows.extend(chunk.data_array or [])
            nxt = chunk.next_chunk_index
        truncated = (len(rows) > max_rows) if can_detect else None
        rows = rows[:max_rows]
        return {"statement_id": sid, "columns": cols, "rows": rows, "row_count": len(rows), "truncated": truncated}

    def query(self, sql, params=None, max_rows=5000):
        """Runs sql and waits for the result (up to the Databricks wait, then polls)."""
        t = time.time()
        r, max_rows, can_detect = self._submit(sql, params, max_rows, wait="30s")
        r = self._await(r)
        if r.status.state != StatementState.SUCCEEDED:
            raise RuntimeError(r.status.error.message if r.status.error else r.status.state.value)
        return {**self._collect(r, max_rows, can_detect), "ms": self._elapsed(t)}

    def query_async(self, sql, params=None, max_rows=5000):
        """Submits without waiting and returns the statement_id. Poll with query_status()."""
        t = time.time()
        r, max_rows, can_detect = self._submit(sql, params, max_rows, wait="0s")
        self.jobs[r.statement_id] = {"max_rows": max_rows, "can_detect": can_detect, "t0": t, "ms": None}
        return r.statement_id

    def query_status(self, sid):
        job = self.jobs.get(sid)
        if job is None:
            raise RuntimeError(f"Unknown statement_id: {sid} (not submitted to this server process)")
        r = self._call("statement.get", lambda: self.w.statement_execution.get_statement(sid), statement_id=sid)
        state = r.status.state
        out = {"statement_id": sid, "columns": [], "rows": [], "row_count": 0, "truncated": None, "ms": None}
        if state not in (StatementState.PENDING, StatementState.RUNNING):
            if job["ms"] is None:  # first poll that sees a finished state: submit-to-completion, to poll granularity
                job["ms"] = self._elapsed(job["t0"])
            out["ms"] = job["ms"]
            if state == StatementState.SUCCEEDED:
                out.update(self._collect(r, job["max_rows"], job["can_detect"]))
            elif state == StatementState.FAILED:
                out["error"] = clean_error(r.status.error.message) if r.status.error else "FAILED"
        return {**out, "state": state.value, "error": out.get("error")}

    def query_cancel(self, sid):
        """Best-effort, asynchronous. Poll query_status() to see CANCELED."""
        self._call("statement.cancel", lambda: self.w.statement_execution.cancel_execution(sid), statement_id=sid)
        return {"statement_id": sid, "cancel_requested": True}

    # ---- metastore browsing ----
    def catalogs(self, refresh=False):
        return self._cached("catalogs.json", lambda: self._call(
            "catalogs.list", lambda: sorted(
                [{"name": c.name, "type": c.catalog_type.value if c.catalog_type else None, "comment": c.comment}
                 for c in self.w.catalogs.list()], key=lambda x: x["name"])), refresh)

    def schemas(self, catalog, refresh=False):
        return self._cached(f"{safe(catalog)}/schemas.json", lambda: self._call(
            "schemas.list", lambda: sorted(
                [{"name": s.name, "comment": s.comment} for s in self.w.schemas.list(catalog_name=catalog)],
                key=lambda x: x["name"]), catalog=catalog), refresh)

    def objects(self, catalog, schema, refresh=False):
        def fetch():
            return sorted([{"name": t.name, "full_name": t.full_name,
                            "type": t.table_type.value if t.table_type else None, "comment": t.comment}
                           for t in self.w.tables.list(catalog_name=catalog, schema_name=schema)
                           if not is_internal(t.name)],
                          key=lambda x: x["name"])
        return self._cached(f"{safe(catalog)}/{safe(schema)}/objects.json",
                            lambda: self._call("tables.list", fetch, catalog=catalog, schema=schema), refresh)

    def search(self, q):
        """Name search. information_schema if a warehouse is set, else whatever schemas are cached locally."""
        if self.warehouse_id:
            rows = self.sql("""
                SELECT table_catalog, table_schema, table_name, table_type
                FROM system.information_schema.tables
                WHERE lower(table_name) LIKE lower(concat('%', :q, '%'))
                  AND left(table_name, 2) <> '__'  -- not NOT startswith(): on information_schema that filter drops every row
                ORDER BY table_name, table_catalog, table_schema
                LIMIT 300""", q=q)
            return {"source": "information_schema", "data": [
                {"full_name": f"{r['table_catalog']}.{r['table_schema']}.{r['table_name']}",
                 "name": r["table_name"], "type": r["table_type"]} for r in rows]}
        hits = [o for p in self.root.glob("*/*/objects.json")
                for o in json.loads(p.read_text(encoding="utf-8"))["data"] if q.lower() in o["name"].lower()]
        return {"source": "cached schemas only (pick a SQL warehouse to search everything)",
                "data": sorted(hits, key=lambda x: (x["name"], x["full_name"]))[:300]}

    def object(self, full_name, refresh=False):
        return self._cached(f"{self._dir(full_name)}/obj/{safe(full_name)}.json",
                            lambda: self._call("tables.get", lambda: self.w.tables.get(full_name=full_name).as_dict(),
                                               full_name=full_name), refresh)

    def lineage(self, full_name, refresh=False):
        def fetch():
            return self.w.api_client.do("GET", "/api/2.0/lineage-tracking/table-lineage",
                                        body={"table_name": full_name, "include_entity_lineage": True})
        return self._cached(f"{self._dir(full_name)}/lineage/{safe(full_name)}.json",
                            lambda: self._call("lineage-tracking/table-lineage", fetch, full_name=full_name), refresh)

    def column_lineage(self, full_name, refresh=False):
        """Column-level lineage rows touching one table, from system.access.column_lineage (one warehouse query).

        Cached like the other metadata, and a cached copy is returned even when no warehouse is selected.
        Raises RuntimeError without a warehouse and no cache, and whatever the warehouse says (no access) otherwise.
        """
        def fetch():
            if not self.warehouse_id:
                raise RuntimeError("Column lineage is read with a SQL warehouse (system.access.column_lineage). "
                                   "Pick one.")
            return self.sql(COLUMN_LINEAGE_SQL, t=full_name)
        return self._cached(f"{self._dir(full_name)}/column_lineage/{safe(full_name)}.json", fetch, refresh)

    def tags(self, full_name, refresh=False):
        """Unity Catalog tags of one table and its columns: {"table": {tag: value}, "columns": {column: {tag: value}}}.

        One read-only warehouse query on <catalog>.information_schema, cached like column lineage (a cached copy is
        returned without a warehouse; `refresh` re-reads). Raises RuntimeError without a warehouse and no cache.
        """
        def fetch():
            if not self.warehouse_id:
                raise RuntimeError("Tags are read with a SQL warehouse (information_schema.table_tags). Pick one.")
            catalog, schema, table = full_name.split(".", 2)
            rows = self.sql(TABLE_TAGS_SQL.format(catalog="`" + catalog.replace("`", "``") + "`"), sch=schema, tbl=table)
            out = {"table": {}, "columns": {}}
            for r in rows:
                if r["table_name"] != table or r["schema_name"] != schema or not r.get("tag_name"):
                    continue
                if r["scope"] == "column" and r.get("column_name"):
                    out["columns"].setdefault(r["column_name"], {})[r["tag_name"]] = r.get("tag_value") or ""
                elif r["scope"] == "table":
                    out["table"][r["tag_name"]] = r.get("tag_value") or ""
            return out
        return self._cached(f"{self._dir(full_name)}/tags/{safe(full_name)}.json", fetch, refresh)

    def find_by_tag(self, tag_name, tag_value=None, catalog=None, limit=100):
        """Tables and columns carrying a tag, from system.information_schema (one warehouse query, never cached).

        Returns {"rows": [{"scope", "table", "column", "tag_name", "tag_value"}], "truncated"}. Raises RuntimeError
        without a warehouse.
        """
        params = {"tag": tag_name}
        filters = ""
        if tag_value is not None:
            filters += " AND tag_value = :val"
            params["val"] = tag_value
        if catalog:
            filters += " AND catalog_name = :cat"
            params["cat"] = catalog
        rows = self.sql(FIND_BY_TAG_SQL.format(filters=filters, limit=int(limit) + 1), **params)
        rows = [r for r in rows if r.get("tag_name") == tag_name
                and (tag_value is None or (r.get("tag_value") or "") == tag_value) and r.get("scope") in ("table", "column")
                and (not catalog or r["catalog_name"] == catalog)]
        return {"rows": [{"scope": r["scope"], "table": f"{r['catalog_name']}.{r['schema_name']}.{r['table_name']}",
                          "column": r.get("column_name") if r["scope"] == "column" else None,
                          "tag_name": r["tag_name"], "tag_value": r.get("tag_value") or ""} for r in rows[:limit]],
                "truncated": len(rows) > limit}

    # ---- edge details: what produced a lineage link, and when ----
    def _link(self, kind, info):
        h = self.w.config.host.rstrip("/")
        i = {"job": info.get("job_id"), "notebook": info.get("notebook_id"),
             "pipeline": info.get("pipeline_id"), "dashboard": info.get("dashboard_id"),
             "query": info.get("query_id")}.get(kind)
        url = {"job": f"{h}/jobs/{i}", "notebook": f"{h}/#notebook/{i}",
               "pipeline": f"{h}/pipelines/{i}", "dashboard": f"{h}/dashboardsv3/{i}",
               "query": f"{h}/sql/editor/{i}"}.get(kind)
        other_ws = info.get("workspace_id") and self.workspace_id and str(info["workspace_id"]) != self.workspace_id
        return {"kind": kind, "id": str(i), "url": None if other_ws or not i else url,
                "workspace_id": str(info.get("workspace_id", "")), "other_workspace": bool(other_ws),
                "last_seen": info.get("lineage_timestamp"), "raw": info}

    def edge_details(self, src, tgt):
        """Reads the cached lineage of src (downstreams) and tgt (upstreams) for this pair, both directions."""
        flows = []
        for a, b in ((src, tgt), (tgt, src)):
            seen = set()
            for owner, direction, other in ((a, "downstreams", b), (b, "upstreams", a)):
                p = self.root / f"{self._dir(owner)}/lineage/{safe(owner)}.json"
                if not p.exists():
                    continue
                for item in json.loads(p.read_text(encoding="utf-8"))["data"].get(direction) or []:
                    ti = item.get("tableInfo") or {}
                    if f"{ti.get('catalog_name')}.{ti.get('schema_name')}.{ti.get('name')}" != other:
                        continue
                    producers = []
                    for key, kind in ENTITY_KEYS.items():
                        v = item.get(key)
                        for info in (v if isinstance(v, list) else [v] if v else []):
                            ent = self._link(kind, info)
                            if (ent["kind"], ent["id"]) not in seen:
                                seen.add((ent["kind"], ent["id"]))
                                producers.append(ent)
                    if producers or ti:
                        flows.append({"source": a, "target": b, "last_seen": ti.get("lineage_timestamp"),
                                      "producers": sorted(producers, key=lambda x: x["last_seen"] or "", reverse=True)})
        # merge duplicates found from both ends
        merged = {}
        for f in flows:
            k = (f["source"], f["target"])
            if k in merged:
                ids = {(p["kind"], p["id"]) for p in merged[k]["producers"]}
                merged[k]["producers"] += [p for p in f["producers"] if (p["kind"], p["id"]) not in ids]
                merged[k]["last_seen"] = max(filter(None, [merged[k]["last_seen"], f["last_seen"]]), default=None)
            else:
                merged[k] = f
        return {"flows": list(merged.values())}

    # ---- graph assembly ----
    def relations(self, full_name, refresh=False):
        """Nodes + edges for one object: lineage, foreign keys, view dependencies."""
        nodes, edges, errors = {}, {}, []

        def node(fid, kind="table", **extra):
            nodes.setdefault(fid, {"id": fid, "label": fid.split(".")[-1], "kind": kind, **extra})

        node(full_name, focus=True)

        try:
            info = self.object(full_name, refresh)["data"]
            nodes[full_name]["kind"] = (info.get("table_type") or "table").lower()
            for con in info.get("table_constraints") or []:
                fk = con.get("foreign_key_constraint")
                if fk and not is_internal(fk["parent_table"]):
                    parent = fk["parent_table"]
                    node(parent)
                    edges[f"fk:{full_name}->{parent}"] = {
                        "id": f"fk:{full_name}->{parent}", "source": full_name, "target": parent, "kind": "fk",
                        "constraint": fk.get("name"), "child_columns": fk.get("child_columns", []),
                        "parent_columns": fk.get("parent_columns", []),
                        "label": ", ".join(fk.get("child_columns", []))}
            for dep in (info.get("view_dependencies") or {}).get("dependencies", []):
                t = (dep.get("table") or {}).get("table_full_name")
                if t and not is_internal(t):
                    node(t)
                    edges[f"view_dep:{t}->{full_name}"] = {"id": f"view_dep:{t}->{full_name}",
                                                           "source": t, "target": full_name, "kind": "view_dep"}
        except Exception as e:
            errors.append(f"tables.get: {clean_error(e)}")

        try:
            lin = self.lineage(full_name, refresh)["data"]
            for direction in ("upstreams", "downstreams"):
                for item in lin.get(direction) or []:
                    ti = item.get("tableInfo")
                    if not ti:
                        continue
                    other = f"{ti['catalog_name']}.{ti['schema_name']}.{ti['name']}"
                    if is_internal(other):
                        continue
                    ts = ti.get("lineage_timestamp")
                    if other == full_name:
                        nodes[full_name]["self_ref"] = True
                        nodes[full_name]["self_ref_last_seen"] = max(filter(None, [nodes[full_name].get("self_ref_last_seen"), ts]), default=None)
                        continue
                    node(other, (ti.get("table_type") or "table").lower())
                    src, dst = (other, full_name) if direction == "upstreams" else (full_name, other)
                    # one edge per pair; a link both ways becomes bidir
                    key = "lineage:" + "<->".join(sorted([src, dst]))
                    e = edges.get(key)
                    if e is None:
                        edges[key] = {"id": key, "source": src, "target": dst, "kind": "lineage",
                                      "bidir": False, "last_seen": ts, "last_seen_by_dir": {f"{src}->{dst}": ts}}
                    else:
                        e["last_seen_by_dir"][f"{src}->{dst}"] = ts
                        if (e["source"], e["target"]) != (src, dst):
                            e["bidir"] = True
                        e["last_seen"] = max(filter(None, [e["last_seen"], ts]), default=None)
        except Exception as e:
            errors.append(f"lineage: {clean_error(e)}")

        return {"nodes": list(nodes.values()), "edges": list(edges.values()), "errors": errors}


# ---------- relationship store support (see relationships.py) ----------

def cache_times(explorer, full_name):
    """When the cached object and lineage files behind relations(full_name) were fetched; None when absent."""
    out = {}
    for key, sub in (("object", "obj"), ("lineage", "lineage")):
        p = explorer.root / f"{Explorer._dir(full_name)}/{sub}/{safe(full_name)}.json"
        try:
            out[key] = json.loads(p.read_text(encoding="utf-8")).get("fetched_at")
        except (OSError, ValueError):
            out[key] = None
    return out


def cached_metadata(explorer):
    """Tables with the names and comments already in the local cache, for searching without a warehouse.

    Reads data/cache/<profile>/<catalog>/<schema>/objects.json (table names and comments) and obj/*.json (columns).
    Returns [{"table", "type", "comment", "columns": [{"name", "comment"}] or None}] sorted by table name; `columns` is
    None for a table whose object file was never fetched. Only what was browsed before is there.
    """
    tables = {}
    for p in explorer.root.glob("*/*/objects.json"):
        try:
            rows = json.loads(p.read_text(encoding="utf-8")).get("data") or []
        except (OSError, ValueError):
            continue
        for o in rows:
            if o.get("full_name"):
                tables[o["full_name"]] = {"table": o["full_name"], "type": o.get("type"),
                                          "comment": o.get("comment"), "columns": None}
    for p in explorer.root.glob("*/*/obj/*.json"):
        try:
            info = json.loads(p.read_text(encoding="utf-8")).get("data") or {}
        except (OSError, ValueError):
            continue
        name = info.get("full_name")
        if not name:
            continue
        entry = tables.setdefault(name, {"table": name, "type": info.get("table_type"), "comment": None, "columns": None})
        entry["comment"] = info.get("comment") or entry["comment"]
        entry["columns"] = [{"name": c.get("name"), "comment": c.get("comment")}
                            for c in info.get("columns") or [] if c.get("name")]
    return sorted(tables.values(), key=lambda t: t["table"])


def cached_search(explorer, q, limit=300):
    """Search table names across everything in the local cache: every catalog and schema ever browsed, and every table
    whose object was ever fetched. `q` matches the table name or the full `catalog.schema.table` name, any case.
    Returns {"source", "data": [{"full_name", "name", "type"}]}, name matches first, at most `limit`."""
    needle = q.strip().lower()
    hits = [{"full_name": t["table"], "name": t["table"].rsplit(".", 1)[-1], "type": t["type"]}
            for t in cached_metadata(explorer) if needle and needle in t["table"].lower()]
    hits.sort(key=lambda h: (needle not in h["name"].lower(), h["name"], h["full_name"]))
    return {"source": "tables already browsed (pick a SQL warehouse to search everything, or type the full name)",
            "data": hits[:limit]}


# ---------- diagrams ----------

def list_diagrams():
    return sorted(p.stem for p in DIAGRAMS.glob("*.json"))


def save_diagram(name, payload):
    p = DIAGRAMS / f"{safe(name)}.json"
    p.write_text(json.dumps({"name": name, "saved_at": now(), **payload}, indent=2), encoding="utf-8")
    return p.stem


def load_diagram(name):
    return json.loads((DIAGRAMS / f"{safe(name)}.json").read_text(encoding="utf-8"))


# ---------- read-only calls for the ontology import (ontology.py) ----------

def api_get(explorer, path, query=None):
    """GET a workspace REST path through the SDK's api_client, logged like every other call. Returns the parsed JSON."""
    query = {k: v for k, v in (query or {}).items() if v is not None}
    return explorer._call("api.get", lambda: explorer.w.api_client.do("GET", path, query=query or None),
                          path=path, query=query)


def table_metric_info(explorer, full_name):
    """One tables.get call for a metric view: {"definition": the `view_definition` YAML or None, "kinds": {column:
    "dimension"|"measure"}}. The kinds come from each column's `type_json` metadata (`metric_view.type`)."""
    info = explorer._call("tables.get", lambda: explorer.w.tables.get(full_name), full_name=full_name)
    kinds = {}
    for col in getattr(info, "columns", None) or []:
        try:
            meta = (json.loads(col.type_json) or {}).get("metadata") or {}
            kind = meta.get("metric_view.type")
        except (TypeError, ValueError, AttributeError):
            continue
        if kind in ("dimension", "measure"):
            kinds[col.name] = kind
    return {"definition": getattr(info, "view_definition", None), "kinds": kinds}
