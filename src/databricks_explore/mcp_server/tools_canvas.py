"""The canvas tools: read, add and change nodes and connectors, run windows, lay them out, render. Every write is saved and undoable."""
import base64
import copy
import json
import re
import time
import uuid

from .. import canvases
from .. import dbx
from .. import graphs
from .. import layout
from .. import lineage as lineage_walk
from .. import relationships
from .. import sqltools

from . import tools_data
from .tooling import B, FORMAT, S, ToolError, integer, obj, strings, text, tool

EXCERPT_LINES = 14
SKETCH = ("shape", "text", "sticky", "frame", "placeholder")
NODE_TYPES = ("shape", "text", "sticky", "frame", "placeholder", "query", "note", "table")
SHAPES = ("rect", "rounded", "ellipse", "diamond", "cylinder")
SIZES = {"rect": (140, 80), "rounded": (140, 80), "ellipse": (140, 80), "diamond": (120, 100), "cylinder": (100, 120),
         "text": (140, 40), "sticky": (160, 160), "frame": (400, 300), "placeholder": (280, 120),
         "query": (760, 520), "note": (320, 220), "table": (320, 300)}  # what the page uses for a new node of each kind
STYLE = {"shape": {"fill": "#ffffff", "stroke": "#1f2328", "font_size": 14}, "text": {"fill": "none", "stroke": "none", "font_size": 16},
         "sticky": {"fill": "#fef9c3", "stroke": "#ca8a04", "font_size": 14}, "frame": {"fill": "#e5e7eb", "stroke": "#6b7280", "font_size": 14},
         "placeholder": {"fill": "#ffffff", "stroke": "#2563eb", "font_size": 14}}
BAR_EXAMPLE = '{"mark":"bar","encoding":{"x":{"field":"category","type":"nominal"},"y":{"field":"rate","type":"quantitative"}}}'
RANGE_EXAMPLE = ('{"layer":[{"mark":"bar","encoding":{"x":{"field":"low","type":"quantitative"},"x2":{"field":"high"}}},'
                 '{"mark":"rule","encoding":{"x":{"field":"best","type":"quantitative"}}}]}')
CHART = {"type": ["object", "null"],
         "description": ("query windows: a Vega-Lite v5 spec (an object with mark or layer; null removes the chart). Its data is the window's "
                         "result, so field names are the result's column names; do not give data. Bar chart: " + BAR_EXAMPLE
                         + ". A range with a best estimate (one row with low, high and best columns): " + RANGE_EXAMPLE
                         + ", which draws the bar from low to high (x and x2) and a rule at best. Draw ranges and uncertainty this way, "
                           "not from rectangles. The chart shows once the window has a result (run_window); view chart opens the window on it")}
VIEW = {"type": "string", "enum": ["results", "chart"], "description": "query windows: the tab the window opens on (needs a chart for chart)"}
AUTO_TIDY = {"type": "boolean", "description": "default true: after the edit, push apart any overlapping nodes among those just touched"}
NAME = {"type": "string", "minLength": 1, "description": "canvas name (letters, digits, _ . -)"}
POINT = {"type": "object", "required": ["x", "y"], "additionalProperties": False, "properties": {"x": {"type": "number"}, "y": {"type": "number"}}}
PLACE = {"type": "object", "required": ["relation", "anchor"], "additionalProperties": False,
         "description": "structural placement (preferred over at): next to or inside an existing node, with a gap",
         "properties": {"relation": {"type": "string", "enum": list(layout.PLACE_RELATIONS)},
                        "anchor": {"type": "string", "minLength": 1, "description": "id of an existing node (or one earlier in this call)"},
                        "gap": {"type": "number", "minimum": 0},
                        "align": {"type": "string", "enum": ["start", "center", "end"],
                                  "description": "across the relation: start (default for right_of/left_of: top-aligned with the anchor; below/above center), center or end"}}}
COLUMN = {"type": "object", "required": ["name"], "additionalProperties": False,
          "properties": {"name": S, "type": S, "key": {"type": "string", "enum": ["pk", "fk"]}}}
STYLE_PROPS = {"fill": {"type": "string", "description": "CSS color"}, "stroke": {"type": "string", "description": "CSS color"},
               "font_size": {"type": "number", "exclusiveMinimum": 0}, "locked": B}
NODE = {"type": "object", "required": ["type"], "additionalProperties": False,
        "description": "type shape (set shape), text, sticky, frame, placeholder (table that does not exist yet), query (sql), note (text) or table (table = catalog.schema.table). Place it with place (preferred) or at; with neither it goes below the existing content.",
        "properties": {"type": {"type": "string", "enum": list(NODE_TYPES)}, "id": {"type": "string", "minLength": 1},
                       "label": {"type": "string", "description": "shape, text, sticky and frame: the text shown on the node"},
                       "title": {"type": "string", "description": "query, note and table windows: unique, used as {{title}} in SQL"},
                       "shape": {"type": "string", "enum": list(SHAPES)}, "sql": S,
                       "text": {"type": "string", "description": "note: the note body. shape, text, sticky and frame: an alias of label (label wins if both are given)"},
                       "table": S, "chart": CHART, "view": VIEW,
                       "name": {"type": "string", "description": "placeholder: the table name"}, "columns": {"type": "array", "items": COLUMN},
                       "w": {"type": "number", "exclusiveMinimum": 0, "description": "omit it and a sketch node is sized to fit its label"},
                       "h": {"type": "number", "exclusiveMinimum": 0},
                       "place": PLACE, "at": POINT, **STYLE_PROPS}}


# ---------------------------------------------------------------- reading

def _load(name: str) -> dict:
    try:
        return canvases.load_canvas(name)
    except canvases.CanvasNotFound as e:
        if graphs.exists(name):  # a saved Graph diagram is a different store
            raise canvases.CanvasNotFound(f"{e}; a saved graph has that name: use get_graph (graphs and canvases are separate)") from e
        raise


def _score_line(canvas: dict) -> str:
    d = layout.doctor(canvas)
    kinds = {}
    for i in d["issues"]:
        kinds[i["severity"]] = kinds.get(i["severity"], 0) + 1
    detail = ", ".join(f"{n} {k}" for k, n in sorted(kinds.items())) or "no issues"
    return f"doctor score {d['score']}/100 ({detail})"


