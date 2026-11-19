"""Saved Graph diagrams under data/diagrams/<name>.json: names, revisions, a trash copy on delete, and building a diagram from tables and edges.

No Flask and no Databricks calls. The file format is the one the Graph tab writes (web/src/graph/diagram.ts):
{name, saved_at, focus_schema, nodes: [{data, position}], edges: [{data}]}, positions being node centers.
"""
import json
import os
import re
import threading
from collections import Counter
from typing import Optional

from . import dbx
from .edge_families import FLOW_KINDS

LOCK = threading.RLock()  # one writer at a time, so an agent's read-modify-write cannot interleave with a save
NAME_MAX = 120
LINEAGE_FLOW = FLOW_KINDS  # the flow kinds set the left-to-right order; the rest (references and meaning links) hang beside them
DERIVED_KINDS = ("fk", "lineage", "view_dep")


class GraphInvalid(ValueError):
    """The graph or its name failed validation (routes return it as HTTP 400)."""


class GraphNotFound(LookupError):
    """No saved graph with that name (routes return HTTP 404)."""


class GraphConflict(RuntimeError):
    """The graph was saved by someone else since the revision the writer started from (routes return HTTP 409)."""

    def __init__(self, name: str, expected: int, info: dict):
        super().__init__(f"graph {name} was saved by {info['by'] or 'someone else'} since revision {expected} (now revision {info['revision']})")
        self.info = info


# ---------------------------------------------------------------- the files

