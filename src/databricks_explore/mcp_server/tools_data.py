"""The catalog, relationship, mining, concept and SQL tools. Text by default, JSON on request, never a workspace write."""
import json
import time
from typing import Any

from .. import concepts
from .. import dbx
from .. import lineage as lineage_walk
from .. import mining
from .. import ontology
from .. import relationships
from ..relationships import RelationshipInvalid

from .sqlguard import NotReadOnly, check_read_only
from .tooling import B, FORMAT, S, ToolError, integer, obj, strings, text, tool

POLL_SECONDS = 1.0       # how often run_sql asks the warehouse whether the statement finished
MINE_WAIT_SECONDS = 25   # how long mine_run waits for the run before saying it is still going
CELL_CHARS = 200         # a longer cell is cut, so one blob cannot fill the agent's context (max_cell_chars changes it)
DEFINITION_CHARS = 400   # how much of a view definition describe_table shows (definition_chars changes it)
TSV_CHARS = 24000        # the most characters of rows run_sql returns
EDGE_LIMIT = 60
SETTLE_NOTE = ("note: the window ends one hour before now on purpose. Query history arrives late, so the newest hour is left "
               "for the next run (this is not a bug).")

TABLE = {"type": "string", "minLength": 1, "description": "full name catalog.schema.table"}
ENDPOINT = {"type": "object", "required": ["table"], "additionalProperties": False,
            "properties": {"table": {"type": "string", "minLength": 1, "description": "catalog.schema.table, ph:<uuid> or concept:<uuid>"},
                           "column": {"type": "string", "minLength": 1}}}


def _json(v: Any) -> list[dict]:
    return text(json.dumps(v, indent=1, default=str))


def _wants_json(args: dict) -> bool:
    return args.get("format") == "json"


def _three_part(name: str) -> str:
    if len(name.split(".")) != 3 or not all(name.split(".")):
        raise ToolError(f"{name!r} is not a full table name: use catalog.schema.table")
    return name


def _end(e: dict) -> str:
    return e["table"] + (f"#{e['column']}" if e.get("column") else "")


def edge_line(e: dict) -> str:
    """One edge as one line: id, kind, status, the two ends, columns, evidence and note."""
    s = f"{e['id']} {e['kind']} {e['status']} {_end(e['source'])} {'->' if e.get('directed', True) else '--'} {_end(e['target'])}"
    if e.get("columns"):
        s += " cols[" + ", ".join(f"{c['source'] or '*'}->{c['target'] or '*'}" for c in e["columns"][:6]) + (
            ", ..." if len(e["columns"]) > 6 else "") + "]"
    if e.get("relation"):
        s += f" relation={e['relation']}"
    ev = e.get("evidence")
    if ev and ev.get("runs") is not None:
        s += f" runs={ev['runs']} users={ev.get('users')}"
    if e.get("note"):
        s += f" note={e['note']!r}"
    return s


# ---------------------------------------------------------------- status

@tool("status", "Report what the app is connected to (profile, SQL warehouse, demo mode), how many canvases exist and whether a mining run is going. Call it first.",
      obj({"format": FORMAT}))
def status(ctx, args):
    from .. import canvases
    e = ctx.explorer()
    out = {"connected": e is not None, "profile": e.profile if e else None, "warehouse_id": e.warehouse_id if e else None,
           "demo": dbx.DEMO, "canvases": len(canvases.list_canvases())}
    if e is not None:
        out["mining"] = ctx.miner().status().get("state")
        with ctx.store() as store:
            out["suggestions"] = store.status_counts()
    if _wants_json(args):
        return _json(out)
    if e is None:
        return text(f"Not connected: connect a profile in the app first (the agent cannot connect or choose a profile).\n"
                    f"demo mode: {'yes' if dbx.DEMO else 'no'}; saved canvases: {out['canvases']} (canvas tools work without a connection)")
    wh = out["warehouse_id"] or "none (pick one in the app for SQL, mining and warehouse search)"
    return text(f"connected: profile {out['profile']}; warehouse {wh}; demo mode: {'yes' if out['demo'] else 'no'}\n"
                f"saved canvases: {out['canvases']}; mining: {out['mining']}; join suggestions: {out['suggestions']}")


