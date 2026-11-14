"""Layout doctor, tidy, arrange, describe and render for saved canvases (format version 2). Pure: no Flask, no SDK.

A canvas here is the saved object: `windows` (each with `position` {x, y} and `size` {w, h}; flat `x`, `y`, `w`, `h`
keys are read too) and top-level `edges`. Frames hold other nodes by geometry, and locked nodes never move.
Every function returns new objects and leaves its input alone. Nothing reads a clock or a random source, so the
same canvas always gives the same answer.
"""
from __future__ import annotations

import copy
import io
import math
from typing import Any, Iterable, Optional

RULES = ("fit_labels", "frames", "overlaps", "align", "spacing", "grid", "handles", "place_labels")
ARRANGE_MODES = ("grid", "row", "column", "layered", "place")
PLACE_RELATIONS = ("right_of", "left_of", "below", "above", "inside")

OVERLAP_TOL = 2.0      # px of intersection on both axes that still counts as touching, not overlapping
NEAR_MIN, NEAR_MAX = 1.0, 6.0  # edges this far apart are a near-miss alignment
ROW_TOL = 24.0         # tops of equal-height nodes in a row (lefts of equal-width nodes in a column) this far apart are a misalignment
NEIGHBOR_DIST = 300.0  # nodes farther apart than this are not compared for alignment
MIN_GAP = 16           # smallest clearance left when an overlap is pushed apart
LABEL_GAP_PAD = 8      # px of slack a connector label needs beyond its own box on the gap it sits in
LABELED_MIN_GAP = 40   # smallest clearance between two nodes joined by a labeled connector
FRAME_PAD = 12         # padding when a frame grows to hold a member
COLLAPSED_H = 36.0     # height of a collapsed window (its title bar)
STEP_OFFSET = 20.0     # how far a step connector leaves a node before turning
DIR = {"t": (0, -1), "r": (1, 0), "b": (0, 1), "l": (-1, 0)}
SKETCH = ("shape", "text", "sticky", "frame", "placeholder")
MAX_FIT_W = 320        # a sketch label wider than this wraps (and the node grows taller) instead of widening further
LABEL_CHAR_W = 6.7     # connector labels: 12 px text, estimated character width
LABEL_LINE_H = 15.6    # one line of a connector label
LABEL_PAD = (14.0, 6.0)  # horizontal and vertical padding plus border of a connector label box
LABEL_STEP = 4         # px a connector label is nudged at a time along its segment
PLACE_DOWN_MAX = 600.0  # a node placed beside an anchor is moved down at most this far to clear what is in the way
SHARE_TOL = 1.0        # px: two connector segments closer than this and parallel run along each other

PENALTY = {  # score points per issue: (each, cap)
    "overlap": (8, 40), "edge_through_node": (6, 24), "bad_handle_side": (3, 15), "outside_frame": (4, 16),
    "near_alignment": (1.5, 12), "uneven_spacing": (3, 12), "label_overflow": (2, 10), "edge_crossings": (1.5, 15),
    "far_away": (2, 6), "off_grid": (0.5, 5), "label_collision": (2, 10),
}
SEVERITY = {
    "overlap": "error", "edge_through_node": "error", "bad_handle_side": "warning", "outside_frame": "warning",
    "near_alignment": "warning", "uneven_spacing": "warning", "label_overflow": "warning",
    "edge_crossings": "warning", "far_away": "info", "off_grid": "info", "label_collision": "warning",
}


class LayoutError(ValueError):
    """The request cannot be laid out (unknown id, bad mode or option). The route returns it as HTTP 400."""


# ---------------------------------------------------------------- geometry

def _num(v: Any, default: float = 0.0) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def _nodes(canvas: dict) -> list[dict]:
    return [n for n in canvas.get("windows", []) if isinstance(n, dict) and "id" in n]


def _edges(canvas: dict) -> list[dict]:
    return [e for e in canvas.get("edges", []) or [] if isinstance(e, dict) and "id" in e]


def _x(n: dict) -> float:
    p = n.get("position")
    return _num(p.get("x")) if isinstance(p, dict) else _num(n.get("x"))


def _y(n: dict) -> float:
    p = n.get("position")
    return _num(p.get("y")) if isinstance(p, dict) else _num(n.get("y"))


def _w(n: dict) -> float:
    s = n.get("size")
    return max(_num(s.get("w")) if isinstance(s, dict) else _num(n.get("w")), 1.0)


def _h(n: dict) -> float:
    if n.get("collapsed") is True and n.get("type") not in SKETCH:
        return COLLAPSED_H
    s = n.get("size")
    return max(_num(s.get("h")) if isinstance(s, dict) else _num(n.get("h")), 1.0)


def _clean(v: float):
    v = round(v)
    return int(v)


def _put(n: dict, x: Optional[float] = None, y: Optional[float] = None,
         w: Optional[float] = None, h: Optional[float] = None) -> None:
    """Writes whole-pixel geometry, into position/size when the node has them and flat keys otherwise."""
    for key, v, outer, inner in (("x", x, "position", "x"), ("y", y, "position", "y"),
                                 ("w", w, "size", "w"), ("h", h, "size", "h")):
        if v is None:
            continue
        if isinstance(n.get(outer), dict):
            n[outer][inner] = _clean(v)
        else:
            n[key] = _clean(v)


def _box(n: dict) -> tuple[float, float, float, float]:
    x, y = _x(n), _y(n)
    return (x, y, x + _w(n), y + _h(n))


def _area(n: dict) -> float:
    return _w(n) * _h(n)


def _inter(a: tuple, b: tuple) -> tuple[float, float]:
    """Width and height of the intersection of two boxes (negative when apart)."""
    return (min(a[2], b[2]) - max(a[0], b[0]), min(a[3], b[3]) - max(a[1], b[1]))


def _gap_dist(a: tuple, b: tuple) -> float:
    gx, gy = max(0.0, max(a[0], b[0]) - min(a[2], b[2])), max(0.0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(gx, gy)


def _order_key(n: dict):
    return (_y(n), _x(n), str(n["id"]))


def _grid_of(canvas: dict, grid: Optional[float]) -> Optional[float]:
    g = grid if grid is not None else canvas.get("grid")
    return float(g) if isinstance(g, (int, float)) and not isinstance(g, bool) and g > 0 else None


def _parents(nodes: list[dict]) -> dict[str, str]:
    """Frame membership by geometry: a node belongs to the smallest larger frame holding at least half of it."""
    frames = [n for n in nodes if n.get("type") == "frame"]
    out: dict[str, str] = {}
    for n in nodes:
        a, nb = _area(n), _box(n)
        best = None
        for f in frames:
            if f is n or _area(f) <= a:
                continue
            ix, iy = _inter(nb, _box(f))
            if ix > 0 and iy > 0 and ix * iy >= 0.5 * a and (best is None or _area(f) < _area(best)):
                best = f
        if best is not None:
            out[n["id"]] = best["id"]
    return out


def _ancestors(nid: str, parent: dict[str, str]) -> set[str]:
    out: set[str] = set()
    while nid in parent and parent[nid] not in out:
        nid = parent[nid]
        out.add(nid)
    return out


def _descendants(nid: str, parent: dict[str, str]) -> list[str]:
    return [k for k in parent if nid in _ancestors(k, parent)]


def _overlap_pairs(nodes: list[dict], parent: dict[str, str], tol: float = OVERLAP_TOL) -> list[tuple]:
    """(a, b, width, height) for each pair of unrelated nodes whose bodies intersect by more than `tol` on both axes."""
    out = []
    anc = {n["id"]: _ancestors(n["id"], parent) for n in nodes}
    boxes = [_box(n) for n in nodes]
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            a, b = nodes[i], nodes[j]
            if a["id"] in anc[b["id"]] or b["id"] in anc[a["id"]]:
                continue
            ox, oy = _inter(boxes[i], boxes[j])
            if ox > tol and oy > tol:
                out.append((a, b, ox, oy))
    return out


# ---------------------------------------------------------------- connectors

def _facing(a: tuple, b: tuple) -> str:
    dx = (b[0] + b[2]) / 2 - (a[0] + a[2]) / 2
    dy = (b[1] + b[3]) / 2 - (a[1] + a[3]) / 2
    if abs(dx) >= abs(dy):
        return "r" if dx >= 0 else "l"
    return "b" if dy >= 0 else "t"


def _faces_away(n: tuple, side: str, m: tuple) -> bool:
    """True when box m lies wholly on the side of n opposite the handle `side`."""
    if side == "l":
        return m[0] >= n[2]
    if side == "r":
        return m[2] <= n[0]
    if side == "t":
        return m[1] >= n[3]
    return m[3] <= n[1]


def _side_point(box: tuple, side: str) -> tuple[float, float]:
    x1, y1, x2, y2 = box
    return {"t": ((x1 + x2) / 2, y1), "r": (x2, (y1 + y2) / 2), "b": ((x1 + x2) / 2, y2), "l": (x1, (y1 + y2) / 2)}[side]


def _handles(e: dict, a: tuple, b: tuple) -> tuple[str, str]:
    return (e.get("source_handle") or _facing(a, b), e.get("target_handle") or _facing(b, a))


def _route(e: dict, a: tuple, b: tuple) -> list[tuple[float, float]]:
    """The polyline a connector is drawn along. Step routing is an approximation of the canvas's own."""
    sh, th = _handles(e, a, b)
    p, q = _side_point(a, sh), _side_point(b, th)
    if e.get("line", "step") != "step":
        return [p, q]
    horiz_s, horiz_t = sh in "lr", th in "lr"
    if horiz_s and horiz_t and ((sh == "r" and th == "l" and q[0] >= p[0]) or (sh == "l" and th == "r" and q[0] <= p[0])):
        mx = (p[0] + q[0]) / 2
        return [p, (mx, p[1]), (mx, q[1]), q]
    if not horiz_s and not horiz_t and ((sh == "b" and th == "t" and q[1] >= p[1]) or (sh == "t" and th == "b" and q[1] <= p[1])):
        my = (p[1] + q[1]) / 2
        return [p, (p[0], my), (q[0], my), q]
    p1 = (p[0] + DIR[sh][0] * STEP_OFFSET, p[1] + DIR[sh][1] * STEP_OFFSET)
    q1 = (q[0] + DIR[th][0] * STEP_OFFSET, q[1] + DIR[th][1] * STEP_OFFSET)
    if horiz_s and not horiz_t:
        mid = [(q1[0], p1[1])]
    elif not horiz_s and horiz_t:
        mid = [(p1[0], q1[1])]
    elif horiz_s:
        xo = max(p1[0], q1[0]) if sh == "r" and th == "r" else min(p1[0], q1[0]) if sh == "l" and th == "l" else None
        ym = (p1[1] + q1[1]) / 2
        mid = [(xo, p1[1]), (xo, q1[1])] if xo is not None else [(p1[0], ym), (q1[0], ym)]
    else:
        yo = max(p1[1], q1[1]) if sh == "b" and th == "b" else min(p1[1], q1[1]) if sh == "t" and th == "t" else None
        xm = (p1[0] + q1[0]) / 2
        mid = [(p1[0], yo), (q1[0], yo)] if yo is not None else [(xm, p1[1]), (xm, q1[1])]
    return [p, p1, *mid, q1, q]


def _seg_hits_box(p: tuple, q: tuple, box: tuple, inset: float = 2.0) -> bool:
    """Liang-Barsky: does the segment pass through the interior of the box (shrunk by `inset`)?"""
    x1, y1, x2, y2 = box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset
    if x1 >= x2 or y1 >= y2:
        return False
    dx, dy = q[0] - p[0], q[1] - p[1]
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, p[0] - x1), (dx, x2 - p[0]), (-dy, p[1] - y1), (dy, y2 - p[1])):
        if pk == 0:
            if qk <= 0:
                return False
        else:
            t = qk / pk
            if pk < 0:
                if t > t1:
                    return False
                t0 = max(t0, t)
            else:
                if t < t0:
                    return False
                t1 = min(t1, t)
    return t0 < t1


