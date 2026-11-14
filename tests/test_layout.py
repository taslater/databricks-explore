"""layout.py: doctor, tidy, arrange, describe and render_png on hand-built canvases and on perturbed generated ones."""
import copy
import random
import struct
import sys
from pathlib import Path

import pytest

import layout

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import layout_bench  # noqa: E402


def node(nid, x, y, w=120, h=60, kind="shape", **extra):
    n = {"id": nid, "type": kind, "position": {"x": x, "y": y}, "size": {"w": w, "h": h}}
    if kind == "shape":
        n.update(shape="rect", label=nid)
    elif kind == "frame":
        n.update(label=nid)
    n.update(extra)
    return n


def edge(eid, a, b, sh=None, th=None, **extra):
    e = {"id": eid, "source": a, "target": b, "line": "step"}
    if sh:
        e["source_handle"] = sh
    if th:
        e["target_handle"] = th
    e.update(extra)
    return e


def canvas(nodes, edges=(), **extra):
    return {"version": 2, "name": "t", "profile": None, "windows": list(nodes), "edges": list(edges), **extra}


def kinds(report):
    return sorted({i["kind"] for i in report["issues"]})


def pos(c, nid):
    n = next(n for n in c["windows"] if n["id"] == nid)
    return n["position"]["x"], n["position"]["y"]


def box_of(c, nid):
    n = next(n for n in c["windows"] if n["id"] == nid)
    return layout._box(n)


# ---------------------------------------------------------------- doctor

def test_clean_canvas_scores_100():
    c = canvas([node("a", 0, 0), node("b", 200, 0)], [edge("e", "a", "b", "r", "l")])
    r = layout.doctor(c)
    assert r["score"] == 100 and r["issues"] == []
    assert r["metrics"]["overlap_area"] == 0 and r["metrics"]["edge_crossings"] == 0


def test_overlap_reported_with_tolerance_and_fix():
    r = layout.doctor(canvas([node("a", 0, 0), node("b", 100, 20)]))
    [i] = [i for i in r["issues"] if i["kind"] == "overlap"]
    assert i["severity"] == "error" and i["nodes"] == ["a", "b"] and i["fix"]["rules"] == ["overlaps"]
    assert r["metrics"]["overlap_area"] == 20 * 40
    assert "overlap" not in kinds(layout.doctor(canvas([node("a", 0, 0), node("b", 119, 0)])))  # 1 px of touching is fine


def test_frame_members_do_not_overlap_their_frame():
    c = canvas([node("f", 0, 0, 400, 300, "frame"), node("a", 20, 40), node("b", 200, 40)])
    assert "overlap" not in kinds(layout.doctor(c))
    assert "overlap" in kinds(layout.doctor(canvas([node("f", 0, 0, 400, 300, "frame"), node("a", 380, 40)])))  # mostly outside


@pytest.mark.parametrize("dy,flagged", [(0, False), (1, True), (3, True), (6, True), (9, False)])
def test_near_alignment_window(dy, flagged):
    r = layout.doctor(canvas([node("a", 0, 0), node("b", 300, dy)]))
    assert ("near_alignment" in kinds(r)) == flagged


def test_near_alignment_names_the_edge_and_nodes():
    r = layout.doctor(canvas([node("a", 0, 0), node("b", 300, 4), node("c", 600, 0)]))
    [i] = [i for i in r["issues"] if i["kind"] == "near_alignment"]
    assert set(i["nodes"]) == {"a", "b", "c"} and "top" in i["id"] and i["fix"]["rules"] == ["align"]


def test_uneven_spacing_in_a_row():
    c = canvas([node("a", 0, 0), node("b", 160, 0), node("c", 330, 0), node("d", 560, 0)])  # gaps 40, 50, 110
    r = layout.doctor(c)
    assert "uneven_spacing" in kinds(r)
    even = canvas([node("a", 0, 0), node("b", 160, 0), node("c", 320, 0), node("d", 480, 0)])
    assert "uneven_spacing" not in kinds(layout.doctor(even))


