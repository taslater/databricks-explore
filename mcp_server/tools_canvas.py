"""The canvas tools: read, add and change nodes and connectors, lay them out, render. Every write is saved and undoable."""
import base64
import copy
import json
import re
import uuid

import canvases
import layout

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
AUTO_TIDY = {"type": "boolean", "description": "default true: after the edit, push apart any overlapping nodes among those just touched"}
NAME = {"type": "string", "minLength": 1, "description": "canvas name (letters, digits, _ . -)"}
POINT = {"type": "object", "required": ["x", "y"], "additionalProperties": False, "properties": {"x": {"type": "number"}, "y": {"type": "number"}}}
PLACE = {"type": "object", "required": ["relation", "anchor"], "additionalProperties": False,
         "description": "structural placement (preferred over at): next to or inside an existing node, with a gap",
         "properties": {"relation": {"type": "string", "enum": list(layout.PLACE_RELATIONS)},
                        "anchor": {"type": "string", "minLength": 1, "description": "id of an existing node (or one earlier in this call)"},
                        "gap": {"type": "number", "minimum": 0}}}
COLUMN = {"type": "object", "required": ["name"], "additionalProperties": False,
          "properties": {"name": S, "type": S, "key": {"type": "string", "enum": ["pk", "fk"]}}}
STYLE_PROPS = {"fill": {"type": "string", "description": "CSS color"}, "stroke": {"type": "string", "description": "CSS color"},
               "font_size": {"type": "number", "exclusiveMinimum": 0}, "locked": B}
NODE = {"type": "object", "required": ["type"], "additionalProperties": False,
        "description": "type shape (set shape), text, sticky, frame, placeholder (table that does not exist yet), query (sql), note (text) or table (table = catalog.schema.table). Place it with place (preferred) or at; with neither it goes below the existing content.",
        "properties": {"type": {"type": "string", "enum": list(NODE_TYPES)}, "id": {"type": "string", "minLength": 1},
                       "label": S, "title": {"type": "string", "description": "query, note and table windows: unique, used as {{title}} in SQL"},
                       "shape": {"type": "string", "enum": list(SHAPES)}, "sql": S, "text": S, "table": S,
                       "name": {"type": "string", "description": "placeholder: the table name"}, "columns": {"type": "array", "items": COLUMN},
                       "w": {"type": "number", "exclusiveMinimum": 0}, "h": {"type": "number", "exclusiveMinimum": 0},
                       "place": PLACE, "at": POINT, **STYLE_PROPS}}


# ---------------------------------------------------------------- reading

def _load(name: str) -> dict:
    return canvases.load_canvas(name)


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
    return _report(canvas, headline + (f"; moved {moved} to clear overlaps" if moved else ""), rev)


def _ids(canvas: dict) -> set:
    return {w["id"] for w in canvas["windows"]} | {e["id"] for e in canvas.get("edges", [])}


def _next_id(prefix: str, used: set) -> str:
    n = 1 + max([int(m.group(1)) for i in used if (m := re.fullmatch(prefix + r"(\d+)", i))] or [0])
    return f"{prefix}{n}"


@tool("list_canvases", "List saved canvases with their node and connector counts and revision.", obj())
def list_canvases(ctx, args):
    names = canvases.list_canvases()
    lines = [f"{len(names)} canvas(es)"]
    for n in names:
        try:
            c = _load(n)
            info = canvases.revision_info(n)
            lines.append(f"{n}: {len(c['windows'])} nodes, {len(c.get('edges', []))} connectors, revision {info['revision']}")
        except (canvases.CanvasInvalid, canvases.CanvasNotFound) as e:
            lines.append(f"{n}: unreadable ({e})")
    return text("\n".join(lines))


@tool("get_canvas", "Read a canvas. describe (default) is a compact text summary: frames, a map, connectors, issues. json is the whole file.",
      obj({"name": NAME, "format": {"type": "string", "enum": ["describe", "json"]}, "max_lines": integer(10, 300)}, ("name",)))