def _segs_cross(a: tuple, b: tuple, c: tuple, d: tuple) -> bool:
    def orient(p, q, r):
        v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        return 0 if abs(v) < 1e-9 else (1 if v > 0 else -1)
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    return o1 * o2 < 0 and o3 * o4 < 0


def _polylines(canvas: dict) -> list[tuple[dict, list]]:
    by = {n["id"]: n for n in _nodes(canvas)}
    out = []
    for e in _edges(canvas):
        if e.get("source") in by and e.get("target") in by and e["source"] != e["target"]:
            out.append((e, _route(e, _box(by[e["source"]]), _box(by[e["target"]]))))
    return out


def _poly_len(pts: list) -> float:
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


# ---------------------------------------------------------------- planners shared by doctor and tidy

def _cluster(items: list[tuple[str, float]], neighbors: set) -> list[list[tuple[str, float]]]:
    """Union-find over near values of neighboring nodes. Returns clusters with at least two members."""
    idx = {nid: i for i, (nid, _) in enumerate(items)}
    root = list(range(len(items)))

    def find(i):
        while root[i] != i:
            root[i] = root[root[i]]
            i = root[i]
        return i
    for i, (a, va) in enumerate(items):
        for j in range(i + 1, len(items)):
            b, vb = items[j]
            if abs(va - vb) <= NEAR_MAX and (a, b) in neighbors:
                root[find(i)] = find(j)
    groups: dict[int, list] = {}
    for nid, v in items:
        groups.setdefault(find(idx[nid]), []).append((nid, v))
    return [g for g in groups.values() if len(g) > 1]


_ALIGN_KINDS = {
    "x": (("left", lambda x, s: x), ("center", lambda x, s: x + s / 2), ("right", lambda x, s: x + s)),
    "y": (("top", lambda y, s: y), ("middle", lambda y, s: y + s / 2), ("bottom", lambda y, s: y + s)),
}


def _would_collide(pos: dict, size: dict, anc: dict, delta: dict[str, float], ai: int) -> bool:
    """True when shifting the nodes in `delta` along axis `ai` makes an unrelated pair overlap that did not before."""
    def box(i, d=0.0):
        x, y = pos[i]
        x, y = (x + d, y) if ai == 0 else (x, y + d)
        return (x, y, x + size[i][0], y + size[i][1])
    for m, d in delta.items():
        for o in pos:
            if o in delta or o in anc[m] or m in anc[o]:
                continue
            nx, ny = _inter(box(m, d), box(o))
            if nx > OVERLAP_TOL and ny > OVERLAP_TOL:
                ox, oy = _inter(box(m), box(o))
                if not (ox > OVERLAP_TOL and oy > OVERLAP_TOL):
                    return True
    return False


def _align_cost(subset, pos: dict, size: dict, nbrs: dict[str, set]) -> int:
    """Near-miss edge pairs minus exact ones, over the pairs that involve a node of . Lower is better."""
    seen, cost = set(), 0
    for a in subset:
        for b in nbrs[a]:
            key = (a, b) if str(a) <= str(b) else (b, a)
            if key in seen:
                continue
            seen.add(key)
            for ai in (0, 1):
                for _, fn in _ALIGN_KINDS["xy"[ai]]:
                    d = abs(fn(pos[a][ai], size[a][ai]) - fn(pos[b][ai], size[b][ai]))
                    if d < NEAR_MIN:
                        cost -= 1
                    elif d <= NEAR_MAX:
                        cost += 1
    return cost


def _plan_align(nodes: list[dict], parent: dict[str, str], grid: Optional[float],
                movable: dict[str, bool]) -> tuple[dict[str, list[float]], list[dict]]:
    """Near-miss alignment. Returns (new [x, y] for the nodes that move, one record per fixed cluster)."""
    pos = {n["id"]: [_x(n), _y(n)] for n in nodes}
    size = {n["id"]: (_w(n), _h(n)) for n in nodes}
    anc = {n["id"]: _ancestors(n["id"], parent) for n in nodes}
    desc = {n["id"]: _descendants(n["id"], parent) for n in nodes if n.get("type") == "frame"}
    order = {n["id"]: i for i, n in enumerate(sorted(nodes, key=_order_key))}
    boxes0 = {n["id"]: _box(n) for n in nodes}
    neighbors = set()
    ids = [n["id"] for n in nodes]
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if a in anc[b] or b in anc[a] or _gap_dist(boxes0[a], boxes0[b]) > NEIGHBOR_DIST:
                continue
            neighbors.add((a, b))
    nbrs: dict[str, set] = {i: set() for i in ids}
    for a, b in neighbors:
        nbrs[a].add(b)
        nbrs[b].add(a)
    moved: dict[str, set] = {"x": set(), "y": set()}
    # the interior of a row of three or more is placed by the spacing rule along x, and of a column along y
    pinned = _pinned(nodes)
    records: list[dict] = []
    for axis, ai in (("x", 0), ("y", 1)):
        for kind, fn in _ALIGN_KINDS[axis]:
            items = [(i, fn(pos[i][ai], size[i][ai])) for i in ids]
            for cl in _cluster(items, neighbors):
                # a member of a frame in the same cluster moves with that frame, so it cannot serve as a target
                inside = {nid for nid, _ in cl}
                cl = [(nid, v) for nid, v in cl if not (anc[nid] & inside)]
                if len(cl) < 2:
                    continue
                vals = [v for _, v in cl]
                if max(vals) - min(vals) > 2 * NEAR_MAX or not any(NEAR_MIN <= abs(a - b) for a in vals for b in vals):
                    continue
                fixed = {nid: v for nid, v in cl if not movable.get(nid, False) or nid in moved[axis] or nid in pinned[axis]}
                if len({round(v, 3) for v in fixed.values()}) > 1:
                    continue
                if fixed:
                    target = next(iter(fixed.values()))
                else:
                    best = None
                    for t in sorted(set(vals)):
                        score = (-sum(1 for v in vals if v == t), sum(abs(v - t) for v in vals), t)
                        if best is None or score < best[0]:
                            best = (score, t)
                    target = best[1]
                target = round(target)
                movers = [(nid, v) for nid, v in cl if nid not in fixed and abs(v - target) >= 0.5]
                if not movers:
                    continue
                shifts = {}
                ok = True
                for nid, v in movers:
                    new = pos[nid][ai] + (target - v)
                    if grid and kind not in ("left", "top") and abs(new / grid - round(new / grid)) > 1e-9:
                        ok = False
                        break
                    shifts[nid] = target - v
                if not ok:
                    continue
                delta: dict[str, float] = {}
                for nid, d in shifts.items():
                    delta[nid] = d
                    for k in desc.get(nid, []):
                        if movable.get(k, False):
                            delta[k] = d
                if _would_collide(pos, size, anc, delta, ai):
                    continue
                before = _align_cost(delta, pos, size, nbrs)
                for nid, d in delta.items():
                    pos[nid][ai] += d
                if _align_cost(delta, pos, size, nbrs) >= before:  # must leave fewer near-misses than exact matches lost
                    for nid, d in delta.items():
                        pos[nid][ai] -= d
                    continue
                moved[axis].update(delta)
                records.append({"kind": kind, "axis": axis, "nodes": [nid for nid, _ in cl],
                                "spread": max(vals) - min(vals), "movers": sorted(shifts)})
    records += _plan_rows(nodes, pos, size, anc, order, movable, moved, pinned)
    orig = {n["id"]: (_x(n), _y(n)) for n in nodes}
    out = {i: pos[i] for i in ids if abs(pos[i][0] - orig[i][0]) > 1e-9 or abs(pos[i][1] - orig[i][1]) > 1e-9}
    records.sort(key=lambda r: (min(order[i] for i in r["nodes"]), r["kind"]))
    return out, records


def _plan_rows(nodes: list[dict], pos: dict, size: dict, anc: dict, order: dict, movable: dict[str, bool],
               moved: dict[str, set], pinned: dict[str, set]) -> list[dict]:
    """Rows of three or more nodes of one height whose tops differ by up to ROW_TOL px, and the same for columns of
    three or more of one width and their lefts. The near-miss clusters only look at gaps of 1 to 6 px, so a card nudged
    by 10 px beside two aligned ones slipped through both the doctor and tidy. Moves the odd ones to the top (left) that
    most of the row has, or to the one a node that may not move already has, in `pos` and `moved`. Returns one record
    per fixed row, shaped like the cluster records."""
    records: list[dict] = []
    cand = [n for n in nodes if n.get("type") != "frame"]
    for axis, ai in (("y", 1), ("x", 0)):
        kind = "top" if axis == "y" else "left"
        for band in _bands([copy.copy(n) | {"position": {"x": pos[n["id"]][0], "y": pos[n["id"]][1]}} for n in cand],
                           "x" if axis == "y" else "y", 3):
            groups: dict[int, list[str]] = {}
            for n in band:
                groups.setdefault(round(size[n["id"]][ai]), []).append(n["id"])
            for ids in groups.values():
                if len(ids) < 3:  # a pair may be staggered on purpose; three of one size are a row
                    continue
                vals = {i: pos[i][ai] for i in ids}
                spread = max(vals.values()) - min(vals.values())
                if spread < 0.5 or spread > ROW_TOL:
                    continue
                fixed = {i: v for i, v in vals.items() if not movable.get(i, False) or i in moved[axis] or i in pinned[axis]}
                if len({round(v, 3) for v in fixed.values()}) > 1:
                    continue
                if fixed:
                    target = next(iter(fixed.values()))
                else:
                    votes: dict[float, list[str]] = {}
                    for i in sorted(ids, key=lambda i: order[i]):
                        votes.setdefault(round(vals[i], 3), []).append(i)
                    target = min(votes, key=lambda v: (-len(votes[v]), order[votes[v][0]]))
                target = round(target)
                delta = {i: target - v for i, v in vals.items() if i not in fixed and abs(v - target) >= 0.5}
                if not delta or _would_collide(pos, size, anc, delta, ai):
                    continue
                for i, d in delta.items():
                    pos[i][ai] += d
                moved[axis].update(delta)
                records.append({"kind": kind, "axis": axis, "nodes": sorted(ids, key=lambda i: order[i]),
                                "spread": spread, "movers": sorted(delta)})
    return records


def _bands(nodes: list[dict], axis: str, min_size: int = 3) -> list[list[dict]]:
    """Rows (axis 'x') or columns (axis 'y'): groups of nodes sharing at least half of the smaller extent."""
    lo, hi = (1, 3) if axis == "x" else (0, 2)
    bands: list[list] = []
    for n in sorted(nodes, key=lambda n: ((_box(n)[lo] + _box(n)[hi]) / 2, _order_key(n))):
        b = _box(n)
        for band in bands:
            a = _box(band[0])
            ov = min(a[hi], b[hi]) - max(a[lo], b[lo])
            if ov >= 0.5 * min(a[hi] - a[lo], b[hi] - b[lo]):
                band.append(n)
                break
        else:
            bands.append([n])
    return [bd for bd in bands if len(bd) >= min_size]


