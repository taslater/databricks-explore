"""The Flask app: REST routes, the built React UI and the MCP server. Start it with the `databricks-explore` command."""
import mimetypes
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException, MethodNotAllowed, NotFound

from . import __version__, canvases
from . import cardinality
from . import concepts
from . import dbx
from . import demo
from . import genie
from . import graphs
from . import layout
from . import mcp_server
from . import mining
from . import nodefacts
from . import ontology
from . import relationships
from . import relprofile
from . import sqltools
from . import starexpand
from . import tablestats
from .mcp_server import tools_canvas
from .mcp_server.tooling import Context, ToolError

# Windows can map these to text/plain through the registry, and a browser then refuses module scripts and styles.
for _ext, _type in ((".js", "text/javascript"), (".mjs", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml")):
    mimetypes.add_type(_type, _ext)

app = Flask(__name__, static_folder=None)  # the React build in web_dist is the only UI
STATE = {"ex": None}  # single local user -> one active connection
MAX_CONNECTOR_TABLES = 80  # tables one POST /api/relationships/connectors reads relations for
WEB_DIST = Path(__file__).resolve().parent / "web_dist"  # `npm run build` in web/ writes it; the wheel ships it


@app.before_request
def local_only():
    """Every route, not only /mcp: refuse a Host or Origin that is not this machine. A DNS-rebinding page reaches
    the app under its own name, and would otherwise use the connected workspace's credentials through /api/*."""
    if not mcp_server.auth.host_is_local(request.host) or not mcp_server.auth.origin_is_local(request.headers.get("Origin")):
        return jsonify({"error": "this app answers only requests addressed to 127.0.0.1 or localhost"}), 403


def ex():
    if not STATE["ex"]:
        raise RuntimeError("Not connected. Pick a profile first.")
    return STATE["ex"]


def refresh():
    return request.args.get("refresh") == "1"


def _api_route_exists(path):
    """True when some route other than the SPA fallback serves this path under any method."""
    adapter = app.url_map.bind("localhost")
    for method in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        try:
            if adapter.match(path, method=method)[0] != "spa":
                return True
        except HTTPException:
            pass
    return False


@app.errorhandler(Exception)
def err(e):
    """JSON error body. HTTP errors (404, 405, ...) keep their status; anything else is a 500."""
    if isinstance(e, HTTPException):
        if isinstance(e, MethodNotAllowed) and request.path.startswith("/api/") and not _api_route_exists(request.path):
            e = NotFound()  # only the SPA fallback matched this path, so it is an unknown API route
        resp = jsonify({"error": e.description})
        resp.status_code = e.code
        if isinstance(e, MethodNotAllowed) and e.valid_methods:
            resp.headers["Allow"] = ", ".join(e.valid_methods)
        return resp
    return jsonify({"error": dbx.clean_error(e)}), 500


@app.get("/")
def index():
    if not (WEB_DIST / "index.html").is_file():
        return "Frontend not built. Run `npm run build` in web/ (or `npm run dev`).", 503
    return send_from_directory(WEB_DIST, "index.html")


@app.get("/<path:path>")
def spa(path):
    if path == "api" or path.startswith("api/"):
        abort(404)  # unknown API route: same JSON error shape as every other failure
    if (WEB_DIST / path).is_file():
        return send_from_directory(WEB_DIST, path)
    return index()  # client-side routes fall back to index.html


@app.get("/api/profiles")
def profiles():
    return jsonify({"profiles": dbx.list_profiles(), "config": "demo mode: invented data, no Databricks" if dbx.DEMO else str(dbx.cfg_path())})


@app.get("/api/session")
def session():
    """What the server is connected to right now. Null fields when not connected. No connection needed."""
    e = STATE["ex"]
    return jsonify({"profile": e.profile if e else None, "warehouse_id": e.warehouse_id if e else None, "version": __version__})


@app.post("/api/connect")
def connect():
    body = request.json
    profile = body["profile"]
    # interactive=False is used when the page restores a previous session on load: it must never open a browser.
    interactive = body.get("interactive", True)
    try:
        e = dbx.Explorer(profile)
        who = e.whoami()
    except Exception as first_error:
        if not interactive:
            return jsonify({"error": f"Could not reconnect to {profile}: {dbx.clean_error(first_error)}"}), 401
        dbx.cli_login(profile)          # browser pops up; blocks until done
        e = dbx.Explorer(profile)
        who = e.whoami()
    STATE["ex"] = e
    return jsonify({"profile": profile, **who})


@app.get("/api/warehouses")
def warehouses():
    return jsonify(ex().warehouses())


@app.post("/api/warehouse")
def set_warehouse():
    ex().warehouse_id = request.json.get("id") or None
    return jsonify({"warehouse_id": ex().warehouse_id})


@app.get("/api/catalogs")
def catalogs():
    return jsonify(ex().catalogs(refresh()))


@app.get("/api/schemas")
def schemas():
    return jsonify(ex().schemas(request.args["catalog"], refresh()))


@app.get("/api/objects")
def objects():
    return jsonify(ex().objects(request.args["catalog"], request.args["schema"], refresh()))


@app.get("/api/functions")
def functions():
    return jsonify(ex().functions(request.args["catalog"], request.args["schema"], refresh()))


@app.get("/api/search")
def search():
    e = ex()
    if e.warehouse_id:
        return jsonify(e.search(request.args["q"]))
    return jsonify(dbx.cached_search(e, request.args["q"]))  # every cached table, in every catalog


@app.get("/api/object")
def obj():
    return jsonify(ex().object(request.args["name"], refresh()))


@app.get("/api/relations")
def relations():
    return jsonify(ex().relations(request.args["name"], refresh()))


@app.get("/api/edge")
def edge():
    return jsonify(ex().edge_details(request.args["src"], request.args["tgt"]))


@app.errorhandler(graphs.GraphInvalid)
def graph_invalid(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(graphs.GraphNotFound)
def graph_not_found(e):
    return jsonify({"error": str(e)}), 404


@app.errorhandler(graphs.GraphConflict)
def graph_conflict(e):
    return jsonify({"error": str(e), **e.info}), 409


@app.get("/api/diagrams")
def diagrams():
    return jsonify(graphs.list_graphs())


@app.get("/api/diagrams/<name>")
def diagram(name):
    return jsonify(graphs.load_graph(name))


@app.post("/api/diagrams")
def save():
    base = request.headers.get("X-Base-Revision")  # the page sends the revision it loaded, to avoid overwriting a newer save
    if base is not None and not base.isdigit():
        return jsonify({"error": "X-Base-Revision: must be a whole number"}), 400
    name, revision = graphs.write_graph(request.get_json(silent=True), expect=int(base) if base is not None else None)
    return jsonify({"saved": name, "revision": revision})


@app.get("/api/diagrams/<name>/revision")
def diagram_revision(name):
    """The saved graph's revision and who wrote it last (ui or agent). The page polls this."""
    return jsonify(graphs.revision_info(name))


@app.post("/api/diagrams/<name>/rename")
def diagram_rename(name):
    body = request.get_json(silent=True)
    if not isinstance(body, dict) or not isinstance(body.get("new_name"), str):
        return jsonify({"error": "send new_name (a string)"}), 400
    new, revision = graphs.rename_graph(name, body["new_name"])
    return jsonify({"renamed": new, "revision": revision})


@app.delete("/api/diagrams/<name>")
def diagram_delete(name):
    """Move a saved graph to diagrams/.trash/ (a copy is kept)."""
    return jsonify({"deleted": graphs.resolve(name), "trash": graphs.delete_graph(name)})


# ---------- relationships (relationships.py): derived edges plus the persisted ones ----------

@app.errorhandler(relationships.RelationshipInvalid)
def relationship_invalid(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(relationships.RelationshipNotFound)
def relationship_not_found(e):
    return jsonify({"error": str(e)}), 404


def rel_store():
    """The store for the connected profile."""
    return relationships.open_store(ex().profile)


VIEW_KINDS = ("view", "materialized_view")  # node kinds whose definition is read for the joins it defines
MAX_VIEW_READS = 20  # views read (from the local cache, or one tables.get each) per request


def learn_view_joins(e, store, table, rel):
    """Record the joins defined by the table (if it is a view) and by the views built from it that `rel` shows.

    `rel` is an Explorer.relations() response. A view that cannot be read is skipped: this never fails a request."""
    views = [n["id"] for n in (rel or {}).get("nodes", []) if n.get("kind") in VIEW_KINDS and not n["id"].startswith("ph:")]
    for view in sorted(views, key=lambda v: v != table)[:MAX_VIEW_READS]:  # the table itself first
        try:
            info = e.object(view)["data"]  # cached: the caller has just read the table itself
            store.replace_view_joins(view, relationships.view_join_groups(view, info))
        except Exception:
            continue


@app.get("/api/relationships")
def relationships_for_table():
    table = relationships.check_table(request.args.get("table", ""))
    e = ex()
    level = request.args.get("level", "table")
    rel, times, columns, notes = None, None, None, []
    if not table.startswith("ph:"):  # a placeholder has no catalog metadata
        rel, times = e.relations(table, refresh()), dbx.cache_times(e, table)
        if level == "column":  # one warehouse query, cached. With no warehouse or no access the rest still loads.
            try:
                columns = e.column_lineage(table, refresh())
            except Exception as err:
                notes.append(f"column_lineage: {dbx.clean_error(err)}")
    with rel_store() as store:
        learn_view_joins(e, store, table, rel)
        out = relationships.unified(store, table, rel, times, level, columns)
    extra = {"column_lineage_source": columns["source"]} if columns and columns.get("source") else {}
    return jsonify({**out, **extra, "errors": [*out["errors"], *notes]})


@app.get("/api/relationships/joins")
def relationship_joins():
    """How one table is known to join to others: declared foreign keys, mined joins and manual edges, with columns."""
    table = relationships.check_table(request.args.get("table", ""))
    info, rel, errors = None, None, []
    if not table.startswith("ph:"):  # a placeholder has no catalog metadata
        try:
            info = ex().object(table, refresh())["data"]
        except Exception as err:  # stored edges still answer
            errors.append(f"tables.get: {dbx.clean_error(err)}")
        try:
            rel = ex().relations(table)  # cached once the Graph has read it; names the views built from this table
        except Exception:
            pass
    with rel_store() as store:
        if rel:
            learn_view_joins(ex(), store, table, rel)
        out = relationships.join_keys(store, table, info)
    return jsonify({**out, "errors": errors})


@app.get("/api/relationships/suggestions")
def relationship_suggestions():
    statuses = request.args.get("status", "proposed").split(",")
    with rel_store() as store:
        edges = store.suggestions(relationships.check_statuses(statuses), table=request.args.get("table") or None)
        counts = store.status_counts()
        in_views = store.views_by_pair()
    views = {x.id: v for x in edges if (v := in_views.get(relationships.pair_key(x)))}
    return jsonify({"edges": [x.model_dump(mode="json") for x in edges], "counts": counts, "views": views})


@app.post("/api/relationships/bulk")
def relationship_bulk():
    body = relationships.parse_bulk(request.get_json(silent=True))
    with rel_store() as store:
        return jsonify({"updated": store.set_status_many(body.ids, body.status)})


@app.post("/api/relationships")
def relationship_create():
    body = relationships.parse_create(request.get_json(silent=True))
    with rel_store() as store:
        edge, created = store.create_manual(body)
    return jsonify(edge.model_dump(mode="json")), 201 if created else 200


@app.patch("/api/relationships/<rid>")
def relationship_patch(rid):
    patch = relationships.parse_patch(request.get_json(silent=True))
    with rel_store() as store:
        if rid.startswith("e_"):
            edge = store.patch(rid, patch.status, patch.note)
        else:  # a derived edge: its id is its natural key, and only a note can be attached
            if patch.status is not None:
                raise relationships.RelationshipInvalid("status: derived edges only take a note")
            edge = store.set_derived_note(rid, patch.note)
    return jsonify(edge.model_dump(mode="json"))


@app.delete("/api/relationships/<rid>")
def relationship_delete(rid):
    with rel_store() as store:
        if rid.startswith("e_"):
            store.delete(rid)
        else:
            store.clear_derived_note(rid)
    return jsonify({"deleted": rid})


@app.get("/api/relationships/export")
def relationships_export():
    with rel_store() as store:
        return jsonify(store.export())


@app.post("/api/relationships/import")
def relationships_import():
    file = relationships.parse_export(request.get_json(silent=True))
    with rel_store() as store:
        return jsonify(store.import_file(file))


# ---------- concepts (concepts.py): a business glossary linked to tables, columns and other concepts ----------

@app.get("/api/concepts")
def concept_list():
    status = request.args.get("status") or None
    with rel_store() as store:
        return jsonify(concepts.listing(store, request.args.get("q", ""), request.args.get("domain") or None, status))


@app.post("/api/concepts")
def concept_create():
    body = concepts.parse_create(request.get_json(silent=True))
    with rel_store() as store:
        return jsonify(concepts.detail(store, concepts.create(store, body).id)), 201


@app.get("/api/concepts/export")
def concepts_export():
    with rel_store() as store:
        return jsonify(store.export(concepts_only=True))


@app.get("/api/concepts/for-tables")
def concepts_for_tables():
    with rel_store() as store:
        return jsonify(concepts.for_tables(store, request.args.getlist("table")))


@app.get("/api/concepts/suggest/plan")
def concept_suggest_plan():
    return jsonify(concepts.tag_plan(ex().warehouse_id))


@app.post("/api/concepts/suggest/run")
def concept_suggest_run():
    result = ex().query(concepts.TAG_SQL, None, concepts.TAG_ROW_CAP)
    with rel_store() as store:
        return jsonify(concepts.tag_run(store, result))


# ---------- card facts (nodefacts.py, tablestats.py): the grain, and size and freshness read on demand ----------

def _table_names(body):
    """The catalog.schema.table names in a request body's `tables` (placeholders are skipped). 400 when it is not a list of names."""
    tables = body.get("tables") if isinstance(body, dict) else None
    if not isinstance(tables, list) or not all(isinstance(t, str) for t in tables):
        raise relationships.RelationshipInvalid("tables: expected a list of table names")
    names = [t for t in dict.fromkeys(tables) if nodefacts.table_name(t)]
    if len(names) > nodefacts.MAX_TABLES:
        raise relationships.RelationshipInvalid(f"tables: at most {nodefacts.MAX_TABLES} at a time")
    return names


def _stats_plan(e, names):
    """(tables to read, [{"table", "reason"}] for the ones with nothing to read): views, metric views and non-Delta tables are skipped."""
    eligible, skipped = [], []
    for t in names:
        try:
            reason = tablestats.skip_reason(e.object(t)["data"])
        except Exception as err:
            reason = f"cannot read the table: {dbx.clean_error(err)}"
        (skipped.append({"table": t, "reason": reason}) if reason else eligible.append(t))
    return eligible, skipped


@app.post("/api/relationships/cardinality")
def relationship_cardinality():
    """The crow's-foot ends of reference edges ({id, kind, source, target} each), from keys and nullability. Reads tables.get and the store; never the warehouse."""
    body = request.get_json(silent=True)
    edges = body.get("edges") if isinstance(body, dict) else None
    if not isinstance(edges, list) or not all(isinstance(x, dict) for x in edges):
        raise relationships.RelationshipInvalid("edges: expected a list of {id, kind, source, target}")
    if len(edges) > 400:
        raise relationships.RelationshipInvalid("edges: at most 400 at a time")
    e = ex()

    def object_of(t):
        try:
            return e.object(t)["data"] if nodefacts.table_name(t) else None
        except Exception:
            return None
    with rel_store() as store:
        out = cardinality.for_edges(edges, object_of, lambda t: relationships.join_keys(store, t, object_of(t)) if nodefacts.table_name(t) else None,
                                    relprofile.lookup(e.profile))
    return jsonify({"cardinality": out})


@app.post("/api/node-facts")
def node_facts():
    """The grain of each table and the size and freshness read before. Reads the cache and tables.get; never the warehouse."""
    return jsonify({"facts": nodefacts.facts(ex(), _table_names(request.get_json(silent=True)))})


@app.post("/api/table-stats/plan")
def table_stats_plan():
    """The statements `POST /api/table-stats/read` would run for these tables, and the tables it would skip."""
    e = ex()
    eligible, skipped = _stats_plan(e, _table_names(request.get_json(silent=True)))
    return jsonify({"statements": [{"table": t, **s} for t in eligible for s in tablestats.statements(t)], "skipped": skipped,
                    "warehouse_id": e.warehouse_id})


@app.post("/api/table-stats/read")
def table_stats_read():
    """Run DESCRIBE DETAIL and DESCRIBE HISTORY for the tables and cache the answers (one at a time, replacing what was cached)."""
    e = ex()
    names = _table_names(request.get_json(silent=True))
    if not e.warehouse_id:
        raise ontology.NeedsWarehouse("Pick a SQL warehouse to read size and history.")
    eligible, skipped = _stats_plan(e, names)

    def one(t):
        try:
            e.table_stats(t, True)
            return t, None
        except Exception as err:
            return t, dbx.clean_error(err)
    with ThreadPoolExecutor(max_workers=4) as pool:
        errors = {t: msg for t, msg in pool.map(one, eligible) if msg}
    return jsonify({"facts": nodefacts.facts(e, eligible), "skipped": skipped, "errors": errors})


# ---------- relationship profile (relprofile.py): measured on demand, shown as SQL first, kept with its date ----------

def _profile_specs(e, store, body):
    """(specs, skipped) for the {id, kind, source, target} edges of a request body: what `relprofile.plan_edges` finds profilable, and why not for the rest."""
    edges = body.get("edges") if isinstance(body, dict) else None
    if not isinstance(edges, list) or not all(isinstance(x, dict) and isinstance(x.get("id"), str) and isinstance(x.get("source"), str)
                                              and isinstance(x.get("target"), str) for x in edges):
        raise relationships.RelationshipInvalid("edges: expected a list of {id, kind, source, target}")
    if len(edges) > relprofile.MAX_EDGES:
        raise relationships.RelationshipInvalid(f"edges: at most {relprofile.MAX_EDGES} at a time")

    def object_of(t):
        try:
            return e.object(t)["data"] if nodefacts.table_name(t) else None
        except Exception:
            return None
    return relprofile.plan_edges(edges, object_of, lambda t: relationships.join_keys(store, t, object_of(t)))


@app.post("/api/relationships/profile/plan")
def relationship_profile_plan():
    """The statement `/profile/run` would run for each reference edge, the table sizes known so far, and the edges it would skip. Never queries."""
    e = ex()
    with rel_store() as store:
        specs, skipped = _profile_specs(e, store, request.get_json(silent=True))
    sizes = nodefacts.facts(e, sorted({t for s in specs for t in (s["source"], s["target"])}), fetch=False)
    return jsonify({"statements": [{**s, "rows": {t: ((sizes.get(t) or {}).get("stats") or {}).get("rows") for t in (s["source"], s["target"])}} for s in specs],
                    "skipped": skipped, "warehouse_id": e.warehouse_id})


@app.post("/api/relationships/profile/run")
def relationship_profile_run():
    """Run the profiling statement of each reference edge (two at a time), keep every result with its date, and answer the profiles and the ends they give."""
    e = ex()
    if not e.warehouse_id:
        raise ontology.NeedsWarehouse("Pick a SQL warehouse to profile relationships.")
    with rel_store() as store:
        specs, skipped = _profile_specs(e, store, request.get_json(silent=True))

    def one(spec):
        try:
            return spec["id"], relprofile.run(e.sql, spec["source"], spec["target"], [tuple(x) for x in spec["pairs"]]), None
        except Exception as err:
            return spec["id"], None, dbx.clean_error(err)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(one, specs))
    for spec, (_, p, _) in zip(specs, results):  # written here, one at a time: the file is read and replaced whole
        if p:
            relprofile.put(e.profile, spec["kind"], spec["source"], spec["target"], p)
    return jsonify({"profiles": {i: p for i, p, _ in results if p}, "errors": {i: m for i, _, m in results if m}, "skipped": skipped,
                    "cardinality": {i: relprofile.as_cardinality(p) for i, p, _ in results if p}})


# ---------- ontology import (ontology.py): read-only, into concepts with origin "ontology" ----------

@app.get("/api/concepts/import/plan")
def ontology_plan():
    return jsonify(ontology.plan(ex().warehouse_id))


@app.post("/api/concepts/import/run")
def ontology_run():
    e = ex()
    with rel_store() as store:
        return jsonify(ontology.run(e, store))


@app.errorhandler(ontology.NeedsWarehouse)
def needs_warehouse(e):
    return jsonify({"error": str(e)}), 400


@app.get("/api/certification")
def certification():
    return jsonify(ontology.cached_certification(ex()))  # the local cache only: nothing here ever wakes a warehouse


@app.post("/api/certification/refresh")
def certification_refresh():
    return jsonify(ontology.refresh_certification(ex()))


@app.get("/api/concepts/<cid>")
def concept_get(cid):
    with rel_store() as store:
        return jsonify(concepts.detail(store, concepts.check_concept_id(cid)))


@app.patch("/api/concepts/<cid>")
def concept_patch(cid):
    cid = concepts.check_concept_id(cid)
    patch = concepts.parse_patch(request.get_json(silent=True))
    with rel_store() as store:
        concepts.update(store, cid, patch)
        return jsonify(concepts.detail(store, cid))


@app.delete("/api/concepts/<cid>")
def concept_delete(cid):
    with rel_store() as store:
        return jsonify(concepts.remove(store, concepts.check_concept_id(cid)))


@app.post("/api/concepts/<cid>/links")
def concept_link_add(cid):
    cid = concepts.check_concept_id(cid)
    body = concepts.parse_link(request.get_json(silent=True))
    with rel_store() as store:
        edge, created = concepts.add_link(store, cid, body)
    return jsonify(edge.model_dump(mode="json")), 201 if created else 200


@app.delete("/api/concepts/<cid>/links/<edge_id>")
def concept_link_remove(cid, edge_id):
    with rel_store() as store:
        return jsonify(concepts.remove_link(store, concepts.check_concept_id(cid), edge_id))


@app.get("/api/concepts/<cid>/candidates")
def concept_candidates(cid):
    with rel_store() as store:
        return jsonify(concepts.candidates(store, concepts.check_concept_id(cid), dbx.cached_metadata(ex())))


# ---------- query-history mining (mining.py): explicit, user-triggered runs ----------

@app.errorhandler(mining.MiningInvalid)
def mining_invalid(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(mining.MiningBusy)
def mining_busy(e):
    return jsonify({"error": str(e)}), 409


def miner():
    """The Miner for the connected Explorer."""
    m = STATE.get("miner")
    if m is None or m.ex is not ex():
        m = STATE["miner"] = mining.Miner(ex())
    return m


def _mining_args(source):
    """window_days and full from a query string or body, as ints and bools. Bad types are MiningInvalid."""
    days = source.get("window_days", mining.WINDOW_DAYS)
    if isinstance(days, str):
        if not days.strip().isdigit():
            raise mining.MiningInvalid(f"window_days: must be a whole number from 1 to {mining.MAX_WINDOW_DAYS}")
        days = int(days)
    full = source.get("full", False)
    return days, full in (True, "1", "true")


@app.get("/api/mining/plan")
def mining_plan():
    days, full = _mining_args(request.args)
    return jsonify({**mining.plan(ex().profile, days, full), "warehouse_id": ex().warehouse_id})


@app.post("/api/mining/runs")
def mining_start():
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        raise mining.MiningInvalid("(root): body must be a JSON object")
    days, full = _mining_args(body)
    return jsonify(miner().start(days, full)), 202


@app.get("/api/mining/status")
def mining_status():
    return jsonify(miner().status())


@app.get("/api/mining/usage")
def mining_usage():
    limit = request.args.get("limit", "10")
    if not limit.isdigit() or not 1 <= int(limit) <= 100:
        raise mining.MiningInvalid("limit: must be a whole number from 1 to 100")
    return jsonify(mining.usage_summary(ex().profile, int(limit)))


def _query_sql(body):
    """The SQL to run: with a windows map, {{title}} references are expanded first."""
    return sqltools.expand_refs(body["sql"], body["windows"]) if body.get("windows") else body["sql"]


@app.post("/api/query")
def query():
    body = request.json
    return jsonify(ex().query(_query_sql(body), body.get("params"), body.get("max_rows", 5000)))


@app.post("/api/query/tables")
def query_tables():
    """Tables a query reads, after {{title}} expansion. No Databricks call; sqlglot only."""
    return jsonify({"tables": sqltools.tables_read(_query_sql(request.json))})


@app.errorhandler(starexpand.StarError)
def star_error(e):
    return jsonify({"error": str(e)}), 400


@app.post("/api/sql/expand-star")
def expand_star():
    """Columns for the `*` at a cursor offset in one statement: {text, start, end, count}, replacing sql[start:end].

    Body: {sql, offset, catalog?, schema?}. Table columns come from the same cached details as GET /api/object.
    """
    body = request.json
    e = ex()

    def columns_of(name):
        try:
            info = e.object(name)["data"]
        except Exception as err:  # unknown table, no access, no connection to the workspace
            raise starexpand.StarError(f"Could not read the columns of {name}: {dbx.clean_error(err)}") from err
        return [c["name"] for c in info.get("columns") or [] if c.get("name")]

    return jsonify(starexpand.expand_star(body["sql"], int(body["offset"]), columns_of, body.get("catalog"), body.get("schema")))


@app.post("/api/query/async")
def query_async():
    body = request.json
    sql = _query_sql(body)
    return jsonify({"statement_id": ex().query_async(sql, body.get("params"), body.get("max_rows", 5000)),
                    "sql_hash": sqltools.sql_hash(sql)})


@app.post("/api/query/hashes")
def query_hashes():
    """The hash of each statement after {{title}} expansion, so the page can tell whether a saved result still matches."""
    body = request.json
    out = []
    for statement in body["statements"]:
        try:
            out.append(sqltools.sql_hash(sqltools.expand_refs(statement, body["windows"]) if body.get("windows") else statement))
        except ValueError:  # an unknown title, a cycle or SQL that does not read: it cannot match a saved result
            out.append(None)
    return jsonify({"hashes": out})


@app.get("/api/query/<sid>")
def query_status(sid):
    return jsonify(ex().query_status(sid))


@app.delete("/api/query/<sid>")
def query_cancel(sid):
    return jsonify(ex().query_cancel(sid))


# ---------- Ask (genie.py): Genie One questions over MCP. Nothing is stored; the page keeps the conversation ----------

@app.errorhandler(genie.GenieInvalid)
def genie_invalid(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(genie.GenieError)
def genie_failed(e):
    return jsonify({"error": dbx.clean_error(e)}), e.status


def genie_client():
    """The Genie client for the connected Explorer (the fake one in demo mode), pointed at the selected warehouse."""
    e = ex()
    cached = STATE.get("genie")
    if cached is None or cached[0] is not e:
        cached = STATE["genie"] = (e, demo.FakeGenie() if dbx.DEMO else genie.GenieClient(e.w))
    cached[1].warehouse_id = e.warehouse_id
    return cached[1]


def _genie_call(op, fn):
    """Run one Genie call and log its name and timing. Never the question, the answer or the rows."""
    t = time.time()
    try:
        out = fn()
    except Exception as e:
        dbx.log({"op": op, "ms": int((time.time() - t) * 1000), "ok": False, "error": dbx.clean_error(e)[:200]})
        raise
    dbx.log({"op": op, "ms": int((time.time() - t) * 1000), "ok": True})
    return jsonify(out)


@app.post("/api/ask")
def ask():
    question, cid = genie.parse_ask(request.get_json(silent=True))
    return _genie_call("genie.ask", lambda: genie_client().ask(question, cid))


@app.get("/api/ask/poll")
def ask_poll():
    cid, rid = genie.parse_ids(request.args, "conversation_id", "response_id")
    return _genie_call("genie.poll", lambda: genie_client().poll(cid, rid))


@app.get("/api/ask/result")
def ask_result():
    cid, rid, item = genie.parse_ids(request.args, "conversation_id", "response_id", "item_id")
    return _genie_call("genie.result", lambda: genie_client().query_result(cid, rid, item))


@app.post("/api/ask/cancel")
def ask_cancel():
    (cid,) = genie.parse_ids(request.get_json(silent=True) or {}, "conversation_id")
    return _genie_call("genie.cancel", lambda: genie_client().cancel(cid))


@app.get("/api/canvases")
def canvas_list():
    return jsonify(canvases.list_canvases())


@app.post("/api/canvases")
def canvas_save():
    body = request.get_json(silent=True)
    base = request.headers.get("X-Base-Revision")  # the page sends the revision it loaded, to avoid overwriting a newer save
    if base is not None and not base.isdigit():
        return jsonify({"error": "X-Base-Revision: must be a whole number"}), 400
    try:
        name, revision = canvases.write_canvas(body, expect=int(base) if base is not None else None)
        return jsonify({"saved": name, "revision": revision})
    except canvases.CanvasInvalid as e:
        return jsonify({"error": str(e)}), 400
    except canvases.CanvasConflict as e:
        return jsonify({"error": str(e), **e.info}), 409


@app.get("/api/canvases/<name>")
def canvas_get(name):
    try:
        return jsonify(canvases.load_canvas(name))
    except canvases.CanvasNotFound as e:
        return jsonify({"error": str(e)}), 404
    except canvases.CanvasInvalid as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/canvases/<name>/revision")
def canvas_revision(name):
    """The canvas's revision, who wrote it last (ui, agent or undo) and how many undo snapshots exist. The page polls this."""
    return jsonify(canvases.revision_info(name))


@app.post("/api/canvases/<name>/undo")
def canvas_undo(name):
    """Restore the state before the last agent write. Another undo goes one agent write further back."""
    return jsonify(canvases.undo_canvas(name))


@app.post("/api/canvases/<name>/connect-known")
def canvas_connect_known(name):
    """Draw connectors for the known relationships (foreign keys, mined, manual) between the table cards of a saved canvas.
    Body (all optional): {"ids": [card ids], "include_proposed": false}. Saved as an agent write, so the page's Undo works."""
    body = request.get_json(silent=True) or {}
    ids, proposed, lineage = body.get("ids"), body.get("include_proposed", False), body.get("include_lineage", False)
    if (not (ids is None or (isinstance(ids, list) and all(isinstance(i, str) for i in ids)))
            or not isinstance(proposed, bool) or not isinstance(lineage, bool)):
        return jsonify({"error": "send ids (a list of card ids), include_proposed and include_lineage (true or false)"}), 400
    ctx = Context(explorer=lambda: STATE["ex"], store=rel_store, miner=miner)
    try:
        return jsonify(tools_canvas.connect_known_on(ctx, name, ids, proposed, lineage))
    except ToolError as e:
        return jsonify({"error": str(e)}), 400


@app.post("/api/relationships/connectors")
def relationship_connectors():
    """The connectors the Graph draws on the canvas for tables it sends: one per pair of the given tables, from the known
    relationships among them. Body: {"tables": [name, ...], "include_proposed": false, "include_lineage": true}."""
    body = request.get_json(silent=True) or {}
    tables, proposed, lineage = body.get("tables"), body.get("include_proposed", False), body.get("include_lineage", True)
    if (not isinstance(tables, list) or not tables or not all(isinstance(t, str) and t for t in tables)
            or not isinstance(proposed, bool) or not isinstance(lineage, bool)):
        return jsonify({"error": "send tables (a list of table names), include_proposed and include_lineage (true or false)"}), 400
    if len(tables) > MAX_CONNECTOR_TABLES:
        return jsonify({"error": f"at most {MAX_CONNECTOR_TABLES} tables at a time"}), 400
    ctx = Context(explorer=lambda: STATE["ex"], store=rel_store, miner=miner)
    try:
        names = [relationships.check_table(t) for t in dict.fromkeys(tables) if not t.startswith(("ph:", "concept:"))]
        plan, skipped = tools_canvas.known_connector_plan(ctx, names, proposed, lineage)
    except ToolError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"connectors": [{"source": p["source"], "target": p["target"], "label": p["label"], "directed": p["directed"],
                                    "proposed": p["proposed"], "bidir": p.get("bidir", False), "kinds": p.get("kinds", [])}
                                   for p in plan], "skipped": skipped})


# ---- Layout: doctor, tidy, arrange, describe, render. Each takes {"canvas": {...}} or {"name": "<saved>"}. ----

@app.errorhandler(layout.LayoutError)
def layout_bad_request(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(canvases.CanvasInvalid)
def canvas_bad_request(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(canvases.CanvasNotFound)
def canvas_not_found(e):
    return jsonify({"error": str(e)}), 404


def _layout_body():
    """(body, canvas, grid) for a layout route. The canvas is validated and never saved."""
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        raise layout.LayoutError("body must be a JSON object")
    if isinstance(body.get("canvas"), dict):
        data = body["canvas"]
        canvases.parse_canvas({**data, "name": data.get("name") or "unsaved"})
    elif isinstance(body.get("name"), str):
        data = canvases.load_canvas(body["name"])
    else:
        raise layout.LayoutError('send {"canvas": {...}} or {"name": "<saved canvas>"}')
    grid = body.get("grid")
    if grid is not None and (isinstance(grid, bool) or not isinstance(grid, (int, float)) or grid <= 0):
        raise layout.LayoutError("grid must be a positive number")
    return body, data, grid


def _layout_list(body, key):
    v = body.get(key)
    if v is not None and not (isinstance(v, list) and all(isinstance(i, str) for i in v)):
        raise layout.LayoutError(f"{key} must be a list of strings")
    return v


@app.post("/api/layout/doctor")
def layout_doctor():
    _, data, grid = _layout_body()
    return jsonify(layout.doctor(data, grid))


@app.post("/api/layout/tidy")
def layout_tidy():
    body, data, grid = _layout_body()
    out, changes = layout.tidy(data, _layout_list(body, "ids"), _layout_list(body, "rules"), grid)
    return jsonify({"changes": changes, "canvas": out,
                    "score": {"before": layout.doctor(data, grid)["score"], "after": layout.doctor(out, grid)["score"]}})


@app.post("/api/layout/arrange")
def layout_arrange():
    body, data, grid = _layout_body()
    opts = body.get("options") or {}
    if not isinstance(opts, dict) or not isinstance(body.get("mode"), str) or {"canvas", "ids", "mode", "grid"} & set(opts):
        raise layout.LayoutError("send mode (a string) and optionally options (an object of mode options)")
    out, changes = layout.arrange(data, _layout_list(body, "ids"), body["mode"], grid=grid, **opts)
    return jsonify({"changes": changes, "canvas": out,
                    "score": {"before": layout.doctor(data, grid)["score"], "after": layout.doctor(out, grid)["score"]}})


@app.post("/api/layout/describe")
def layout_describe():
    _, data, grid = _layout_body()
    return jsonify({"text": layout.describe(data, grid=grid)})


@app.post("/api/layout/render")
def layout_render():
    body, data, grid = _layout_body()
    width = body.get("width", 1200)
    if isinstance(width, bool) or not isinstance(width, int):
        raise layout.LayoutError("width must be an integer")
    hi = body.get("highlight")
    if hi == "issues":  # every node an error or warning names
        hi = sorted({n for i in layout.doctor(data, grid)["issues"] if i["severity"] != "info" for n in i["nodes"]}, key=str)
    elif hi is not None and not (isinstance(hi, list) and all(isinstance(i, str) for i in hi)):
        raise layout.LayoutError('highlight must be a list of ids or "issues"')
    return app.response_class(layout.render_png(data, width, hi), mimetype="image/png")


# ---- MCP server (mcp_server/): /mcp for coding agents, /api/agent-access for the page. Local only, bearer token. ----
mcp_server.register(app, explorer=lambda: STATE["ex"], store=rel_store, miner=miner)

