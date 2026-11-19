"""Lenses of a saved graph: the three presets, the fact and dimension roles read off key references, and the Model lens's layout.

A lens is a preset for one question (web/src/graph/lens.ts keeps the same rules). Flow asks where data comes from and shows the flow
edges, with no columns. Model asks how tables join and shows the reference edges at the keys level, with facts in a middle row and
dimensions above and below. All is the whole graph. The role of a table is inferred from the references on the graph and never stored.
Pure: no Flask, no Databricks calls."""
from typing import Optional

from .edge_families import family_of

LENSES = ("all", "flow", "model")
DEFAULT_LENS = "all"
FACT_GAP = 60  # between facts in the middle row
DIM_GAP = 40  # between dimensions in a row
ROW_GAP = 90  # between rows: room for the crow's feet
PART_GAP = 60  # between parts of the graph with no reference between them


def check_lens(value) -> str:
    """The `lens` of a diagram: all, flow or model. ValueError for anything else."""
    if value in LENSES:
        return value
    raise ValueError(f"lens: expected one of {', '.join(LENSES)}, got {value!r}")


def check_lens_positions(value) -> dict:
    """The `lens_positions` of a diagram: {lens: {table: {x, y}}}, the node centers a lens left behind while another one showed."""
    if not isinstance(value, dict):
        raise ValueError("lens_positions: must be an object")
    for lens, positions in value.items():
        check_lens(lens)
        if not isinstance(positions, dict):
            raise ValueError(f"lens_positions.{lens}: must be an object of positions")
        for table, p in positions.items():
            ok = isinstance(p, dict) and all(isinstance(p.get(k), (int, float)) and not isinstance(p.get(k), bool) for k in ("x", "y"))
            if not ok:
                raise ValueError(f"lens_positions.{lens}.{table}: expected {{x, y}} numbers")
    return value


def lens_of(data: Optional[dict]) -> str:
    """The saved lens of a diagram (all when it saved none or an unknown one)."""
    lens = (data or {}).get("lens")
    return lens if lens in LENSES else DEFAULT_LENS


def reference_pairs(edges: list[dict], ids=None) -> list[tuple[str, str]]:
    """(referencing table, referenced table) for each pair the reference edges join: not superseded or rejected, no self reference, one per pair."""
    seen: set = set()
    out: list[tuple[str, str]] = []
    for e in edges:
        s, t = e.get("source"), e.get("target")
        if family_of(e.get("kind")) != "reference" or e.get("status") in ("superseded", "rejected") or s == t or not s or not t:
            continue
        if ids is not None and (s not in ids or t not in ids):
            continue
        if (s, t) not in seen:
            seen.add((s, t))
            out.append((s, t))
    return out


def depths(ids: list[str], pairs: list[tuple[str, str]]) -> dict[str, int]:
    """Row of each table that a reference touches: 0 for facts (nothing references them), one further out for each table they reference.

    A table's row is its longest path from a fact, so a dimension of a dimension is always further out than the dimension that
    references it. A part with no fact (a cycle) starts at its first table."""
    index = {i: n for n, i in enumerate(ids)}
    touched = [i for i in ids if any(i in p for p in pairs)]
    referenced = {t for _, t in pairs}
    parent = {i: i for i in touched}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for s, t in pairs:
        parent[find(s)] = find(t)
    roots = [i for i in touched if i not in referenced]
    covered = {find(r) for r in roots}
    for i in touched:  # a part with no fact: its first table
        if find(i) not in covered:
            covered.add(find(i))
            roots.append(i)
    size = {}
    for i in touched:
        size[find(i)] = size.get(find(i), 0) + 1
    depth = {r: 0 for r in roots}
    fixed = set(roots)
    for _ in range(len(touched)):
        moved = False
        for s, t in pairs:
            if s in depth and t not in fixed and depth[s] + 1 > depth.get(t, -1) and depth[s] + 1 < size[find(t)]:
                depth[t] = depth[s] + 1
                moved = True
        if not moved:
            break
    return {i: depth.get(i, 0) for i in sorted(touched, key=index.get)}


def _names(tables: list[str]) -> str:
    return ", ".join(t.rsplit(".", 1)[-1] for t in tables)