def _atomic_write(path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def stem_of(name) -> str:
    """The file stem a graph name is stored under: the name with anything but letters, digits, _ . - turned into _."""
    if not isinstance(name, str) or not name.strip():
        raise GraphInvalid("name: required")
    name = name.strip()
    if len(name) > NAME_MAX:
        raise GraphInvalid(f"name: at most {NAME_MAX} characters")
    if name.startswith("."):
        raise GraphInvalid("name: must not start with a dot")
    return dbx.safe(name)


def path_for(stem: str):
    return dbx.DIAGRAMS / f"{stem}.json"


def history_dir(stem: str):
    """data/diagram_history/<stem>/: the revision counter of one graph. It outlives a delete, so a later graph of the same name keeps counting."""
    return dbx.DIAGRAMS.parent / "diagram_history" / stem


def trash_dir():
    return dbx.DIAGRAMS / ".trash"


def list_graphs() -> list[str]:
    """The stored names (file stems), sorted."""
    return sorted(p.stem for p in dbx.DIAGRAMS.glob("*.json"))


def resolve(name) -> str:
    """The stored name for a name as typed or as stored (`Returns graph` and `Returns_graph`). GraphNotFound when there is none."""
    stem = stem_of(name)
    stored = list_graphs()  # not is_file(): on a case-insensitive disk that would accept a wrong-case stem
    if stem in stored:
        return stem
    same = [s for s in stored if s.lower() == stem.lower()]
    if len(same) == 1:
        return same[0]
    raise GraphNotFound(f"graph not found: {name}")


def exists(name) -> bool:
    try:
        resolve(name)
        return True
    except (GraphNotFound, GraphInvalid):
        return False


def _meta(stem: str) -> dict:
    try:
        meta = json.loads((history_dir(stem) / "meta.json").read_text(encoding="utf-8"))
        return meta if isinstance(meta, dict) else {}
    except (OSError, ValueError):
        return {}


def revision_info(name) -> dict:
    """{"name", "revision", "by"} for a saved graph. `by` is ui or agent (None before any save with revisions; revision 0 then)."""
    with LOCK:
        stem = resolve(name)
        meta = _meta(stem)
        revision = meta.get("revision") if isinstance(meta.get("revision"), int) else 0
        return {"name": stem, "revision": revision, "by": meta.get("by") if revision else None}


def load_graph(name) -> dict:
    """The stored diagram as saved."""
    stem = resolve(name)
    try:
        data = json.loads(path_for(stem).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise GraphInvalid(f"{stem}: unreadable ({e})") from e
    if not isinstance(data, dict):
        raise GraphInvalid(f"{stem}: not a diagram")
    return data


def check_body(data) -> str:
    """Validate a diagram body: an object with a name, and lists for nodes and edges when present. Returns the stored name."""
    if not isinstance(data, dict):
        raise GraphInvalid("(root): a diagram must be an object")
    for key in ("nodes", "edges"):
        if key in data and not isinstance(data[key], list):
            raise GraphInvalid(f"{key}: must be a list")
    return stem_of(data.get("name"))


def write_graph(data: dict, by: str = "ui", expect: Optional[int] = None, create_only: bool = False) -> tuple[str, int]:
    """Validate and write data/diagrams/<name>.json with a fresh saved_at. Returns (stored name, revision).

    Every write bumps the revision and records who made it (`by`: ui or agent). With `expect`, the write is refused
    (GraphConflict) when the graph exists and is not at that revision, so the page cannot overwrite an agent's newer save unseen.
    With `create_only` it is refused when the name is taken."""
    stem = check_body(data)
    text = json.dumps({**data, "name": data["name"].strip(), "saved_at": dbx.now()}, indent=2, allow_nan=False)
    with LOCK:
        clash = [s for s in list_graphs() if s.lower() == stem.lower() and s != stem]
        if clash:  # Windows and macOS treat these as one file
            raise GraphInvalid(f"name: '{data['name']}' differs from existing graph '{clash[0]}' only by case; pick another name")
        path = path_for(stem)
        if create_only and path.is_file():
            raise GraphInvalid(f"graph '{stem}' already exists; use update_graph to change it")
        meta = _meta(stem)
        old = meta.get("revision") if isinstance(meta.get("revision"), int) else 0
        if expect is not None and path.is_file() and old != expect:
            raise GraphConflict(stem, expect, revision_info(stem))
        _atomic_write(path, text)
        _atomic_write(history_dir(stem) / "meta.json", json.dumps({"revision": old + 1, "by": by}))
        return stem, old + 1


def delete_graph(name) -> str:
    """Move a saved graph to data/diagrams/.trash/ (it is not deleted outright). Returns the trash file's name."""
    with LOCK:
        stem = resolve(name)
        info = revision_info(stem)
        stamp = dbx.now().replace(":", "").replace("-", "").replace("+0000", "Z")
        target = trash_dir() / f"{stem}.{stamp}.r{info['revision']}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        n = 1
        while target.exists():
            n += 1
            target = trash_dir() / f"{stem}.{stamp}.r{info['revision']}-{n}.json"
        os.replace(path_for(stem), target)
        return target.name


def rename_graph(name, new_name, by: str = "ui") -> tuple[str, int]:
    """Rename a saved graph (the name inside the file too). Returns (new stored name, its revision, one past the old one)."""
    with LOCK:
        stem = resolve(name)
        new_stem = stem_of(new_name)
        if new_stem == stem and new_name.strip() == load_graph(stem).get("name"):
            raise GraphInvalid(f"graph already has the name {new_name!r}")
        if new_stem != stem and new_stem.lower() == stem.lower():
            raise GraphInvalid("a rename that changes only the case is not allowed (Windows and macOS keep one file)")
        taken = [s for s in list_graphs() if s.lower() == new_stem.lower() and s != stem]
        if taken:
            raise GraphInvalid(f"a graph named '{taken[0]}' already exists")
        data = load_graph(stem)
        old = revision_info(stem)["revision"]
        text = json.dumps({**data, "name": new_name.strip(), "saved_at": dbx.now()}, indent=2, allow_nan=False)
        _atomic_write(path_for(new_stem), text)
        _atomic_write(history_dir(new_stem) / "meta.json",
                      json.dumps({"revision": max(old, _meta(new_stem).get("revision") or 0) + 1, "by": by}))
        if new_stem != stem:
            path_for(stem).unlink()
        return new_stem, revision_info(new_stem)["revision"]


# ---------------------------------------------------------------- reading a diagram

def summary(data: dict) -> dict:
    """{"nodes", "edges", "focus_schema", "saved_at"}: the counts and facts a listing needs, from a stored diagram of either UI's format."""
    nodes = [n for n in data.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("data"), dict)]
    edges = [e for e in data.get("edges") or [] if isinstance(e, dict) and isinstance(e.get("data"), dict)]
    return {"nodes": len(nodes), "edges": len(edges), "focus_schema": data.get("focus_schema"), "saved_at": data.get("saved_at")}


# ---------------------------------------------------------------- edges as the Graph draws them (web/src/graph/relationships.ts)

def adapt_edge(r: dict) -> dict:
    """One table-level relationship (an /api/relationships edge) as a graph edge, with the legacy fields (child_columns, last_seen, ...)."""
    info = {"id": r["id"], "source": r["source"]["table"], "target": r["target"]["table"], "kind": r["kind"],
            "directed": r.get("directed", True), "status": r.get("status"), "note": r.get("note", ""),
            "provenance": r.get("provenance"),
            "patch_ids": [r["id"]] if r["kind"] in DERIVED_KINDS else (r.get("members") or [r["id"]])}
    if r.get("evidence"):
        info["evidence"] = r["evidence"]
        if r["evidence"].get("last_seen"):
            info["last_seen"] = r["evidence"]["last_seen"]
    if r["kind"] == "fk":
        pairs = r.get("columns") or []
        info["constraint"] = (r.get("provenance") or {}).get("source_ref")
        info["child_columns"] = [c["source"] for c in pairs if c.get("source")]
        info["parent_columns"] = [c["target"] for c in pairs if c.get("target")]
        info["label"] = ", ".join(info["child_columns"])
    return info


def graph_edges(rels: list[dict]) -> list[dict]:
    """Relationships as graph edges. Lineage seen in both directions is one `bidir` edge with the id `lineage:<a><-><b>` (names sorted)."""
    out, lineage = [], {}
    for r in rels:
        info = adapt_edge(r)
        if r["kind"] != "lineage":
            out.append(info)
            continue
        pair = "<->".join(sorted([info["source"], info["target"]]))
        direction = f"{info['source']}->{info['target']}"
        merged = lineage.get(pair)
        if merged is None:
            info["id"] = f"lineage:{pair}"
            info["bidir"] = False
            info["last_seen_by_dir"] = {direction: info.get("last_seen", "")}
            lineage[pair] = info
            out.append(info)
            continue
        if direction not in merged["last_seen_by_dir"]:
            merged["bidir"] = True
        merged["last_seen_by_dir"][direction] = info.get("last_seen", "")
        merged["last_seen"] = max(filter(None, [merged.get("last_seen"), info.get("last_seen")]), default=None) or merged.get("last_seen")
        merged["patch_ids"] = [*merged["patch_ids"], *info["patch_ids"]]
        merged["note"] = merged.get("note") or info.get("note", "")
    return out


# ---------------------------------------------------------------- layout (the Graph's rules, left to right)

RANK_SEP, NODE_SEP, COMPONENT_GAP, CLEAR = 110, 24, 60, 16


def estimate_size(lines: list[str]) -> tuple[float, float]:
    """The size the page estimates for a node before React Flow measures it (web/src/graph/layout.ts estimateSize)."""
    longest = max([0, *(len(l) for l in lines)])
    return float(min(240, max(60, round(longest * 6.8) + 18))), float(len(lines) * 16 + 16)


def layout_positions(sizes: dict[str, tuple[float, float]], edges: list[tuple[str, str, str]]) -> dict[str, tuple[float, float]]:
    """Top-left positions for nodes (id -> (width, height)) and edges (source, target, kind), flowing left to right.

    Lineage and view dependencies set the columns (a source is left of what is built from it). A node with only
    references (foreign keys, joins) joins the column of the node it refers to or is referred by. Parts of the graph
    with no edge between them are stacked top to bottom. Deterministic: the order of `sizes` breaks every tie."""
    ids = list(sizes)
    index = {i: n for n, i in enumerate(ids)}
    live = [(s, t, k) for s, t, k in edges if s in index and t in index and s != t]
    parent = {i: i for i in ids}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for s, t, _ in live:
        parent[find(s)] = find(t)
    parts: dict[str, list[str]] = {}
    for i in ids:
        parts.setdefault(find(i), []).append(i)
    out: dict[str, tuple[float, float]] = {}
    top = 0.0
    for members in parts.values():
        mset = set(members)
        flow = [(s, t) for s, t, k in live if s in mset and k in LINEAGE_FLOW]
        refs = [(s, t) for s, t, k in live if s in mset and k not in LINEAGE_FLOW]
        rank = {i: 0 for i in members}
        for _ in range(len(members)):  # longest path; a cycle stops growing at the part's size
            moved = False
            for s, t in flow:
                if rank[s] + 1 > rank[t] and rank[s] + 1 < len(members):
                    rank[t] = rank[s] + 1
                    moved = True
            if not moved:
                break
        touched = {i for e in flow for i in e}
        settled = set(touched)
        pending = [i for i in members if i not in settled]
        while pending and settled:  # a reference-only node takes the column of a partner that has one
            nxt = []
            for i in pending:
                partner = next((b if a == i else a for a, b in refs if i in (a, b) and (b if a == i else a) in settled), None)
                if partner is None:
                    nxt.append(i)
                else:
                    rank[i] = rank[partner]
                    settled.add(i)
            if len(nxt) == len(pending):
                break
            pending = nxt
        columns: dict[int, list[str]] = {}
        for i in members:
            columns.setdefault(rank[i], []).append(i)
        nbrs: dict[str, list[str]] = {i: [] for i in members}
        for a, b in flow + refs:
            nbrs[a].append(b)
            nbrs[b].append(a)
        placed: dict[str, float] = {}
        heights, widths, order = {}, {}, {}
        for r in sorted(columns):
            col = columns[r]
            if placed:
                col.sort(key=lambda i: (sum(placed[n] for n in nbrs[i] if n in placed) / max(1, sum(1 for n in nbrs[i] if n in placed))
                                        if any(n in placed for n in nbrs[i]) else float(index[i]), index[i]))
            else:
                col.sort(key=lambda i: index[i])
            for n, i in enumerate(col):
                placed[i] = float(n)
            order[r] = col
            heights[r] = sum(sizes[i][1] for i in col) + NODE_SEP * (len(col) - 1)
            widths[r] = max(sizes[i][0] for i in col)
        tallest = max(heights.values())
        x = 0.0
        bottom = top
        for r in sorted(order):
            y = top + (tallest - heights[r]) / 2
            for i in order[r]:
                out[i] = (x + (widths[r] - sizes[i][0]) / 2, y)
                y += sizes[i][1] + NODE_SEP
            x += widths[r] + RANK_SEP
            bottom = max(bottom, top + (tallest - heights[r]) / 2 + heights[r])
        top = bottom + COMPONENT_GAP
    return out


def _clear_of(box, others) -> Optional[tuple]:
    for o in others:
        if box[0] < o[2] + CLEAR and o[0] < box[2] + CLEAR and box[1] < o[3] + CLEAR and o[1] < box[3] + CLEAR:
            return o
    return None


def build_body(name: str, nodes: list[dict], edges: list[dict], previous: Optional[dict] = None, relayout: bool = False) -> dict:
    """A diagram body from `nodes` ({id, kind, focus?, self_ref?, self_ref_last_seen?, self_ref_fks?, files?}, in the order to lay out) and graph `edges`.

    Every node is pinned (added on purpose, so the Graph's edge filters never hide it). The focus schema is the focus
    node's, else the most common schema. With `previous` (a stored diagram), nodes already in it keep their positions
    unless `relayout`; new nodes take the layout's positions, moved clear of the others."""
    focus = next((n for n in nodes if n.get("focus")), None)
    schemas = Counter(n["id"].rsplit(".", 1)[0] for n in nodes)
    focus_schema = (focus["id"].rsplit(".", 1)[0] if focus else max(schemas, key=lambda s: (schemas[s], -list(schemas).index(s)))) if nodes else None
    via = {e["target"]: ", ".join(e.get("child_columns") or []) for e in edges if e["kind"] == "fk"}
    label = {n["id"]: n["id"].rsplit(".", 1)[-1] for n in nodes}
    external = {n["id"]: n["id"].rsplit(".", 1)[0] != focus_schema for n in nodes}
    sizes = {n["id"]: estimate_size([label[n["id"]], *([n["id"].rsplit(".", 1)[0]] if external[n["id"]] else []),
                                     *([f"via {via[n['id']]}"] if via.get(n["id"]) else [])]) for n in nodes}
    load = {i: estimate_size([label[i], i.rsplit(".", 1)[0]]) for i in label}  # the size the page assumes when it reads the file
    fresh = layout_positions(sizes, [(e["source"], e["target"], e["kind"]) for e in edges])
    kept = {}
    if previous and not relayout:
        for n in previous.get("nodes") or []:
            d, p = (n or {}).get("data") or {}, (n or {}).get("position") or {}
            if d.get("id") in sizes and isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
                w, h = load[d["id"]]
                kept[d["id"]] = (p["x"] - w / 2, p["y"] - h / 2)
    top_left = dict(fresh)
    if kept:
        dx = sum(kept[i][0] - fresh[i][0] for i in kept) / len(kept)
        dy = sum(kept[i][1] - fresh[i][1] for i in kept) / len(kept)
        top_left = {i: kept.get(i, (fresh[i][0] + dx, fresh[i][1] + dy)) for i in sizes}
        boxes = [(*top_left[i], top_left[i][0] + sizes[i][0], top_left[i][1] + sizes[i][1]) for i in kept]
        for i in (i for i in sizes if i not in kept):
            x, y = top_left[i]
            for _ in range(len(sizes) + 1):
                hit = _clear_of((x, y, x + sizes[i][0], y + sizes[i][1]), boxes)
                if not hit:
                    break
                y = hit[3] + CLEAR + 4
            top_left[i] = (x, y)
            boxes.append((x, y, x + sizes[i][0], y + sizes[i][1]))
    out_nodes = []
    for n in nodes:
        i = n["id"]
        data = {"id": i, "label": label[i], "kind": n.get("kind") or "table", "external": external[i], "pinned": True}
        if n.get("focus"):
            data["focus"] = True
        if n.get("self_ref"):
            data["self_ref"] = True
            if n.get("self_ref_last_seen"):
                data["self_ref_last_seen"] = n["self_ref_last_seen"]
        for key in ("self_ref_fks", "files"):  # facts about the node itself, shown as markers
            if n.get(key):
                data[key] = n[key]
        if via.get(i):
            data["via"] = via[i]
        w, h = load[i]
        out_nodes.append({"data": data, "position": {"x": round(top_left[i][0] + w / 2), "y": round(top_left[i][1] + h / 2)}})
    return {"name": name, "focus_schema": focus_schema, "nodes": out_nodes, "edges": [{"data": e} for e in edges]}
