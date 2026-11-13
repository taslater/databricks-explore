"""Local Databricks relationship explorer.  Run:  uv run --with-requirements requirements.txt app.py"""
import os
import sys
from pathlib import Path

if "--demo" in sys.argv:  # must be set before dbx is imported: it picks the data folder and client at import
    os.environ["EXPLORER_DEMO"] = "1"
if "--redacted" in sys.argv:  # demo only: query history text reads <REDACTED>, to try that path
    os.environ["EXPLORER_DEMO_REDACTED"] = "1"

from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException, MethodNotAllowed, NotFound

import canvases
import dbx
import mining
import relationships
import sqltools

app = Flask(__name__, static_folder=None)  # the React build in web/dist is the only UI
STATE = {"ex": None}  # single local user -> one active connection
WEB_DIST = Path(__file__).resolve().parent / "web" / "dist"  # built by `npm run build` in web/


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
    return jsonify({"error": str(e)}), 500


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
    return jsonify({"profile": e.profile if e else None, "warehouse_id": e.warehouse_id if e else None})


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
            return jsonify({"error": f"Could not reconnect to {profile}: {first_error}"}), 401
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


@app.get("/api/search")
def search():
    return jsonify(ex().search(request.args["q"]))


@app.get("/api/object")
def obj():
    return jsonify(ex().object(request.args["name"], refresh()))


@app.get("/api/relations")
def relations():
    return jsonify(ex().relations(request.args["name"], refresh()))


@app.get("/api/edge")
def edge():
    return jsonify(ex().edge_details(request.args["src"], request.args["tgt"]))


@app.get("/api/diagrams")
def diagrams():
    return jsonify(dbx.list_diagrams())


@app.get("/api/diagrams/<name>")
def diagram(name):
    return jsonify(dbx.load_diagram(name))


@app.post("/api/diagrams")
def save():
    body = request.json
    return jsonify({"saved": dbx.save_diagram(body["name"], body)})


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
                notes.append(f"column_lineage: {err}")
    with rel_store() as store:
        out = relationships.unified(store, table, rel, times, level, columns)
    return jsonify({**out, "errors": [*out["errors"], *notes]})


@app.get("/api/relationships/suggestions")
def relationship_suggestions():
    statuses = request.args.get("status", "proposed").split(",")
    with rel_store() as store:
        edges = store.suggestions(relationships.check_statuses(statuses), table=request.args.get("table") or None)
        counts = store.status_counts()
    return jsonify({"edges": [x.model_dump(mode="json") for x in edges], "counts": counts})


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


@app.post("/api/query/async")
def query_async():
    body = request.json
    return jsonify({"statement_id": ex().query_async(_query_sql(body), body.get("params"), body.get("max_rows", 5000))})


@app.get("/api/query/<sid>")
def query_status(sid):
    return jsonify(ex().query_status(sid))


@app.delete("/api/query/<sid>")
def query_cancel(sid):
    return jsonify(ex().query_cancel(sid))


@app.get("/api/canvases")
def canvas_list():
    return jsonify(canvases.list_canvases())


@app.post("/api/canvases")
def canvas_save():
    body = request.get_json(silent=True)
    try:
        return jsonify({"saved": canvases.save_canvas(body)})
    except canvases.CanvasInvalid as e:
        return jsonify({"error": str(e)}), 400


@app.get("/api/canvases/<name>")
def canvas_get(name):
    try:
        return jsonify(canvases.load_canvas(name))
    except canvases.CanvasNotFound as e:
        return jsonify({"error": str(e)}), 404
    except canvases.CanvasInvalid as e:
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    # Demo mode uses its own port so the browser keeps its saved profile and warehouse apart from real use.
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8767 if dbx.DEMO else 8765)), debug=True)