def _report(canvas: dict, headline: str, revision: int) -> str:
    """What an edit did: the headline, the doctor score and a short describe excerpt, so the agent sees the effect."""
    return (f"{headline}. revision {revision}; {_score_line(canvas)}. undo_canvas reverts it.\n"
            + layout.describe(canvas, max_lines=EXCERPT_LINES))


def _edit(name: str, mutate, auto_tidy: bool = True) -> str:
    """Load, mutate (returns headline and the ids it touched), tidy overlaps among those, validate, save with a snapshot."""
    canvas, headline, rev = _commit(name, mutate, auto_tidy)
    return _report(canvas, headline, rev)


def _commit(name: str, mutate, auto_tidy: bool = True) -> tuple[dict, str, int]:
    """The write behind _edit: returns the saved canvas, the headline (with what auto tidy moved) and the new revision."""
    with canvases.LOCK:
        canvas = copy.deepcopy(_load(name))
        canvas["version"] = 2  # the sketch node types and connectors need version 2; version 1 content stays valid
        canvas.setdefault("edges", [])
        headline, touched = mutate(canvas)
        moved = 0
        if auto_tidy and touched:
            canvas, changes = layout.tidy(canvas, ids=touched, rules=["overlaps"])
            moved = sum(1 for c in changes if c["kind"] == "node")
        _, rev = canvases.write_canvas(canvas, by="agent", snapshot=True)
    return canvas, headline + (f"; moved {moved} to clear overlaps" if moved else ""), rev


def _ids(canvas: dict) -> set:
    return {w["id"] for w in canvas["windows"]} | {e["id"] for e in canvas.get("edges", [])}


def _next_id(prefix: str, used: set) -> str:
    n = 1 + max([int(m.group(1)) for i in used if (m := re.fullmatch(prefix + r"(\d+)", i))] or [0])
    return f"{prefix}{n}"


@tool("list_canvases", "List saved canvases with their node and connector counts and revision.", obj())
def list_canvases(ctx, args):
    names = canvases.list_canvases()
    lines = [f"{len(names)} canvas(es)"]
    if not names:
        lines.append("Graphs saved from the Graph tab are a separate store: list_graphs.")
    for n in names:
        try:
            c = _load(n)
            info = canvases.revision_info(n)
            lines.append(f"{n}: {len(c['windows'])} nodes, {len(c.get('edges', []))} connectors, revision {info['revision']}")
        except (canvases.CanvasInvalid, canvases.CanvasNotFound) as e:
            lines.append(f"{n}: unreadable ({e})")
    return text("\n".join(lines))


RESULT_ROWS_IN_JSON = 5  # get_canvas json keeps this many rows of each saved result unless full_results is given


def _results_lines(canvas: dict) -> list[str]:
    """One line per query window that holds a saved result: its size, when it ran, whether the SQL still matches, its chart."""
    windows = {w["title"]: w.get("sql", "") for w in canvas["windows"] if w.get("type") == "query"}
    out = []
    for w in canvas["windows"]:
        r = w.get("result")
        if w.get("type") != "query" or not r:
            continue
        try:
            same = sqltools.sql_hash(sqltools.expand_refs(w.get("sql", ""), windows)) == r["sql_hash"]
        except ValueError:
            same = False
        rows = f"{len(r['rows'])} of {r['row_count']} rows" if len(r["rows"]) < r["row_count"] else f"{r['row_count']} rows"
        out.append(f"  {w['id']} {w['title']!r}: {rows}, ran {r['ran_at']}, " + ("matches its SQL" if same else "SQL differs from what ran (stale)")
                   + (f", chart {layout.chart_mark(w['chart']['vega_lite'])}" if w.get("chart") else "") + (f", opens on {w['view']}" if w.get("view") else ""))
    return (["Saved results:", *out]) if out else []


def _trim_results(canvas: dict) -> dict:
    """The canvas with each saved result cut to its first rows, so reading the file does not flood the agent's context."""
    c = copy.deepcopy(canvas)
    for w in c["windows"]:
        r = w.get("result")
        if r and len(r["rows"]) > RESULT_ROWS_IN_JSON:
            r["rows_omitted"] = len(r["rows"]) - RESULT_ROWS_IN_JSON
            r["rows"] = r["rows"][:RESULT_ROWS_IN_JSON]
    return c


@tool("get_canvas", "Read a canvas. describe (default) is a compact text summary: frames, a map, connectors, issues, and each query window's saved result. json is the whole file, with each saved result cut to its first 5 rows unless full_results is true.",
      obj({"name": NAME, "format": {"type": "string", "enum": ["describe", "json", "text"], "description": "describe (default; text is an alias, as in doctor), or json"},
           "max_lines": integer(10, 300), "full_results": {**B, "description": "json: keep every saved row (default false)"}}, ("name",)))
def get_canvas(ctx, args):
    c = _load(args["name"])
    if args.get("format") == "json":
        return text(json.dumps(c if args.get("full_results") else _trim_results(c), separators=(",", ":")))
    return text("\n".join([layout.describe(c, max_lines=args.get("max_lines", 60)), *_results_lines(c)]))


# ---------------------------------------------------------------- writing

@tool("create_canvas", "Create an empty canvas (a version 2 sketch with no connection needed). Fails if the name is taken.",
      obj({"name": NAME}, ("name",)), read_only=False)
def create_canvas(ctx, args):
    name = args["name"]
    with canvases.LOCK:
        if name in canvases.list_canvases():
            raise ToolError(f"canvas {name!r} already exists; use add_nodes to change it")
        canvases.write_canvas({"version": 2, "name": name, "profile": None, "windows": [], "edges": []}, by="agent")
    return text(f"created canvas {name} (empty). Add nodes with add_nodes or add_query_window.")


def _title(canvas: dict, base: str) -> str:
    taken = {w.get("title") for w in canvas["windows"]}
    if base not in taken:
        return base
    n = 2
    while f"{base}_{n}" in taken:
        n += 1
    return f"{base}_{n}"