def _pinned(nodes: list[dict]) -> dict[str, set]:
    """Ids whose x (interior of a row) or y (interior of a column) is owned by the spacing rule."""
    cand = [n for n in nodes if n.get("type") != "frame"]
    out: dict[str, set] = {"x": set(), "y": set()}
    for axis, ai in (("x", 0), ("y", 1)):
        for band in _bands(cand, axis):
            band = sorted(band, key=lambda n: (_box(n)[ai], str(n["id"])))
            out[axis] |= {n["id"] for n in band[1:-1]}
    return out


def _plan_spacing(nodes: list[dict], parent: dict[str, str], grid: Optional[float], movable: dict[str, bool]) -> tuple[dict[str, list[float]], list[dict]]:
    """Even gaps along rows and columns of three or more. First and last stay put. Returns (moves, records)."""
    tol = max(4.0, grid or 0.0)
    pos = {n["id"]: [_x(n), _y(n)] for n in nodes}
    sizes = {n["id"]: (_w(n), _h(n)) for n in nodes}
    anc = {n["id"]: _ancestors(n["id"], parent) for n in nodes}
    cand = [n for n in nodes if n.get("type") != "frame"]
    records: list[dict] = []
    for axis, ai in (("x", 0), ("y", 1)):
        lo, hi = (0, 2) if axis == "x" else (1, 3)
        size = (lambda n: _w(n)) if axis == "x" else (lambda n: _h(n))
        # a row (gaps along x) is a band of nodes sharing vertical extent
        for band in _bands(cand, "x" if axis == "x" else "y"):
            row = sorted(band, key=lambda n: (pos[n["id"]][ai], str(n["id"])))
            gaps = [pos[row[i + 1]["id"]][ai] - (pos[row[i]["id"]][ai] + size(row[i])) for i in range(len(row) - 1)]
            if min(gaps) < 0:
                continue
            spread, mean = max(gaps) - min(gaps), sum(gaps) / len(gaps)
            if spread <= tol or spread > max(80.0, 0.75 * mean):
                continue
            interior = row[1:-1]
            if any(not movable.get(n["id"], False) for n in interior):
                continue
            total = pos[row[-1]["id"]][ai] - (pos[row[0]["id"]][ai] + size(row[0]))
            gap = (total - sum(size(n) for n in interior)) / (len(row) - 1)
            cur = pos[row[0]["id"]][ai] + size(row[0]) + gap
            delta = {}
            for n in interior:
                new = round(cur)
                if grid:
                    new = round(round(cur / grid) * grid)
                delta[n["id"]] = new - pos[n["id"]][ai]
                cur += size(n) + gap
            if _would_collide(pos, sizes, anc, delta, ai):
                continue
            for nid, d in delta.items():
                pos[nid][ai] += d
            records.append({"axis": axis, "nodes": [n["id"] for n in row], "gaps": [round(g, 1) for g in gaps],
                            "target": round(gap, 1)})
    orig = {n["id"]: (_x(n), _y(n)) for n in nodes}
    out = {i: p for i, p in pos.items() if abs(p[0] - orig[i][0]) > 1e-9 or abs(p[1] - orig[i][1]) > 1e-9}
    return out, records


def _outside_frame(nodes: list[dict], parent: dict[str, str]) -> list[tuple[dict, dict]]:
    by = {n["id"]: n for n in nodes}
    out = []
    for n in nodes:
        f = by.get(parent.get(n["id"], ""))
        if f is None:
            continue
        b, fb = _box(n), _box(f)
        if b[0] < fb[0] - 1 or b[1] < fb[1] - 1 or b[2] > fb[2] + 1 or b[3] > fb[3] + 1:
            out.append((n, f))
    return out


def _bad_handles(canvas: dict) -> list[tuple[dict, dict]]:
    """(edge, {'source': side-or-None, 'target': ...}) for connectors leaving a side that faces away from the other end."""
    by = {n["id"]: n for n in _nodes(canvas)}
    out = []
    for e in _edges(canvas):
        a, b = by.get(e.get("source")), by.get(e.get("target"))
        if a is None or b is None or a is b:
            continue
        ab, bb = _box(a), _box(b)
        bad = {}
        if e.get("source_handle") and _faces_away(ab, e["source_handle"], bb):
            bad["source"] = _facing(ab, bb)
        if e.get("target_handle") and _faces_away(bb, e["target_handle"], ab):
            bad["target"] = _facing(bb, ab)
        if bad:
            out.append((e, bad))
    return out


def _text_of(n: dict) -> str:
    return str(n.get("label") if n.get("label") is not None else (n.get("title") or ""))


def _label_fit(n: dict) -> Optional[tuple[int, int]]:
    """None when the label fits its box, else a size (w, h) it would need. A character-width estimate."""
    t = n.get("type")
    if t == "placeholder":
        name = str((n.get("placeholder") or {}).get("name") or "")
        need = len(name) * 8.2 + 40
        return (int(math.ceil(need)), int(_h(n))) if name and need > _w(n) else None
    text = _text_of(n)
    if not text:
        return None
    if t not in SKETCH:  # a window's title shares its bar with buttons
        need = len(text) * 7.4 + 90
        return (int(math.ceil(need)), int(_h(n))) if need > _w(n) else None
    fs = _num(n.get("font_size"), 14.0) or 14.0
    cw, lh = 0.56 * fs, 1.3 * fs
    f = {"ellipse": 0.7, "diamond": 0.5, "cylinder": 0.9}.get(n.get("shape", ""), 1.0) if t == "shape" else 1.0
    usable_w, usable_h = _w(n) * f - 16, _h(n) * f - 8
    if t == "frame":  # one line in the title bar
        need = len(text) * cw + 16
        return (int(math.ceil(need)), int(_h(n))) if need > _w(n) else None
    lines, cur = 1, 0.0
    longest = 0.0
    for para in text.split("\n"):
        cur = 0.0
        for word in para.split(" "):
            ww = len(word) * cw
            longest = max(longest, ww)
            if cur and cur + cw + ww > usable_w:
                lines += 1
                cur = ww
            else:
                cur += (cw if cur else 0) + ww
        lines += 1
    lines -= 1
    need_h = lines * lh
    if longest > usable_w or need_h > usable_h:
        return (int(math.ceil(max(longest + 16, _w(n) * f) / f)), int(math.ceil((need_h + 8) / f)))
    return None


def fit_size(n: dict, max_w: float = MAX_FIT_W) -> tuple[int, int]:
    """The node's size grown just enough for its label to fit by the doctor's estimate; never smaller than it is now.

    Shape, text and sticky labels widen to their one-line width up to `max_w`, then wrap and grow taller. A longer
    single word still widens the node, since it cannot wrap. Frame titles, window titles and placeholder names are one
    line, so they widen as far as they need."""
    w, h = _w(n), _h(n)
    probe = copy.deepcopy(n)
    t = n.get("type")
    if t in ("shape", "text", "sticky"):
        text = _text_of(n)
        if text:
            fs = _num(n.get("font_size"), 14.0) or 14.0
            f = {"ellipse": 0.7, "diamond": 0.5, "cylinder": 0.9}.get(n.get("shape", ""), 1.0) if t == "shape" else 1.0
            one_line = (max(len(p) for p in text.split("\n")) * 0.56 * fs + 16) / f
            w = max(w, min(one_line, max_w))
    for _ in range(4):
        _put(probe, w=w, h=h)
        need = _label_fit(probe)
        if need is None:
            break
        w, h = max(w, need[0]), max(h, need[1])
    return (int(math.ceil(w)), int(math.ceil(h)))


# ---------------------------------------------------------------- connector labels
#
# Placement rule (the web canvas follows the same one, in web/src/sketch/labels.ts): a connector's label is centered
# at the midpoint of the longest segment of its route that no other connector runs along, moved along that segment by
# the edge's `label_offset` px (0 when absent; toward the end of the segment when positive). When every segment is
# shared the longest one is used. `tidy` sets `label_offset` to nudge a label off whatever it would collide with.

def _label_size(text: str) -> tuple[float, float]:
    lines = text.split("\n")
    return (max(len(l) for l in lines) * LABEL_CHAR_W + LABEL_PAD[0], len(lines) * LABEL_LINE_H + LABEL_PAD[1])


def _segments(pts: list) -> list[tuple]:
    """The straight runs of a route: repeated points dropped, and consecutive segments that continue the same line merged."""
    segs: list[tuple] = []
    for p, q in zip(pts, pts[1:]):
        if math.dist(p, q) <= 1e-6:
            continue
        if segs:
            a, b = segs[-1]
            cross = (b[0] - a[0]) * (q[1] - b[1]) - (b[1] - a[1]) * (q[0] - b[0])
            dot = (b[0] - a[0]) * (q[0] - b[0]) + (b[1] - a[1]) * (q[1] - b[1])
            if abs(cross) < 1e-6 * max(1.0, math.dist(a, b) * math.dist(b, q)) and dot > 0:
                segs[-1] = (a, q)
                continue
        segs.append((p, q))
    return segs


def _runs_along(p: tuple, q: tuple, r: tuple, s: tuple) -> bool:
    """Do segments pq and rs lie on one line and overlap by more than SHARE_TOL?"""
    d = (q[0] - p[0], q[1] - p[1])
    ln = math.hypot(*d)
    if ln < 1e-9:
        return False
    u = (d[0] / ln, d[1] / ln)
    if any(abs((pt[0] - p[0]) * u[1] - (pt[1] - p[1]) * u[0]) > SHARE_TOL for pt in (r, s)):
        return False
    a, b = (r[0] - p[0]) * u[0] + (r[1] - p[1]) * u[1], (s[0] - p[0]) * u[0] + (s[1] - p[1]) * u[1]
    return min(ln, max(a, b)) - max(0.0, min(a, b)) > SHARE_TOL


def _label_plan(canvas: dict) -> dict[str, dict]:
    """For each labeled connector with both ends on the canvas: its anchor segment and label size."""
    polys = _polylines(canvas)
    out: dict[str, dict] = {}
    for e, pts in polys:
        text = e.get("label")
        if not isinstance(text, str) or not text:
            continue
        segs = _segments(pts) or [(pts[0], (pts[0][0] + 1.0, pts[0][1]))]
        others = [sg for e2, pts2 in polys if e2 is not e for sg in _segments(pts2)]
        free = [sg for sg in segs if not any(_runs_along(sg[0], sg[1], o[0], o[1]) for o in others)]
        a, b = max(free or segs, key=lambda sg: math.dist(sg[0], sg[1]))  # max keeps the first of equals
        ln = math.dist(a, b)
        out[e["id"]] = {"edge": e, "mid": ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), "len": ln,
                        "dir": ((b[0] - a[0]) / ln, (b[1] - a[1]) / ln) if ln > 1e-9 else (1.0, 0.0),
                        "size": _label_size(text)}
    return out


