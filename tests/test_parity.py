"""Parity of the logic that lives twice, in Python (for agents and the saved files) and in TypeScript (the page).

Each file in tests/fixtures/parity/ holds cases {name, input, expected}. This module runs the Python side on every case and
web/src/parity.test.ts runs the TypeScript side on the same files, so neither copy can drift without a test failing. After a
deliberate change to a twin, review the diff of the fixtures and rewrite their expectations with
`PARITY_REGEN=1 uv run pytest tests/test_parity.py`."""
import json
import os
from pathlib import Path

import pytest

from databricks_explore import edge_families, graph_collapse, graph_export, graph_lens, graphs

FIXTURES = Path(__file__).parent / "fixtures" / "parity"
SHARED_LEGEND = {"data flows", "key reference", "dashed: inferred or proposed", graph_export._END_TEXT}  # the lines both legends word the same way
REGEN = os.environ.get("PARITY_REGEN") == "1"


def clean(value):
    """The value as JSON, without nulls and with floats rounded: the two languages leave different things unset."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return round(value, 1) if isinstance(value, float) else value


def edges_of(case):
    return [{"id": f"{e['source']}->{e['target']}", **e} for e in case["edges"]]


def shift_to_origin(positions: dict) -> dict:
    left, top = min(x for x, _ in positions.values()), min(y for _, y in positions.values())
    return {i: [round(x - left, 1), round(y - top, 1)] for i, (x, y) in positions.items()}


def broken_rules(positions: dict, sizes: dict, spec: dict) -> list:
    """The rules of a layout that do not hold: overlaps, and the spec's left_of and below pairs. The same function is in parity.test.ts."""
    box = {i: (positions[i][0], positions[i][1], positions[i][0] + sizes[i][0], positions[i][1] + sizes[i][1]) for i in sizes}
    out = [f"{a} overlaps {b}" for a in box for b in box if a < b and box[a][0] < box[b][2] and box[b][0] < box[a][2] and box[a][1] < box[b][3] and box[b][1] < box[a][3]]
    out += [f"{a} is not left of {b}" for a, b in spec.get("left_of", []) if box[a][2] > box[b][0]]
    out += [f"{a} is not below {b}" for a, b in spec.get("below", []) if box[a][1] < box[b][3]]
    return out


def run_graph_edges(case):
    return graphs.graph_edges(case["relationships"])


def run_edge_families(case):
    return {k: edge_families.family_of(k) for k in case["kinds"]}


def run_roles(case):
    return graph_lens.roles(case["ids"], case["edges"])


def run_model_layout(case):
    return shift_to_origin(graph_lens.model_layout({i: tuple(s) for i, s in case["sizes"].items()}, case["edges"]))


def run_estimate_size(case):
    return list(graphs.estimate_size(case["lines"]))


def run_legend(case):
    return [t for t in graph_export.legend(case["lens"], case["edges"], case["cards"], case["keys"]) if t in SHARED_LEGEND]


def run_collapse(case):
    p = graph_collapse.plan(case["nodes"], case["edges"], case["grouping"], case.get("tags"))
    return {"groups": [{k: g[k] for k in ("key", "label", "tables", "collapsed", "default_collapsed")} for g in p["groups"]],
            "chains": [{k: c[k] for k in ("id", "source", "target", "views", "edges")} for c in p["chains"]]}


def run_flow_layout(case):
    sizes = {i: tuple(s) for i, s in case["sizes"].items()}
    return broken_rules(graphs.layout_positions(sizes, [(e["source"], e["target"], e["kind"]) for e in case["edges"]], case.get("focus")), sizes, case.get("expected") or {})


RUNNERS = {"graph_edges": run_graph_edges, "edge_families": run_edge_families, "roles": run_roles, "model_layout": run_model_layout,
           "estimate_size": run_estimate_size, "legend": run_legend, "collapse": run_collapse, "flow_layout": run_flow_layout}


def all_cases():
    for path in sorted(FIXTURES.glob("*.json")):
        for n, case in enumerate(json.loads(path.read_text(encoding="utf-8"))["cases"]):
            yield pytest.param(path.stem, n, id=f"{path.stem}: {case['name']}")


def test_every_fixture_has_a_python_runner():
    assert {p.stem for p in FIXTURES.glob("*.json")} == set(RUNNERS)


@pytest.mark.parametrize("stem,n", all_cases())
def test_the_python_side_gives_the_shared_answer(stem, n):
    path = FIXTURES / f"{stem}.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    case = {**doc["cases"][n]["input"], "expected": doc["cases"][n].get("expected")}
    actual = clean(RUNNERS[stem](case))
    if stem == "flow_layout":  # the expectation is a set of rules, not positions
        assert actual == [], actual
        return
    if REGEN:
        doc["cases"][n]["expected"] = actual
        path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        return
    assert actual == doc["cases"][n]["expected"]