def build_node(canvas: dict, spec: dict) -> dict:
    """A window dict for one add_nodes entry, with the page's defaults for its type, at a provisional position."""
    kind = spec["type"]
    used = _ids(canvas)
    nid = spec.get("id") or _next_id("s" if kind in SKETCH else "w", used)
    if nid in used:
        raise ToolError(f"id {nid!r} is already used on this canvas")
    shape = spec.get("shape", "rect")
    w, h = SIZES[shape if kind == "shape" else kind]
    at = spec.get("at") or {"x": 0, "y": 0}
    node = {"id": nid, "type": kind, "position": {"x": at["x"], "y": at["y"]},
            "size": {"w": spec.get("w", w), "h": spec.get("h", h)}}
    if kind in STYLE:
        node.update(STYLE[kind])
    for key in ("fill", "stroke", "font_size", "locked"):
        if key in spec:
            node[key] = spec[key]
    label = spec["label"] if "label" in spec else spec.get("text")  # text is an alias of label on sketch nodes; label wins
    if kind == "shape":
        node.update(shape=shape, label=label if label is not None else "")
    elif kind in ("text", "sticky", "frame"):
        node["label"] = label if label is not None else ("Group" if kind == "frame" else "")
    elif kind == "placeholder":
        cols = spec.get("columns") or [{"name": "id", "type": "bigint", "key": "pk"}]
        node["placeholder"] = {"id": str(uuid.uuid4()), "name": spec.get("name") or spec.get("label") or "new_table", "columns": cols}
        if "h" not in spec:
            node["size"]["h"] = max(h, 40 + 24 * len(cols))
    elif kind == "query":
        if "sql" not in spec:
            raise ToolError("a query node needs sql")
        node.update(title=_title(canvas, spec.get("title") or "query"), sql=spec["sql"], collapsed=False, editor_split=30)
        _set_chart_and_view(node, spec)
    elif kind == "note":
        node.update(title=_title(canvas, spec.get("title") or "note"), text=spec.get("text", ""), collapsed=False)
    else:  # table
        if not spec.get("table"):
            raise ToolError("a table node needs table (catalog.schema.table)")
        base = re.sub(r"[{}]", "", spec["table"].split(".")[-1]).strip() or "table"
        node.update(title=_title(canvas, spec.get("title") or base), table=spec["table"], collapsed=False)
    if kind != "query" and ("chart" in spec or "view" in spec):
        raise ToolError("chart and view belong to query windows")
    if kind in SKETCH and "w" not in spec:  # no width asked for: size the node to its label (wrapping past MAX_FIT_W)
        node["size"]["w"], node["size"]["h"] = layout.fit_size(node)
    return node


def _below_content(canvas: dict, gap: float = 40.0) -> tuple[float, float]:
    live = [w for w in canvas["windows"]]
    if not live:
        return 0.0, 0.0
    return (min(layout._x(w) for w in live), max(layout._y(w) + layout._h(w) for w in live) + gap)


def add_nodes_to(canvas: dict, specs: list) -> list[str]:
    """Add nodes to a canvas dict (placement included) and return their ids. Raises ToolError on a bad spec."""
    new_ids = []
    batch = []  # consecutive nodes with the same placement are arranged together, so they stack instead of chaining
    def flush():
        if not batch:
            return
        place = batch[0][1]
        out, _ = layout.arrange(canvas, [n for n, _ in batch], "place", relation=place["relation"], anchor=place["anchor"],
                                gap=place.get("gap", 40), align=place.get("align"))
        canvas["windows"][:] = out["windows"]
        canvas["edges"][:] = out["edges"]
        batch.clear()
    for spec in specs:
        if "place" in spec and "at" in spec:
            raise ToolError("give place or at, not both")
        node = build_node(canvas, spec)
        if "at" not in spec and "place" not in spec:
            flush()
            node["position"]["x"], node["position"]["y"] = _below_content(canvas)
        place = spec.get("place")
        if batch and batch[0][1] != place:
            flush()  # the new node may anchor on one still waiting in the batch
        if place:
            anchor = next((w for w in canvas["windows"] if w["id"] == place["anchor"]), None)
            if anchor is None:
                raise ToolError(f"place.anchor {place['anchor']!r} is not on this canvas (nor added earlier in this call)")
            node["position"]["x"], node["position"]["y"] = layout._x(anchor), layout._y(anchor)
        canvas["windows"].append(node)
        new_ids.append(node["id"])
        if place:
            batch.append((node["id"], place))
    flush()
    return new_ids


@tool("add_nodes", "Add shapes, text, sticky notes, frames, placeholder tables, query windows, notes or table cards to a canvas. Prefer structural placement (place: right_of/left_of/below/above/inside an anchor id, with a gap) over absolute at {x, y}. Returns the doctor score and a describe excerpt.",
      obj({"name": NAME, "nodes": {"type": "array", "minItems": 1, "maxItems": 100, "items": NODE}, "auto_tidy": AUTO_TIDY}, ("name", "nodes")),
      read_only=False)
def add_nodes(ctx, args):
    def mutate(canvas):
        ids = add_nodes_to(canvas, args["nodes"])
        return f"added {', '.join(ids)}" + _chart_notes(canvas, ids), ids
    return text(_edit(args["name"], mutate, args.get("auto_tidy", True)))


@tool("add_query_window", "Add a SQL query window to a canvas (it is not run). Use {{title}} in another window's SQL to reference it. Prefer structural placement.",
      obj({"name": NAME, "sql": S, "title": S, "chart": CHART, "view": VIEW, "place": PLACE, "at": POINT, "w": {"type": "number", "exclusiveMinimum": 0},
           "h": {"type": "number", "exclusiveMinimum": 0}, "auto_tidy": AUTO_TIDY}, ("name", "sql")), read_only=False)
def add_query_window(ctx, args):
    spec = {"type": "query", **{k: v for k, v in args.items() if k not in ("name", "auto_tidy")}}
    def mutate(canvas):
        ids = add_nodes_to(canvas, [spec])
        return f"added query window {ids[0]}" + _chart_notes(canvas, ids), ids
    return text(_edit(args["name"], mutate, args.get("auto_tidy", True)))


UPDATE_FIELDS = {"label": {"type": "string", "description": "shape, text, sticky and frame: the text shown on the node"}, "title": S, "sql": S,
                 "text": {"type": "string", "description": "note: the note body. shape, text, sticky and frame: an alias of label (label wins if both are given)"},
                 "table": S, "shape": {"type": "string", "enum": list(SHAPES)},
                 "collapsed": B, "z": {"type": "number"}, "chart": CHART, "view": VIEW,
                 "w": {"type": "number", "exclusiveMinimum": 0}, "h": {"type": "number", "exclusiveMinimum": 0}, "name": S, "columns": {"type": "array", "items": COLUMN},
                 "linked": {"type": ["string", "null"]}, "place": PLACE, "at": POINT, **STYLE_PROPS}