def get_canvas(ctx, args):
    c = _load(args["name"])
    if args.get("format") == "json":
        return text(json.dumps(c, separators=(",", ":")))
    return text(layout.describe(c, max_lines=args.get("max_lines", 60)))


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
    if kind == "shape":
        node.update(shape=shape, label=spec.get("label", ""))
    elif kind in ("text", "sticky", "frame"):
        node["label"] = spec.get("label", "Group" if kind == "frame" else "")
    elif kind == "placeholder":
        cols = spec.get("columns") or [{"name": "id", "type": "bigint", "key": "pk"}]
        node["placeholder"] = {"id": str(uuid.uuid4()), "name": spec.get("name") or spec.get("label") or "new_table", "columns": cols}
        if "h" not in spec:
            node["size"]["h"] = max(h, 40 + 24 * len(cols))
    elif kind == "query":
        if "sql" not in spec:
            raise ToolError("a query node needs sql")
        node.update(title=_title(canvas, spec.get("title") or "query"), sql=spec["sql"], collapsed=False, editor_split=30)
    elif kind == "note":
        node.update(title=_title(canvas, spec.get("title") or "note"), text=spec.get("text", ""), collapsed=False)
    else:  # table
        if not spec.get("table"):
            raise ToolError("a table node needs table (catalog.schema.table)")
        base = re.sub(r"[{}]", "", spec["table"].split(".")[-1]).strip() or "table"
        node.update(title=_title(canvas, spec.get("title") or base), table=spec["table"], collapsed=False)
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
                                gap=place.get("gap", 40))
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
        return f"added {', '.join(ids)}", ids
    return text(_edit(args["name"], mutate, args.get("auto_tidy", True)))


@tool("add_query_window", "Add a SQL query window to a canvas (it is not run). Use {{title}} in another window's SQL to reference it. Prefer structural placement.",
      obj({"name": NAME, "sql": S, "title": S, "place": PLACE, "at": POINT, "w": {"type": "number", "exclusiveMinimum": 0},
           "h": {"type": "number", "exclusiveMinimum": 0}, "auto_tidy": AUTO_TIDY}, ("name", "sql")), read_only=False)
def add_query_window(ctx, args):
    spec = {"type": "query", **{k: v for k, v in args.items() if k not in ("name", "auto_tidy")}}
    def mutate(canvas):
        ids = add_nodes_to(canvas, [spec])
        return f"added query window {ids[0]}", ids
    return text(_edit(args["name"], mutate, args.get("auto_tidy", True)))


UPDATE_FIELDS = {"label": S, "title": S, "sql": S, "text": S, "table": S, "shape": {"type": "string", "enum": list(SHAPES)},
                 "collapsed": B, "z": {"type": "number"}, "w": {"type": "number", "exclusiveMinimum": 0},
                 "h": {"type": "number", "exclusiveMinimum": 0}, "name": S, "columns": {"type": "array", "items": COLUMN},
                 "linked": {"type": ["string", "null"]}, "place": PLACE, "at": POINT, **STYLE_PROPS}


@tool("update_nodes", "Change fields of existing nodes: label, title, sql, text, colors, size, locked, collapsed, or move one with place or at. A new title rewrites {{old}} references in other windows. Locked nodes need locked: false in the same update to change.",
      obj({"name": NAME, "updates": {"type": "array", "minItems": 1, "maxItems": 100, "items": {
          "type": "object", "required": ["id"], "additionalProperties": False,
          "properties": {"id": {"type": "string", "minLength": 1}, **UPDATE_FIELDS}}}, "auto_tidy": AUTO_TIDY}, ("name", "updates")),
      read_only=False)
def update_nodes(ctx, args):
    def mutate(canvas):
        by_id = {w["id"]: w for w in canvas["windows"]}
        touched = []
        for u in args["updates"]:
            n = by_id.get(u["id"])
            if n is None:
                raise ToolError(f"no node with id {u['id']!r}; ids: {', '.join(sorted(by_id)[:30])}")
            if n.get("locked") and u.get("locked") is not False:
                raise ToolError(f"node {u['id']} is locked; send locked: false to change it")
            _apply(canvas, n, u)
            touched.append(n["id"])
        return f"updated {', '.join(touched)}", touched
    return text(_edit(args["name"], mutate, args.get("auto_tidy", True)))


def _apply(canvas: dict, n: dict, u: dict) -> None:
    for key in ("label", "sql", "text", "table", "shape", "collapsed", "z", "fill", "stroke", "font_size", "locked"):
        if key in u:
            n[key] = u[key]
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
        out, _ = layout.arrange(canvas, [n["id"]], "place", relation=p["relation"], anchor=p["anchor"], gap=p.get("gap", 40))
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
        pairs = ", ".join(s["source"] + "->" + s["target"] for s in specs)
        return f"connected {pairs} as {', '.join(made)}", []
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


@tool("tidy", "Fix a layout with the least movement: frames, overlaps, alignment, even spacing, grid, connector sides. ids limits what may move; rules picks a subset.",
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


@tool("render_canvas", "A schematic PNG of the canvas (boxes by type with ids and labels, connectors with arrows) for judging layout. highlight outlines node ids, or \"issues\".",
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