# ---------------------------------------------------------------- catalog

@tool("search_tables", "Find tables by name. scope auto uses the SQL warehouse if the app has one selected (information_schema), otherwise the local cache; cache never uses the warehouse.",
      obj({"q": {"type": "string", "minLength": 1, "description": "part of a table name or of catalog.schema.table"},
           "scope": {"type": "string", "enum": ["auto", "cache"]}, "limit": integer(1, 300)}, ("q",)))
def search_tables(ctx, args):
    e = ctx.need_explorer()
    q, limit = args["q"], args.get("limit", 25)
    res = e.search(q) if args.get("scope", "auto") == "auto" and e.warehouse_id else dbx.cached_search(e, q)
    rows = res["data"]
    head = f"{len(rows)} match(es) for {q!r} ({res['source']})"
    lines = [f"{r['full_name']}  {r.get('type') or ''}".rstrip() for r in rows[:limit]]
    if len(rows) > limit:
        lines.append(f"... {len(rows) - limit} more; narrow the search or raise limit")
    return text("\n".join([head, *lines]))


def _constraints(info: dict) -> list[str]:
    out = []
    for c in info.get("table_constraints") or []:
        if "primary_key_constraint" in c:
            out.append("PK (" + ", ".join(c["primary_key_constraint"].get("child_columns", [])) + ")")
        if "foreign_key_constraint" in c:
            fk = c["foreign_key_constraint"]
            out.append(f"FK ({', '.join(fk.get('child_columns', []))}) -> {fk.get('parent_table')}({', '.join(fk.get('parent_columns', []))})")
    return out


def _tag_text(tags: dict) -> str:
    return ", ".join(f"{k}={v}" if v else k for k, v in sorted(tags.items()))


def _tag_lines(e, name: str, refresh: bool) -> list[str]:
    """The tags section of describe_table: the table's tags, then each tagged column's. Never fails the call."""
    try:
        data = e.tags(name, refresh)["data"]
    except Exception as err:  # no warehouse and nothing cached, or no access to information_schema
        if not e.warehouse_id:
            return ["tags: select a warehouse to read tags"]
        return [f"tags: could not be read ({dbx.clean_error(err)})"]
    if not data["table"] and not data["columns"]:
        return ["tags: none"]
    lines = ["tags:"]
    if data["table"]:
        lines.append(f"  table: {_tag_text(data['table'])}")
    lines += [f"  {col}: {_tag_text(t)}" for col, t in sorted(data["columns"].items())]
    return lines


@tool("describe_table", "Columns, types, comments, constraints and Unity Catalog tags (including system.certification_status) of one table. Reads the local cache; fetches from Unity Catalog once if the table was never opened. Tags are read with one query on the selected warehouse and cached; refresh re-reads both. A view or metric view definition is cut at 400 characters unless definition_chars is raised.",
      obj({"name": TABLE, "refresh": {"type": "boolean", "description": "re-read from Unity Catalog (and re-read the tags)"},
           "definition_chars": integer(1, 20000, "how many characters of a view or metric-view definition to show (default 400)"),
           "format": FORMAT}, ("name",)))
def describe_table(ctx, args):
    e = ctx.need_explorer()
    res = e.object(_three_part(args["name"]), bool(args.get("refresh")))
    info = res["data"]
    if _wants_json(args):
        return _json(res)
    lines = [f"{info.get('full_name') or args['name']} ({info.get('table_type')}); fetched {res.get('fetched_at')}"]
    if info.get("comment"):
        lines.append(f"comment: {info['comment']}")
    cols = info.get("columns") or []
    lines.append(f"{len(cols)} columns:")
    for c in cols:
        lines.append(f"  {c.get('name')} {c.get('type_text') or ''}{'' if c.get('nullable', True) else ' NOT NULL'}"
                     + (f" -- {c['comment']}" if c.get("comment") else ""))
    if _constraints(info):
        lines.append("constraints: " + "; ".join(_constraints(info)))
    if info.get("view_definition"):
        definition, limit = " ".join(info["view_definition"].split()), args.get("definition_chars", DEFINITION_CHARS)
        lines.append("view definition: " + definition[:limit]
                     + (f"... (cut at {limit} of {len(definition)} characters; raise definition_chars, up to 20000, to see more)"
                        if len(definition) > limit else ""))
    lines += _tag_lines(e, args["name"], bool(args.get("refresh")))
    return text("\n".join(lines))


