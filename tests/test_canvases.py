"""Canvas persistence: validation, save/load round trip, list, and the /api/canvases routes.

Run from the repo root:  .venv/Scripts/python.exe -m pytest tests/test_canvases.py -q
Every test points canvases.CANVASES at tmp_path, so the real data/canvases is never written.
"""
import copy
import json
from pathlib import Path

import pytest

from databricks_explore import app as app_module
from databricks_explore import canvases

# The example from contracts/api.md, section 3.
EXAMPLE = {
    "version": 1, "name": "hours", "profile": "dev", "warehouse_id": "abc123",
    "viewport": {"x": 0, "y": 0, "zoom": 1},
    "windows": [
        {"id": "w1", "type": "query", "title": "daily_hours", "position": {"x": 0, "y": 0},
         "size": {"w": 520, "h": 360}, "sql": "SELECT day, hours FROM main.default.hours", "collapsed": False},
        {"id": "w2", "type": "query", "title": "long_days", "position": {"x": 560, "y": 0},
         "size": {"w": 520, "h": 360}, "sql": "SELECT * FROM {{daily_hours}} WHERE hours > 8", "collapsed": False},
    ],
    "links": [{"from": "w1", "to": "w2"}],
}


@pytest.fixture
def cdir(tmp_path, monkeypatch):
    d = tmp_path / "canvases"
    d.mkdir()
    monkeypatch.setattr(canvases, "CANVASES", d)
    return d


@pytest.fixture
def client(cdir):
    return app_module.app.test_client()


def example():
    return copy.deepcopy(EXAMPLE)


# ---------- round trip ----------

def test_example_round_trips_unchanged(cdir):
    assert canvases.save_canvas(example()) == "hours"
    assert canvases.load_canvas("hours") == EXAMPLE


def test_example_round_trips_through_routes(client):
    resp = client.post("/api/canvases", json=example())
    assert resp.status_code == 200
    assert resp.get_json()["saved"] == "hours"
    resp = client.get("/api/canvases/hours")
    assert resp.status_code == 200
    assert resp.get_json() == EXAMPLE


def test_stored_body_gets_no_added_fields(cdir):
    body = example()
    del body["links"]
    del body["viewport"]
    del body["warehouse_id"]
    canvases.save_canvas(body)
    assert json.loads((cdir / "hours.json").read_text(encoding="utf-8")) == body
    assert canvases.load_canvas("hours") == body


def test_all_window_types_are_accepted(client):
    body = example()
    body["windows"] = [
        {"id": "q", "type": "query", "title": "q", "position": {"x": 0, "y": 0}, "size": {"w": 1, "h": 1}, "sql": "SELECT 1"},
        {"id": "c", "type": "chart", "title": "c", "position": {"x": 0, "y": 0}, "size": {"w": 1, "h": 1},
         "chart": {"vega_lite": {"mark": "bar"}}},
        {"id": "n", "type": "note", "title": "n", "position": {"x": 0, "y": 0}, "size": {"w": 1, "h": 1}, "text": "# hi"},
        {"id": "t", "type": "table", "title": "t", "position": {"x": 0, "y": 0}, "size": {"w": 1, "h": 1},
         "table": "main.sales.orders"},
    ]
    body["links"] = []
    assert client.post("/api/canvases", json=body).status_code == 200
    assert client.get("/api/canvases/hours").get_json() == body


# ---------- rejected bodies (HTTP 400, path named in the message) ----------

def _set(path, value):
    def mutate(body):
        target = body
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
        return body
    return mutate


def _delete(path):
    def mutate(body):
        target = body
        for key in path[:-1]:
            target = target[key]
        del target[path[-1]]
        return body
    return mutate


def _links(links):
    def mutate(body):
        body["links"] = links
        return body
    return mutate


