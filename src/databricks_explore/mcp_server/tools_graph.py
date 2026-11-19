"""The graph tools: read, create, change, rename and delete the diagrams saved from the Graph tab. They never touch the workspace."""
import json

from .. import dbx
from .. import graphs
from .. import relationships

from .tooling import B, ToolError, integer, obj, strings, text, tool

MAX_TABLES = 60
GRAPH_KINDS = ("fk", "view_dep", "lineage", "join_mined", "manual", "sketch")  # what the Graph draws between two tables
SHOWN = ("derived", "accepted")  # the Graph's default filters hide rejected edges; proposed joins wait for a review
NAME = {"type": "string", "minLength": 1, "description": "graph name, as typed (Returns graph) or as stored (Returns_graph)"}
TABLES = strings("full table names, catalog.schema.table")


def _run(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except (graphs.GraphInvalid, graphs.GraphNotFound) as e:
        raise ToolError(str(e)) from e
    except graphs.GraphConflict as e:
        raise ToolError(str(e)) from e


def _nodes_of(data: dict) -> list[dict]:
    return [n["data"] for n in data.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("data"), dict) and n["data"].get("id")]


def _edges_of(data: dict) -> list[dict]:
    return [e["data"] for e in data.get("edges") or [] if isinstance(e, dict) and isinstance(e.get("data"), dict)]


def _kinds_line(edges: list[dict]) -> str:
    counts: dict[str, int] = {}
    for e in edges:
        counts[e.get("kind", "?")] = counts.get(e.get("kind", "?"), 0) + 1
    return ", ".join(f"{k} {n}" for k, n in sorted(counts.items()))


# ---------------------------------------------------------------- reading

@tool("list_graphs", "List the graphs saved from the Graph tab (separate from canvases, see list_canvases) with their table and edge counts, revision and saved time.", obj())
def list_graphs(ctx, args):
    names = graphs.list_graphs()
    lines = [f"{len(names)} graph(s)"]
    for n in names:
        try:
            data = graphs.load_graph(n)
            s, info = graphs.summary(data), graphs.revision_info(n)
            shown = data.get("name")
            lines.append(f"{n}: {s['nodes']} tables, {s['edges']} edges, revision {info['revision']}"
                         + (f" ({info['by']})" if info["by"] else "") + f", saved {s['saved_at']}"
                         + (f", named {shown!r}" if shown and shown != n else ""))
        except (graphs.GraphInvalid, graphs.GraphNotFound) as e:
            lines.append(f"{n}: unreadable ({e})")
    if not names:
        lines.append("Saved Graph diagrams are listed here. Canvases are a separate store: list_canvases. create_graph makes one.")
    return text("\n".join(lines))


@tool("get_graph", "Read a graph saved from the Graph tab: its tables (kind, focus) and edges (kind, source, target, status, join columns). The name may be typed (Returns graph) or stored (Returns_graph). json gives every field, with positions.",
      obj({"name": NAME, "format": {"type": "string", "enum": ["text", "json"], "description": "text (default, compact) or json"}}, ("name",)))
def get_graph(ctx, args):
    data = _run(graphs.load_graph, args["name"])
    info = _run(graphs.revision_info, args["name"])
    nodes, edges = _nodes_of(data), _edges_of(data)
    pos = {n["data"]["id"]: n.get("position") for n in data.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("data"), dict)}
    if args.get("format") == "json":
        return text(json.dumps({
            "name": info["name"], "title": data.get("name"), "revision": info["revision"], "by": info["by"], "saved_at": data.get("saved_at"),
            "focus_schema": data.get("focus_schema"),
            "nodes": [{"table": n["id"], "kind": n.get("kind", "table"), **({"focus": True} if n.get("focus") else {}),
                       **({"pinned": True} if n.get("pinned") else {}), "x": (pos.get(n["id"]) or {}).get("x"), "y": (pos.get(n["id"]) or {}).get("y")}
                      for n in nodes],
            "edges": [{k: v for k, v in {"id": e.get("id"), "kind": e.get("kind"), "source": e.get("source"), "target": e.get("target"),
                                         "status": e.get("status"), "directed": e.get("directed"), "bidir": e.get("bidir") or None,
                                         "columns": e.get("child_columns"), "parent_columns": e.get("parent_columns"),
                                         "note": e.get("note") or None}.items() if v is not None} for e in edges]},
            separators=(",", ":")))
    head = (f"{info['name']}: {len(nodes)} tables, {len(edges)} edges, revision {info['revision']}" + (f" ({info['by']})" if info["by"] else "")
            + f", saved {data.get('saved_at')}")
    lines = [head, f"focus schema: {data.get('focus_schema') or 'none'}. Graph filters are not saved with a graph: the page's defaults apply on load.", "Tables:"]
    for n in nodes:
        lines.append(f"  {n['id']} [{n.get('kind', 'table')}]" + (" focus" if n.get("focus") else "") + (" pinned" if n.get("pinned") else ""))
    lines.append("Edges:" if edges else "Edges: none")
    for e in edges:
        arrow = "<->" if e.get("bidir") else ("->" if e.get("directed", True) else "--")
        keys = e.get("label") or ""
        lines.append(f"  {e.get('source')} {arrow} {e.get('target')}  {e.get('kind')} {e.get('status') or ''}".rstrip() + (f" ({keys})" if keys else "")
                     + (f" note: {e['note']}" if e.get("note") else ""))
    return text("\n".join(lines))