@tool("find_by_tag", "List the tables and columns that carry a Unity Catalog tag, optionally with one value, in one catalog or all of them. One read-only query on system.information_schema (table_tags and column_tags) through the selected warehouse; nothing is cached. Certification is the tag system.certification_status (certified or deprecated).",
      obj({"tag_name": {"type": "string", "minLength": 1}, "tag_value": {"type": "string", "description": "only this value"},
           "catalog": {"type": "string", "minLength": 1}, "limit": integer(1, 1000, "default 100"), "format": FORMAT}, ("tag_name",)))
def find_by_tag(ctx, args):
    e = ctx.need_explorer()
    if not e.warehouse_id:
        raise ToolError("No SQL warehouse is selected: pick one in the app first (tags are read from system.information_schema).")
    limit = args.get("limit", 100)
    try:
        out = e.find_by_tag(args["tag_name"], args.get("tag_value"), args.get("catalog"), limit)
    except Exception as err:
        raise ToolError(f"Could not read the tag tables: {dbx.clean_error(err)}") from err
    if _wants_json(args):
        return _json(out)
    what = args["tag_name"] + (f"={args['tag_value']}" if args.get("tag_value") is not None else "")
    lines = [f"{len(out['rows'])}{'+' if out['truncated'] else ''} hit(s) for tag {what}" + (f" in {args['catalog']}" if args.get("catalog") else "")]
    for r in out["rows"]:
        lines.append(f"{r['scope']} {r['table']}" + (f"#{r['column']}" if r["column"] else "")
                     + (f"  {r['tag_name']}={r['tag_value']}" if args.get("tag_value") is None and r["tag_value"] else ""))
    if out["truncated"]:
        lines.append(f"... more than {limit}; raise limit or narrow with tag_value or catalog")
    return text("\n".join(lines))


@tool("list_schemas", "List the schemas of a catalog, or the catalogs when no catalog is given. Cached.",
      obj({"catalog": {"type": "string", "minLength": 1}, "format": FORMAT}))
def list_schemas(ctx, args):
    e = ctx.need_explorer()
    res = e.schemas(args["catalog"]) if args.get("catalog") else e.catalogs()
    if _wants_json(args):
        return _json(res)
    what = f"schemas of {args['catalog']}" if args.get("catalog") else "catalogs"
    return text("\n".join([f"{len(res['data'])} {what}", *(f"{r['name']}" + (f" -- {r['comment']}" if r.get("comment") else "")
                                                           for r in res["data"])]))


@tool("list_tables", "List the tables and views of one schema with their types and comments. Cached. A table is marked [certified] or [deprecated] when the app's certification cache (system.certification_status) says so; the header says when that cache is not loaded.",
      obj({"catalog": {"type": "string", "minLength": 1}, "schema": {"type": "string", "minLength": 1},
           "limit": integer(1, 1000), "format": FORMAT}, ("catalog", "schema")))
def list_tables(ctx, args):
    e = ctx.need_explorer()
    res = e.objects(args["catalog"], args["schema"])
    if _wants_json(args):
        return _json(res)
    limit = args.get("limit", 200)
    rows = res["data"]
    cert = ontology.cached_certification(e)
    lines = [f"{len(rows)} objects in {args['catalog']}.{args['schema']}"
             + ("" if cert["fetched_at"] else "; certification cache not loaded, so [certified]/[deprecated] marks are missing "
                "(refresh certification in the app: Concepts tab, or Import from Databricks)")]
    lines += [f"{r['name']} {r.get('type') or ''}"
              + (f" [{cert['tables'][r['full_name']]}]" if r.get("full_name") in cert["tables"] else "")
              + (f" -- {r['comment']}" if r.get("comment") else "") for r in rows[:limit]]
    if len(rows) > limit:
        lines.append(f"... {len(rows) - limit} more")
    return text("\n".join(lines))