INVALID = [
    ("duplicate title", _set(["windows", 1, "title"], "daily_hours"),
     'windows[1].title: duplicate title "daily_hours"'),
    ("duplicate window id", _set(["windows", 1, "id"], "w1"),
     'windows[1].id: duplicate id "w1"'),
    ("link to missing id", _links([{"from": "w1", "to": "w9"}]),
     'links[0].to: no window with id "w9"'),
    ("link from missing id", _links([{"from": "w9", "to": "w2"}]),
     'links[0].from: no window with id "w9"'),
    ("query without sql", _delete(["windows", 0, "sql"]),
     'windows[0]: type "query" requires "sql"'),
    ("invalid name with space", _set(["name"], "bad name"), "name: "),
    ("invalid name with slash", _set(["name"], "a/b"), "name: "),
    ("empty name", _set(["name"], ""), "name: "),
    ("version 3", _set(["version"], 3), "version: "),
    ("version true", _set(["version"], True), "version: "),
    ("zoom 0", _set(["viewport", "zoom"], 0), "viewport.zoom: "),
    ("size w 0", _set(["windows", 0, "size", "w"], 0), "windows[0].size.w: "),
    ("title with brace", _set(["windows", 0, "title"], "a{b"), "windows[0].title: "),
    ("unknown window type", _set(["windows", 0, "type"], "pie"), "windows[0].type: "),
    ("string position", _set(["windows", 0, "position", "x"], "0"), "windows[0].position.x: "),
    ("extra key on link", _links([{"from": "w1", "to": "w2", "label": "x"}]), "links[0].label: "),
    ("missing profile", _delete(["profile"]), "profile: "),
    ("windows not a list", _set(["windows"], {}), "windows: "),
]


@pytest.mark.parametrize("label,mutate,expected", INVALID, ids=[c[0] for c in INVALID])
def test_invalid_body_is_400_with_path(client, cdir, label, mutate, expected):
    resp = client.post("/api/canvases", json=mutate(example()))
    assert resp.status_code == 400
    message = resp.get_json()["error"]
    assert message.startswith(expected), message
    assert list(cdir.iterdir()) == []  # nothing written


def test_duplicate_title_message_is_exact(client):
    resp = client.post("/api/canvases", json=_set(["windows", 1, "title"], "daily_hours")(example()))
    assert resp.get_json() == {"error": 'windows[1].title: duplicate title "daily_hours"'}


def test_non_finite_number_is_rejected(client, cdir):
    raw = json.dumps(example()).replace('"zoom": 1}', '"zoom": Infinity}')
    resp = client.post("/api/canvases", data=raw, content_type="application/json")
    assert resp.status_code == 400
    assert "error" in resp.get_json()
    assert list(cdir.iterdir()) == []


@pytest.mark.parametrize("raw", ["[]", "42", "not json at all", ""])
def test_body_must_be_a_json_object(client, raw):
    resp = client.post("/api/canvases", data=raw, content_type="application/json")
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_overwrite_replaces_existing_canvas(client):
    client.post("/api/canvases", json=example())
    changed = example()
    changed["profile"] = "prod"
    resp = client.post("/api/canvases", json=changed)
    assert resp.get_json()["saved"] == "hours"
    assert client.get("/api/canvases/hours").get_json()["profile"] == "prod"
    assert client.get("/api/canvases").get_json() == ["hours"]


# ---------- load errors ----------

def test_missing_canvas_is_404(client):
    resp = client.get("/api/canvases/nope")
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "canvas not found: nope"}


def test_unsafe_name_is_404(client):
    resp = client.get("/api/canvases/a%20b")
    assert resp.status_code == 404
    assert resp.get_json() == {"error": "canvas not found: a b"}


def test_corrupt_json_file_is_400(client, cdir):
    (cdir / "bad.json").write_text("{not json", encoding="utf-8")
    resp = client.get("/api/canvases/bad")
    assert resp.status_code == 400
    assert resp.get_json()["error"].startswith("(root): stored file is not valid JSON")


def test_stored_file_failing_schema_is_400(client, cdir):
    stored = example()
    stored["version"] = 3
    (cdir / "hours.json").write_text(json.dumps(stored), encoding="utf-8")
    resp = client.get("/api/canvases/hours")
    assert resp.status_code == 400
    assert resp.get_json()["error"].startswith("version: ")


def test_stored_file_with_wrong_name_is_400(client, cdir):
    stored = example()
    stored["name"] = "other"
    (cdir / "hours.json").write_text(json.dumps(stored), encoding="utf-8")
    resp = client.get("/api/canvases/hours")
    assert resp.status_code == 400
    assert resp.get_json()["error"].startswith("name: ")


def test_stored_file_with_duplicate_title_is_400(client, cdir):
    stored = _set(["windows", 1, "title"], "daily_hours")(example())
    (cdir / "hours.json").write_text(json.dumps(stored), encoding="utf-8")
    resp = client.get("/api/canvases/hours")
    assert resp.status_code == 400
    assert resp.get_json() == {"error": 'windows[1].title: duplicate title "daily_hours"'}


# ---------- list ----------