def test_edge_through_node_ignores_endpoints_and_counts_crossings():
    c = canvas([node("a", 0, 0), node("m", 200, 0), node("b", 400, 0)], [edge("e", "a", "b", "r", "l")])
    r = layout.doctor(c)
    [i] = [i for i in r["issues"] if i["kind"] == "edge_through_node"]
    assert i["nodes"] == ["a", "b", "m"] and i["edges"] == ["e"]
    x = canvas([node("a", 0, 0), node("b", 400, 300), node("c", 400, 0), node("d", 0, 300)],
               [edge("e1", "a", "b", "r", "l", line="straight"), edge("e2", "c", "d", "l", "r", line="straight")])
    r = layout.doctor(x)
    assert r["metrics"]["edge_crossings"] == 1
    assert [i["count"] for i in r["issues"] if i["kind"] == "edge_crossings"] == [1]


def test_connectors_sharing_a_node_do_not_cross():
    c = canvas([node("a", 0, 100), node("b", 400, 0), node("c", 400, 200)],
               [edge("e1", "a", "b", "r", "l", line="straight"), edge("e2", "a", "c", "r", "l", line="straight")])
    assert layout.doctor(c)["metrics"]["edge_crossings"] == 0


def test_bad_handle_side():
    c = canvas([node("a", 0, 0), node("b", 300, 0)], [edge("e", "a", "b", "l", "r")])
    [i] = [i for i in layout.doctor(c)["issues"] if i["kind"] == "bad_handle_side"]
    assert i["edges"] == ["e"] and i["fix"]["rules"] == ["handles"]
    ok = canvas([node("a", 0, 0), node("b", 300, 0)], [edge("e", "a", "b", "r", "l")])
    assert "bad_handle_side" not in kinds(layout.doctor(ok))
    unset = canvas([node("a", 0, 0), node("b", 300, 0)], [edge("e", "a", "b")])
    assert "bad_handle_side" not in kinds(layout.doctor(unset))


def test_outside_frame_and_its_fix():
    c = canvas([node("f", 0, 0, 300, 300, "frame"), node("a", 20, 20), node("b", 240, 100)])  # b is 60 of 120 px inside
    [i] = [i for i in layout.doctor(c)["issues"] if i["kind"] == "outside_frame"]
    assert i["nodes"] == ["b", "f"]
    locked = canvas([node("f", 0, 0, 300, 300, "frame", locked=True), node("b", 240, 100)])
    assert [i["fix"] for i in layout.doctor(locked)["issues"] if i["kind"] == "outside_frame"] == [None]


def test_label_overflow():
    long = node("a", 0, 0, 80, 30, label="A very long label that cannot possibly fit")
    r = layout.doctor(canvas([long, node("b", 200, 0)]))
    [i] = [i for i in r["issues"] if i["kind"] == "label_overflow"]
    assert i["needs"]["w"] > 0 and i["fix"] is None
    assert "label_overflow" not in kinds(layout.doctor(canvas([node("a", 0, 0, 120, 60, label="Orders")])))