# ---------------------------------------------------------------- relationships

@tool("get_relationships", "Edges around one table: foreign keys, lineage and view dependencies (derived) plus stored ones (mined, manual, sketch). level column adds column lineage, which may read the cached system table or run one read-only query.",
      obj({"table": TABLE, "level": {"type": "string", "enum": ["table", "column"]}, "format": FORMAT}, ("table",)))
def get_relationships(ctx, args):
    e = ctx.need_explorer()
    table, level = relationships.check_table(args["table"]), args.get("level", "table")
    rel, times, columns, notes = None, None, None, []
    if not table.startswith("ph:"):
        rel, times = e.relations(table), dbx.cache_times(e, table)
        if level == "column":
            try:
                columns = e.column_lineage(table)
            except Exception as err:  # no warehouse, or no access to the system table: the rest still loads
                notes.append(f"column_lineage: {dbx.clean_error(err)}")
    with ctx.store() as store:
        out = relationships.unified(store, table, rel, times, level, columns)
    out["errors"] = [*out["errors"], *notes]
    if _wants_json(args):
        return _json(out)
    edges = out["edges"]
    lines = [f"{len(edges)} edge(s) at {table} ({level} level)"]
    lines += [edge_line(x) for x in edges[:EDGE_LIMIT]]
    if len(edges) > EDGE_LIMIT:
        lines.append(f"... {len(edges) - EDGE_LIMIT} more; use format json")
    lines += [f"error: {x}" for x in out["errors"]]
    return text("\n".join(lines))


DIRECTION = {"type": "string", "enum": ["downstream", "upstream", "both"],
             "description": "downstream (default): what is built from the table; upstream: what it is built from; both"}
DEPTH = integer(1, lineage_walk.MAX_DEPTH, f"hops to follow, default 3, at most {lineage_walk.MAX_DEPTH}")


@tool("lineage", "Walk table lineage and view dependencies from one table, several hops at once (get_relationships is one hop). One line per edge with its hop and kind, then the tables reached, marked [certified] or [deprecated] when the certification cache is loaded. Uses the cache; a table never expanded is read from Databricks (tables.get and table lineage, one call each), at most 60 tables per walk. Foreign keys, mined and manual joins are not followed (see get_relationships).",
      obj({"table": TABLE, "direction": DIRECTION, "depth": DEPTH, "format": FORMAT}, ("table",)))
def lineage(ctx, args):
    e = ctx.need_explorer()
    table = relationships.check_table(args["table"])
    if table.startswith("ph:"):
        raise ToolError("a placeholder has no lineage")
    out = lineage_walk.walk(lambda t: e.relations(t), table, args.get("direction", "downstream"), args.get("depth", 3))
    cert = ontology.cached_certification(e)
    loaded = bool(cert["fetched_at"])
    if loaded:
        for n in out["nodes"]:
            if n["table"] in cert["tables"]:
                n["certification"] = cert["tables"][n["table"]]
    if _wants_json(args):
        return _json({k: out[k] for k in ("nodes", "edges", "truncated", "errors")})
    n_tables = len(out["nodes"]) - 1
    lines = [f"lineage of {table}, {out['direction']}, depth {out['depth']}: {n_tables} other table(s), {len(out['edges'])} edge(s)"]
    lines += [f"hop {x['hop']} {x['kind']} {x['source']} -> {x['target']}" for x in out["edges"]]
    if not out["edges"]:
        lines.append("no lineage or view dependencies found (lineage only shows queries run since lineage was enabled; try get_relationships)")
    lines.append("tables reached:")
    for n in out["nodes"]:
        where = "start" if n["side"] == "start" else f"hop {n['hop']} {n['side']}"
        lines.append(f"  {n['table']}" + (f" {n['kind']}" if n["kind"] else "") + f" ({where})"
                     + (f" [{n['certification']}]" if n.get("certification") else ""))
    if out["truncated"]:
        lines.append(f"stopped at {lineage_walk.NODE_CAP} tables: use a smaller depth or walk one direction")
    if not loaded:
        lines.append("certification cache not loaded, so [certified]/[deprecated] marks are missing")
    lines += [f"error: {x}" for x in out["errors"]]
    return text("\n".join(lines))