UPDATE_ITEMS = {"type": "array", "minItems": 1, "maxItems": 100, "items": {
    "type": "object", "required": ["id"], "additionalProperties": False,
    "properties": {"id": {"type": "string", "minLength": 1}, **UPDATE_FIELDS}}}


@tool("update_nodes", "Change fields of existing nodes: label, title, sql, text, colors, size, locked, collapsed, chart and view (query windows), or move one with place or at. A new title rewrites {{old}} references in other windows. Locked nodes need locked: false in the same update to change. Give the changes as updates (add_nodes calls its list nodes, and nodes is accepted here as an alias).",
      obj({"name": NAME, "updates": UPDATE_ITEMS,
           "nodes": {**UPDATE_ITEMS, "description": "alias of updates, the name add_nodes uses; give one of the two"},
           "auto_tidy": AUTO_TIDY}, ("name",)),
      read_only=False)
def update_nodes(ctx, args):
    if "updates" in args and "nodes" in args:
        raise ToolError("give updates or nodes (an alias), not both")
    items = args.get("updates", args.get("nodes"))
    if items is None:
        raise ToolError("update_nodes needs updates (a list of {id, ...}); nodes is accepted as an alias")

    def mutate(canvas):
        by_id = {w["id"]: w for w in canvas["windows"]}
        touched = []
        for u in items:
            n = by_id.get(u["id"])
            if n is None:
                raise ToolError(f"no node with id {u['id']!r}; ids: {', '.join(sorted(by_id)[:30])}")
            if n.get("locked") and u.get("locked") is not False:
                raise ToolError(f"node {u['id']} is locked; send locked: false to change it")
            _apply(canvas, n, u)
            touched.append(n["id"])
        return f"updated {', '.join(touched)}" + _chart_notes(canvas, touched), touched
    return text(_edit(args["name"], mutate, args.get("auto_tidy", True)))


def _chart_spec(chart) -> dict:
    """The Vega-Lite spec an agent gave, checked: an object with `mark` or `layer`. Raises ToolError."""
    if not isinstance(chart, dict) or not ("mark" in chart or "layer" in chart):
        raise ToolError("chart must be a Vega-Lite spec: an object with mark or layer, e.g. " + BAR_EXAMPLE)
    return chart


def _set_chart_and_view(node: dict, spec: dict) -> None:
    """Apply `chart` (null removes it) and `view` from a spec to a query window."""
    if "chart" in spec:
        if spec["chart"] is None:
            node.pop("chart", None)
        else:
            node["chart"] = {"vega_lite": _chart_spec(spec["chart"])}
    if "view" in spec:
        node["view"] = spec["view"]
    if node.get("view") == "chart" and "chart" not in node:
        raise ToolError(f"view chart needs a chart on {node['id']}: give chart too")


def _chart_fields(spec) -> set:
    """Field names a spec reads from its data, from the encodings of the spec and of its layers."""
    out: set = set()
    if isinstance(spec, dict):
        for ch in (spec.get("encoding") or {}).values():
            if isinstance(ch, dict) and isinstance(ch.get("field"), str):
                out.add(ch["field"].replace("\\", ""))
        for part in spec.get("layer") or []:
            out |= _chart_fields(part)
    return out


def _chart_notes(canvas: dict, ids) -> str:
    """A note for each chart that reads a field the window's saved result does not have (nothing when it has no result
    yet, or the spec computes fields with `transform`)."""
    notes = []
    for w in canvas["windows"]:
        spec = (w.get("chart") or {}).get("vega_lite")
        if w["id"] not in ids or not spec or not w.get("result") or "transform" in json.dumps(spec):
            continue
        have = {c["name"] for c in w["result"]["columns"]}
        missing = sorted(_chart_fields(spec) - have)
        if missing:
            notes.append(f"{w['id']}'s chart reads {', '.join(missing)}, not a column of its saved result (columns: {', '.join(sorted(have))})")
    return "; note: " + "; ".join(notes) if notes else ""


def _apply(canvas: dict, n: dict, u: dict) -> None:
    if ("chart" in u or "view" in u) and n.get("type") != "query":
        raise ToolError(f"chart and view belong to query windows; {n['id']} is a {n.get('type')}")
    if "chart" in u or "view" in u:
        _set_chart_and_view(n, u)
    for key in ("label", "sql", "text", "table", "shape", "collapsed", "z", "fill", "stroke", "font_size", "locked"):
        if key in u:
            n[key] = u[key]
    if n.get("type") in ("shape", "text", "sticky", "frame") and "text" in u:  # text is an alias of label on sketch nodes; label wins
        n.pop("text", None)
        if "label" not in u:
            n["label"] = u["text"]
    if "title" in u and u["title"] != n.get("title"):
        old = n.get("title")
        n["title"] = u["title"]
        if old:  # keep {{old}} references working
            pattern = re.compile(r"\{\{\s*" + re.escape(old) + r"\s*\}\}")
            for w in canvas["windows"]:
                if w.get("sql"):
                    w["sql"] = pattern.sub("{{" + u["title"] + "}}", w["sql"])
    if "w" in u or "h" in u:
        n["size"] = {"w": u.get("w", n["size"]["w"]), "h": u.get("h", n["size"]["h"])}
    ph = n.get("placeholder")
    if ph is not None:
        for src, dst in (("name", "name"), ("columns", "columns"), ("linked", "linked")):
            if src in u:
                ph[dst] = u[src]
    if "at" in u:
        n["position"] = {"x": u["at"]["x"], "y": u["at"]["y"]}
    if "place" in u:
        if "at" in u:
            raise ToolError("give place or at, not both")
        p = u["place"]
        out, _ = layout.arrange(canvas, [n["id"]], "place", relation=p["relation"], anchor=p["anchor"], gap=p.get("gap", 40),
                                align=p.get("align"))
        canvas["windows"][:] = out["windows"]
        canvas["edges"][:] = out["edges"]


@tool("remove_nodes", "Remove nodes (and the connectors attached to them) or connectors, by id.",
      obj({"name": NAME, "ids": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1}}}, ("name", "ids")),
      read_only=False, destructive=True)