def roles(ids: list[str], edges: list[dict]) -> dict[str, dict]:
    """{table: {role: fact | dimension, reason, depth}} for the tables a key reference touches. A fact references others and nothing references it."""
    pairs = reference_pairs(edges, set(ids))
    row = depths(ids, pairs)
    out: dict[str, dict] = {}
    for i, d in row.items():
        refers = [t for s, t in pairs if s == i]
        by = [s for s, t in pairs if t == i]
        if d == 0:
            reason = f"references {_names(refers)}" + (" and nothing references it" if not by else f", and {_names(by)} reference{'s' if len(by) == 1 else ''} it back (a cycle, so it starts the picture)")
            out[i] = {"role": "fact", "reason": reason, "depth": 0}
        else:
            reason = f"referenced by {_names(by)}" + (f", and references {_names(refers)} in turn (a dimension of a dimension)" if refers else "")
            out[i] = {"role": "dimension", "reason": reason, "depth": d}
    return out


def model_layout(sizes: dict[str, tuple[float, float]], edges: list[dict]) -> dict[str, tuple[float, float]]:
    """Top-left positions for the Model lens. `sizes` is {id: (width, height)}, `edges` the graph's edges (only references count).

    Facts sit in a middle row, left to right. The tables they reference are above and below, alternating, each centered on the
    facts that reference it, so one referenced by two facts sits between them. A dimension of a dimension goes one row further out,
    on the same side. Parts with no reference between them are stacked top to bottom. Deterministic: the order of `sizes` breaks ties."""
    ids = list(sizes)
    index = {i: n for n, i in enumerate(ids)}
    pairs = reference_pairs(edges, set(ids))
    row = depths(ids, pairs)
    parent = {i: i for i in ids}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for s, t in pairs:
        parent[find(s)] = find(t)
    parts: dict[str, list[str]] = {}
    for i in ids:
        parts.setdefault(find(i), []).append(i)
    out: dict[str, tuple[float, float]] = {}
    top = 0.0
    for members in parts.values():
        mine = [(s, t) for s, t in pairs if s in members]
        placed = _part(members, mine, {i: row.get(i, 0) for i in members}, sizes, index)
        left = min(x for x, _ in placed.values())
        up = min(y for _, y in placed.values())
        bottom = max(y + sizes[i][1] for i, (_, y) in placed.items())
        for i, (x, y) in placed.items():
            out[i] = (x - left, y - up + top)
        top += bottom - up + PART_GAP
    return out


def _part(members, pairs, depth, sizes, index) -> dict[str, tuple[float, float]]:
    """One part's tables, relative to its middle row's center line."""
    referrers = {i: [s for s, t in pairs if t == i] for i in members}
    cx: dict[str, float] = {}
    x = 0.0
    facts = sorted((i for i in members if depth[i] == 0), key=index.get)
    for i in facts:
        cx[i] = x + sizes[i][0] / 2
        x += sizes[i][0] + FACT_GAP
    side: dict[str, str] = {}
    cells: dict[tuple[str, int], list[str]] = {}
    for d in range(1, max(depth.values(), default=0) + 1):
        level = [i for i in members if depth[i] == d]
        want = {i: _mean([cx[r] for r in referrers[i] if r in cx]) for i in level}
        level.sort(key=lambda i: (want[i], index[i]))
        for k, i in enumerate(level):
            if d == 1:
                side[i] = "up" if k % 2 == 0 else "down"
            else:
                above = sorted((r for r in referrers[i] if r in side), key=lambda r: (depth[r] != d - 1, index[r]))
                side[i] = side[above[0]] if above else "up"
        for s in ("up", "down"):
            row = [i for i in level if side[i] == s]
            if not row:
                continue
            cells[(s, d)] = row
            edge = None
            for i in row:  # left to right from where each wants to be, pushed apart
                left = want[i] - sizes[i][0] / 2
                if edge is not None and left < edge + DIM_GAP:
                    left = edge + DIM_GAP
                cx[i] = left + sizes[i][0] / 2
                edge = left + sizes[i][0]
            shift = _mean([want[i] - cx[i] for i in row])
            for i in row:
                cx[i] += shift
    cy = {i: 0.0 for i in facts}
    fact_h = max((sizes[i][1] for i in facts), default=0.0)
    edge = {"up": -fact_h / 2, "down": fact_h / 2}
    for d in range(1, max(depth.values(), default=0) + 1):
        for s, sign in (("up", -1), ("down", 1)):
            row = cells.get((s, d))
            if not row:
                continue
            h = max(sizes[i][1] for i in row)
            centre = edge[s] + sign * (ROW_GAP + h / 2)
            edge[s] = centre + sign * h / 2
            for i in row:
                cy[i] = centre
    return {i: (cx[i] - sizes[i][0] / 2, cy[i] - sizes[i][1] / 2) for i in members if i in cx}


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0