@tool("add_relationship", "Store a manual relationship between two tables or columns (status accepted, origin user). Local only.",
      obj({"source": ENDPOINT, "target": ENDPOINT, "directed": B, "note": S}, ("source", "target")), read_only=False)
def add_relationship(ctx, args):
    ctx.need_explorer()
    body = relationships.parse_create({k: v for k, v in args.items() if k != "format"})
    with ctx.store() as store:
        edge, created = store.create_manual(body)
    return text(("created: " if created else "already existed, re-accepted: ") + edge_line(edge.model_dump(mode="json")))


@tool("set_relationship_status", "Accept, reject or re-propose a stored relationship, and/or set its note. A derived id (fk:, lineage:, view_dep:) takes only a note. Local only.",
      obj({"id": {"type": "string", "minLength": 1}, "status": {"type": "string", "enum": ["proposed", "accepted", "rejected"]},
           "note": S}, ("id",)), read_only=False)
def set_relationship_status(ctx, args):
    ctx.need_explorer()
    patch = relationships.parse_patch({k: v for k, v in args.items() if k != "id"})
    rid = args["id"]
    with ctx.store() as store:
        if rid.startswith("e_"):
            edge = store.patch(rid, patch.status, patch.note)
        else:
            if patch.status is not None:
                raise RelationshipInvalid("status: derived edges only take a note")
            edge = store.set_derived_note(rid, patch.note)
    return text(edge_line(edge.model_dump(mode="json")))


# ---------------------------------------------------------------- mining

@tool("mining_suggestions", "Join pairs mined from query history, most evidence first, with their review status. Reads the local store only.",
      obj({"status": {"type": "string", "enum": ["proposed", "accepted", "rejected"]}, "table": TABLE,
           "limit": integer(1, 200), "format": FORMAT}))
def mining_suggestions(ctx, args):
    ctx.need_explorer()
    with ctx.store() as store:
        edges = store.suggestions(relationships.check_statuses([args.get("status", "proposed")]), table=args.get("table"))
        counts = store.status_counts()
    limit = args.get("limit", 20)
    rows = [x.model_dump(mode="json") for x in edges]
    if _wants_json(args):
        return _json({"edges": rows[:limit], "counts": counts})
    lines = [f"{len(rows)} {args.get('status', 'proposed')} suggestion(s); all statuses: {counts}"]
    lines += [edge_line(x) for x in rows[:limit]]
    if len(rows) > limit:
        lines.append(f"... {len(rows) - limit} more")
    return text("\n".join(lines))


@tool("usage", "The busiest tables and table pairs from the last mining run (runs and distinct users). Reads the local store only.",
      obj({"limit": integer(1, 100), "format": FORMAT}))
def usage(ctx, args):
    e = ctx.need_explorer()
    u = mining.usage_summary(e.profile, args.get("limit", 10))
    if _wants_json(args):
        return _json(u)
    if not u["window"]:
        return text("No usage yet: no mining run has been stored. Use mine_plan, then mine_run.")
    lines = [f"{u['statements']} statements, {u['window']['since']} to {u['window']['until']}", "tables:"]
    lines += [f"  {t['table']} runs={t['runs']} users={t['users']}" for t in u["tables"]]
    lines.append("pairs read together:")
    lines += [f"  {' + '.join(p['tables'])} runs={p['runs']} users={p['users']}" for p in u["pairs"]]
    return text("\n".join(lines))


