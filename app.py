"""Local Databricks relationship explorer.  Run:  uv run --with-requirements requirements.txt app.py"""
import os
import sys
import time
from pathlib import Path

if "--demo" in sys.argv:  # must be set before dbx is imported: it picks the data folder and client at import
    os.environ["EXPLORER_DEMO"] = "1"
if "--redacted" in sys.argv:  # demo only: query history text reads <REDACTED>, to try that path
    os.environ["EXPLORER_DEMO_REDACTED"] = "1"

from flask import Flask, abort, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException, MethodNotAllowed, NotFound

import canvases
import concepts
import dbx
import demo
import genie
import layout
import mcp_server
import mining
import ontology
import relationships
import sqltools

app = Flask(__name__, static_folder=None)  # the React build in web/dist is the only UI
STATE = {"ex": None}  # single local user -> one active connection
WEB_DIST = Path(__file__).resolve().parent / "web" / "dist"  # built by `npm run build` in web/


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
                notes.append(f"column_lineage: {dbx.clean_error(err)}")
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


if __name__ == "__main__":
    # Demo mode uses its own port so the browser keeps its saved profile and warehouse apart from real use.
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 8767 if dbx.DEMO else 8765)), debug=True)