def remove_nodes(ctx, args):
    def mutate(canvas):
        known = _ids(canvas)
        missing = [i for i in args["ids"] if i not in known]
        if missing:
            raise ToolError(f"no node or connector with id: {', '.join(missing)}")
        drop = set(args["ids"])
        canvas["windows"] = [w for w in canvas["windows"] if w["id"] not in drop]
        gone = {w["id"] for w in canvas["windows"]}
        kept = [e for e in canvas["edges"] if e["id"] not in drop and e["source"] in gone and e["target"] in gone]
        attached = sum(1 for e in canvas["edges"] if e["id"] not in drop) - len(kept)
        canvas["edges"] = kept
        canvas["links"] = [x for x in canvas.get("links", []) if x["from"] in gone and x["to"] in gone]
        return f"removed {', '.join(args['ids'])} and {attached} attached connector(s)", []
    return text(_edit(args["name"], mutate, False))


LINE = {"type": "string", "enum": ["straight", "step", "curve"]}
EDGE_PROPS = {"source": {"type": "string", "minLength": 1}, "target": {"type": "string", "minLength": 1}, "label": S, "line": LINE,
              "arrow_end": B, "arrow_start": B, "dashed": B, "color": S,
              "source_handle": {"type": "string", "enum": ["t", "r", "b", "l"]}, "target_handle": {"type": "string", "enum": ["t", "r", "b", "l"]}}


def add_connectors(canvas: dict, specs: list) -> list[str]:
    """Append a connector for each {source, target, ...} spec and return their ids. Raises ToolError for an unknown node.
    Sides default to right to left and are re-picked to face each other unless a spec names one."""
    nodes = {w["id"] for w in canvas["windows"]}
    made = []
    for s in specs:
        for end in ("source", "target"):
            if s[end] not in nodes:
                raise ToolError(f"{end} {s[end]!r} is not a node on this canvas; ids: {', '.join(sorted(nodes)[:30])}")
        edge = {"id": _next_id("c", _ids(canvas)), "source": s["source"], "target": s["target"],
                "source_handle": s.get("source_handle", "r"), "target_handle": s.get("target_handle", "l"),
                "line": s.get("line", "step"), "arrow_start": s.get("arrow_start", False), "arrow_end": s.get("arrow_end", True),
                "dashed": s.get("dashed", False)}
        for key in ("label", "color"):
            if key in s:
                edge[key] = s[key]
        canvas["edges"].append(edge)
        made.append(edge["id"])
    ends = sorted({e for s in specs for e in (s["source"], s["target"])})
    if not any("source_handle" in s or "target_handle" in s for s in specs):
        out, _ = layout.tidy(canvas, ids=ends, rules=["handles"])  # re-pick sides that face away
        canvas["edges"][:] = out["edges"]
    return made


@tool("connect", "Draw a connector from one node to another (source, target), or several at once with edges. Sides are picked to face each other.",
      obj({"name": NAME, **EDGE_PROPS, "edges": {"type": "array", "minItems": 1, "maxItems": 100, "items": {
          "type": "object", "required": ["source", "target"], "additionalProperties": False, "properties": EDGE_PROPS}}}, ("name",)),
      read_only=False)
def connect(ctx, args):
    single = {k: v for k, v in args.items() if k in EDGE_PROPS}
    if args.get("edges") and single:
        raise ToolError("give source and target, or edges, not both")
    specs = args.get("edges") or [single]
    if not all(s.get("source") and s.get("target") for s in specs):
        raise ToolError("connect needs source and target (or edges)")
    def mutate(canvas):
        made = add_connectors(canvas, specs)
        pairs = ", ".join(s["source"] + "->" + s["target"] for s in specs)
        return f"connected {pairs} as {', '.join(made)}", []
    return text(_edit(args["name"], mutate, False))


def _table_cards(canvas: dict, ids) -> dict[str, str]:
    """Table name (lower case) to the id of its first card, for the table cards of the canvas or just `ids`."""
    cards = [w for w in canvas["windows"] if w.get("type") == "table" and w.get("table")]
    if ids is not None:
        known = {w["id"]: w for w in canvas["windows"]}
        bad = [i for i in ids if i not in known or known[i].get("type") != "table" or not known[i].get("table")]
        if bad:
            raise ToolError(f"not table cards on this canvas: {', '.join(bad)}")
        cards = [known[i] for i in dict.fromkeys(ids)]
    out: dict[str, str] = {}
    for w in cards:
        out.setdefault(w["table"].lower(), w["id"])
    return out


def _known_specs(canvas: dict, plan: list, cards: dict[str, str]) -> tuple[list, int]:
    """Connector specs for the planned relationships whose two tables have a card, minus pairs already joined by a
    connector in either direction. Returns (specs, how many were already connected)."""
    joined = {frozenset((e["source"], e["target"])) for e in canvas.get("edges", [])}
    specs, existing = [], 0
    for p in plan:
        a, b = cards.get(p["source"].lower()), cards.get(p["target"].lower())
        if a is None or b is None:
            continue
        if frozenset((a, b)) in joined:
            existing += 1
            continue
        spec = {"source": a, "target": b, "arrow_end": p["directed"], "dashed": p["proposed"]}
        if p.get("bidir"):
            spec["arrow_start"] = True
        if p["label"]:
            spec["label"] = p["label"]
        specs.append(spec)
    return specs, existing


def known_connector_plan(ctx, tables, include_proposed: bool = False, include_lineage: bool = False) -> tuple[list, dict]:
    """The connectors for the relationships the app knows among `tables`: (plan, skipped).

    Foreign keys, mined joins and manual edges as relationships.connector_plan draws them, and with `include_lineage`
    lineage and view dependencies too (lineage.connector_plan: directed source to target, labeled `lineage` or `view`).
    A pair that has a key connector is not drawn twice for its lineage; `skipped["lineage_covered"]` counts those."""
    ex = ctx.need_explorer()
    memo: dict = {}

    def relations_of(t):
        if t not in memo:
            memo[t] = ex.relations(t)
        return memo[t]
    with ctx.store() as store:
        edges = relationships.known_edges_among(store, list(tables), relations_of, lambda t: dbx.cache_times(ex, t))
    plan, skipped = relationships.connector_plan(edges, include_proposed)
    skipped = {**skipped, "lineage_covered": 0}
    if include_lineage:
        keyed = {frozenset((p["source"].lower(), p["target"].lower())) for p in plan}
        for p in lineage_walk.among(relations_of, tables):
            if frozenset((p["source"].lower(), p["target"].lower())) in keyed:
                skipped["lineage_covered"] += 1
            else:
                plan.append(p)
    return plan, skipped