@tool("mine_plan", "Show what a mining run would read (time window and the exact read-only SQL on system tables). Runs nothing. The window always ends an hour before now: query history arrives late, so the newest hour is left for the next run.",
      obj({"window_days": integer(1, mining.MAX_WINDOW_DAYS), "full": B}))
def mine_plan(ctx, args):
    e = ctx.need_explorer()
    p = mining.plan(e.profile, args.get("window_days", mining.WINDOW_DAYS), bool(args.get("full")))
    lines = [f"window {p['since']} to {p['until']}; {'incremental from ' + p['cursor'] if p['incremental'] else 'full window'}; "
             f"row cap {p['row_cap']}; warehouse {e.warehouse_id or 'none selected'}",
             SETTLE_NOTE]
    if p.get("remine_reason"):
        lines.append(f"note: {p['remine_reason']}")
    for q in p["queries"]:
        lines.append(f"-- {q['name']} params {json.dumps(q['params'])}\n{q['sql']}")
    return text("\n".join(lines))


@tool("mine_run", "Run query-history mining: read-only SQL on system.query.history and system.access.table_lineage through the selected warehouse. Stores proposed join edges locally. Requires confirm: true; call mine_plan first. The run reads up to an hour before now, because query history arrives late; the newest hour is picked up by the next run.",
      obj({"confirm": {"type": "boolean", "const": True, "description": "must be true"}, "window_days": integer(1, mining.MAX_WINDOW_DAYS),
           "full": B}, ("confirm",)), read_only=False)
def mine_run(ctx, args):
    if args.get("confirm") is not True:
        raise ToolError("mine_run needs confirm: true (it uses the SQL warehouse). Call mine_plan to see what it would run.")
    e = ctx.need_explorer()
    miner = ctx.miner()
    st = miner.start(args.get("window_days", mining.WINDOW_DAYS), bool(args.get("full")))
    deadline = time.time() + MINE_WAIT_SECONDS
    while st["state"] == "running" and time.time() < deadline:
        time.sleep(0.25)
        st = miner.status()
    out = f"mining {st['state']}"
    if st["state"] == "running":
        return text(out + f" (phase {st.get('phase')}); still going after {MINE_WAIT_SECONDS}s. Call status, then mining_suggestions later.")
    if st.get("error"):
        out += f": {st['error']}"
    if st.get("result"):
        r = st["result"]
        out += (f"; {r['statements']} statements, {r['pairs']} join pairs, {r['created']} new, {r['updated']} updated"
                + ("; hit the row cap, run again to continue" if r.get("capped") else ""))
        out += "\n" + SETTLE_NOTE
    return text(out)


# ---------------------------------------------------------------- concepts

def _concept_line(c: dict) -> str:
    s = f"{c['id']} {c['name']} [{c['status']}]"
    if c.get("domain"):
        s += f" domain={c['domain']}"
    if c.get("link_count") is not None:
        s += f" links={c['link_count']}"
    if c.get("definition"):
        s += " -- " + " ".join(c["definition"].split())[:100]
    return s


def _concept_detail(d: dict) -> str:
    lines = [_concept_line(d)]
    if d.get("synonyms"):
        lines.append("synonyms: " + ", ".join(d["synonyms"]))
    if d.get("tags"):
        lines.append("tags: " + ", ".join(d["tags"]))
    lines.append(f"origin: {d['provenance']['origin']}")
    for x in d.get("links", []):
        lines.append(f"link {x['id']} {x.get('relation')} -> {_end(x['target'])}")
    for x in d.get("incoming", []):
        lines.append(f"incoming {x['id']} {x.get('relation')} from {_end(x['source'])}")
    return "\n".join(lines)


CONCEPT_FIELDS = {"definition": S, "synonyms": strings(), "domain": {"type": ["string", "null"]},
                  "status": {"type": "string", "enum": ["draft", "reviewed", "certified"]}, "tags": strings()}


@tool("list_concepts", "List business concepts (glossary terms), optionally filtered by text, domain or status.",
      obj({"q": S, "domain": S, "status": {"type": "string", "enum": ["draft", "reviewed", "certified"]},
           "limit": integer(1, 500), "format": FORMAT}))
