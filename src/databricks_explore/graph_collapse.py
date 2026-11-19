"""Collapsed groups and elided chains of a saved graph, as the Graph tab works them out (web/src/graph/collapse.ts keeps the same rules).

A group is the tables of one schema (or one tag value). It starts collapsed when it holds more than MAX_OPEN tables and neither
the focus nor a pinned table. A chain is views and materialized views with one flow edge in and one out and nothing else, drawn as
one edge. The Graph's filters are not saved with a graph, so this reads the page's defaults: flow and reference edges, none that
were superseded or rejected. Pure: no Flask, no Databricks calls."""
from typing import Optional

from .edge_families import family_of

MAX_OPEN = 8
VIEW_KINDS = ("view", "materialized_view")


def default_grouping() -> dict:
    """What a graph that saved no grouping uses: by schema, chains on, no group chosen by hand."""
    return {"by": "schema", "collapsed": [], "expanded": [], "chains": True}


def grouping_of(data: dict) -> dict:
    """The saved `grouping` of a diagram with its defaults filled in."""
    saved = data.get("grouping") if isinstance(data.get("grouping"), dict) else {}
    return {**default_grouping(), **{k: v for k, v in saved.items() if k in ("by", "collapsed", "expanded", "chains")}}


def check_grouping(value) -> dict:
    """The `grouping` of a diagram: {by?: schema | none | tag:<key>, collapsed?: [keys], expanded?: [keys], chains?: bool}. GraphInvalid is raised by the caller's wrapper."""
    if not isinstance(value, dict):
        raise ValueError("grouping: must be an object")
    for key in value:
        if key not in ("by", "collapsed", "expanded", "chains"):
            raise ValueError(f"grouping: unknown field {key!r}")
    by = value.get("by", "schema")
    if not (by in ("schema", "none") or (isinstance(by, str) and by.startswith("tag:") and 0 < len(by[4:].strip()) <= 200)):
        raise ValueError(f"grouping.by: expected schema, none or tag:<key>, got {by!r}")
    for key in ("collapsed", "expanded"):
        if key in value and not (isinstance(value[key], list) and all(isinstance(k, str) for k in value[key])):
            raise ValueError(f"grouping.{key}: must be a list of group names")
    if "chains" in value and not isinstance(value["chains"], bool):
        raise ValueError("grouping.chains: must be true or false")
    return value


def _shown(e: dict) -> bool:
    return family_of(e.get("kind")) in ("flow", "reference") and e.get("status") not in ("superseded", "rejected")


def _label(key: str, by: str, all_keys: list[str]) -> str:
    short = key.rsplit(".", 1)[-1] if by == "schema" else key
    clash = sum(1 for k in all_keys if (k.rsplit(".", 1)[-1] if by == "schema" else k) == short) > 1
    return key if clash else short


def plan(nodes: list[dict], edges: list[dict], grouping: Optional[dict] = None, tags: Optional[dict] = None) -> dict:
    """Twin of collapseGraph in web/src/graph/collapse.ts (tests/test_parity.py). {"by", "chains_on", "groups": [{key, label, tables, count, collapsed, default_collapsed}], "chains": [{id, source, target, views, edges}]}.

    `nodes` are the saved node data ({id, kind, focus?, pinned?}), `edges` the saved edge data. `tags` is {table: tag value} for a tag grouping
    (tables without one are in no group)."""
    g = {**default_grouping(), **(grouping or {})}
    by, tags = g["by"], tags or {}
    by_id = {n["id"]: n for n in nodes}
    shown = [e for e in edges if _shown(e) and e.get("source") in by_id and e.get("target") in by_id]
    any_edge = {i for e in edges for i in (e.get("source"), e.get("target"))}
    shown_edge = {i for e in shown for i in (e["source"], e["target"])}
    visible = {i for i, n in by_id.items() if n.get("focus") or n.get("pinned") or i not in any_edge or i in shown_edge}

    chains: list[dict] = []
    if g["chains"]:
        touching: dict[str, list[dict]] = {}
        for e in shown:
            for i in {e["source"], e["target"]}:
                touching.setdefault(i, []).append(e)
        plain = lambda e: family_of(e["kind"]) == "flow" and e.get("directed") is not False and not e.get("bidir")  # noqa: E731
        ends: dict[str, tuple[dict, dict]] = {}
        for i, n in by_id.items():
            if n.get("kind") not in VIEW_KINDS or n.get("focus") or n.get("pinned") or n.get("missing") or n.get("self_ref") or i not in visible:
                continue
            mine = touching.get(i, [])
            into = [e for e in mine if e["target"] == i and e["source"] != i]
            out = [e for e in mine if e["source"] == i and e["target"] != i]
            if len(mine) == 2 and len(into) == 1 and len(out) == 1 and plain(into[0]) and plain(out[0]):
                ends[i] = (into[0], out[0])
        direct = {(e["source"], e["target"]) for e in shown if family_of(e["kind"]) == "flow"}
        for head, (link_in, _) in ends.items():
            if link_in["source"] in ends:
                continue
            views, ids, cur = [], [link_in.get("id")], head
            while cur in ends and cur not in views:
                views.append(cur)
                out = ends[cur][1]
                ids.append(out.get("id"))
                cur = out["target"]
            if cur in ends or link_in["source"] == cur or (link_in["source"], cur) in direct:
                continue
            chains.append({"id": f"chain:{ids[0]}", "source": link_in["source"], "target": cur, "views": views, "edges": ids})
    elided = {v for c in chains for v in c["views"]}

    groups: list[dict] = []
    if by != "none":
        keyed: dict[str, list[dict]] = {}
        for i, n in by_id.items():
            if i not in visible or i in elided or n.get("missing") or i.startswith("ph:"):
                continue
            key = i.rsplit(".", 1)[0] if by == "schema" else (tags.get(i) or None)
            if key:
                keyed.setdefault(key, []).append(n)
        if len(keyed) >= 2:
            for key, members in keyed.items():
                if len(members) < 2:
                    continue
                default = len(members) > MAX_OPEN and not any(m.get("focus") or m.get("pinned") for m in members)
                collapsed = True if key in g["collapsed"] else False if key in g["expanded"] else default
                groups.append({"key": key, "label": _label(key, by, list(keyed)), "tables": [m["id"] for m in members], "count": len(members),
                               "collapsed": collapsed, "default_collapsed": default})
    return {"by": by, "chains_on": bool(g["chains"]), "groups": groups, "chains": chains}


