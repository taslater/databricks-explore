"""The graph tools: read, create, change, rename and delete the diagrams saved from the Graph tab. They never touch the workspace."""
import base64
import json

from .. import cardinality
from .. import column_trace
from .. import dbx
from .. import graph_collapse
from .. import graph_export
from .. import graph_lens
from .. import graphs
from ..edge_families import family_of
from .. import nodefacts
from .. import nodemeta
from .. import relationships
from .. import relprofile
from .. import transforms

from .tooling import B, ToolError, integer, obj, strings, text, tool

MAX_TABLES = 60
GRAPH_KINDS = ("fk", "view_dep", "lineage", "join_mined", "manual", "sketch")  # what the Graph draws between two tables
SHOWN = ("derived", "accepted")  # the Graph's default filters hide rejected edges; proposed joins wait for a review
NAME = {"type": "string", "minLength": 1, "description": "graph name, as typed (Returns graph) or as stored (Returns_graph)"}
TABLES = strings("full table names, catalog.schema.table")
LENS = {"type": "string", "enum": list(graph_lens.LENSES), "description": "the question the graph answers: all (the whole graph, the default), flow (where data comes from: flow edges, left to right, no columns) or model (how tables join: key references with crow's feet, key columns, facts in a middle row and dimensions above and below). Each lens keeps its own positions; a table's fact or dimension role is inferred, never stored."}
COLOR_BY = {"type": "string", "description": "what the node fill means: type (default), schema, catalog, owner, certification, freshness, or tag:<key> (for example tag:domain). Color by tag shows a table's value once the page has read its tags."}


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


def _group_tags(ctx, grouping: dict, tables: list[str]) -> dict[str, str]:
    """The tag value of each table, for a graph grouped by a tag: from the tags the app has read, never a warehouse. Empty otherwise."""
    by = grouping.get("by", "")
    ex = ctx.explorer()
    if not by.startswith("tag:") or not ex:
        return {}
    found = nodemeta.meta(ex, tables, fetch=False)
    return {t: (m["tags"][by[4:]] or "(set)") for t, m in found.items() if isinstance(m.get("tags"), dict) and by[4:] in m["tags"]}


def _card_facts(ctx, tables: list[str]) -> dict[str, dict]:
    """Grain, size and freshness per table, from what the app has cached. Never reads the workspace; empty when not connected."""
    ex = ctx.explorer()
    return nodefacts.facts(ex, tables, fetch=False) if ex else {}


def _facts_json(f: dict) -> dict:
    """The agent's fields for one table: grain (label, basis, columns), rows, bytes, last_write, late, and when they were read."""
    g, s = f.get("grain"), f.get("stats")
    out: dict = {}
    if g:
        out["grain"] = {"label": g["label"], "basis": g["basis"], "columns": g["columns"], "source": g["source"]}
    if s:
        out.update({"rows": s["rows"], "bytes": s["bytes"], "last_write": s["last_write"], "late": s["late"], "stats_fetched_at": s["fetched_at"]})
    return out


def _facts_text(f: dict) -> str:
    g, s = f.get("grain"), f.get("stats")
    bits = [g["label"]] if g else []
    if s:
        bits += ([f"{s['rows']:,} rows"] if s["rows"] is not None else []) + ([f"{s['bytes']:,} bytes"] if s["bytes"] is not None else [])
        bits += ["late"] if s["late"] else []
    return f" ({', '.join(bits)})" if bits else ""


def _transforms(ctx, edges: list[dict]) -> dict[tuple[str, str], dict]:
    """The transform of each flow edge whose SQL the app has: from the cache, never the workspace; empty when not connected."""
    ex = ctx.explorer()
    return transforms.for_pairs(ex, edges) if ex else {}


_END_MARK = {"one": "||", "zero_one": "o|", "one_many": "|<", "zero_many": "o<"}