def list_concepts(ctx, args):
    ctx.need_explorer()
    with ctx.store() as store:
        out = concepts.listing(store, args.get("q", ""), args.get("domain"), args.get("status"))
    limit = args.get("limit", 50)
    if _wants_json(args):
        return _json({**out, "concepts": out["concepts"][:limit]})
    rows = out["concepts"]
    lines = [f"{len(rows)} concept(s); domains: {', '.join(out['domains']) or 'none'}", *map(_concept_line, rows[:limit])]
    if len(rows) > limit:
        lines.append(f"... {len(rows) - limit} more")
    return text("\n".join(lines))


@tool("get_concept", "One concept with its definition, synonyms, tags and links to tables, columns and other concepts.",
      obj({"id": {"type": "string", "minLength": 1}, "format": FORMAT}, ("id",)))
def get_concept(ctx, args):
    ctx.need_explorer()
    with ctx.store() as store:
        d = concepts.detail(store, concepts.check_concept_id(args["id"]))
    return _json(d) if _wants_json(args) else text(_concept_detail(d))


@tool("create_concept", "Create a business concept (a glossary term). The name must be unique, ignoring case. Local only.",
      obj({"name": {"type": "string", "minLength": 1}, **CONCEPT_FIELDS}, ("name",)), read_only=False)
def create_concept(ctx, args):
    ctx.need_explorer()
    body = concepts.parse_create(args)
    with ctx.store() as store:
        d = concepts.detail(store, concepts.create(store, body).id)
    return text("created " + _concept_detail(d))


@tool("update_concept", "Change a concept's name, definition, synonyms, domain (null clears it), status or tags. Local only.",
      obj({"id": {"type": "string", "minLength": 1}, "name": {"type": "string", "minLength": 1}, **CONCEPT_FIELDS}, ("id",)),
      read_only=False)
def update_concept(ctx, args):
    ctx.need_explorer()
    cid = concepts.check_concept_id(args["id"])
    patch = concepts.parse_patch({k: v for k, v in args.items() if k != "id"})
    with ctx.store() as store:
        concepts.update(store, cid, patch)
        d = concepts.detail(store, cid)
    return text("updated " + _concept_detail(d))


@tool("link_concept", "Link a concept to a table, a column or another concept (target.table concept:<id>). relation: defines, measures, identifies, describes for tables and columns; is_a, part_of, related_to for concepts. Local only.",
      obj({"id": {"type": "string", "minLength": 1}, "target": ENDPOINT,
           "relation": {"type": "string", "enum": ["defines", "measures", "identifies", "describes", "is_a", "part_of", "related_to"]},
           "note": S}, ("id", "target", "relation")), read_only=False)
def link_concept(ctx, args):
    ctx.need_explorer()
    cid = concepts.check_concept_id(args["id"])
    body = concepts.parse_link({k: v for k, v in args.items() if k != "id"})
    with ctx.store() as store:
        edge, created = concepts.add_link(store, cid, body)
    e = edge.model_dump(mode="json")
    return text(f"{'linked' if created else 'link updated'}: {e['id']} {e.get('relation')} -> {_end(e['target'])}")


@tool("unlink_concept", "Remove one link of a concept, by the link id that get_concept shows. Local only.",
      obj({"id": {"type": "string", "minLength": 1}, "link_id": {"type": "string", "minLength": 1}}, ("id", "link_id")), read_only=False)
def unlink_concept(ctx, args):
    ctx.need_explorer()
    with ctx.store() as store:
        out = concepts.remove_link(store, concepts.check_concept_id(args["id"]), args["link_id"])
    return text(f"removed link {out['deleted']}")


@tool("find_candidates", "Tables and columns in the local cache whose name or comment mentions a concept or its synonyms. Never uses the warehouse.",
      obj({"id": {"type": "string", "minLength": 1}, "limit": integer(1, 200), "format": FORMAT}, ("id",)))