def _noun(kinds: list[str]) -> str:
    return "table" if all(k in ("table", "managed", "external", "foreign", None) for k in kinds) else "object"


def scene(nodes: list[dict], edges: list[dict], p: dict) -> tuple[list[dict], list[dict]]:
    """The nodes and edges to draw for a plan: a collapsed group is one node (kind group, with a label such as `bronze (12 tables)`, at the mean of its tables' x and y), a chain of
    pass-through views is one edge, and the edges of a collapsed group's tables are merged per family, as web/src/graph/exportPicture.ts exportScene draws them.

    `nodes` carry x and y when they have a place, and focus or pinned when saved so. Edges the Graph's filters hide are dropped; an edge nothing touches is returned as it came."""
    by_id = {n["id"]: n for n in nodes}
    collapsed = {t: g for g in p["groups"] if g["collapsed"] for t in g["tables"]}
    views = {v for c in p["chains"] for v in c["views"]}
    in_chain = {i for c in p["chains"] for i in c["edges"]}
    rep = lambda i: "summary:" + collapsed[i]["key"] if i in collapsed else i  # noqa: E731
    by_edge = {e.get("id"): e for e in edges}
    logical = [(e, e["source"], e["target"], None) for e in edges if _shown(e) and e.get("source") in by_id and e.get("target") in by_id and e.get("id") not in in_chain]
    logical += [(by_edge[c["edges"][0]], c["source"], c["target"], c) for c in p["chains"] if c["edges"][0] in by_edge]
    merged: dict[tuple, list] = {}
    for e, s, t, chain in logical:
        source, target = rep(s), rep(t)
        remapped = (source, target) != (s, t)
        if remapped and source == target:
            continue  # inside one collapsed group
        merged.setdefault((source, target, family_of(e.get("kind"))), []).append((e, chain, remapped))
    out_edges = []
    for (source, target, family), items in merged.items():
        first, chain, remapped = items[0]
        if len(items) == 1 and not remapped and not chain:
            out_edges.append(first)
            continue
        same_status = len({i[0].get("status") for i in items}) == 1
        out_edges.append({"id": chain["id"] if len(items) == 1 and chain else f"merged:{source}|{target}|{family}", "source": source, "target": target, "kind": first.get("kind"),
                          **({"status": first["status"]} if same_status and first.get("status") else {}),
                          **({"directed": False} if first.get("directed") is False else {}), **({"bidir": True} if len(items) == 1 and first.get("bidir") else {})})
    touched = {i for e in edges for i in (e.get("source"), e.get("target"))}
    drawn = {i for e in edges if _shown(e) and e.get("source") in by_id and e.get("target") in by_id for i in (e["source"], e["target"])}
    out_nodes = [n for n in nodes if n["id"] not in collapsed and n["id"] not in views and (n.get("focus") or n.get("pinned") or n["id"] not in touched or n["id"] in drawn)]  # the Graph leaves out a table whose edges are all hidden
    for g in p["groups"]:
        if not g["collapsed"]:
            continue
        members = [by_id[t] for t in g["tables"]]
        xs, ys = [m["x"] for m in members if isinstance(m.get("x"), (int, float))], [m["y"] for m in members if isinstance(m.get("y"), (int, float))]
        n = len(members)
        out_nodes.append({"id": "summary:" + g["key"], "kind": "group", "label": f"{g['label']} ({n} {_noun([m.get('kind') for m in members])}{'s' if n != 1 else ''})",
                          "x": sum(xs) / len(xs) if xs else 0, "y": sum(ys) / len(ys) if ys else 0})
    return out_nodes, out_edges


def text_lines(p: dict) -> list[str]:
    """The groups and chains as the lines get_graph prints."""
    lines = [f"Groups (by {p['by']})" + (": none" if not p["groups"] else ":")]
    for g in p["groups"]:
        lines.append(f"  {g['key']}: {g['count']} tables, {'collapsed' if g['collapsed'] else 'open'}" + (" (by the default rule)" if g["collapsed"] == g["default_collapsed"] else " (chosen)"))
    lines.append("Chains of pass-through views " + ("(drawn as one edge)" if p["chains_on"] else "(off)") + (": none" if not p["chains"] else ":"))
    for c in p["chains"]:
        n = len(c["views"])
        lines.append(f"  {c['source']} -> {c['target']} via {n} view{'s' if n != 1 else ''}: {', '.join(c['views'])}")
    return lines