def connect_known_on(ctx, name: str, ids=None, include_proposed: bool = False, include_lineage: bool = False) -> dict:
    """Draw connectors between the table cards of canvas `name` for the relationships the app knows (Unity Catalog foreign
    keys, mined joins, manual ones, and with `include_lineage` lineage and view dependencies) and save it as an undoable
    agent edit. Returns {"added": [connector ids], "skipped": {...}, "message": the edit report}.
    Raises ToolError when nothing is connected or no card pair is related."""
    ctx.need_explorer()
    canvas = _load(name)
    cards = _table_cards(canvas, ids)
    if len(cards) < 2:
        raise ToolError("connect_known needs at least two table cards on the canvas (add them with add_nodes, type table)")
    names = [w["table"] for w in canvas["windows"] if w.get("type") == "table" and w["table"].lower() in cards]
    plan, skipped = known_connector_plan(ctx, names, include_proposed, include_lineage)
    specs, existing = _known_specs(canvas, plan, cards)
    notes = [f"{existing} already connected" if existing else "", f"{skipped['rejected']} rejected" if skipped["rejected"] else "",
             f"{skipped['proposed']} proposed (include_proposed: true draws them)" if skipped["proposed"] else "",
             f"{skipped['lineage_covered']} lineage pair(s) already drawn as a key connector" if skipped["lineage_covered"] else ""]
    tail = ("; skipped " + ", ".join(n for n in notes if n)) if any(notes) else ""
    if not specs:
        hint = "" if include_lineage else " (include_lineage: true also draws lineage and view dependencies)"
        return {"added": [], "skipped": {**skipped, "existing": existing},
                "message": f"no connectors added: no new known relationship between these {len(cards)} table cards{tail}{hint}. {_score_line(canvas)}"}
    made: list[str] = []

    def mutate(c):
        fresh, _ = _known_specs(c, plan, _table_cards(c, ids))
        made[:] = add_connectors(c, fresh)
        shown = "; ".join(f"{sp['source']}->{sp['target']}" + (f" ({sp['label']})" if sp.get("label") else "") for sp in fresh[:8])
        return f"connected {len(fresh)} known relationship(s): {shown}{tail}", []
    return {"added": made, "skipped": {**skipped, "existing": existing}, "message": _edit(name, mutate, False)}


@tool("connect_known", "Draw connectors between the table cards on a canvas for the relationships the app already knows: Unity Catalog foreign keys, mined joins and manual ones, labeled with the join columns (order_id + line_no for a composite key). Rejected ones are skipped, proposed ones only with include_proposed, and a pair that already has a connector is left alone. include_lineage also draws lineage and view dependencies, directed from the source table to the one built from it and labeled lineage or view. ids limits it to those table cards. Needs a connected profile (it reads the cached table metadata and the relationship store). Dashed connectors are proposed.",
      obj({"name": NAME, "ids": strings("table card ids; default every table card"), "include_proposed": {
          **B, "description": "also draw mined joins nobody has accepted yet (default false)"},
           "include_lineage": {**B, "description": "also draw lineage and view-dependency connectors between the cards (default false)"}}, ("name",)),
      read_only=False)
def connect_known(ctx, args):
    return text(connect_known_on(ctx, args["name"], args.get("ids"), args.get("include_proposed", False),
                                 args.get("include_lineage", False))["message"])


@tool("add_lineage", "Add table cards for every table reached by walking lineage and view dependencies from one table (the lineage tool shows the walk first), skip cards already on the canvas, connect them with lineage and view connectors (source to the table built from it) and lay them out left to right by hop. Cards the walk reaches that were already on the canvas are laid out with the new ones. One undoable edit. Needs a connected profile; reads cached lineage and fetches what was never expanded, at most 60 tables.",
      obj({"name": NAME, "table": {"type": "string", "minLength": 1, "description": "full name catalog.schema.table to start from"},
           "direction": {"type": "string", "enum": ["downstream", "upstream", "both"], "description": "default downstream"},
           "depth": integer(1, lineage_walk.MAX_DEPTH, "hops to follow, default 3")}, ("name", "table")), read_only=False)
def add_lineage(ctx, args):
    ex = ctx.need_explorer()
    _load(args["name"])  # a missing canvas fails before any Databricks call
    table = relationships.check_table(args["table"])
    if table.startswith("ph:"):
        raise ToolError("a placeholder has no lineage")
    memo: dict = {}

    def relations_of(t):
        if t not in memo:
            memo[t] = ex.relations(t)
        return memo[t]
    out = lineage_walk.walk(relations_of, table, args.get("direction", "downstream"), args.get("depth", 3))
    # connectors for every pair among the tables reached, so a pair is labeled as connect_known include_lineage labels it
    plan = lineage_walk.among(relations_of, [n["table"] for n in out["nodes"]])

    def mutate(canvas):
        have = _table_cards(canvas, None)
        fresh = [n["table"] for n in out["nodes"] if n["table"].lower() not in have]
        ids = add_nodes_to(canvas, [{"type": "table", "table": t} for t in fresh])
        have = _table_cards(canvas, None)
        specs, existing = _known_specs(canvas, plan, have)
        made = add_connectors(canvas, specs)
        walked = [have[n["table"].lower()] for n in out["nodes"]]
        laid, _ = layout.arrange(canvas, walked, "layered", direction="LR")
        canvas.clear()
        canvas.update(laid)
        notes = [f"{len(out['nodes']) - len(fresh)} already on the canvas" if len(fresh) < len(out["nodes"]) else "",
                 f"{existing} connector(s) already there" if existing else "",
                 f"stopped at {lineage_walk.NODE_CAP} tables" if out["truncated"] else "",
                 f"errors: {'; '.join(out['errors'])}" if out["errors"] else ""]
        tail = ("; " + ", ".join(n for n in notes if n)) if any(notes) else ""
        if len(out["nodes"]) == 1 and not plan:
            tail += "; no lineage or view dependencies found for it"
        return (f"added {len(ids)} table card(s) and {len(made)} lineage connector(s) for {table} ({out['direction']}, depth "
                f"{out['depth']}), laid out left to right by hop{tail}"), []
    return text(_edit(args["name"], mutate, False))