# ---------------------------------------------------------------- building from tables

def _norm_tables(tables: list, what: str = "tables") -> list[str]:
    out: dict[str, str] = {}
    for t in tables:
        try:
            name = relationships.check_table(t)
        except relationships.RelationshipInvalid as e:
            raise ToolError(f"{what}: {t!r}: {e}") from e
        if name.startswith("ph:"):
            raise ToolError(f"{what}: {t!r} is a placeholder; a graph holds Unity Catalog tables")
        out.setdefault(name.lower(), name)
    return list(out.values())


def derive(ctx, tables: list[str]) -> tuple[list[dict], dict[str, dict], list[str]]:
    """What the Graph tab would draw for exactly these tables: (graph edges, node facts by table, notes).

    The edges are the relationships the app knows with both ends in the set (foreign keys, view dependencies, lineage,
    and joins that are accepted or manual), read as the Graph reads them (relationships.unified). Rejected and proposed
    edges are left out, a lineage edge is left out where the pair has a view dependency, and so is one into a view
    that no longer reads its source. Raises ToolError for a table that cannot be read."""
    ex = ctx.need_explorer()
    memo: dict = {}

    def relations_of(t):
        if t not in memo:
            memo[t] = ex.relations(t)
        return memo[t]
    unreadable = [t for t in tables if any(str(e).startswith("tables.get:") for e in relations_of(t).get("errors", []))]
    if unreadable:
        raise ToolError("cannot read " + ", ".join(unreadable) + " (not found, or no access): " + "; ".join(
            f"{t}: {next(e for e in relations_of(t)['errors'] if str(e).startswith('tables.get:'))}" for t in unreadable[:3]))
    wanted = {t.lower(): t for t in tables}
    found: dict[str, dict] = {}
    with ctx.store() as store:
        for t in tables:
            out = relationships.unified(store, t, relations_of(t), dbx.cache_times(ex, t), "table")
            for e in out["edges"]:
                a, b = e["source"]["table"].lower(), e["target"]["table"].lower()
                if e["kind"] in GRAPH_KINDS and e["status"] in SHOWN and a != b and a in wanted and b in wanted:
                    e["source"]["table"], e["target"]["table"] = wanted[a], wanted[b]
                    found.setdefault(e["id"], e)
    rels, notes = list(found.values()), []
    views = {t: {e["source"].lower() for e in relations_of(t).get("edges", []) if e["kind"] == "view_dep" and e["target"].lower() == t.lower()}
             for t in tables}
    pairs_with_view = {frozenset((e["source"]["table"].lower(), e["target"]["table"].lower())) for e in rels if e["kind"] == "view_dep"}
    kept, dropped = [], 0
    for e in rels:
        s, t = e["source"]["table"], e["target"]["table"]
        if e["kind"] == "lineage" and (frozenset((s.lower(), t.lower())) in pairs_with_view or (views.get(t) and s.lower() not in views[t])):
            dropped += 1
            continue
        kept.append(e)
    if dropped:
        notes.append(f"{dropped} lineage edge(s) left out: the pair is a view dependency, or the view no longer reads that source")
    facts = {}
    for t in tables:
        node = next((n for n in relations_of(t).get("nodes", []) if n["id"] == t), {})
        facts[t] = {"id": t, "kind": node.get("kind", "table"), "self_ref": node.get("self_ref"), "self_ref_last_seen": node.get("self_ref_last_seen")}
    return graphs.graph_edges(kept), facts, notes


def _lonely(tables: list[str], edges: list[dict]) -> list[str]:
    linked = {e["source"] for e in edges} | {e["target"] for e in edges}
    return [t for t in tables if t not in linked]


def _result(verb: str, stem: str, rev: int, tables: list[str], edges: list[dict], notes: list[str]) -> str:
    kinds = _kinds_line(edges)
    lonely = _lonely(tables, edges) if len(tables) > 1 else []
    tail = [f"{len(lonely)} table(s) have no known relationship to the others: " + ", ".join(lonely)] if lonely else []
    return (f"{verb} graph {stem}: {len(tables)} tables, {len(edges)} edges" + (f" ({kinds})" if kinds else "") + f". revision {rev}. "
            + " ".join([*notes, *tail]) + " Open it from the Graph tab's saved diagrams; get_graph reads it back.").replace("  ", " ")