def test_list_is_sorted_stems_and_ignores_other_files(client, cdir):
    for name in ["sales", "hours", "alpha.v2"]:
        body = example()
        body["name"] = name
        canvases.save_canvas(body)
    (cdir / "notes.txt").write_text("not a canvas", encoding="utf-8")
    assert canvases.list_canvases() == ["alpha.v2", "hours", "sales"]
    assert client.get("/api/canvases").get_json() == ["alpha.v2", "hours", "sales"]


def test_list_empty(client):
    assert client.get("/api/canvases").get_json() == []


# ---------- version 2: sketch nodes and connectors ----------

PH_ID = "0b6f1c0e-5c1a-4d2e-9a52-3f6d1a7e8c90"


def example_v2():
    """A version 2 canvas: a table card, a query, every sketch node type, and connectors between them."""
    body = example()
    body["version"] = 2
    body["profile"] = None
    base = {"size": {"w": 140, "h": 80}, "collapsed": False}
    body["windows"] += [
        {"id": "w3", "type": "table", "title": "orders", "position": {"x": 0, "y": 400},
         "size": {"w": 320, "h": 300}, "table": "main.sales.orders", "collapsed": False, "z": 2},
        {"id": "s1", "type": "shape", "shape": "rounded", "label": "API", "position": {"x": 700, "y": 0},
         "fill": "#dbeafe", "stroke": "#2563eb", "font_size": 14, "locked": True, "z": 1, **base},
        {"id": "s2", "type": "shape", "shape": "cylinder", "label": "", "position": {"x": 700, "y": 200}, **base},
        {"id": "s3", "type": "text", "label": "Notes", "position": {"x": 700, "y": 400}, **base},
        {"id": "s4", "type": "sticky", "label": "todo", "position": {"x": 900, "y": 0}, **base},
        {"id": "s5", "type": "frame", "label": "Group", "position": {"x": 650, "y": -40},
         "size": {"w": 500, "h": 600}, "z": -1},
        {"id": "s6", "type": "placeholder", "position": {"x": 900, "y": 200}, "size": {"w": 280, "h": 160},
         "placeholder": {"id": PH_ID, "name": "customers", "linked": "main.sales.customers",
                         "columns": [{"name": "id", "type": "bigint", "key": "pk"},
                                     {"name": "email", "type": ""}]}},
    ]
    body["edges"] = [
        {"id": "e1", "source": "s1", "target": "w3", "source_handle": "b", "target_handle": "t", "line": "curve",
         "arrow_start": True, "arrow_end": True, "dashed": True, "label": "reads", "label_offset": -24, "color": "#dc2626"},
        {"id": "e2", "source": "w3", "target": "s6", "line": "straight", "arrow_start": False, "arrow_end": True,
         "dashed": False, "relationship": {"id": "e_" + "a" * 32, "source_column": "customer_id", "target_column": "id"}},
    ]
    return body


def test_v1_file_loads_unchanged(cdir):
    """A version 1 file written before the bump loads and returns exactly as stored, with no sketch fields added."""
    (cdir / "hours.json").write_text(json.dumps(EXAMPLE), encoding="utf-8")
    assert canvases.load_canvas("hours") == EXAMPLE
    assert canvases.parse_canvas(EXAMPLE).edges == []


def test_label_offset_is_optional_and_defaults_to_zero():
    edges = canvases.parse_canvas(example_v2()).edges
    assert edges[0].label_offset == -24 and edges[1].label_offset == 0


def test_v2_round_trips_unchanged(cdir):
    body = example_v2()
    canvases.save_canvas(body)
    assert canvases.load_canvas("hours") == body
    assert json.loads((cdir / "hours.json").read_text(encoding="utf-8")) == body


def test_v2_round_trips_through_routes(client):
    body = example_v2()
    assert client.post("/api/canvases", json=body).get_json()["saved"] == "hours"
    assert client.get("/api/canvases/hours").get_json() == body


def test_v2_with_a_profile_and_no_sketch_content_is_fine(client):
    body = example()
    body["version"] = 2
    body["profile"] = "dev"
    assert client.post("/api/canvases", json=body).status_code == 200
    assert client.get("/api/canvases/hours").get_json() == body


def test_v1_and_v2_both_listed_and_overwrite_each_other(client):
    assert client.post("/api/canvases", json=example()).status_code == 200
    assert client.post("/api/canvases", json=example_v2()).status_code == 200
    assert client.get("/api/canvases/hours").get_json()["version"] == 2
    assert client.get("/api/canvases").get_json() == ["hours"]