def _cardinalities(ctx, edges: list[dict], fetch: bool = False) -> dict[str, dict]:
    """{edge id: cardinality} for the reference edges: what the saved edge carries, else computed from the cached table metadata (never a warehouse)."""
    have = {e["id"]: e["cardinality"] for e in edges if e.get("cardinality") and e.get("id")}
    measuring = ctx.explorer()
    measured = relprofile.lookup(measuring.profile) if measuring else None  # a kept measurement wins over what a saved edge carries
    if measured:
        have.update({e["id"]: relprofile.as_cardinality(m) for e in edges if e.get("id") and e.get("kind") in cardinality.REFERENCE_KINDS
                     and isinstance(e.get("source"), str) and isinstance(e.get("target"), str) and (m := measured(e["kind"], e["source"], e["target"]))})
    todo = [e for e in edges if e.get("id") and e["id"] not in have and e.get("kind") in cardinality.REFERENCE_KINDS]
    ex = ctx.explorer() if todo else None
    if ex:
        def object_of(t):
            try:
                return (ex.object(t) if fetch else ex.cached_object(t) or {}).get("data")
            except Exception:
                return None
        with ctx.store() as store:
            have.update({k: v for k, v in cardinality.for_edges(todo, object_of, lambda t: relationships.join_keys(store, t, object_of(t))).items() if v})
    return have


def _ends_text(c: dict, e: dict) -> str:
    """` [orders o<, customers ||]`: the crow's-foot end at each table, for the ends that are known."""
    bits = [f"{e[side].rsplit('.', 1)[-1]} {_END_MARK[c[side]['end']]}" for side in ("source", "target") if c.get(side)]
    orphans = relprofile.orphan_sentence(c["profile"]) if c.get("profile") else None
    return (f" [{', '.join(bits)}]" if bits else "") + (f" ({orphans})" if orphans else "")


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


@tool("get_graph", "Read a graph saved from the Graph tab: its tables (kind, focus, and, when known, grain with its basis, rows, bytes, last_write and late from the cached size and history reads) and edges (kind, family: flow, reference or meaning, source, target, status, join columns, and for a reference edge its crow's-foot cardinality: the end at each table that is known, with its basis; for a flow edge its transform when the SQL behind it is known: the aggregate, join, union, dedupe and filters its source goes through), the groups the Graph draws (by schema or tag: table count, collapsed or open) and the chains of pass-through views it draws as one edge. Also the graph's lens (all, flow or model) and each table's inferred role (fact or dimension, with the reason in json). The name may be typed (Returns graph) or stored (Returns_graph). json gives every field, with positions (and, for a graph that was shown in more than one lens, the positions each other lens keeps: lens_positions).",
      obj({"name": NAME, "format": {"type": "string", "enum": ["text", "json"], "description": "text (default, compact) or json"}}, ("name",)))