def find_candidates(ctx, args):
    e = ctx.need_explorer()
    with ctx.store() as store:
        out = concepts.candidates(store, concepts.check_concept_id(args["id"]), dbx.cached_metadata(e))
    limit = args.get("limit", 20)
    if _wants_json(args):
        return _json({**out, "hits": out["hits"][:limit]})
    s = out["searched"]
    lines = [f"terms: {', '.join(out['terms'])}; searched {s['tables']} tables ({s['tables_with_columns']} with columns), {s['columns']} columns; {len(out['hits'])} hit(s)"]
    for h in out["hits"][:limit]:
        where = h["table"] + (f"#{h['column']}" if h["kind"] == "column" else "")
        lines.append(f"{where} {h['field']}={h['text'][:60]!r} matched {h['matched']!r}" + (" (linked)" if h["linked"] else ""))
    return text("\n".join(lines))


# ---------------------------------------------------------------- SQL

def _cell(v, max_chars: int = CELL_CHARS) -> str:
    s = "NULL" if v is None else str(v)
    s = s.replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return s if len(s) <= max_chars else s[:max_chars] + "..."


def tsv(result: dict, max_rows: int, max_cell_chars: int = CELL_CHARS) -> str:
    """A result as column types, a TSV header and TSV rows, cut by row count and by size, with a closing line that says so."""
    cols = result["columns"]
    lines = ["columns: " + ", ".join(f"{c['name']} {c.get('type_text') or c.get('type')}" for c in cols),
             "\t".join(c["name"] for c in cols)]
    size, shown = sum(map(len, lines)), 0
    for row in result["rows"]:
        line = "\t".join(_cell(v, max_cell_chars) for v in row)
        if size + len(line) > TSV_CHARS:
            break
        lines.append(line)
        size += len(line) + 1
        shown += 1
    total = result["row_count"]
    note = f"{shown} row(s) shown"
    if shown < total:
        note += f" of {total} fetched (output size cap)"
    if result.get("truncated"):
        note += f"; the query has more than {max_rows} rows (cap {max_rows})"
    elif result.get("truncated") is None and total >= max_rows:
        note += f"; cut at {max_rows} rows"
    return "\n".join([*lines, f"({note}; {result.get('ms')} ms)"])


@tool("run_sql", "Run one read-only statement (SELECT or WITH...SELECT, DESCRIBE, SHOW or EXPLAIN) on the SQL warehouse the app selected. Rows and time are capped and a slow statement is cancelled. A cell longer than max_cell_chars (default 200) is cut and ends in \"...\". Returns column types and TSV. Metric views need SELECT MEASURE(`name`) ... GROUP BY ..., not SELECT *.",
      obj({"statement": {"type": "string", "minLength": 1}, "max_rows": integer(1, 1000, "default 100"),
           "timeout_s": integer(1, 300, "default 60"),
           "max_cell_chars": integer(50, 4000, "cut each cell after this many characters (default 200)")}, ("statement",)))
def run_sql(ctx, args):
    e = ctx.need_explorer()
    try:
        sql = check_read_only(args["statement"])
    except NotReadOnly as err:
        raise ToolError(f"Rejected: {err}") from err
    if not e.warehouse_id:
        raise ToolError("No SQL warehouse is selected: pick one in the app first.")
    max_rows, timeout = args.get("max_rows", 100), args.get("timeout_s", 60)
    sid = e.query_async(sql, None, max_rows)
    deadline = time.time() + timeout
    while True:
        st = e.query_status(sid)
        if st["state"] not in ("PENDING", "RUNNING"):
            break
        if time.time() >= deadline:
            e.query_cancel(sid)
            raise ToolError(f"Timed out after {timeout}s and cancelled the statement.")
        time.sleep(min(POLL_SECONDS, max(0.0, deadline - time.time())))
    if st["state"] != "SUCCEEDED":
        raise ToolError(f"Statement {st['state'].lower()}" + (f": {st['error']}" if st.get("error") else ""))
    return text(tsv(st, max_rows, args.get("max_cell_chars", CELL_CHARS)))