ARRANGE_OPTS = {"gap": {"type": "number", "minimum": 0}, "align": {"type": "string", "enum": ["start", "center", "end"]},
                "cols": {"type": "integer", "minimum": 1}, "direction": {"type": "string", "enum": ["LR", "TB"]},
                "layer_gap": {"type": "number", "minimum": 0}, "relation": {"type": "string", "enum": list(layout.PLACE_RELATIONS)},
                "anchor": S, "spacing": {"type": "number", "minimum": 0}}


@tool("arrange", "Lay out nodes from structure: grid, row, column, layered (connector graphs; direction LR or TB) or place (relation and anchor). ids defaults to every non-frame node. The subset's top-left corner stays put.",
      obj({"name": NAME, "mode": {"type": "string", "enum": list(layout.ARRANGE_MODES)}, "ids": strings(), **ARRANGE_OPTS,
           "grid": {"type": "number", "exclusiveMinimum": 0}}, ("name", "mode")), read_only=False)
def arrange(ctx, args):
    opts = {k: v for k, v in args.items() if k in ARRANGE_OPTS}
    def mutate(canvas):
        out, changes = layout.arrange(canvas, args.get("ids"), args["mode"], grid=args.get("grid"), **opts)
        canvas.clear()
        canvas.update(out)
        return f"arranged ({args['mode']}): {sum(1 for c in changes if c['kind'] == 'node')} node(s) moved, {sum(1 for c in changes if c['kind'] == 'edge')} connector(s) re-sided", []
    return text(_edit(args["name"], mutate, False))


@tool("tidy", "Fix a layout with the least movement: grow nodes to fit their labels, frames, overlaps, alignment, even spacing, grid, connector sides, connector label placement. ids limits what may move; rules picks a subset.",
      obj({"name": NAME, "ids": strings(), "rules": {"type": "array", "items": {"type": "string", "enum": list(layout.RULES)}},
           "grid": {"type": "number", "exclusiveMinimum": 0}}, ("name",)), read_only=False)
def tidy(ctx, args):
    def mutate(canvas):
        before = layout.doctor(canvas, args.get("grid"))["score"]
        out, changes = layout.tidy(canvas, args.get("ids"), args.get("rules"), args.get("grid"))
        canvas.clear()
        canvas.update(out)
        return f"tidied: {len(changes)} change(s), score {before} -> {layout.doctor(out, args.get('grid'))['score']}", []
    return text(_edit(args["name"], mutate, False))


@tool("doctor", "Score a canvas layout 0-100 and list what is wrong (overlaps, connectors through nodes, misalignment, ...), each with a fix when one exists. Read only.",
      obj({"name": NAME, "grid": {"type": "number", "exclusiveMinimum": 0}, "limit": integer(1, 100), "format": FORMAT}, ("name",)))
def doctor(ctx, args):
    d = layout.doctor(_load(args["name"]), args.get("grid"))
    if args.get("format") == "json":
        return text(json.dumps(d, separators=(",", ":")))
    limit = args.get("limit", 25)
    lines = [f"score {d['score']}/100; {len(d['issues'])} issue(s)"]
    for i in d["issues"][:limit]:
        fix = i["fix"]
        lines.append(f"{i['severity']} {i['kind']} {','.join(i['nodes'][:4])}: {i['message']}"
                     + (f" [fix: tidy rules={','.join(fix['rules'])} ids={','.join(fix['ids'][:4])}]" if fix else ""))
    if len(d["issues"]) > limit:
        lines.append(f"... {len(d['issues']) - limit} more")
    return text("\n".join(lines))


# ---------------------------------------------------------------- running windows

RUN_ROWS = 500  # default rows a window run fetches (the saved result keeps at most this many)
RUN_FIELDS = {"max_rows": integer(1, 1000, f"default {RUN_ROWS}; a window's saved result keeps at most {canvases.MAX_RESULT_ROWS} rows"),
              "timeout_s": integer(1, 300, "default 60, for each window")}


def _query_window(canvas: dict, wid: str) -> dict:
    win = next((w for w in canvas["windows"] if w["id"] == wid), None)
    if win is None:
        raise ToolError(f"no node with id {wid!r}; query windows: {', '.join(w['id'] for w in canvas['windows'] if w.get('type') == 'query') or 'none'}")
    if win.get("type") != "query":
        raise ToolError(f"{wid} is a {win.get('type')}, not a query window")
    return win


def _expanded(canvas: dict, win: dict) -> str:
    """The window's SQL with {{title}} references expanded the way the app expands them before a run."""
    titles = {w["title"]: w.get("sql", "") for w in canvas["windows"] if w.get("type") == "query"}
    try:
        return sqltools.expand_refs(win.get("sql", ""), titles)
    except ValueError as e:
        raise ToolError(f"cannot expand the {{{{title}}}} references in {win['id']}: {e}") from e


def _store_results(name: str, results: dict[str, dict], headline: str) -> tuple[str, int]:
    """Save snapshots into their windows as one agent write (revision bump, snapshot of the replaced file first)."""
    def mutate(canvas):
        by_id = {w["id"]: w for w in canvas["windows"]}
        kept = [i for i in results if i in by_id]
        for i in kept:
            by_id[i]["result"] = results[i]
        return headline, kept
    canvas, head, rev = _commit(name, mutate, False)
    return head, rev


def run_levels(windows: list[dict]) -> tuple[list[list[dict]], list[tuple[dict, str]]]:
    """Query windows with SQL grouped by dependency: each level holds windows whose {{title}} references are all in
    earlier levels, in canvas order. Returns (levels, skipped), where skipped is (window, reason) for windows with no SQL
    and for reference cycles (and whatever waits on one)."""
    skipped = [(w, "no SQL") for w in windows if w.get("type") == "query" and not w.get("sql", "").strip()]
    todo = [w for w in windows if w.get("type") == "query" and w.get("sql", "").strip()]
    by_title = {w["title"]: w for w in todo}
    needs = {}
    for w in todo:
        try:
            needs[w["id"]] = {by_title[t]["id"] for t in sqltools.window_refs(w["sql"]) if t in by_title}
        except ValueError:
            needs[w["id"]] = set()  # a malformed reference: the run reports it when it expands
    levels, done = [], set()
    while True:
        level = [w for w in todo if w["id"] not in done and needs[w["id"]] <= done]
        if not level:
            break
        levels.append(level)
        done |= {w["id"] for w in level}
    skipped += [(w, "reference cycle") for w in todo if w["id"] not in done]
    return levels, skipped


