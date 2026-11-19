"""The graph tools: read the diagrams saved from the Graph tab. They never touch the workspace."""
import json

from .. import graphs

from .tooling import ToolError, obj, strings, text, tool

NAME = {"type": "string", "minLength": 1, "description": "graph name, as typed (Returns graph) or as stored (Returns_graph)"}


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
