"""Canvas persistence: validation, save/load round trip, list, and the /api/canvases routes.

Run from the repo root:  .venv/Scripts/python.exe -m pytest tests/test_canvases.py -q
Every test points canvases.CANVASES at tmp_path, so the real data/canvases is never written.
"""
import copy
import json

import pytest

import app as app_module
import canvases

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
    assert resp.get_json() == {"saved": "hours"}
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
    ("version 2", _set(["version"], 2), "version: "),
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
    assert resp.get_json() == {"saved": "hours"}
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
    stored["version"] = 2
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
