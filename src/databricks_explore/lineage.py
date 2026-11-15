"""Table lineage and view dependencies: a bounded multi-hop walk over the derived edges, and the connectors it draws on a canvas."""
from typing import Callable, Optional

LINEAGE_KINDS = ("lineage", "view_dep")  # the derived edge kinds that say where data comes from
LABELS = {"lineage": "lineage", "view_dep": "view"}  # what a connector for each kind says
MAX_DEPTH = 6
NODE_CAP = 60  # the most tables a walk reaches (the start included), so one call stays bounded
_ERROR_LIMIT = 5
_RANK = {"view_dep": 0, "lineage": 1}  # a pair with both is drawn as a view dependency


def _edge_id(kind: str, source: str, target: str) -> str:
    return f"{kind}:{source}->{target}"  # the id relationships.derived_id gives a table-level edge


def _steps(edge: dict, table: str, side: str):
    """(source, target, other end) for each way `edge` leads away from `table` on this side ('down' or 'up').

    A lineage edge seen both ways (`bidir`) leads either way."""
    src, tgt = edge["source"], edge["target"]
    if side == "down":
        if src == table:
            yield src, tgt, tgt
        if edge.get("bidir") and tgt == table:
            yield tgt, src, src
    else:
        if tgt == table:
            yield src, tgt, src
        if edge.get("bidir") and src == table:
            yield tgt, src, tgt


def walk(relations_of: Callable[[str], Optional[dict]], table: str, direction: str = "downstream", depth: int = 3,
         node_cap: int = NODE_CAP) -> dict:
    """Follow lineage and view dependencies from `table`, breadth first, up to `depth` hops.

    `relations_of(table)` is an Explorer.relations() response (or None). `direction` is downstream, upstream or both.
    Each table is expanded once per side, so a cycle ends the walk instead of looping, and at most `node_cap` tables
    are reached (`truncated` says it stopped there). Returns {"table", "direction", "depth", "nodes", "edges",
    "truncated", "errors"}: a node is {table, hop, side (start, down or up), kind}, an edge {id, kind, source, target,
    hop}, source to target as data flows. Edges are ordered by hop, nodes by hop and name."""
    if direction not in ("downstream", "upstream", "both"):
        raise ValueError("direction must be downstream, upstream or both")
    depth = max(1, min(int(depth), MAX_DEPTH))
    sides = {"downstream": ("down",), "upstream": ("up",), "both": ("down", "up")}[direction]
    nodes: dict[str, dict] = {table: {"table": table, "hop": 0, "side": "start", "kind": None}}
    edges: dict[tuple, dict] = {}
    errors: list[str] = []
    memo: dict[str, dict] = {}
    truncated = False

    def relations(t: str) -> dict:
        if t not in memo:
            try:
                memo[t] = relations_of(t) or {}
            except Exception as e:  # one unreadable table must not end the walk
                memo[t] = {}
                errors.append(f"{t}: {e}")
            for msg in memo[t].get("errors") or []:
                errors.append(f"{t}: {msg}")
            if t == table:
                nodes[table]["kind"] = next((n.get("kind") for n in memo[t].get("nodes") or [] if n.get("id") == table), None)
        return memo[t]

    for side in sides:
        frontier, seen = [table], {table}
        for hop in range(1, depth + 1):
            reached: list[str] = []
            for t in frontier:
                rel = relations(t)
                kinds = {n.get("id"): n.get("kind") for n in rel.get("nodes") or []}
                for e in sorted((x for x in rel.get("edges") or [] if x.get("kind") in LINEAGE_KINDS),
                                key=lambda x: (x["kind"], x["source"], x["target"])):
                    for src, tgt, other in _steps(e, t, side):
                        if other == t:
                            continue
                        if other not in nodes:
                            if len(nodes) >= node_cap:
                                truncated = True
                                continue
                            nodes[other] = {"table": other, "hop": hop, "side": side, "kind": kinds.get(other)}
                        key = (e["kind"], src, tgt)
                        if key not in edges or edges[key]["hop"] > hop:
                            edges[key] = {"id": _edge_id(e["kind"], src, tgt), "kind": e["kind"], "source": src,
                                          "target": tgt, "hop": hop}
                        if other not in seen:
                            seen.add(other)
                            reached.append(other)
            frontier = reached
            if not frontier:
                break
    # A table that was read also names edges between tables the walk reached by another way (a view's dependency on the
    # table it was reached from, a link back along a cycle). They cost no read, so they are listed too.
    for rel in memo.values():
        for e in rel.get("edges") or []:
            if e.get("kind") not in LINEAGE_KINDS:
                continue
            for src, tgt in ((e["source"], e["target"]), *(((e["target"], e["source"]),) if e.get("bidir") else ())):
                if src != tgt and src in nodes and tgt in nodes and (e["kind"], src, tgt) not in edges:
                    edges[(e["kind"], src, tgt)] = {"id": _edge_id(e["kind"], src, tgt), "kind": e["kind"], "source": src,
                                                    "target": tgt, "hop": max(1, nodes[src]["hop"], nodes[tgt]["hop"])}
    if len(errors) > _ERROR_LIMIT:
        errors = errors[:_ERROR_LIMIT] + [f"... {len(errors) - _ERROR_LIMIT} more"]
    return {"table": table, "direction": direction, "depth": depth,
            "nodes": sorted(nodes.values(), key=lambda n: (n["hop"], n["table"])),
            "edges": sorted(edges.values(), key=lambda e: (e["hop"], e["source"], e["target"], e["kind"])),
            "truncated": truncated, "errors": errors}


def connector_plan(edges: list[dict]) -> list[dict]:
    """One planned connector per pair of tables from lineage and view-dependency edges (dicts with kind, source, target).

    A plan entry is {source, target, label, directed, proposed, bidir, kinds}, the same shape as
    relationships.connector_plan: it runs source to target as data flows, is labeled `lineage` or `view` (`view` when
    the pair has a view dependency), is never dashed, and has an arrow at the start too when the pair flows both ways."""
    by_pair: dict[tuple, list[dict]] = {}
    for e in edges:
        if e["kind"] in LINEAGE_KINDS and e["source"].lower() != e["target"].lower():
            by_pair.setdefault(tuple(sorted((e["source"].lower(), e["target"].lower()))), []).append(e)
    plan = []
    for key in sorted(by_pair):
        es = sorted(by_pair[key], key=lambda e: (_RANK[e["kind"]], e["source"], e["target"]))
        first = es[0]
        kinds = sorted({e["kind"] for e in es}, key=_RANK.__getitem__)
        both = any(e["source"].lower() != first["source"].lower() for e in es)
        plan.append({"source": first["source"], "target": first["target"], "label": LABELS[kinds[0]], "directed": True,
                     "proposed": False, "bidir": both, "kinds": kinds})
    return plan


def among(relations_of: Callable[[str], Optional[dict]], tables) -> list[dict]:
    """The connector plan for lineage and view dependencies between `tables` (both ends in the set, any case).

    Reads `relations_of(table)` for each table, which is cached after the first read."""
    wanted = {t.lower() for t in tables}
    found: dict[tuple, dict] = {}
    for t in sorted(set(tables)):
        rel = relations_of(t) or {}
        for e in rel.get("edges") or []:
            if e.get("kind") in LINEAGE_KINDS and e["source"].lower() in wanted and e["target"].lower() in wanted:
                found.setdefault((e["kind"], e["source"], e["target"]), e)
                if e.get("bidir"):
                    found.setdefault((e["kind"], e["target"], e["source"]), {**e, "source": e["target"], "target": e["source"]})
    return connector_plan(list(found.values()))