@tool("create_graph", "Save a new graph from tables: a node for each table and an edge for each relationship the app knows between them (foreign keys, view dependencies, lineage, accepted or manual joins; rejected and proposed ones are left out, as in the Graph tab), laid out left to right. You name tables, not edges or positions. Fails if the name is taken. Needs a connected profile. Use the lineage tool to find a path's tables first.",
      obj({"name": {**NAME, "description": "graph name (letters, digits, _ . - ; other characters become _)"}, "tables": {**TABLES, "minItems": 1, "maxItems": MAX_TABLES},
           "focus": {"type": "string", "description": "one of the tables: the focus (the Graph's starting object); its schema is the focus schema"}}, ("name", "tables")), read_only=False)
def create_graph(ctx, args):
    ctx.need_explorer()
    stem = _run(graphs.stem_of, args["name"])
    if graphs.exists(stem) or any(s.lower() == stem.lower() for s in graphs.list_graphs()):
        raise ToolError(f"graph {stem!r} already exists; use update_graph to change it")
    tables = _norm_tables(args["tables"])
    if len(tables) > MAX_TABLES:
        raise ToolError(f"at most {MAX_TABLES} tables in one graph")
    focus = None
    if args.get("focus"):
        focus = next((t for t in tables if t.lower() == args["focus"].lower()), None)
        if focus is None:
            raise ToolError(f"focus {args['focus']!r} is not one of the tables")
    edges, facts, notes = derive(ctx, tables)
    nodes = [{**facts[t], "focus": t == focus} for t in tables]
    body = graphs.build_body(args["name"].strip(), nodes, edges)
    with graphs.LOCK:
        stem, rev = _run(graphs.write_graph, body, "agent", None, True)
    return text(_result("created", stem, rev, tables, edges, notes))


@tool("update_graph", "Add or remove tables on a saved graph. Edges are derived again for the new set of tables, as in create_graph. Tables already on the graph keep their positions unless relayout is true; added tables are placed clear of them. Needs a connected profile.",
      obj({"name": NAME, "add": {**TABLES, "description": "tables to add"}, "remove": {**TABLES, "description": "tables to remove (with their edges)"},
           "relayout": {**B, "description": "lay every table out again (default false)"}}, ("name",)), read_only=False)
def update_graph(ctx, args):
    ctx.need_explorer()
    add, remove = args.get("add") or [], args.get("remove") or []
    if not add and not remove and not args.get("relayout"):
        raise ToolError("nothing to do: give add, remove or relayout")
    with graphs.LOCK:
        data = _run(graphs.load_graph, args["name"])
        stem = _run(graphs.resolve, args["name"])
        old = _nodes_of(data)
        have = {n["id"].lower(): n["id"] for n in old}
        gone = _norm_tables(remove, "remove")
        missing = [t for t in gone if t.lower() not in have]
        if missing:
            raise ToolError("not on the graph: " + ", ".join(missing))
        new = [t for t in _norm_tables(add, "add") if t.lower() not in have]
        drop = {t.lower() for t in gone}
        tables = [n["id"] for n in old if n["id"].lower() not in drop] + [t for t in new if t.lower() not in drop]
        if not tables:
            raise ToolError("that would leave the graph empty; use delete_graph to remove it")
        if len(tables) > MAX_TABLES:
            raise ToolError(f"at most {MAX_TABLES} tables in one graph")
        edges, facts, notes = derive(ctx, tables)
        focus = {n["id"] for n in old if n.get("focus")}
        nodes = [{**facts[t], "focus": t in focus} for t in tables]
        body = graphs.build_body(data.get("name") or stem, nodes, edges, previous=data, relayout=bool(args.get("relayout")))
        stem, rev = _run(graphs.write_graph, body, "agent")
    changes = [f"added {len(new)}" if new else "", f"removed {len(gone)}" if gone else "", "laid out again" if args.get("relayout") else ""]
    return text(_result("updated", stem, rev, tables, edges, [", ".join(c for c in changes if c) + ".", *notes]))


@tool("rename_graph", "Rename a saved graph. Fails if the new name is taken. The name may be typed or as stored.",
      obj({"name": NAME, "new_name": {"type": "string", "minLength": 1, "description": "the new name (other characters than letters, digits, _ . - become _)"}}, ("name", "new_name")), read_only=False)
def rename_graph(ctx, args):
    stem, rev = _run(graphs.rename_graph, args["name"], args["new_name"], "agent")
    return text(f"renamed graph {args['name']} to {stem}. revision {rev}.")


@tool("delete_graph", "Delete a saved graph. A copy is kept in the diagrams/.trash folder of the data folder, so the person can restore it by hand. The name may be typed or as stored.",
      obj({"name": NAME}, ("name",)), read_only=False, destructive=True)
def delete_graph(ctx, args):
    stem = _run(graphs.resolve, args["name"])
    kept = _run(graphs.delete_graph, args["name"])
    return text(f"deleted graph {stem}. A copy is in diagrams/.trash/{kept}.")
