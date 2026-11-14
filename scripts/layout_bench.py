"""Benchmark for layout.tidy: perturb generated canvases the way an LLM does, tidy them, print doctor metrics before and after.

Run:  python scripts/layout_bench.py [--seed N] [--grid 20]
"""
import argparse
import copy
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import layout  # noqa: E402


def _node(nid, x, y, w=140, h=60, kind="shape", **extra):
    n = {"id": nid, "type": kind, "position": {"x": x, "y": y}, "size": {"w": w, "h": h}}
    if kind == "shape":
        n.update(shape="rounded", label=nid)
    elif kind == "query":
        n.update(title=nid, sql="SELECT 1")
    elif kind == "frame":
        n.update(label=nid)
    n.update(extra)
    return n


def _edge(i, a, b, sh="r", th="l"):
    return {"id": f"e{i}", "source": a, "target": b, "source_handle": sh, "target_handle": th, "line": "step"}


def gen_flow():
    """A layered flow: 3 sources, 2 cleaning steps, a join, 2 marts and a report, drawn left to right."""
    cols = [["src_a", "src_b", "src_c"], ["clean_a", "clean_b"], ["join"], ["mart_x", "mart_y"], ["report"]]
    nodes = []
    for ci, col in enumerate(cols):
        for ri, nid in enumerate(col):
            nodes.append(_node(nid, ci * 260, ri * 120 + (ci % 2) * 60))
    links = [("src_a", "clean_a"), ("src_b", "clean_b"), ("src_c", "clean_b"), ("clean_a", "join"), ("clean_b", "join"),
             ("join", "mart_x"), ("join", "mart_y"), ("mart_x", "report"), ("mart_y", "report")]
    edges = [_edge(i, a, b) for i, (a, b) in enumerate(links)]
    return {"version": 2, "name": "flow", "profile": None, "windows": nodes, "edges": edges}


def gen_query_grid():
    """A 4 x 3 grid of query windows with a few connectors."""
    nodes = [_node(f"q{r}{c}", c * 420, r * 300, 380, 260, "query") for r in range(3) for c in range(4)]
    edges = [_edge(0, "q00", "q01"), _edge(1, "q01", "q02"), _edge(2, "q02", "q03"), _edge(3, "q10", "q11"),
             _edge(4, "q11", "q12"), _edge(5, "q21", "q22"), _edge(6, "q00", "q10", "b", "t"), _edge(7, "q12", "q22", "b", "t")]
    return {"version": 2, "name": "grid", "profile": None, "windows": nodes, "edges": edges}


def gen_frames():
    """Three frames with four members each, and connectors between members."""
    nodes, edges = [], []
    for fi in range(3):
        x0 = fi * 520
        nodes.append(_node(f"zone{fi}", x0, 0, 460, 360, "frame", z=-1))
        for mi in range(4):
            nodes.append(_node(f"z{fi}m{mi}", x0 + 30 + (mi % 2) * 210, 60 + (mi // 2) * 140, 180, 80))
    links = [("z0m1", "z1m0"), ("z1m1", "z2m0"), ("z0m3", "z1m2"), ("z1m3", "z2m2"), ("z0m0", "z0m3", "b", "t")]
    edges = [_edge(i, *lk) for i, lk in enumerate(links)]
    return {"version": 2, "name": "frames", "profile": None, "windows": nodes, "edges": edges}


GENERATORS = {"flow": gen_flow, "query grid": gen_query_grid, "frames": gen_frames}


def perturb(canvas, seed):
    """Jitter every node, push some into overlaps, nudge some off alignment and put some connectors on the wrong sides."""
    rng = random.Random(seed)
    c = copy.deepcopy(canvas)
    nodes = [n for n in c["windows"] if n["type"] != "frame"]
    for n in nodes:  # jitter: whole-pixel noise of up to 6 px each way
        n["position"]["x"] += rng.randint(-6, 6)
        n["position"]["y"] += rng.randint(-6, 6)
    for n in rng.sample(nodes, max(1, len(nodes) // 6)):  # off-by-a-few: a node drifts 3 to 5 px
        n["position"]["y"] += rng.choice([-1, 1]) * rng.randint(3, 5)
    for n in rng.sample(nodes, max(1, len(nodes) // 6)):  # overlap: slide onto a neighbor by a quarter of its width
        other = min((m for m in nodes if m is not n), key=lambda m: (abs(m["position"]["x"] - n["position"]["x"])
                                                                   + abs(m["position"]["y"] - n["position"]["y"]), m["id"]))
        n["position"]["x"] = other["position"]["x"] + other["size"]["w"] * 0.75
        n["position"]["y"] = other["position"]["y"] + rng.randint(-10, 20)
    for e in rng.sample(c["edges"], max(1, len(c["edges"]) // 3)):  # wrong sides
        e["source_handle"], e["target_handle"] = e["target_handle"], e["source_handle"]
    return c


def _row(label, rep):
    m = rep["metrics"]
    return (f"{label:<9} score {rep['score']:>3}  overlap {m['overlap_area']:>7.0f}  crossings {m['edge_crossings']:>2}  "
            f"align {m['alignment_score']:.2f}  edge len {m['edge_length_mean']:>5.0f} (var {m['edge_length_variance']:>7.0f})  "
            f"issues {len(rep['issues']):>2}")


def run(seed=7, grid=None):
    """Prints before and after for each scenario. Returns {name: (before_score, after_score, second_tidy_changes)}."""
    results = {}
    for name, gen in GENERATORS.items():
        clean = gen()
        broken = perturb(clean, seed)
        fixed, changes = layout.tidy(broken, grid=grid)
        again = layout.tidy(fixed, grid=grid)[1]
        before, after = layout.doctor(broken, grid), layout.doctor(fixed, grid)
        moved = [c for c in changes if c["kind"] == "node"]
        shift = [abs(c["to"]["x"] - c["from"]["x"]) + abs(c["to"]["y"] - c["from"]["y"]) for c in moved]
        print(f"== {name}: {len(clean['windows'])} nodes, {len(clean['edges'])} connectors")
        print("  " + _row("clean", layout.doctor(clean, grid)))
        print("  " + _row("perturbed", before))
        print("  " + _row("tidied", after))
        print(f"  tidy moved {len(moved)} nodes (mean {sum(shift) / len(shift) if shift else 0:.0f} px), "
              f"changed {len(changes) - len(moved)} connectors; second tidy changes: {len(again)}")
        results[name] = (before["score"], after["score"], len(again))
    return results


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--grid", type=float, default=None, help="grid snap size; omit for no snap")
    a = ap.parse_args()
    run(a.seed, a.grid)