def test_far_away_needs_an_outlier():
    near = [node(f"n{i}", (i % 3) * 200, (i // 3) * 100) for i in range(6)]
    assert "far_away" not in kinds(layout.doctor(canvas(near)))
    r = layout.doctor(canvas(near + [node("lost", 9000, 9000)]))
    assert [i["nodes"] for i in r["issues"] if i["kind"] == "far_away"] == [["lost"]]


def test_off_grid_only_when_grid_is_on():
    c = canvas([node("a", 3, 0), node("b", 200, 0)])
    assert "off_grid" not in kinds(layout.doctor(c))
    assert [i["nodes"] for i in layout.doctor(c, grid=20)["issues"] if i["kind"] == "off_grid"] == [["a"]]
    assert "off_grid" in kinds(layout.doctor({**c, "grid": 20}))


def test_flat_geometry_is_read_too():
    flat = canvas([{"id": "a", "type": "shape", "shape": "rect", "x": 0, "y": 0, "w": 100, "h": 50},
                   {"id": "b", "type": "shape", "shape": "rect", "x": 50, "y": 10, "w": 100, "h": 50}])
    assert "overlap" in kinds(layout.doctor(flat))
    fixed, ch = layout.tidy(flat)
    assert "x" in fixed["windows"][1] and ch[0]["id"] == "b"


def test_doctor_does_not_mutate_and_is_deterministic():
    c = layout_bench.perturb(layout_bench.gen_flow(), 3)
    before = copy.deepcopy(c)
    r1, r2 = layout.doctor(c), layout.doctor(c)
    assert c == before and r1 == r2
    assert r1["issues"] == sorted(r1["issues"], key=lambda i: ({"error": 0, "warning": 1, "info": 2}[i["severity"]], i["kind"], i["id"]))
    assert 0 <= r1["score"] <= 100 and {"score", "metrics", "issues"} == set(r1)
    for i in r1["issues"]:
        assert {"id", "kind", "severity", "nodes", "message", "fix"} <= set(i)


def test_metrics_shape():
    m = layout.doctor(layout_bench.gen_flow())["metrics"]
    for k in ("overlap_area", "edge_crossings", "edge_length_mean", "edge_length_variance", "alignment_score", "whitespace_ratio"):
        assert k in m
    assert 0 <= m["whitespace_ratio"] <= 1 and m["edge_length_mean"] > 0


def test_empty_canvas():
    r = layout.doctor(canvas([]))
    assert r["score"] == 100 and r["issues"] == []
    assert layout.describe(canvas([])).startswith('Canvas "t": 0 nodes')


# ---------------------------------------------------------------- tidy

def test_tidy_separates_overlap_and_keeps_order():
    c = canvas([node("a", 0, 0), node("b", 100, 10)])
    fixed, changes = layout.tidy(c)
    assert pos(fixed, "a") == (0, 0)  # the earlier node stays
    assert pos(fixed, "b")[0] >= 128  # right of a, with a gap
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0
    [ch] = [c for c in changes if c["id"] == "b"]
    assert ch["from"] == {"x": 100, "y": 10, "w": 120, "h": 60} and ch["to"]["w"] == 120 and ch["kind"] == "node"


def test_tidy_pushes_down_when_vertical_penetration_is_smaller():
    fixed, _ = layout.tidy(canvas([node("a", 0, 0), node("b", 10, 50)]))
    assert pos(fixed, "b")[1] >= 68 and pos(fixed, "b")[0] == 10


def test_tidy_never_moves_locked_and_moves_the_other():
    c = canvas([node("a", 0, 0), node("b", 100, 10, locked=True)])
    fixed, changes = layout.tidy(c)
    assert pos(fixed, "b") == (100, 10) and pos(fixed, "a")[0] <= -8 - 120 + 100 + 8  # a moved left of b
    assert [ch["id"] for ch in changes] == ["a"]
    both = canvas([node("a", 0, 0, locked=True), node("b", 100, 10, locked=True)])
    assert layout.tidy(both)[1] == []


def test_tidy_does_not_mutate_input():
    c = canvas([node("a", 0, 0), node("b", 100, 10)])
    before = copy.deepcopy(c)
    layout.tidy(c)
    assert c == before


def test_tidy_ids_limits_what_moves():
    c = canvas([node("a", 0, 0), node("b", 100, 30), node("c", 300, 4), node("d", 600, 0)])
    fixed, changes = layout.tidy(c, ids=["c"])
    assert {ch["id"] for ch in changes} == {"c"}  # the overlap of a and b is left alone
    assert pos(fixed, "b") == (100, 30)


def test_tidy_rules_are_switchable():
    c = canvas([node("a", 0, 0), node("b", 100, 10), node("c", 400, 4), node("d", 700, 0)], [edge("e", "a", "d", "l", "r")])
    only_overlap, ch = layout.tidy(c, rules=["overlaps"])
    assert {x["kind"] for x in ch} == {"node"} and pos(only_overlap, "c") == (400, 4)
    only_handles, ch = layout.tidy(c, rules=["handles"])
    assert [x["kind"] for x in ch] == ["edge"]
    with pytest.raises(layout.LayoutError):
        layout.tidy(c, rules=["nonsense"])
    with pytest.raises(layout.LayoutError):
        layout.tidy(c, ids=["zzz"])


def test_tidy_aligns_near_misses_with_the_fewest_moves():
    c = canvas([node("a", 0, 0), node("b", 300, 4), node("c", 600, 0)])
    fixed, changes = layout.tidy(c)
    assert pos(fixed, "b") == (300, 0) and [ch["id"] for ch in changes] == ["b"]


def test_tidy_aligns_to_a_locked_node():
    c = canvas([node("a", 0, 5, locked=True), node("b", 300, 0)])
    fixed, _ = layout.tidy(c)
    assert pos(fixed, "a") == (0, 5) and pos(fixed, "b") == (300, 5)


def test_tidy_evens_spacing_keeping_the_ends():
    c = canvas([node("a", 0, 0), node("b", 160, 0), node("c", 330, 0), node("d", 540, 0)])
    fixed, _ = layout.tidy(c)
    xs = [pos(fixed, i)[0] for i in "abcd"]
    gaps = [xs[i + 1] - xs[i] - 120 for i in range(3)]
    assert xs[0] == 0 and xs[3] == 540 and max(gaps) - min(gaps) <= 1


def test_tidy_snaps_to_grid_only_with_a_grid():
    c = canvas([node("a", 3, 7), node("b", 203, 7)])
    assert pos(layout.tidy(c)[0], "a") == (3, 7)
    fixed, _ = layout.tidy(c, grid=20)
    assert pos(fixed, "a") == (0, 0) and pos(fixed, "b") == (200, 0)
    assert "off_grid" not in kinds(layout.doctor(fixed, grid=20))


def test_tidy_repicks_connector_sides():
    c = canvas([node("a", 0, 0), node("b", 300, 0)], [edge("e", "a", "b", "l", "r")])
    fixed, changes = layout.tidy(c)
    e = fixed["edges"][0]
    assert (e["source_handle"], e["target_handle"]) == ("r", "l")
    assert changes == [{"kind": "edge", "id": "e", "from": {"source_handle": "l", "target_handle": "r"},
                        "to": {"source_handle": "r", "target_handle": "l"}}]


def test_tidy_grows_a_frame_and_moves_members_with_it():
    c = canvas([node("f", 0, 0, 300, 300, "frame"), node("a", 20, 20), node("b", 240, 100)])
    fixed, changes = layout.tidy(c)
    fb = box_of(fixed, "f")
    for nid in ("a", "b"):
        b = box_of(fixed, nid)
        assert b[0] >= fb[0] and b[2] <= fb[2] and b[1] >= fb[1] and b[3] <= fb[3]
    assert [ch["id"] for ch in changes] == ["f"]
    moved, _ = layout.tidy(canvas([node("f", 0, 0, 300, 300, "frame"), node("a", 20, 20), node("o", 310, 0, 100, 100),
                                   node("p", 300, 0, 100, 100)]), rules=["overlaps"])
    assert pos(moved, "f") == (0, 0)


def test_overlapping_frames_move_with_members():
    c = canvas([node("f1", 0, 0, 300, 300, "frame"), node("a", 20, 40), node("f2", 250, 0, 300, 300, "frame"), node("b", 280, 40)])
    fixed, _ = layout.tidy(c)
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0
    # b stays inside f2 by the same shift
    assert box_of(fixed, "b")[0] - box_of(fixed, "f2")[0] == 30


def test_tidy_is_idempotent_by_hand():
    c = canvas([node("a", 0, 0), node("b", 100, 10), node("c", 400, 4), node("d", 700, 0)], [edge("e", "a", "d", "l", "r")])
    once, _ = layout.tidy(c)
    assert layout.tidy(once)[1] == []


@pytest.mark.parametrize("grid", [None, 20])
@pytest.mark.parametrize("gen", sorted(layout_bench.GENERATORS))
def test_tidy_idempotent_and_overlap_free_on_perturbed_canvases(gen, grid):
    for seed in range(40):
        broken = layout_bench.perturb(layout_bench.GENERATORS[gen](), seed)
        before = copy.deepcopy(broken)
        fixed, changes = layout.tidy(broken, grid=grid)
        assert broken == before
        again, more = layout.tidy(fixed, grid=grid)
        assert more == [] and again == fixed, f"{gen} seed {seed} grid {grid}: {more[:3]}"
        rep = layout.doctor(fixed, grid)
        assert rep["metrics"]["overlap_area"] == 0, f"{gen} seed {seed}"
        assert not [i for i in rep["issues"] if i["kind"] in ("bad_handle_side", "near_alignment", "uneven_spacing",
                                                               "outside_frame", "off_grid")], f"{gen} seed {seed} {kinds(rep)}"
        assert rep["score"] >= layout.doctor(broken, grid)["score"]
        assert changes == layout._diff(broken, fixed)


def test_tidy_with_locked_nodes_is_idempotent():
    for seed in range(20):
        broken = layout_bench.perturb(layout_bench.gen_query_grid(), seed)
        rng = random.Random(seed)
        for n in rng.sample(broken["windows"], 3):
            n["locked"] = True
        fixed, _ = layout.tidy(broken)
        assert layout.tidy(fixed)[1] == []
        for a, b in zip(broken["windows"], fixed["windows"]):
            if a.get("locked"):
                assert a["position"] == b["position"] and a["size"] == b["size"]


# ---------------------------------------------------------------- arrange

def test_row_keeps_the_top_left_and_uses_the_gap():
    c = canvas([node("a", 100, 50), node("b", 400, 400), node("c", 50, 900)])
    fixed, _ = layout.arrange(c, ["a", "b", "c"], "row", gap=30)
    xs = sorted(pos(fixed, i)[0] for i in "abc")
    assert xs[0] == 50  # the subset's left edge stayed
    assert min(pos(fixed, i)[1] for i in "abc") == 50
    ordered = sorted("abc", key=lambda i: pos(fixed, i)[0])
    assert ordered == ["c", "a", "b"]  # left to right by where they were
    assert pos(fixed, ordered[1])[0] - pos(fixed, ordered[0])[0] == 150


def test_column_and_grid():
    c = canvas([node(f"n{i}", i * 13, i * 7) for i in range(6)])
    col, _ = layout.arrange(c, None, "column", gap=20)
    ys = sorted(pos(col, f"n{i}")[1] for i in range(6))
    assert [b - a for a, b in zip(ys, ys[1:])] == [80] * 5
    grid, _ = layout.arrange(c, None, "grid", cols=3, gap=20)
    xs = sorted({pos(grid, f"n{i}")[0] for i in range(6)})
    assert len(xs) == 3 and len({pos(grid, f"n{i}")[1] for i in range(6)}) == 2
    assert layout.doctor(grid)["metrics"]["overlap_area"] == 0


def test_arrange_subset_does_not_move_others_or_overlap_them():
    c = canvas([node("a", 0, 0), node("b", 300, 0), node("c", 130, 0, 60, 60)])  # c sits in the row's way
    fixed, changes = layout.arrange(c, ["a", "b"], "column", gap=10)
    assert pos(fixed, "c") == (130, 0)
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0
    assert {ch["id"] for ch in changes} <= {"a", "b"}


def test_arrange_leaves_locked_alone_and_rejects_bad_input():
    c = canvas([node("a", 0, 0, locked=True), node("b", 300, 200)])
    fixed, _ = layout.arrange(c, ["a", "b"], "row")
    assert pos(fixed, "a") == (0, 0)
    for bad in (lambda: layout.arrange(c, ["a"], "spiral"), lambda: layout.arrange(c, ["nope"], "row"),
                lambda: layout.arrange(c, ["a"], "row", gap=-1), lambda: layout.arrange(c, ["b"], "layered", direction="up"),
                lambda: layout.arrange(c, ["b"], "place", relation="sideways", anchor="a"),
                lambda: layout.arrange(c, ["b"], "place", relation="right_of", anchor="zz")):
        with pytest.raises(layout.LayoutError):
            bad()


def flow_canvas():
    nodes = [node(i, x, y) for i, x, y in (("a", 500, 400), ("b", 0, 0), ("c", 300, 300), ("d", 40, 600), ("e", 700, 10))]
    links = [("a", "c"), ("b", "c"), ("c", "d"), ("c", "e")]
    return canvas(nodes, [edge(f"e{i}", s, t) for i, (s, t) in enumerate(links)])


def test_layered_lr_puts_sources_left_of_targets():
    fixed, changes = layout.arrange(flow_canvas(), None, "layered", direction="LR", gap=30)
    xa, xb, xc, xd, xe = (pos(fixed, i)[0] for i in "abcde")
    assert xa == xb < xc < xd == xe
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0
    assert all((e["source_handle"], e["target_handle"]) == ("r", "l") for e in fixed["edges"])
    assert min(pos(fixed, i)[0] for i in "abcde") == 0 and min(pos(fixed, i)[1] for i in "abcde") == 0  # top-left kept


def test_layered_tb_puts_sources_above_targets():
    fixed, _ = layout.arrange(flow_canvas(), None, "layered", direction="TB")
    ya, yb, yc, yd, ye = (pos(fixed, i)[1] for i in "abcde")
    assert ya == yb < yc < yd == ye
    assert all((e["source_handle"], e["target_handle"]) == ("b", "t") for e in fixed["edges"])


def test_layered_handles_cycles_and_isolated_nodes():
    c = canvas([node("a", 0, 0), node("b", 10, 200), node("c", 20, 400), node("z", 900, 900)],
               [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")])
    fixed, _ = layout.arrange(c, None, "layered")
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0
    xs = [pos(fixed, i)[0] for i in "abc"]
    assert xs[0] < xs[1] < xs[2]  # the back edge is reversed, so the chain stays a chain


def test_layered_reduces_crossings():
    nodes = [node("s1", 0, 0), node("s2", 0, 100), node("t1", 400, 0), node("t2", 400, 100)]
    c = canvas(nodes, [edge("e1", "s1", "t2", line="straight"), edge("e2", "s2", "t1", line="straight")])
    assert layout.doctor(c)["metrics"]["edge_crossings"] == 1
    fixed, _ = layout.arrange(c, None, "layered")
    assert layout.doctor(fixed)["metrics"]["edge_crossings"] == 0


def test_layered_does_not_overlap_nodes_outside_the_subset():
    c = flow_canvas()
    c["windows"].append(node("x", 0, 0, 300, 300))  # a large bystander on the subset's top-left
    ids = ["a", "b", "c", "d", "e"]
    fixed, changes = layout.arrange(c, ids, "layered")
    assert pos(fixed, "x") == (0, 0)
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0


def test_place_relations():
    c = canvas([node("anchor", 400, 300, 200, 100), node("n", 0, 0, 100, 40), node("m", 0, 100, 100, 40)])
    right, _ = layout.arrange(c, ["n"], "place", relation="right_of", anchor="anchor", gap=50)
    assert pos(right, "n") == (650, 330)  # right of the anchor, centered on it
    below, _ = layout.arrange(c, ["n"], "place", relation="below", anchor="anchor", gap=20)
    assert pos(below, "n") == (450, 420)
    left, _ = layout.arrange(c, ["n"], "place", relation="left_of", anchor="anchor", gap=10, align="start")
    assert pos(left, "n") == (290, 300)
    above, _ = layout.arrange(c, ["n", "m"], "place", relation="above", anchor="anchor", gap=10)
    assert box_of(above, "n")[3] <= 290 and box_of(above, "m")[3] <= 290
    assert layout.doctor(above)["metrics"]["overlap_area"] == 0


def test_place_shifts_along_the_direction_to_clear_a_bystander():
    c = canvas([node("anchor", 0, 0), node("n", 900, 900), node("block", 160, 0)])
    fixed, _ = layout.arrange(c, ["n"], "place", relation="right_of", anchor="anchor", gap=40)
    assert pos(fixed, "n")[0] >= 160 + 120
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0


def test_place_inside_grows_the_frame():
    c = canvas([node("f", 0, 0, 300, 200, "frame")] + [node(f"n{i}", 1000, i * 100, 120, 60) for i in range(6)])
    fixed, _ = layout.arrange(c, [f"n{i}" for i in range(6)], "place", relation="inside", anchor="f", gap=20)
    fb = box_of(fixed, "f")
    for i in range(6):
        b = box_of(fixed, f"n{i}")
        assert b[0] >= fb[0] and b[2] <= fb[2] and b[1] >= fb[1] and b[3] <= fb[3]
    assert fb[3] > 200  # it had to grow
    assert layout.doctor(fixed)["metrics"]["overlap_area"] == 0
    with pytest.raises(layout.LayoutError):
        layout.arrange(c, ["n0"], "place", relation="inside", anchor="n1")


def test_arrange_respects_grid():
    c = canvas([node("a", 3, 3), node("b", 77, 5)])
    fixed, _ = layout.arrange(c, None, "row", gap=40, grid=20)
    assert all(pos(fixed, i)[0] % 20 == 0 and pos(fixed, i)[1] % 20 == 0 for i in "ab")


# ---------------------------------------------------------------- describe

def big_canvas(n=50):
    nodes = [node(f"n{i}", (i % 10) * 220, (i // 10) * 120, label=f"Table {i}") for i in range(n)]
    nodes.append(node("fr", -20, -20, 480, 160, "frame", label="Raw"))
    edges = [edge(f"e{i}", f"n{i}", f"n{i + 1}", "r", "l", label="join" if i % 7 == 0 else None) for i in range(n - 1)]
    for e in edges:
        if e["label"] is None:
            del e["label"]
    return canvas(nodes, edges, name="big")


def test_describe_is_compact_and_informative():
    text = layout.describe(big_canvas(50))
    lines = text.split("\n")
    assert len(lines) <= 60
    assert 'Canvas "big"' in lines[0] and "score" in lines[0]
    assert "Frames:" in text and "Raw" in text and "holds" in text
    assert "→" in text and "(join)" in text
    assert "n0" in text and "Table 0" in text


def test_describe_flags_issues_and_falls_back_to_regions():
    rng = random.Random(1)
    messy = canvas([node(f"n{i}", rng.randint(0, 5000), rng.randint(0, 5000)) for i in range(50)] + [node("x", 10, 10), node("y", 20, 20)])
    text = layout.describe(messy)
    assert len(text.split("\n")) <= 60
    assert "Top issues:" in text and "overlap" in text
    assert any(w in text for w in ("top-left", "middle-center", "bottom-right"))


def test_describe_verbose_lists_every_node():
    text = layout.describe(canvas([node("a", 0, 0), node("b", 200, 0)]), verbose=True)
    assert "Nodes:" in text and 'a "a"' in text and "(shape)" in text


# ---------------------------------------------------------------- render

def png_size(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    return struct.unpack(">II", data[16:24])


def test_render_png_sizes_and_highlight():
    c = layout_bench.gen_frames()
    plain = layout.render_png(c, width=900)
    w, h = png_size(plain)
    assert w == 900 and 100 < h < 4001
    marked = layout.render_png(c, width=900, highlight=["z0m0"])
    assert marked != plain
    assert layout.render_png(c, width=900) == plain  # deterministic


def test_render_png_handles_empty_and_odd_nodes():
    assert png_size(layout.render_png(canvas([])))[0] == 1200
    odd = canvas([node("t", 0, 0, 200, 40, "text", label="x" * 200), node("p", 0, 100, 200, 100, "placeholder", placeholder={"id": "x", "name": "dim_customer"}),
                  node("d", 300, 0, shape="diamond"), node("q", 300, 100, 300, 200, "query", title="query_1", collapsed=True)],
                 [edge("e", "t", "q", "r", "l", label="hi", color="#ff0000", arrow_start=True)])
    assert png_size(layout.render_png(odd, width=400))[0] == 400
