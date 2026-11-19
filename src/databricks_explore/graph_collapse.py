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
    """{"by", "chains_on", "groups": [{key, label, tables, count, collapsed, default_collapsed}], "chains": [{id, source, target, views, edges}]}.

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