def _label_box_at(info: dict, offset: float) -> tuple[float, float, float, float]:
    half = info["len"] / 2
    o = max(-half, min(half, offset))
    cx, cy = info["mid"][0] + info["dir"][0] * o, info["mid"][1] + info["dir"][1] * o
    w, h = info["size"]
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def edge_label_boxes(canvas: dict) -> dict[str, tuple[float, float, float, float]]:
    """The estimated box of every connector label, by connector id, where both renderers draw it."""
    return {eid: _label_box_at(i, _num(i["edge"].get("label_offset"))) for eid, i in _label_plan(canvas).items()}


def _collides(a: tuple, b: tuple) -> bool:
    ox, oy = _inter(a, b)
    return ox > 1.0 and oy > 1.0


def _label_collisions(canvas: dict) -> list[tuple[str, str, str]]:
    """(connector id, 'label' or 'node', other id) for each connector label that overlaps another label or a node."""
    boxes = edge_label_boxes(canvas)
    solid = [n for n in _nodes(canvas) if n.get("type") != "frame"]
    out = []
    ids = sorted(boxes, key=str)
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if _collides(boxes[a], boxes[b]):
                out.append((a, "label", b))
        for n in solid:
            if _collides(boxes[a], _box(n)):
                out.append((a, "node", n["id"]))
    return out


# ---------------------------------------------------------------- doctor

def _issue(kind: str, key: str, nodes: list[str], message: str, fix: Optional[dict] = None, **extra) -> dict:
    out = {"id": f"{kind}:{key}", "kind": kind, "severity": SEVERITY[kind], "nodes": nodes, "message": message, "fix": fix}
    out.update(extra)
    return out


def _tidy_fix(rules: list[str], ids: list[str]) -> dict:
    return {"tool": "tidy", "rules": rules, "ids": ids}


def _label(n: dict) -> str:
    t = _text_of(n)
    return f'{n["id"]} "{t[:24]}"' if t else str(n["id"])


def doctor(canvas: dict, grid: Optional[float] = None) -> dict:
    """Score a layout from 0 to 100 and list what is wrong with it, each issue with a fix when one exists."""
    nodes, g = _nodes(canvas), _grid_of(canvas, grid)
    by = {n["id"]: n for n in nodes}
    parent = _parents(nodes)
    issues: list[dict] = []
    locked = {n["id"]: n.get("locked") is True for n in nodes}

    pairs = _overlap_pairs(nodes, parent)
    for a, b, ox, oy in pairs:
        issues.append(_issue("overlap", f'{a["id"]}|{b["id"]}', [a["id"], b["id"]],
                             f'{_label(a)} and {_label(b)} overlap by {ox:.0f} x {oy:.0f} px',
                             _tidy_fix(["overlaps"], [a["id"], b["id"]]) if not (locked[a["id"]] and locked[b["id"]]) else None))

    movable = {n["id"]: not locked[n["id"]] for n in nodes}
    _, align_records = _plan_align(nodes, parent, g, movable)
    for r in align_records:
        issues.append(_issue("near_alignment", f'{r["kind"]}:{"|".join(r["nodes"])}', r["nodes"],
                             f'{r["kind"]} of {", ".join(r["nodes"])} differ by up to {r["spread"]:.0f} px',
                             _tidy_fix(["align"], r["nodes"])))

    _, space_records = _plan_spacing(nodes, parent, g, movable)
    for r in space_records:
        axis = "row" if r["axis"] == "x" else "column"
        issues.append(_issue("uneven_spacing", f'{axis}:{"|".join(r["nodes"])}', r["nodes"],
                             f'gaps in the {axis} {", ".join(r["nodes"])} are {r["gaps"]}; even would be {r["target"]}',
                             _tidy_fix(["spacing"], r["nodes"])))

    polys = _polylines(canvas)
    for e, pts in polys:
        for n in nodes:
            if n["id"] in (e["source"], e["target"]) or n.get("type") == "frame":
                continue
            if any(_seg_hits_box(pts[i], pts[i + 1], _box(n)) for i in range(len(pts) - 1)):
                issues.append(_issue("edge_through_node", f'{e["id"]}|{n["id"]}', [e["source"], e["target"], n["id"]],
                                     f'connector {e["id"]} ({e["source"]} to {e["target"]}) passes through {_label(n)}',
                                     None, edges=[e["id"]]))
    crossings = 0
    crossing_nodes: list[str] = []
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            e1, p1 = polys[i]
            e2, p2 = polys[j]
            if {e1["source"], e1["target"]} & {e2["source"], e2["target"]}:
                continue
            hit = sum(1 for a in range(len(p1) - 1) for b in range(len(p2) - 1)
                      if _segs_cross(p1[a], p1[a + 1], p2[b], p2[b + 1]))
            if hit:
                crossings += hit
                crossing_nodes += [e1["source"], e1["target"], e2["source"], e2["target"]]
    if crossings:
        ids = sorted(set(crossing_nodes), key=str)
        issues.append(_issue("edge_crossings", "all", ids,
                             f"{crossings} connector crossing{'s' if crossings != 1 else ''}; "
                             "arrange the connected nodes as a layered flow to reduce them", None, count=crossings))
    for e, bad in _bad_handles(canvas):
        side = ", ".join(f'{k} {e[k + "_handle"]}' for k in bad)
        issues.append(_issue("bad_handle_side", e["id"], [e["source"], e["target"]],
                             f'connector {e["id"]} uses a side facing away from the other end ({side})',
                             _tidy_fix(["handles"], [e["source"], e["target"]]), edges=[e["id"]]))
    for n, f in _outside_frame(nodes, parent):
        issues.append(_issue("outside_frame", n["id"], [n["id"], f["id"]],
                             f'{_label(n)} mostly sits in frame {_label(f)} but sticks out of it',
                             None if locked[f["id"]] else _tidy_fix(["frames"], [f["id"]])))
    for n in nodes:
        need = _label_fit(n)
        if need:
            issues.append(_issue("label_overflow", n["id"], [n["id"]],
                                 f'the label of {_label(n)} probably does not fit; it needs about {need[0]} x {need[1]} px; '
                                 'tidy with fit_labels grows the node to fit',
                                 None if locked[n["id"]] else _tidy_fix(["fit_labels"], [n["id"]]),
                                 needs={"w": need[0], "h": need[1]}))
    edge_by = {e["id"]: e for e in _edges(canvas)}
    for eid, kind, other in _label_collisions(canvas):
        e = edge_by[eid]
        ends = [e["source"], e["target"]]
        if kind == "label":
            o = edge_by[other]
            ids = sorted(set(ends + [o["source"], o["target"]]), key=str)
            issues.append(_issue("label_collision", f"{eid}|{other}", ids,
                                 f'the labels of connectors {eid} and {other} overlap',
                                 _tidy_fix(["place_labels"], ids), edges=[eid, other]))
        else:
            issues.append(_issue("label_collision", f"{eid}|{other}", ends + ([other] if other not in ends else []),
                                 f'the label of connector {eid} ("{str(e["label"])[:24]}") overlaps {_label(by[other])}',
                                 _tidy_fix(["place_labels"], ends), edges=[eid]))
    far = _far_away(nodes)
    for n, d in far:
        issues.append(_issue("far_away", n["id"], [n["id"]], f'{_label(n)} is {d:.0f} px from the nearest node', None))
    if g:
        off = [n["id"] for n in nodes if abs(_x(n) / g - round(_x(n) / g)) * g > 0.01 or abs(_y(n) / g - round(_y(n) / g)) * g > 0.01]
        if off:
            issues.append(_issue("off_grid", "all", off, f"{len(off)} node(s) are off the {g:g} px grid",
                                 _tidy_fix(["grid"], off)))

    metrics = _metrics(nodes, pairs, polys, crossings, align_records, parent)
    penalty = 0.0
    counts: dict[str, int] = {}
    for i in issues:
        counts[i["kind"]] = counts.get(i["kind"], 0) + 1
    for kind, c in counts.items():
        each, cap = PENALTY[kind]
        penalty += min(cap, each * (crossings if kind == "edge_crossings" else c))
    issues.sort(key=lambda i: ({"error": 0, "warning": 1, "info": 2}[i["severity"]], i["kind"], i["id"]))
    return {"score": max(0, min(100, int(round(100 - penalty)))), "metrics": metrics, "issues": issues}