INVALID_V1 = [
    ("sketch type in v1", _set(["windows", 0, "type"], "frame"), "windows[0].type: "),
    ("edges in v1", lambda b: b.update(edges=[]) or b, "edges: needs version 2"),
    ("profile null in v1", _set(["profile"], None), "profile: required in version 1"),
]

INVALID_V2 = [
    ("shape without kind", _set(["windows", 3, "shape"], None), 'windows[3]: type "shape" requires "shape"'),
    ("unknown shape kind", _set(["windows", 3, "shape"], "star"), "windows[3].shape: "),
    ("placeholder without spec", _set(["windows", 8, "placeholder"], None),
     'windows[8]: type "placeholder" requires "placeholder"'),
    ("placeholder id not a uuid", _set(["windows", 8, "placeholder", "id"], "not-a-uuid"),
     "windows[8].placeholder.id: "),
    ("placeholder key unknown", _set(["windows", 8, "placeholder", "columns", 0, "key"], "uk"),
     "windows[8].placeholder.columns[0].key: "),
    ("query without title in v2", _set(["windows", 0, "title"], None), 'windows[0]: type "query" requires "title"'),
    ("edge to missing node", _set(["edges", 0, "target"], "zz"), 'edges[0].target: no window with id "zz"'),
    ("edge from missing node", _set(["edges", 1, "source"], "zz"), 'edges[1].source: no window with id "zz"'),
    ("duplicate edge id", _set(["edges", 1, "id"], "e1"), 'edges[1].id: duplicate id "e1"'),
    ("unknown line kind", _set(["edges", 0, "line"], "wavy"), "edges[0].line: "),
    ("unknown handle", _set(["edges", 0, "source_handle"], "x"), "edges[0].source_handle: "),
    ("extra edge key", _set(["edges", 0, "weight"], 3), "edges[0].weight: "),
    ("empty relationship column", _set(["edges", 1, "relationship", "source_column"], ""),
     "edges[1].relationship.source_column: "),
    ("zero font size", _set(["windows", 3, "font_size"], 0), "windows[3].font_size: "),
    ("text label offset", _set(["edges", 0, "label_offset"], "left"), "edges[0].label_offset: "),
]


@pytest.mark.parametrize("label,mutate,expected", INVALID_V1, ids=[c[0] for c in INVALID_V1])
def test_invalid_v1_body_is_400_with_path(client, cdir, label, mutate, expected):
    resp = client.post("/api/canvases", json=mutate(example()))
    assert resp.status_code == 400
    assert resp.get_json()["error"].startswith(expected)
    assert list(cdir.iterdir()) == []


@pytest.mark.parametrize("label,mutate,expected", INVALID_V2, ids=[c[0] for c in INVALID_V2])
def test_invalid_v2_body_is_400_with_path(client, cdir, label, mutate, expected):
    resp = client.post("/api/canvases", json=mutate(example_v2()))
    assert resp.status_code == 400
    message = resp.get_json()["error"]
    assert message.startswith(expected), message
    assert list(cdir.iterdir()) == []


def test_sketch_labels_need_not_be_unique(client):
    body = example_v2()
    body["windows"][4]["label"] = body["windows"][3]["label"] = "same"
    assert client.post("/api/canvases", json=body).status_code == 200


def test_sketch_nodes_do_not_take_part_in_title_uniqueness(client):
    body = example_v2()
    body["windows"][3]["title"] = "daily_hours"  # a sketch node carrying a title the query also has
    assert client.post("/api/canvases", json=body).status_code == 200


def test_schema_file_agrees_with_the_models():
    """contracts/canvas.schema.json accepts both examples and rejects what the models reject (needs jsonschema)."""
    jsonschema = pytest.importorskip("jsonschema")
    schema = json.loads((Path(__file__).resolve().parents[1] / "contracts" / "canvas.schema.json").read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    assert list(validator.iter_errors(example())) == []
    assert list(validator.iter_errors(example_v2())) == []
    for label, mutate, _ in INVALID_V1:
        assert list(validator.iter_errors(mutate(example()))), label
    for label, mutate, _ in INVALID_V2:
        if label in ("duplicate edge id", "edge to missing node", "edge from missing node"):
            continue  # references and uniqueness are the server's checks; JSON Schema cannot express them
        assert list(validator.iter_errors(mutate(example_v2()))), label