@tool("run_window", "Run a query window's SQL on the SQL warehouse and save the result in the window, so a reader of the canvas sees it without pressing Run. {{title}} references are expanded as in the app, and the statement goes through the same read-only gate as run_sql (one SELECT, DESCRIBE, SHOW or EXPLAIN; anything else is rejected before the warehouse). The result (at most 500 rows) is stored as an agent write that undo_canvas reverts. Returns the rows like run_sql.",
      obj({"name": NAME, "id": {"type": "string", "minLength": 1, "description": "id of a query window"}, **RUN_FIELDS}, ("name", "id")), read_only=False)
def run_window(ctx, args):
    canvas = _load(args["name"])
    win = _query_window(canvas, args["id"])
    sql = _expanded(canvas, win)
    max_rows, timeout = args.get("max_rows", RUN_ROWS), args.get("timeout_s", 60)
    sid = tools_data.submit_read_only(ctx, sql, max_rows)  # the gate: a non-SELECT is rejected here, nothing is written
    st = tools_data.await_statement(ctx.need_explorer(), sid, time.time() + timeout, timeout)
    snap = canvases.result_snapshot(st, sqltools.sql_hash(sql))
    _, rev = _store_results(args["name"], {win["id"]: snap}, f"saved the result of {win['id']}")
    kept = f"{len(snap['rows'])} of {snap['row_count']} rows" if len(snap["rows"]) < snap["row_count"] else f"{snap['row_count']} rows"
    return text(tools_data.tsv(st, max_rows) + f"\nsaved in {win['id']} ({kept}). revision {rev}; undo_canvas reverts it.")


@tool("run_all_windows", "Run every query window of a canvas on the SQL warehouse and save each result in its window. A window that references another through {{title}} runs after it (windows with no dependency between them run together). Each statement goes through the same read-only gate as run_sql. Reports one line per window; a window that fails or is rejected does not stop the others. All the results are saved in one agent write that undo_canvas reverts.",
      obj({"name": NAME, **RUN_FIELDS}, ("name",)), read_only=False)
def run_all_windows(ctx, args):
    e = ctx.need_explorer()
    if not e.warehouse_id:
        raise ToolError("No SQL warehouse is selected: pick one in the app first.")
    canvas = _load(args["name"])
    levels, skipped = run_levels(canvas["windows"])
    if not levels:
        why = ", ".join(w["id"] + " " + reason for w, reason in skipped)
        raise ToolError("no query window with SQL to run" + (f" ({why})" if why else ""))
    max_rows, timeout = args.get("max_rows", RUN_ROWS), args.get("timeout_s", 60)
    lines: dict[str, str] = {}
    saved: dict[str, dict] = {}
    for level in levels:
        pending = []
        for w in level:  # submit the whole level first, so its windows run on the warehouse together
            try:
                sql = _expanded(canvas, w)
                pending.append((w, sql, tools_data.submit_read_only(ctx, sql, max_rows), time.time() + timeout))
            except ToolError as err:
                lines[w["id"]] = f"{w['id']} {w['title']}: not run: {err}"
        for w, sql, sid, deadline in pending:
            try:
                st = tools_data.await_statement(e, sid, deadline, timeout)
            except ToolError as err:
                lines[w["id"]] = f"{w['id']} {w['title']}: failed: {err}"
                continue
            saved[w["id"]] = canvases.result_snapshot(st, sqltools.sql_hash(sql))
            r = saved[w["id"]]
            lines[w["id"]] = f"{w['id']} {w['title']}: ok, {r['row_count']} rows" + (f" ({len(r['rows'])} saved)" if len(r["rows"]) < r["row_count"] else "") + f", {st.get('ms')} ms"
    ordered = [lines[w["id"]] for level in levels for w in level] + [f"{w['id']} {w['title']}: skipped ({why})" for w, why in skipped]
    if saved:
        _, rev = _store_results(args["name"], saved, f"saved {len(saved)} results")
        tail = f"saved {len(saved)} of {len(lines)} results. revision {rev}; undo_canvas reverts them all."
    else:
        tail = "nothing saved."
    return text("\n".join([*ordered, tail]))


@tool("render_canvas", "A PNG of the canvas as a reader sees it: shapes, stickies, text and frames with their labels (wrapped to the node, at its font_size), notes with their text (Markdown markers removed), query windows with the title, the first lines of the SQL and the first rows of the saved result as a small table (or chart: <mark>, N rows when the window opens on its chart), table cards with the table name, placeholder tables with their columns, and connectors with arrows and labels. Each node has its id as a small tag. Text scales with the picture, so use a larger width to read a big canvas. highlight outlines node ids, or \"issues\".",
      obj({"name": NAME, "width": integer(200, 2000), "highlight": {"anyOf": [strings(), S]}}, ("name",)))
def render_canvas(ctx, args):
    canvas = _load(args["name"])
    hi = args.get("highlight")
    if hi == "issues":
        hi = sorted({n for i in layout.doctor(canvas)["issues"] if i["severity"] != "info" for n in i["nodes"]}, key=str)
    elif hi is not None and not isinstance(hi, list):
        raise ToolError('highlight must be a list of ids or "issues"')
    png = layout.render_png(canvas, args.get("width", 1000), hi)
    return [{"type": "image", "data": base64.b64encode(png).decode("ascii"), "mimeType": "image/png"},
            {"type": "text", "text": f"{args['name']}: {len(canvas['windows'])} nodes, {len(canvas.get('edges', []))} connectors; {_score_line(canvas)}"}]


@tool("undo_canvas", "Undo the last agent change to a canvas (up to 20 are kept). Calling it again goes one change further back.",
      obj({"name": NAME}, ("name",)), read_only=False, destructive=True)
def undo_canvas(ctx, args):
    out = canvases.undo_canvas(args["name"])
    return text(f"undone. revision {out['revision']}; {out['snapshots']} earlier agent change(s) can still be undone.\n"
                + layout.describe(_load(args["name"]), max_lines=EXCERPT_LINES))