def _far_away(nodes: list[dict]) -> list[tuple[dict, float]]:
    flat = [n for n in nodes if n.get("type") != "frame"]
    if len(flat) < 4:
        return []
    dist = {}
    for n in flat:
        dist[n["id"]] = min(_gap_dist(_box(n), _box(m)) for m in flat if m is not n)
    ds = sorted(dist.values())
    median = ds[len(ds) // 2]
    limit = max(400.0, 4 * median)
    return [(n, dist[n["id"]]) for n in flat if dist[n["id"]] > limit]


def _metrics(nodes, pairs, polys, crossings, align_records, parent) -> dict:
    lens = [_poly_len(p) for _, p in polys]
    mean = sum(lens) / len(lens) if lens else 0.0
    var = sum((v - mean) ** 2 for v in lens) / len(lens) if lens else 0.0
    # alignment: of the neighboring edge pairs that are aligned or nearly so, the share that are exact
    flat = [n for n in nodes]
    exact = near = 0
    for axis in "xy":
        for _, fn in _ALIGN_KINDS[axis]:
            vals = [(n["id"], fn(_x(n) if axis == "x" else _y(n), _w(n) if axis == "x" else _h(n)), _box(n)) for n in flat]
            for i in range(len(vals)):
                for j in range(i + 1, len(vals)):
                    if _gap_dist(vals[i][2], vals[j][2]) > NEIGHBOR_DIST:
                        continue
                    d = abs(vals[i][1] - vals[j][1])
                    if d < NEAR_MIN:
                        exact += 1
                    elif d <= NEAR_MAX:
                        near += 1
    solid = [n for n in nodes if n.get("type") != "frame"]
    if nodes:
        bx = [min(_box(n)[0] for n in nodes), min(_box(n)[1] for n in nodes),
              max(_box(n)[2] for n in nodes), max(_box(n)[3] for n in nodes)]
        bbox = max((bx[2] - bx[0]) * (bx[3] - bx[1]), 1.0)
        used = sum(_area(n) for n in solid) - sum(ox * oy for a, b, ox, oy in pairs if a in solid and b in solid)
        ws = max(0.0, min(1.0, 1 - used / bbox))
    else:
        ws = 0.0
    return {
        "node_count": len(nodes), "edge_count": len(polys),
        "overlap_area": round(sum(ox * oy for _, _, ox, oy in pairs), 1),
        "edge_crossings": crossings,
        "edge_length_mean": round(mean, 1), "edge_length_variance": round(var, 1),
        "alignment_score": round(exact / (exact + near), 3) if exact + near else 1.0,
        "whitespace_ratio": round(ws, 3),
    }


# ---------------------------------------------------------------- tidy

class _Ctx:
    """A working copy of a canvas plus what the rules need: who may move, frame membership, the grid."""

    def __init__(self, canvas: dict, ids: Optional[Iterable[str]], grid: Optional[float]):
        self.canvas = copy.deepcopy(canvas)
        self.nodes = _nodes(self.canvas)
        self.by = {n["id"]: n for n in self.nodes}
        self.grid = _grid_of(canvas, grid)
        if ids is None:
            self.allowed: Optional[set] = None
        else:
            self.allowed = set(ids)
            unknown = sorted(self.allowed - set(self.by), key=str)
            if unknown:
                raise LayoutError(f"unknown ids: {', '.join(map(str, unknown))}")
        self.parent: dict[str, str] = {}
        self.refresh()

    def refresh(self) -> None:
        self.parent = _parents(self.nodes)

    def descendants(self, nid: str) -> list[str]:
        return _descendants(nid, self.parent)

    def movable(self, nid: str) -> bool:
        n = self.by[nid]
        if n.get("locked") is True or (self.allowed is not None and nid not in self.allowed):
            return False
        return all(self.by[k].get("locked") is not True for k in self.descendants(nid))

    def movable_map(self) -> dict[str, bool]:
        return {nid: self.movable(nid) for nid in self.by}

    def move(self, nid: str, dx: float, dy: float) -> None:
        """Moves a node, and with a frame its unlocked members. Whole pixels."""
        for k in [nid] + self.descendants(nid):
            n = self.by[k]
            if k != nid and n.get("locked") is True:
                continue
            _put(n, x=_x(n) + dx, y=_y(n) + dy)

    def set_pos(self, nid: str, x: float, y: float) -> None:
        self.move(nid, x - _x(self.by[nid]), y - _y(self.by[nid]))


def _snap_dir(v: float, g: Optional[float], up: bool) -> float:
    if not g:
        return v
    return (math.ceil(v / g - 1e-9) if up else math.floor(v / g + 1e-9)) * g


def _rule_frames(ctx: _Ctx) -> bool:
    changed = False
    ctx.refresh()
    for n, f in _outside_frame(ctx.nodes, ctx.parent):
        if f.get("locked") is True or (ctx.allowed is not None and f["id"] not in ctx.allowed):
            continue
        b, fb = _box(n), _box(f)
        x1 = min(fb[0], b[0] - FRAME_PAD) if b[0] < fb[0] - 1 else fb[0]
        y1 = min(fb[1], b[1] - FRAME_PAD) if b[1] < fb[1] - 1 else fb[1]
        x2 = max(fb[2], b[2] + FRAME_PAD) if b[2] > fb[2] + 1 else fb[2]
        y2 = max(fb[3], b[3] + FRAME_PAD) if b[3] > fb[3] + 1 else fb[3]
        if ctx.grid:
            x1, y1 = _snap_dir(x1, ctx.grid, False), _snap_dir(y1, ctx.grid, False)
            x2, y2 = _snap_dir(x2, ctx.grid, True), _snap_dir(y2, ctx.grid, True)
        if (x1, y1, x2, y2) != fb:
            _put(f, x=x1, y=y1, w=x2 - x1, h=y2 - y1)
            changed = True
    return changed


def _pair_clearance(ctx: _Ctx, a: str, b: str, ai: int) -> float:
    """The gap to leave between two nodes pushed apart along axis `ai`: MIN_GAP, or when a labeled connector joins them
    enough for its label (the estimated size along that axis plus padding, at least LABELED_MIN_GAP)."""
    need = float(MIN_GAP)
    for e in _edges(ctx.canvas):
        text = e.get("label")
        if isinstance(text, str) and text and {e.get("source"), e.get("target")} == {a, b}:
            need = max(need, LABELED_MIN_GAP, _label_size(text)[ai] + LABEL_GAP_PAD)
    return need


def _make_room(ctx: _Ctx, boxes: dict[str, tuple], growth: dict[str, tuple[float, float]],
               pairs: Iterable[tuple[int, str, str]] = ()) -> bool:
    """Inserts space where nodes grew, so what lay beyond keeps its gap.

    `boxes` are the nodes' boxes before the growth and `growth` is how far each node's right edge (x) and bottom edge
    (y) moved. A node beyond a growing edge, overlapping the grown node's span on the other axis, moves outward by the
    growth, and so, transitively, does whatever lies beyond it; two nodes pushed by different growths move by the
    larger chain, not the sum. `pairs` are (axis, near, far) triples forced the same way whether or not the spans
    overlap. Nodes that may not move stay put, and nothing is pulled back, so order and gaps only widen."""
    ctx.refresh()
    forced = set(pairs)
    shift = {nid: [0.0, 0.0] for nid in boxes}
    for ai in (0, 1):
        oa = 1 - ai
        order = sorted(boxes, key=lambda k: (boxes[k][ai], str(k)))
        for i, k in enumerate(order):
            best = 0.0
            kb = boxes[k]
            for p in order[:i]:
                carry = shift[p][ai] + growth.get(p, (0.0, 0.0))[ai]
                if carry <= best:
                    continue
                pb = boxes[p]
                beyond = kb[ai] >= pb[ai + 2] - 1.0
                if (beyond and min(pb[oa + 2], kb[oa + 2]) - max(pb[oa], kb[oa]) > 1.0) or (ai, p, k) in forced:
                    best = carry
            shift[k][ai] = best if best > 0 and ctx.movable(k) else 0.0
    depth = {nid: len(_ancestors(nid, ctx.parent)) for nid in boxes}
    applied = {nid: [0.0, 0.0] for nid in boxes}
    changed = False
    for k in sorted(boxes, key=lambda k: (depth[k], str(k))):
        dx, dy = (shift[k][i] - applied[k][i] for i in (0, 1))
        dx, dy = (d if d > 1e-9 else 0.0 for d in (dx, dy))
        if not dx and not dy:
            continue
        ctx.move(k, dx, dy)
        for d in ctx.descendants(k):
            if d in applied and ctx.by[d].get("locked") is not True:
                applied[d][0] += dx
                applied[d][1] += dy
        changed = True
    return changed


def _rule_overlaps(ctx: _Ctx) -> bool:
    skipped: set = set()
    start = {n["id"]: (_x(n), _y(n)) for n in ctx.nodes}
    pushes: dict[str, int] = {}
    stuck: set = set()  # nodes squeezed between nodes that cannot move: put back, and left overlapping
    for _ in range(400):
        ctx.refresh()
        order = {n["id"]: i for i, n in enumerate(sorted(ctx.nodes, key=_order_key))}
        todo = [p for p in _overlap_pairs(ctx.nodes, ctx.parent)
                if (p[0]["id"], p[1]["id"]) not in skipped and p[0]["id"] not in stuck and p[1]["id"] not in stuck]
        if not todo:
            break
        a, b, ox, oy = todo[0]
        sideways = ox <= oy  # least penetration decides the axis
        ai = 0 if sideways else 1
        ca, cb = (_box(a)[ai] + _box(a)[ai + 2]) / 2, (_box(b)[ai] + _box(b)[ai + 2]) / 2
        # the node further along the axis is pushed further along it, so pushes cascade one way and cannot ping-pong
        high, low = (a, b) if (ca, order[a["id"]]) >= (cb, order[b["id"]]) else (b, a)
        hb, lb = _box(high), _box(low)
        if ctx.movable(high["id"]):
            gap = _pair_clearance(ctx, high["id"], low["id"], ai)
            target = _snap_dir(lb[ai + 2] + gap, ctx.grid, True)
            mover, delta = high, target - hb[ai]
        elif ctx.movable(low["id"]):
            gap = _pair_clearance(ctx, high["id"], low["id"], ai)
            target = _snap_dir(hb[ai] - gap - (lb[ai + 2] - lb[ai]), ctx.grid, False)
            mover, delta = low, target - lb[ai]
        else:
            skipped.add((a["id"], b["id"]))
            continue
        ctx.move(mover["id"], delta if sideways else 0, 0 if sideways else delta)
        pushes[mover["id"]] = pushes.get(mover["id"], 0) + 1
        if pushes[mover["id"]] > 8:
            ctx.set_pos(mover["id"], *start[mover["id"]])
            stuck.add(mover["id"])
    return any(abs(_x(n) - start[n["id"]][0]) > 1e-9 or abs(_y(n) - start[n["id"]][1]) > 1e-9 for n in ctx.nodes)


def _apply_moves(ctx: _Ctx, moves: dict[str, list[float]]) -> bool:
    changed = False
    for nid, (x, y) in moves.items():
        n = ctx.by[nid]
        if abs(_x(n) - x) > 1e-9 or abs(_y(n) - y) > 1e-9:
            _put(n, x=x, y=y)
            changed = True
    return changed


def _rule_align(ctx: _Ctx) -> bool:
    ctx.refresh()
    moves, _ = _plan_align(ctx.nodes, ctx.parent, ctx.grid, ctx.movable_map())
    return _apply_moves(ctx, moves)


def _rule_spacing(ctx: _Ctx) -> bool:
    ctx.refresh()
    moves, _ = _plan_spacing(ctx.nodes, ctx.parent, ctx.grid, ctx.movable_map())
    return _apply_moves(ctx, moves)


def _rule_grid(ctx: _Ctx) -> bool:
    if not ctx.grid:
        return False
    changed = False
    ctx.refresh()
    depth = {n["id"]: len(_ancestors(n["id"], ctx.parent)) for n in ctx.nodes}
    for n in sorted(ctx.nodes, key=lambda n: (depth[n["id"]], _order_key(n))):
        if not ctx.movable(n["id"]):
            continue
        nx, ny = round(_x(n) / ctx.grid) * ctx.grid, round(_y(n) / ctx.grid) * ctx.grid
        if abs(nx - _x(n)) > 0.01 or abs(ny - _y(n)) > 0.01:
            ctx.move(n["id"], nx - _x(n), ny - _y(n))
            changed = True
    return changed


def _rule_handles(ctx: _Ctx, edge_ids: Optional[set] = None) -> bool:
    changed = False
    for e, bad in _bad_handles(ctx.canvas):
        if edge_ids is not None and e["id"] not in edge_ids:
            continue
        if ctx.allowed is not None and e["source"] not in ctx.allowed and e["target"] not in ctx.allowed:
            continue
        for end, side in bad.items():
            e[end + "_handle"] = side
            changed = True
    return changed


def _rule_fit_labels(ctx: _Ctx) -> bool:
    """Grows nodes whose label overflows to the size `fit_size` gives, and pushes what lies beyond a growing edge outward
    by the growth (`_make_room`), so the gaps stay. Never shrinks; locked nodes are left alone."""
    before = {n["id"]: _box(n) for n in ctx.nodes}
    growth: dict[str, tuple[float, float]] = {}
    for n in ctx.nodes:
        if n.get("locked") is True or (ctx.allowed is not None and n["id"] not in ctx.allowed):
            continue
        w, h = fit_size(n)
        if w > _w(n) + 1e-9 or h > _h(n) + 1e-9:
            growth[n["id"]] = (max(w, _w(n)) - _w(n), max(h, _h(n)) - _h(n))
            _put(n, w=max(w, _w(n)), h=max(h, _h(n)))
    if growth:
        _make_room(ctx, before, growth)
    return bool(growth)


def _widen_gap(ctx: _Ctx, info: dict) -> bool:
    """Makes room between a connector's end nodes when its label's segment is too short for the label: inserts the
    missing length after the nearer end along the segment's axis, as `_make_room` does for a grown node."""
    e = info["edge"]
    ai = 0 if abs(info["dir"][0]) >= abs(info["dir"][1]) else 1
    need = max(LABELED_MIN_GAP, info["size"][ai] + LABEL_GAP_PAD) - info["len"]
    if need <= 1e-9:
        return False
    a, b = ctx.by[e["source"]], ctx.by[e["target"]]
    near, far = sorted((a, b), key=lambda n: (_box(n)[ai] + _box(n)[ai + 2]) / 2)
    if _box(far)[ai] < _box(near)[ai + 2] - 1.0:  # the ends overlap along the axis: no gap to widen
        return False
    need = math.ceil(need)
    boxes = {n["id"]: _box(n) for n in ctx.nodes}
    return _make_room(ctx, boxes, {near["id"]: (need, 0.0) if ai == 0 else (0.0, need)}, [(ai, near["id"], far["id"])])


def _rule_place_labels(ctx: _Ctx) -> bool:
    """Sets `label_offset` on connectors whose label collides with another label or a node: the nearest offset along
    the label's segment that clears everything. A label that collides with nothing keeps its offset. When the segment
    is too short for the label and no offset clears it, the gap between the connector's end nodes is widened instead."""
    changed = False
    widened: set = set()
    for _ in range(len(_edges(ctx.canvas)) + 1):
        ch, wide = _place_labels_pass(ctx, widened)
        changed |= ch
        if not wide:
            break
    return changed


def _place_labels_pass(ctx: _Ctx, widened: set) -> tuple[bool, bool]:
    plan = _label_plan(ctx.canvas)
    solid = [_box(n) for n in ctx.nodes if n.get("type") != "frame"]
    offsets = {eid: _num(i["edge"].get("label_offset")) for eid, i in plan.items()}
    free = {eid for eid, i in plan.items() if ctx.allowed is None or i["edge"]["source"] in ctx.allowed or i["edge"]["target"] in ctx.allowed}
    settled = [eid for eid in plan if eid not in free]  # labels that may not move are obstacles from the start
    changed = False
    for eid in sorted(free, key=str):
        info = plan[eid]
        e = info["edge"]
        others = list(settled)  # a label is checked against those settled before it, so the first of a pair stays put
        settled.append(eid)

        def clear(o: float) -> bool:
            b = _label_box_at(info, o)
            return not any(_collides(b, s) for s in solid) and not any(
                _collides(b, _label_box_at(plan[k], offsets[k])) for k in others)
        if clear(offsets[eid]):
            continue
        half = int(info["len"] // 2)
        cands = sorted({v for k in range(0, half // LABEL_STEP + 1) for v in (k * LABEL_STEP, -k * LABEL_STEP)} | {half, -half},
                       key=lambda v: (abs(v), -v))
        best = next((c for c in cands if clear(c)), None)
        if best is None and eid not in widened:
            widened.add(eid)
            if _widen_gap(ctx, info):  # geometry moved: plan again from the new routes
                return True, True
        if best is None or best == offsets[eid]:
            continue
        offsets[eid] = best
        if best:
            e["label_offset"] = _clean(best)
        else:
            e.pop("label_offset", None)
        changed = True
    return changed, False


_RULE_FNS = {"fit_labels": _rule_fit_labels, "frames": _rule_frames, "overlaps": _rule_overlaps, "align": _rule_align,
             "spacing": _rule_spacing, "grid": _rule_grid, "handles": _rule_handles, "place_labels": _rule_place_labels}


def _check_rules(rules: Optional[Iterable[str]]) -> tuple[str, ...]:
    if rules is None:
        return RULES
    rules = tuple(rules)
    bad = [r for r in rules if r not in RULES]
    if bad:
        raise LayoutError(f"unknown rules: {', '.join(map(str, bad))}; use {', '.join(RULES)}")
    return tuple(r for r in RULES if r in rules)


def _diff(before: dict, after: dict) -> list[dict]:
    """Node geometry changes and connector handle changes between two canvases."""
    out = []
    old = {n["id"]: n for n in _nodes(before)}
    for n in _nodes(after):
        o = old.get(n["id"])
        if o is None:
            continue
        a = {"x": _x(o), "y": _y(o), "w": _w(o), "h": _num((o.get("size") or {}).get("h", o.get("h")), _h(o))}
        b = {"x": _x(n), "y": _y(n), "w": _w(n), "h": _num((n.get("size") or {}).get("h", n.get("h")), _h(n))}
        if any(abs(a[k] - b[k]) > 1e-9 for k in a):
            out.append({"kind": "node", "id": n["id"], "from": _round_geo(a), "to": _round_geo(b)})
    olde = {e["id"]: e for e in _edges(before)}
    for e in _edges(after):
        o = olde.get(e["id"])
        if o is None:
            continue
        a = {"source_handle": o.get("source_handle"), "target_handle": o.get("target_handle")}
        b = {"source_handle": e.get("source_handle"), "target_handle": e.get("target_handle")}
        if _num(o.get("label_offset")) != _num(e.get("label_offset")):
            a["label_offset"], b["label_offset"] = _num(o.get("label_offset")), _num(e.get("label_offset"))
        if a != b:
            out.append({"kind": "edge", "id": e["id"], "from": a, "to": b})
    return out


def _round_geo(g: dict) -> dict:
    return {k: (int(v) if float(v).is_integer() else round(v, 2)) for k, v in g.items()}


def tidy(canvas: dict, ids: Optional[Iterable[str]] = None, rules: Optional[Iterable[str]] = None,
         grid: Optional[float] = None) -> tuple[dict, list[dict]]:
    """Fix a layout with the least movement. Returns the new canvas and the changes (second call changes nothing)."""
    use = _check_rules(rules)
    ctx = _Ctx(canvas, ids, grid)
    for _ in range(8):
        changed = False
        for r in use:
            changed |= _RULE_FNS[r](ctx)
        if not changed:
            break
    return ctx.canvas, _diff(canvas, ctx.canvas)


# ---------------------------------------------------------------- arrange

def _reading_order(nodes: list[dict]) -> list[dict]:
    """Top to bottom in bands, left to right inside a band."""
    out: list[dict] = []
    rest = sorted(nodes, key=_order_key)
    while rest:
        first = rest[0]
        fb = _box(first)
        band = [n for n in rest if _box(n)[1] < fb[3] - 0.5 * (fb[3] - fb[1])]
        band_ids = {n["id"] for n in band}
        out += sorted(band, key=lambda n: (_x(n), str(n["id"])))
        rest = [n for n in rest if n["id"] not in band_ids]
    return out


def _layout_grid(ns: list[dict], cols: int, gap: float, align: str) -> dict[str, tuple[float, float]]:
    rows = [ns[i:i + cols] for i in range(0, len(ns), cols)]
    colw = [max((_w(r[c]) for r in rows if c < len(r)), default=0) for c in range(cols)]
    out, y = {}, 0.0
    for r in rows:
        rh = max(_h(n) for n in r)
        x = 0.0
        for c, n in enumerate(r):
            off = {"start": 0.0, "center": (rh - _h(n)) / 2, "end": rh - _h(n)}[align]
            out[n["id"]] = (x, y + off)
            x += colw[c] + gap
        y += rh + gap
    return out


def _layout_line(ns: list[dict], axis: str, gap: float, align: str) -> dict[str, tuple[float, float]]:
    out, cur = {}, 0.0
    cross = max((_h(n) if axis == "x" else _w(n)) for n in ns)
    for n in ns:
        size, other = (_w(n), _h(n)) if axis == "x" else (_h(n), _w(n))
        off = {"start": 0.0, "center": (cross - other) / 2, "end": cross - other}[align]
        out[n["id"]] = (cur, off) if axis == "x" else (off, cur)
        cur += size + gap
    return out


def _layers(ids: list[str], edges: list[tuple[str, str]], index: dict[str, int]) -> tuple[dict[str, int], set]:
    """Longest-path layers after reversing back edges found by a depth-first search. Returns (layer, reversed edges)."""
    succ: dict[str, list[str]] = {i: [] for i in ids}
    for a, b in edges:
        if b not in succ[a]:
            succ[a].append(b)
    state: dict[str, int] = {}
    rev: set = set()

    def dfs(u):
        state[u] = 1
        for v in sorted(succ[u], key=lambda k: index[k]):
            if state.get(v) == 1:
                rev.add((u, v))
            elif v not in state:
                dfs(v)
        state[u] = 2
    for u in sorted(ids, key=lambda k: index[k]):
        if u not in state:
            dfs(u)
    dag = [(b, a) if (a, b) in rev else (a, b) for a, b in edges]
    preds: dict[str, set] = {i: set() for i in ids}
    for a, b in dag:
        if a != b:
            preds[b].add(a)
    layer: dict[str, int] = {}

    def depth(u):
        if u not in layer:
            layer[u] = 0 if not preds[u] else 1 + max(depth(p) for p in preds[u])
        return layer[u]
    for u in ids:
        depth(u)
    return layer, rev


def _order_layers(layers: list[list[str]], edges: list[tuple[str, str]], rev: set, index: dict[str, int]) -> list[list[str]]:
    nb: dict[str, set] = {i: set() for lay in layers for i in lay}
    for a, b in edges:
        if a != b:
            nb[a].add(b)
            nb[b].add(a)
    layers = [sorted(lay, key=lambda k: index[k]) for lay in layers]
    layer_of = {i: li for li, lay in enumerate(layers) for i in lay}

    def sweep(rng, forward):
        for li in rng:
            lay = layers[li]
            rank = {i: (k / max(len(layers[layer_of[i]]) - 1, 1)) for lj in layers for k, i in enumerate(lj)}
            bary = {}
            for k, i in enumerate(lay):
                ns = [j for j in nb[i] if (layer_of[j] < li if forward else layer_of[j] > li)]
                bary[i] = sum(rank[j] for j in ns) / len(ns) if ns else rank[i]
            layers[li] = sorted(lay, key=lambda i: (bary[i], lay.index(i)))
    for _ in range(6):
        sweep(range(1, len(layers)), True)
        sweep(range(len(layers) - 2, -1, -1), False)
    return layers


def _layout_layered(ns: list[dict], edges: list[dict], direction: str, gap: float, layer_gap: float):
    by = {n["id"]: n for n in ns}
    order = _reading_order(ns)
    index = {n["id"]: i for i, n in enumerate(order)}
    pairs, seen = [], set()
    for e in edges:
        k = (e["source"], e["target"])
        if e["source"] in by and e["target"] in by and e["source"] != e["target"] and k not in seen:
            seen.add(k)
            pairs.append(k)
    ids = [n["id"] for n in order]
    layer, rev = _layers(ids, pairs, index)
    nlayers = max(layer.values(), default=0) + 1
    layers = [[i for i in ids if layer[i] == li] for li in range(nlayers)]
    dag = [(b, a) if (a, b) in rev else (a, b) for a, b in pairs]
    layers = _order_layers(layers, dag, rev, index)
    lr = direction == "LR"
    # `pos` runs inside a layer, `along` runs from layer to layer
    out: dict[str, tuple[float, float]] = {}
    along = 0.0
    totals = [sum((_h(by[i]) if lr else _w(by[i])) for i in lay) + gap * max(len(lay) - 1, 0) for lay in layers]
    widest = max(totals, default=0.0)
    for li, lay in enumerate(layers):
        thick = max(((_w(by[i]) if lr else _h(by[i])) for i in lay), default=0.0)
        pos = (widest - totals[li]) / 2
        for i in lay:
            n = by[i]
            if lr:
                out[i] = (along + (thick - _w(n)) / 2, pos)
                pos += _h(n) + gap
            else:
                out[i] = (pos, along + (thick - _h(n)) / 2)
                pos += _w(n) + gap
        along += thick + layer_gap
    return out, rev


def _shift_clear(ctx: _Ctx, movers: dict[str, tuple[float, float]], obstacles: list[dict], gap: float,
                 axes: tuple = ("x-", "x+", "y-", "y+"), then: tuple = (), max_first: Optional[float] = None) -> tuple[float, float]:
    """Smallest rigid shift of the proposed boxes that clears every obstacle. (0, 0) when nothing is in the way.

    The shift is the smallest one along `axes`. With `then`, `axes` is tried first, and only when it needs more than
    `max_first` px (or finds nothing) is the smallest shift along `then` used instead."""
    boxes = {i: (p[0], p[1], p[0] + _w(ctx.by[i]), p[1] + _h(ctx.by[i])) for i, p in movers.items()}

    def hits(dx, dy):
        for i, b in boxes.items():
            sb = (b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy)
            for o in obstacles:
                ob = _box(o)
                ox, oy = _inter(sb, ob)
                if ox > OVERLAP_TOL and oy > OVERLAP_TOL:
                    if o.get("type") == "frame":
                        a = (sb[2] - sb[0]) * (sb[3] - sb[1])
                        if ox * oy >= 0.5 * a:
                            continue  # it lands inside the frame and becomes a member
                    return True
        return False
    if not hits(0, 0):
        return (0.0, 0.0)
    bx = (min(b[0] for b in boxes.values()), min(b[1] for b in boxes.values()),
          max(b[2] for b in boxes.values()), max(b[3] for b in boxes.values()))

    def smallest(group: tuple, limit: Optional[float] = None):
        cands = []
        for o in obstacles:
            ob = _box(o)
            if "x+" in group:
                cands.append((ob[2] + gap - bx[0], 0.0))
            if "x-" in group:
                cands.append((ob[0] - gap - bx[2], 0.0))
            if "y+" in group:
                cands.append((0.0, ob[3] + gap - bx[1]))
            if "y-" in group:
                cands.append((0.0, ob[1] - gap - bx[3]))
        cands.sort(key=lambda c: (abs(c[0]) + abs(c[1]), c))
        for dx, dy in cands:
            if (limit is None or abs(dx) + abs(dy) <= limit) and not hits(dx, dy):
                return (dx, dy)
        return None
    for group, limit in ((axes, max_first if then else None), (then, None)):
        if group and (found := smallest(group, limit)) is not None:
            return found
    group = then or axes
    allb = [_box(o) for o in obstacles]
    far = max(b[2] for b in allb) + gap - bx[0] if "x+" in group else (max(b[3] for b in allb) + gap - bx[1])
    return (far, 0.0) if "x+" in group else (0.0, far)


def arrange(canvas: dict, ids: Optional[Iterable[str]], mode: str, grid: Optional[float] = None, **opts) -> tuple[dict, list[dict]]:
    """Lay nodes out from structure. Modes: grid, row, column, layered (direction LR/TB), place (relation, anchor)."""
    if mode not in ARRANGE_MODES:
        raise LayoutError(f"unknown mode {mode!r}; use {', '.join(ARRANGE_MODES)}")
    ctx = _Ctx(canvas, None, grid)
    ctx.allowed = None
    wanted = [n["id"] for n in ctx.nodes if n.get("type") != "frame"] if ids is None else list(ids)
    unknown = sorted(set(wanted) - set(ctx.by), key=str)
    if unknown:
        raise LayoutError(f"unknown ids: {', '.join(map(str, unknown))}")
    gap = _num(opts.get("gap"), 40.0)
    if gap < 0:
        raise LayoutError("gap must be 0 or more")
    side_by_side = mode == "place" and (opts.get("relation") or opts.get("rel")) in ("right_of", "left_of")
    align = opts.get("align") or ("center" if mode in ("place", "layered") and not side_by_side else "start")
    if align not in ("start", "center", "end"):
        raise LayoutError("align must be start, center or end")
    # a frame in the set carries its members, so members whose frame is also in the set are not laid out themselves
    chosen = set(wanted)
    movers = [ctx.by[i] for i in wanted if ctx.by[i].get("locked") is not True
              and not (_ancestors(i, ctx.parent) & chosen)]
    if mode == "place":
        _arrange_place(ctx, movers, opts, gap, align)
    elif not movers:
        return ctx.canvas, []
    else:
        tl = (min(_x(n) for n in movers), min(_y(n) for n in movers))
        rev: set = set()
        if mode == "grid":
            cols = int(opts.get("cols") or max(1, math.ceil(math.sqrt(len(movers)))))
            rel = _layout_grid(_reading_order(movers), max(cols, 1), gap, align)
        elif mode == "row":
            rel = _layout_line(sorted(movers, key=lambda n: (_x(n), _order_key(n))), "x", gap, align)
        elif mode == "column":
            rel = _layout_line(sorted(movers, key=_order_key), "y", gap, align)
        else:
            direction = str(opts.get("direction", "LR")).upper()
            if direction not in ("LR", "TB"):
                raise LayoutError("direction must be LR or TB")
            rel, rev = _layout_layered(movers, _edges(ctx.canvas), direction, gap, _num(opts.get("layer_gap"), 2 * gap))
        target = {i: (tl[0] + p[0], tl[1] + p[1]) for i, p in rel.items()}
        if ctx.grid:
            target = {i: (round(p[0] / ctx.grid) * ctx.grid, round(p[1] / ctx.grid) * ctx.grid) for i, p in target.items()}
        keep = set(_carried(movers, ctx))
        holders = {a for i in rel for a in _ancestors(i, ctx.parent)}  # frames the subset sits in are not in its way
        obstacles = [n for n in ctx.nodes if n["id"] not in keep and n["id"] not in holders]
        dx, dy = _shift_clear(ctx, target, obstacles, gap)
        if ctx.grid:
            dx, dy = _snap_dir(dx, ctx.grid, dx > 0), _snap_dir(dy, ctx.grid, dy > 0)
        for i, p in target.items():
            ctx.set_pos(i, p[0] + dx, p[1] + dy)
        if mode == "layered":
            lr = str(opts.get("direction", "LR")).upper() == "LR"
            inside = set(rel)
            for e in _edges(ctx.canvas):
                if e["source"] in inside and e["target"] in inside and e["source"] != e["target"]:
                    if (e["source"], e["target"]) in rev:
                        a, b = _box(ctx.by[e["source"]]), _box(ctx.by[e["target"]])
                        e["source_handle"], e["target_handle"] = _facing(a, b), _facing(b, a)
                    else:
                        e["source_handle"], e["target_handle"] = ("r", "l") if lr else ("b", "t")
    touched = {e["id"] for e in _edges(ctx.canvas) if e["source"] in chosen or e["target"] in chosen}
    _rule_handles(ctx, touched)
    return ctx.canvas, _diff(canvas, ctx.canvas)


def _carried(movers: list[dict], ctx: _Ctx) -> list[str]:
    """The movers and every member that travels with them."""
    out = []
    for n in movers:
        out += [n["id"]] + ctx.descendants(n["id"])
    return out


def _arrange_place(ctx: _Ctx, movers: list[dict], opts: dict, gap: float, align: str) -> None:
    rel = opts.get("relation") or opts.get("rel")
    if rel not in PLACE_RELATIONS:
        raise LayoutError(f"place needs relation: one of {', '.join(PLACE_RELATIONS)}")
    anchor = ctx.by.get(opts.get("anchor"))
    if anchor is None:
        raise LayoutError("place needs an anchor id that exists")
    ns = [n for n in movers if n["id"] != anchor["id"]]
    if not ns:
        return
    ab = _box(anchor)
    if rel == "inside":
        if anchor.get("type") != "frame":
            raise LayoutError("inside needs an anchor that is a frame")
        pad, top = FRAME_PAD, FRAME_PAD + 20
        inner_w = max(ab[2] - ab[0] - 2 * pad, max(_w(n) for n in ns))
        cols = 1  # as many columns as fit the frame's width
        while cols < len(ns):
            w = sum(sorted((_w(n) for n in ns), reverse=True)[:cols + 1]) + gap * cols
            if w > inner_w:
                break
            cols += 1
        rel_pos = _layout_grid(_reading_order(ns), cols, gap, "start")
        existing = [m for m in ctx.nodes if m["id"] != anchor["id"] and m["id"] not in {n["id"] for n in ns}
                    and ctx.parent.get(m["id"]) == anchor["id"]]
        y0 = max([_box(m)[3] + gap for m in existing], default=ab[1] + top)
        for n in ns:
            ctx.set_pos(n["id"], ab[0] + pad + rel_pos[n["id"]][0], y0 + rel_pos[n["id"]][1])
        # grow the frame to hold them
        ctx.refresh()
        fb = list(ab)
        for n in ns:
            b = _box(n)
            fb = [min(fb[0], b[0] - pad), min(fb[1], b[1] - pad), max(fb[2], b[2] + pad), max(fb[3], b[3] + pad)]
        if ctx.grid:
            fb = [_snap_dir(fb[0], ctx.grid, False), _snap_dir(fb[1], ctx.grid, False),
                  _snap_dir(fb[2], ctx.grid, True), _snap_dir(fb[3], ctx.grid, True)]
        if anchor.get("locked") is not True:
            _put(anchor, x=fb[0], y=fb[1], w=fb[2] - fb[0], h=fb[3] - fb[1])
        return
    horizontal = rel in ("right_of", "left_of")
    stack = _layout_line(_reading_order(ns) if horizontal else sorted(ns, key=lambda n: (_x(n), _order_key(n))),
                         "y" if horizontal else "x", _num(opts.get("spacing"), 24.0), align)
    sw = max(p[0] + _w(ctx.by[i]) for i, p in stack.items())
    sh = max(p[1] + _h(ctx.by[i]) for i, p in stack.items())
    if horizontal:
        x0 = ab[2] + gap if rel == "right_of" else ab[0] - gap - sw
        y0 = {"start": ab[1], "center": (ab[1] + ab[3]) / 2 - sh / 2, "end": ab[3] - sh}[align]
    else:
        y0 = ab[3] + gap if rel == "below" else ab[1] - gap - sh
        x0 = {"start": ab[0], "center": (ab[0] + ab[2]) / 2 - sw / 2, "end": ab[2] - sw}[align]
    target = {i: (x0 + p[0], y0 + p[1]) for i, p in stack.items()}
    if ctx.grid:
        target = {i: (round(p[0] / ctx.grid) * ctx.grid, round(p[1] / ctx.grid) * ctx.grid) for i, p in target.items()}
    keep = set(_carried(ns, ctx)) | {anchor["id"]}
    holders = {a for i in stack for a in _ancestors(i, ctx.parent)} | _ancestors(anchor["id"], ctx.parent)
    obstacles = [n for n in ctx.nodes if n["id"] not in keep and n["id"] not in holders]
    axis = {"right_of": ("x+",), "left_of": ("x-",), "below": ("y+",), "above": ("y-",)}[rel]
    if horizontal:  # beside the anchor: when blocked, move down first and only then along the requested side
        dx, dy = _shift_clear(ctx, target, obstacles, gap, ("y+",), axis, PLACE_DOWN_MAX)
    else:
        dx, dy = _shift_clear(ctx, target, obstacles, gap, axis)
    for i, p in target.items():
        ctx.set_pos(i, p[0] + dx, p[1] + dy)


# ---------------------------------------------------------------- describe

def _fmt(n: dict) -> str:
    t = _text_of(n)
    label = f' "{t[:28]}"' if t else ""
    return f'{n["id"]}{label} {_clip(_x(n))},{_clip(_y(n))} {_clip(_w(n))}x{_clip(_h(n))}'


def _clip(v: float) -> str:
    return str(int(round(v)))


def describe(canvas: dict, max_lines: int = 60, verbose: bool = False, grid: Optional[float] = None) -> str:
    """A compact text summary for a language model: frames, a coarse map, connectors and the top issues."""
    nodes, edges = _nodes(canvas), _edges(canvas)
    by = {n["id"]: n for n in nodes}
    parent = _parents(nodes)
    rep = doctor(canvas, grid)
    kinds: dict[str, int] = {}
    for n in nodes:
        kinds[n.get("type", "?")] = kinds.get(n.get("type", "?"), 0) + 1
    out: list[str] = []
    if nodes:
        x1, y1 = min(_box(n)[0] for n in nodes), min(_box(n)[1] for n in nodes)
        x2, y2 = max(_box(n)[2] for n in nodes), max(_box(n)[3] for n in nodes)
        extent = f"; extent x {_clip(x1)}..{_clip(x2)}, y {_clip(y1)}..{_clip(y2)} px"
    else:
        extent = ""
    out.append(f'Canvas "{canvas.get("name", "")}": {len(nodes)} nodes ({", ".join(f"{v} {k}" for k, v in sorted(kinds.items()))}), '
               f'{len(edges)} connectors{extent}. Layout score {rep["score"]}/100.')
    out.append("Position is x,y then WxH in px, origin top-left, y grows downward.")
    budget = max(max_lines - len(out) - 1, 12)
    frames = [n for n in nodes if n.get("type") == "frame"]
    n_issue = min(len(rep["issues"]), max(4, budget // 6))
    n_edge = max(3, budget * 3 // 10)
    n_frame = min(len(frames), max(2, budget // 8))
    n_map = max(budget - n_issue - n_edge - n_frame - 3, 6)
    if frames:
        out.append("Frames:")
        for f in frames[:n_frame]:
            mem = [k for k, p in parent.items() if p == f["id"]]
            names = ", ".join(f'{k}' for k in mem[:10]) + (f" +{len(mem) - 10} more" if len(mem) > 10 else "")
            out.append(f"  {_fmt(f)} holds {len(mem)}: {names or 'nothing'}")
        if len(frames) > n_frame:
            out.append(f"  +{len(frames) - n_frame} more frames")
    flat = [n for n in nodes if n.get("type") != "frame"]
    if verbose:
        out.append("Nodes:")
        out += [f"  {_fmt(n)} ({n.get('type')}){' in ' + parent[n['id']] if n['id'] in parent else ''}" for n in sorted(flat, key=_order_key)]
    elif flat:
        out.append("Map, reading order (id label x,y WxH):")
        out += _spatial_map(flat, parent, n_map)
    if edges:
        out.append("Connectors:")
        grouped: dict[str, list[str]] = {}
        for e in edges:
            tgt = e["target"] + (f' ({e["label"]})' if e.get("label") else "")
            grouped.setdefault(e["source"], []).append(tgt)
        lines = [f"  {s} → {', '.join(ts)}" for s, ts in sorted(grouped.items(), key=lambda kv: (_y(by[kv[0]]), _x(by[kv[0]])) if kv[0] in by else (0, 0))]
        out += lines[:n_edge]
        if len(lines) > n_edge:
            out.append(f"  +{len(lines) - n_edge} more sources")
    m = rep["metrics"]
    out.append(f'Metrics: overlap {m["overlap_area"]:g} px², crossings {m["edge_crossings"]}, alignment {m["alignment_score"]:g}, '
               f'whitespace {m["whitespace_ratio"]:g}.')
    if rep["issues"]:
        out.append("Top issues:")
        for i in rep["issues"][:n_issue]:
            out.append(f'  [{i["severity"]}] {i["message"]}' + (" (fixable by tidy)" if i["fix"] else ""))
        if len(rep["issues"]) > n_issue:
            out.append(f'  +{len(rep["issues"]) - n_issue} more; call doctor for all')
    else:
        out.append("No layout issues.")
    return "\n".join(out[: max(max_lines, 10)])


def _spatial_map(flat: list[dict], parent: dict[str, str], limit: int) -> list[str]:
    """Rows of nodes in reading order. Falls back to a 3 x 3 region map when there are too many rows."""
    rows: list[list[dict]] = []
    for n in sorted(flat, key=lambda n: ((_y(n) + _h(n) / 2), _x(n), str(n["id"]))):
        for r in rows:
            a = _box(r[0])
            b = _box(n)
            if min(a[3], b[3]) - max(a[1], b[1]) >= 0.5 * min(a[3] - a[1], b[3] - b[1]):
                r.append(n)
                break
        else:
            rows.append([n])
    per = 8

    def line(prefix, ns):
        ns = sorted(ns, key=lambda n: (_x(n), str(n["id"])))
        txt = "; ".join(_fmt(n) + (f" in {parent[n['id']]}" if n["id"] in parent else "") for n in ns[:per])
        return f"  {prefix}: {txt}" + (f" +{len(ns) - per} more" if len(ns) > per else "")
    if len(rows) <= limit:
        return [line(f"row {i + 1}", r) for i, r in enumerate(rows)]
    x1, y1 = min(_x(n) for n in flat), min(_y(n) for n in flat)
    x2, y2 = max(_x(n) + _w(n) for n in flat), max(_y(n) + _h(n) for n in flat)
    names = (("top", "middle", "bottom"), ("left", "center", "right"))
    cells: dict[tuple, list] = {}
    for n in flat:
        cx, cy = _x(n) + _w(n) / 2, _y(n) + _h(n) / 2
        r = min(2, int(3 * (cy - y1) / max(y2 - y1, 1)))
        c = min(2, int(3 * (cx - x1) / max(x2 - x1, 1)))
        cells.setdefault((r, c), []).append(n)
    return [line(f"{names[0][r]}-{names[1][c]}", ns) for (r, c), ns in sorted(cells.items())]


# ---------------------------------------------------------------- render

_FILLS = {"query": ("#dbeafe", "#2563eb"), "table": ("#dcfce7", "#16a34a"), "note": ("#fef9c3", "#ca8a04"),
          "chart": ("#ede9fe", "#7c3aed"), "shape": ("#ffffff", "#1f2328"), "sticky": ("#fef9c3", "#ca8a04"),
          "frame": ("#f3f4f6", "#6b7280"), "placeholder": ("#ffedd5", "#ea580c"), "text": (None, None)}


def _color(v: Any, default: Optional[str]) -> Optional[str]:
    if isinstance(v, str) and v.startswith("#") and len(v) in (4, 7) and all(c in "0123456789abcdefABCDEF" for c in v[1:]):
        return v
    return default


def render_png(canvas: dict, width: int = 1200, highlight: Optional[Iterable[str]] = None) -> bytes:
    """A schematic picture: boxes by type with ids and truncated labels, connectors with arrowheads, issue nodes outlined."""
    from PIL import Image, ImageDraw, ImageFont

    width = int(min(max(width, 200), 4000))
    nodes = _nodes(canvas)
    hi = set(highlight or [])
    pad = 30
    if nodes:
        x1, y1 = min(_box(n)[0] for n in nodes), min(_box(n)[1] for n in nodes)
        x2, y2 = max(_box(n)[2] for n in nodes), max(_box(n)[3] for n in nodes)
    else:
        x1 = y1 = 0.0
        x2 = y2 = 100.0
    scale = min((width - 2 * pad) / max(x2 - x1, 1), 1.5)
    height = int(min(max((y2 - y1) * scale + 2 * pad, 120), 4000))
    scale = min(scale, (height - 2 * pad) / max(y2 - y1, 1))

    def tx(p):
        return (pad + (p[0] - x1) * scale, pad + (p[1] - y1) * scale)

    def font(size):
        try:
            return ImageFont.load_default(size=size)
        except TypeError:  # Pillow before 10.1 has one fixed size
            return ImageFont.load_default()
    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)
    # Labels scale with the boxes (the page's 14 px default), so a label the doctor says fits also fits the picture.
    f_lab, f_id = font(max(9, int(14 * scale))), font(9)
    by = {n["id"]: n for n in nodes}
    for n in sorted(nodes, key=lambda n: (_num(n.get("z"), -1 if n.get("type") == "frame" else 0), 0)):
        b = _box(n)
        a, c = tx((b[0], b[1])), tx((b[2], b[3]))
        fill, line = _FILLS.get(n.get("type"), ("#ffffff", "#1f2328"))
        fill, line = _color(n.get("fill"), fill), _color(n.get("stroke"), line)
        shape = n.get("shape") if n.get("type") == "shape" else None
        if n.get("type") == "text":
            pass
        elif shape == "ellipse":
            d.ellipse([a, c], fill=fill, outline=line, width=2)
        elif shape == "diamond":
            mx, my = (a[0] + c[0]) / 2, (a[1] + c[1]) / 2
            d.polygon([(mx, a[1]), (c[0], my), (mx, c[1]), (a[0], my)], fill=fill, outline=line)
        elif shape == "rounded":
            d.rounded_rectangle([a, c], radius=8, fill=fill, outline=line, width=2)
        else:
            d.rectangle([a, c], fill=fill, outline=line, width=2)
        text = _text_of(n)
        if n.get("type") == "placeholder":
            text = str((n.get("placeholder") or {}).get("name") or "")
        if n.get("type") == "frame":
            tpos = (a[0] + 6, a[1] + 3)
        else:
            tw = d.textlength(text, font=f_lab) if text else 0
            maxw = max(c[0] - a[0] - 8, 8)
            while text and tw > maxw and len(text) > 1:
                text = text.rstrip("…")[:-1] + "…"
                tw = d.textlength(text, font=f_lab)
            tpos = ((a[0] + c[0]) / 2 - tw / 2, (a[1] + c[1]) / 2 - 7)
        if text:
            d.text(tpos, text, fill="#111827", font=f_lab)
        d.text((a[0] + 3, a[1] + 1 if n.get("type") != "frame" else c[1] - 11), str(n["id"]), fill="#6b7280", font=f_id)
        if n["id"] in hi:
            d.rectangle([(a[0] - 3, a[1] - 3), (c[0] + 3, c[1] + 3)], outline="#dc2626", width=3)
    by_edge = {e["id"]: e for e in _edges(canvas)}
    for e, pts in _polylines(canvas):
        col = _color(e.get("color"), "#4b5563")
        sp = [tx(p) for p in pts]
        d.line(sp, fill=col, width=2)
        for end, other in ((sp[-1], sp[-2]), (sp[0], sp[1])):
            if (end is sp[-1] and e.get("arrow_end", True)) or (end is sp[0] and e.get("arrow_start", False)):
                ang = math.atan2(end[1] - other[1], end[0] - other[0])
                d.polygon([end, (end[0] - 9 * math.cos(ang - 0.4), end[1] - 9 * math.sin(ang - 0.4)),
                           (end[0] - 9 * math.cos(ang + 0.4), end[1] - 9 * math.sin(ang + 0.4))], fill=col)
    f_edge = font(max(8, int(12 * scale)))
    for eid, (bx1, by1, bx2, by2) in edge_label_boxes(canvas).items():
        a, c = tx((bx1, by1)), tx((bx2, by2))
        d.rectangle([a, c], fill="white", outline="#9ca3af")
        d.multiline_text(((a[0] + c[0]) / 2, (a[1] + c[1]) / 2), str(by_edge[eid].get("label")), fill="#374151", font=f_edge,
                         anchor="mm", align="center")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