def get_graph(ctx, args):
    data = _run(graphs.load_graph, args["name"])
    info = _run(graphs.revision_info, args["name"])
    nodes, edges = _nodes_of(data), _edges_of(data)
    pos = {n["data"]["id"]: n.get("position") for n in data.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("data"), dict)}
    card = _card_facts(ctx, [n["id"] for n in nodes])
    ends = _cardinalities(ctx, edges)
    how = _transforms(ctx, edges)
    grouping = graph_collapse.grouping_of(data)
    shape = graph_collapse.plan(nodes, edges, grouping, _group_tags(ctx, grouping, [n["id"] for n in nodes]))
    role = graph_lens.roles([n["id"] for n in nodes], edges)
    lens = graph_lens.lens_of(data)
    if args.get("format") == "json":
        return text(json.dumps({
            "name": info["name"], "title": data.get("name"), "revision": info["revision"], "by": info["by"], "saved_at": data.get("saved_at"),
            "focus_schema": data.get("focus_schema"), "color_by": data.get("color_by") or "type", "lens": lens, **({"lens_positions": data["lens_positions"]} if data.get("lens_positions") else {}),
            "grouping": {"by": shape["by"], "chains": shape["chains_on"]}, "groups": shape["groups"], "chains": shape["chains"],
            "nodes": [{"table": n["id"], "kind": n.get("kind", "table"), **({"focus": True} if n.get("focus") else {}),
                       **({"pinned": True} if n.get("pinned") else {}), **({"role": {"role": role[n["id"]]["role"], "reason": role[n["id"]]["reason"]}} if n["id"] in role else {}), **_facts_json(card.get(n["id"], {})), "x": (pos.get(n["id"]) or {}).get("x"), "y": (pos.get(n["id"]) or {}).get("y")}
                      for n in nodes],
            "edges": [{k: v for k, v in {"id": e.get("id"), "kind": e.get("kind"), "source": e.get("source"), "target": e.get("target"),
                                         "family": family_of(e.get("kind")), "cardinality": ends.get(e.get("id")), "transform": how.get((e.get("source"), e.get("target"))), "status": e.get("status"), "directed": e.get("directed"), "bidir": e.get("bidir") or None,
                                         "columns": e.get("child_columns"), "parent_columns": e.get("parent_columns"),
                                         "note": e.get("note") or None}.items() if v is not None} for e in edges]},
            separators=(",", ":")))
    head = (f"{info['name']}: {len(nodes)} tables, {len(edges)} edges, revision {info['revision']}" + (f" ({info['by']})" if info["by"] else "")
            + f", saved {data.get('saved_at')}")
    lines = [head, f"focus schema: {data.get('focus_schema') or 'none'}. Lens: {lens}. Color by: {data.get('color_by') or 'type'}. Graph filters are not saved with a graph: the page's defaults apply on load.", "Tables:"]
    for n in nodes:
        lines.append(f"  {n['id']} [{n.get('kind', 'table')}]" + (" focus" if n.get("focus") else "") + (" pinned" if n.get("pinned") else "") + (f" {role[n['id']]['role']}" if n["id"] in role else "") + _facts_text(card.get(n["id"], {})))
    lines.extend(graph_collapse.text_lines(shape))
    lines.append("Edges:" if edges else "Edges: none")
    for e in edges:
        arrow = "<->" if e.get("bidir") else ("->" if e.get("directed", True) else "--")
        keys = e.get("label") or ""
        lines.append(f"  {e.get('source')} {arrow} {e.get('target')}  {e.get('kind')} ({family_of(e.get('kind')) or '?'}) {e.get('status') or ''}".rstrip() + (f" ({keys})" if keys else "")
                     + (_ends_text(ends[e["id"]], e) if e.get("id") in ends else "")
                     + (f" [{transforms.summary(how[(e.get('source'), e.get('target'))]) or 'pass-through'}]" if (e.get("source"), e.get("target")) in how else "")
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
    and joins that are accepted or manual), read as the Graph reads them (relationships.unified). Rejected, proposed and
    superseded edges are left out (relations() already draws one edge per pair and marks lineage that no longer holds). Raises ToolError for a table that cannot be read."""
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
                if e["kind"] in GRAPH_KINDS and a != b and a in wanted and b in wanted and e["id"] not in found and (e["status"] in SHOWN or e["status"] == "superseded"):
                    e["source"]["table"], e["target"]["table"] = wanted[a], wanted[b]
                    found[e["id"]] = e
    merged = graphs.graph_edges(list(found.values()))  # a pair seen both ways is one edge, superseded only when both ways are, as on the page
    left_out = sum(1 for e in merged if e.get("status") == "superseded")
    notes = [f"{left_out} superseded lineage edge(s) left out (the view no longer reads that source)"] if left_out else []
    facts = {}
    for t in tables:
        node = next((n for n in relations_of(t).get("nodes", []) if n["id"] == t), {})
        facts[t] = {"id": t, "kind": node.get("kind", "table"), "self_ref": node.get("self_ref"), "self_ref_last_seen": node.get("self_ref_last_seen"),
                     "self_ref_fks": node.get("self_ref_fks"), "files": node.get("files")}
    edges = [e for e in merged if e.get("status") != "superseded"]
    ends = _cardinalities(ctx, edges, fetch=True)  # both ends were just read, so this costs no new call
    return [{**e, "cardinality": ends[e["id"]]} if e["id"] in ends else e for e in edges], facts, notes


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
           "focus": {"type": "string", "description": "one of the tables: the focus (the Graph's starting object); its schema is the focus schema"},
           "color_by": COLOR_BY, "lens": LENS}, ("name", "tables")), read_only=False)
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
    body = _run(graphs.build_body, args["name"].strip(), nodes, edges, color_by=args.get("color_by"), lens=args.get("lens"))
    with graphs.LOCK:
        stem, rev = _run(graphs.write_graph, body, "agent", None, True)
    return text(_result("created", stem, rev, tables, edges, notes))


@tool("update_graph", "Add or remove tables on a saved graph. Edges are derived again for the new set of tables, as in create_graph. Tables already on the graph keep their positions unless relayout is true; added tables are placed clear of them. Needs a connected profile.",
      obj({"name": NAME, "add": {**TABLES, "description": "tables to add"}, "remove": {**TABLES, "description": "tables to remove (with their edges)"},
           "relayout": {**B, "description": "lay every table out again (default false)"}, "color_by": COLOR_BY, "lens": LENS}, ("name",)), read_only=False)
def update_graph(ctx, args):
    ctx.need_explorer()
    add, remove = args.get("add") or [], args.get("remove") or []
    if not add and not remove and not args.get("relayout") and not args.get("color_by") and not args.get("lens"):
        raise ToolError("nothing to do: give add, remove, relayout, color_by or lens")
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
        body = _run(graphs.build_body, data.get("name") or stem, nodes, edges, previous=data, relayout=bool(args.get("relayout")),
                    color_by=args.get("color_by") or data.get("color_by"), lens=args.get("lens"))
        stem, rev = _run(graphs.write_graph, body, "agent")
    changes = [f"added {len(new)}" if new else "", f"removed {len(gone)}" if gone else "", "laid out again" if args.get("relayout") else "", f"colored by {args['color_by']}" if args.get("color_by") else "", f"lens {args['lens']}" if args.get("lens") else ""]
    return text(_result("updated", stem, rev, tables, edges, [", ".join(c for c in changes if c) + ".", *notes]))


@tool("trace_column", "Trace one column through column lineage, several hops at once: where it comes from (upstream), what is built from it (downstream) or both. One line per hop, source to target as data flows, with what the target's SQL does to it: `=` (same column), `→` (renamed), `cast`, `ƒ` (function or expression), `Σ sum` (aggregate) or `case`. The SQL is a view's definition, or a table's writing statement already read in the Graph; a hop whose SQL is unknown has no class, and the tables to read are listed. Lists the dashboards and other readers that lineage names at the downstream ends. Reads the cache; a table never seen is read from Databricks (column lineage: the cached system table or one read-only query, else the REST API), at most 60 tables. With graph, also adds the traced tables to that saved graph, as update_graph add does.",
      obj({"table": {"type": "string", "minLength": 1, "description": "full name catalog.schema.table"}, "column": {"type": "string", "minLength": 1},
           "direction": {"type": "string", "enum": ["upstream", "downstream", "both"], "description": "both (default), upstream (where it comes from) or downstream (what breaks if it changes)"},
           "depth": integer(1, column_trace.MAX_DEPTH, f"hops to follow on each side, default 3, at most {column_trace.MAX_DEPTH}"),
           "graph": {**NAME, "description": "a saved graph to add the traced tables to"}, "format": {"type": "string", "enum": ["text", "json"]}}, ("table", "column")),
      read_only=False)
def trace_column(ctx, args):
    e = ctx.need_explorer()
    try:
        table = relationships.check_table(args["table"])
        if table.startswith("ph:"):
            raise ToolError("a placeholder has no lineage")
        out = column_trace.trace(e, table, args["column"], args.get("direction", "both"), args.get("depth", 3))
    except (relationships.RelationshipInvalid, ValueError) as err:
        raise ToolError(str(err)) from err
    added = ""
    if args.get("graph"):
        data = _run(graphs.load_graph, args["graph"])
        have = {n["id"].lower() for n in _nodes_of(data)}
        new = [t for t in out["tables"] if t.lower() not in have]
        added = "added to the graph: " + (", ".join(new) if new else "nothing, every table is already on it")
        if new:
            added += "\n" + update_graph(ctx, {"name": args["graph"], "add": new})[0]["text"]
    if args.get("format") == "json":
        return text(json.dumps({**out, **({"graph": added} if added else {})}, indent=1, default=str))
    name = f"{table}.{out['column']}"
    lines = [f"trace of {name}, {out['direction']}, depth {out['depth']}: {len(out['tables']) - 1} other table(s), {len(out['hops'])} hop(s)"]
    for h in out["hops"]:
        how = h["label"] or ("unknown (" + (h["note"] or "no sql") + ")")
        lines.append(f"hop {h['hop']} {h['side']} {h['source']['table']}.{h['source']['column']} -> [{how}] -> {h['target']['table']}.{h['target']['column']}"
                     + (f"  {h['expr']}" if h.get("expr") else ""))
    if not out["hops"]:
        lines.append("no column lineage found (lineage only shows queries run since it was enabled; with no warehouse only the REST API and view definitions are read)")
    if out["readers"]:
        lines.append("read by (lineage names readers of a table, not of one column):")
        lines += [f"  {r['kind']} {r['id']} reads {r['table']}" for r in out["readers"]]
    if out["unread"]:
        lines.append("hops into these tables have no class yet, because the statement that wrote each was never read (read it in the Graph's Details): " + ", ".join(out["unread"]))
    if out["truncated"]:
        lines.append(f"stopped at {column_trace.NODE_CAP} tables or {column_trace.HOP_CAP} hops: use a smaller depth or one direction")
    if added:
        lines.append(added)
    lines += [f"error: {x}" for x in out["errors"]]
    return text("\n".join(lines))


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


# ---------------------------------------------------------------- export

@tool("export_graph", "Export a saved graph for a pull request, wiki or README. format mermaid returns text GitHub renders: lens flow (default; model for a graph saved with the model lens) is a flowchart of the data flows (reference edges as plain lines), lens model an erDiagram of the key references with crow's-foot ends where known and key columns. format png returns a picture with the title, a legend of only what is drawn, and the date the facts were read (oldest cached read, else today). Draws the graph as the Graph tab does: a collapsed group is one node and a chain of pass-through views one edge, unless expand_groups is true. Uses the cache only; never reads the workspace. The name may be typed or stored.",
      obj({"name": NAME, "format": {"type": "string", "enum": ["mermaid", "png"], "description": "mermaid (default) or png"},
           "lens": {"type": "string", "enum": list(graph_export.LENSES), "description": "flow or model; default the graph's own lens (model for a model graph, else flow)"},
           "title": {"type": "string", "description": "png title (default: the graph's name)"}, "caption": {"type": "string", "description": "png: one line under the title"},
           "width": integer(400, 4000, "png: the widest the picture may be, in pixels (default 1200); a smaller picture is not stretched"),
           "expand_groups": {**B, "description": "draw every table, even those in collapsed groups and the views of chains (default false: the picture shows the graph as the Graph tab draws it, a collapsed group as one node and a chain of pass-through views as one edge)"}}, ("name",)))
def export_graph(ctx, args):
    data = _run(graphs.load_graph, args["name"])
    info = _run(graphs.revision_info, args["name"])
    saved = graph_lens.lens_of(data)
    lens = args.get("lens") or ("model" if saved == "model" else "flow")
    if lens not in graph_export.LENSES:
        raise ToolError("lens: expected flow or model")
    fmt = args.get("format") or "mermaid"
    if fmt not in ("mermaid", "png"):
        raise ToolError("format: expected mermaid or png")
    pos = {n["data"]["id"]: n.get("position") or {} for n in data.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("data"), dict) and n["data"].get("id")}
    if lens != saved and isinstance(data.get("lens_positions"), dict):  # a lens that was shown before keeps its own positions
        pos.update({i: p for i, p in (data["lens_positions"].get(lens) or {}).items() if i in pos})
    nodes = [{"id": n["id"], "kind": n.get("kind"), "x": pos[n["id"]].get("x", 0), "y": pos[n["id"]].get("y", 0), "focus": n.get("focus"), "pinned": n.get("pinned")} for n in _nodes_of(data)]
    edges = _edges_of(data)
    ex = ctx.explorer()
    if not args.get("expand_groups"):  # as the Graph tab draws it: collapsed groups and chains of pass-through views
        grouping = graph_collapse.grouping_of(data)
        shape = graph_collapse.plan(_nodes_of(data), edges, grouping, _group_tags(ctx, grouping, [n["id"] for n in nodes]))
        nodes, edges = graph_collapse.scene(nodes, edges, shape)

    def object_of(t):
        return (ex.cached_object(t) or {}).get("data") if ex and not t.startswith("summary:") else None
    if ex:
        with ctx.store() as store:
            read = graph_export.inputs([n["id"] for n in nodes], edges, object_of, lambda t: relationships.join_keys(store, t, object_of(t)))
    else:  # not connected: only what the saved edges carry
        read = graph_export.inputs([n["id"] for n in nodes], edges, lambda t: None, lambda t: None)
    if fmt == "mermaid":
        return text(graph_export.mermaid(lens, nodes, edges, read["keys"], read["cards"]))
    stats = [((ex.cached_table_stats(n["id"]) if ex and n.get("kind") != "group" else None) or {}).get("fetched_at") for n in nodes]
    when = graph_export.facts_read(graph_export._drawn(lens, edges), stats)
    png = graph_export.render_png(lens, nodes, edges, read["keys"], read["cards"], args.get("title") or info["name"], args.get("caption") or "", when, args.get("width", 1200))
    return [{"type": "image", "data": base64.b64encode(png).decode("ascii"), "mimeType": "image/png"},
            {"type": "text", "text": f"{info['name']}: {len(nodes)} {'nodes' if any(n.get('kind') == 'group' for n in nodes) else 'tables'}, {len(graph_export._drawn(lens, edges))} edges drawn, lens {lens}. Facts read {when or 'not dated; the picture says the export date'}."}]
