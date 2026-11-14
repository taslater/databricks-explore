"""The /api/layout/* routes: input forms, validation, the shape of each response, and that nothing is saved."""
import copy

import pytest

from databricks_explore import app as app_module
from databricks_explore import canvases

CANVAS = {
    "version": 2, "name": "sketch", "profile": None,
    "windows": [
        {"id": "a", "type": "shape", "shape": "rect", "label": "A", "position": {"x": 0, "y": 0}, "size": {"w": 120, "h": 60}},
        {"id": "b", "type": "shape", "shape": "rect", "label": "B", "position": {"x": 100, "y": 10}, "size": {"w": 120, "h": 60}},
        {"id": "c", "type": "shape", "shape": "rect", "label": "C", "position": {"x": 400, "y": 3}, "size": {"w": 120, "h": 60}},
    ],
    "edges": [{"id": "e1", "source": "a", "target": "c", "source_handle": "l", "target_handle": "r", "line": "step",
               "arrow_start": False, "arrow_end": True, "dashed": False}],
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    d = tmp_path / "canvases"
    d.mkdir()
    monkeypatch.setattr(canvases, "CANVASES", d)
    return app_module.app.test_client()


def post(client, path, body):
    return client.post(f"/api/layout/{path}", json=body)


def test_doctor_with_inline_canvas(client):
    r = post(client, "doctor", {"canvas": CANVAS})
    assert r.status_code == 200
    body = r.get_json()
    assert {"score", "metrics", "issues"} == set(body)
    assert {"overlap", "bad_handle_side", "near_alignment"} <= {i["kind"] for i in body["issues"]}


def test_doctor_with_saved_name_and_grid(client):
    canvases.save_canvas(copy.deepcopy(CANVAS))
    r = post(client, "doctor", {"name": "sketch", "grid": 20})
    assert r.status_code == 200 and "off_grid" in {i["kind"] for i in r.get_json()["issues"]}


def test_tidy_returns_changes_and_canvas_and_never_saves(client):
    canvases.save_canvas(copy.deepcopy(CANVAS))
    before = canvases.load_canvas("sketch")
    r = post(client, "tidy", {"name": "sketch", "rules": ["overlaps", "handles"]})
    body = r.get_json()
    assert r.status_code == 200
    assert {c["id"] for c in body["changes"]} == {"b", "e1"}
    assert body["canvas"]["name"] == "sketch" and body["score"]["after"] > body["score"]["before"]
    assert canvases.load_canvas("sketch") == before  # not saved
    canvases.parse_canvas(body["canvas"])  # still a valid canvas


def test_tidy_ids_and_inline_canvas_without_a_name(client):
    inline = {k: v for k, v in CANVAS.items() if k != "name"}
    r = post(client, "tidy", {"canvas": inline, "ids": ["c"]})
    # c aligns with a, and its connector re-picks sides; the overlap of a and b is left alone
    assert r.status_code == 200 and {c["id"] for c in r.get_json()["changes"]} == {"c", "e1"}


def test_arrange_modes(client):
    r = post(client, "arrange", {"canvas": CANVAS, "ids": ["a", "b", "c"], "mode": "row", "options": {"gap": 30}})
    assert r.status_code == 200
    xs = sorted(w["position"]["x"] for w in r.get_json()["canvas"]["windows"])
    assert xs == [0, 150, 300]
    r = post(client, "arrange", {"canvas": CANVAS, "mode": "layered", "options": {"direction": "TB"}})
    assert r.status_code == 200 and r.get_json()["canvas"]["edges"][0]["source_handle"] == "b"
    r = post(client, "arrange", {"canvas": CANVAS, "ids": ["c"], "mode": "place",
                                 "options": {"relation": "below", "anchor": "a", "gap": 20}})
    assert r.status_code == 200


def test_describe_returns_text(client):
    r = post(client, "describe", {"canvas": CANVAS})
    assert r.status_code == 200 and r.get_json()["text"].startswith('Canvas "sketch": 3 nodes')


def test_render_returns_png(client):
    r = post(client, "render", {"canvas": CANVAS, "width": 600, "highlight": ["a"]})
    assert r.status_code == 200 and r.mimetype == "image/png" and r.data[:8] == b"\x89PNG\r\n\x1a\n"
    r = post(client, "render", {"canvas": CANVAS, "highlight": "issues"})
    assert r.status_code == 200 and r.mimetype == "image/png"


@pytest.mark.parametrize("path,body,status", [
    ("doctor", {}, 400),
    ("doctor", {"name": "missing"}, 404),
    ("doctor", {"canvas": {"version": 2}}, 400),
    ("doctor", {"canvas": CANVAS, "grid": -1}, 400),
    ("tidy", {"canvas": CANVAS, "rules": ["nope"]}, 400),
    ("tidy", {"canvas": CANVAS, "ids": ["zzz"]}, 400),
    ("tidy", {"canvas": CANVAS, "ids": "a"}, 400),
    ("arrange", {"canvas": CANVAS}, 400),
    ("arrange", {"canvas": CANVAS, "mode": "spiral"}, 400),
    ("arrange", {"canvas": CANVAS, "mode": "row", "options": {"ids": []}}, 400),
    ("arrange", {"canvas": CANVAS, "mode": "place", "options": {"relation": "right_of"}}, 400),
    ("render", {"canvas": CANVAS, "width": "wide"}, 400),
    ("render", {"canvas": CANVAS, "highlight": 5}, 400),
])
def test_bad_requests_are_json_errors(client, path, body, status):
    r = post(client, path, body)
    assert r.status_code == status and "error" in r.get_json()


def test_non_json_body_is_a_400(client):
    r = client.post("/api/layout/doctor", data="x", content_type="text/plain")
    assert r.status_code == 400 and "error" in r.get_json()


def test_tidy_route_fits_labels_and_places_connector_labels(client):
    body = copy.deepcopy(CANVAS)
    body["windows"][2]["position"] = {"x": 900, "y": 0}
    body["windows"][1]["position"] = {"x": 0, "y": 300}
    body["windows"][0]["label"] = "a label that is far too long for its box"
    body["edges"] = [{"id": "e1", "source": "a", "target": "c", "source_handle": "r", "target_handle": "l", "label": "first"},
                     {"id": "e2", "source": "a", "target": "c", "source_handle": "r", "target_handle": "l", "label": "second"}]
    kinds = {i["kind"] for i in post(client, "doctor", {"canvas": body}).get_json()["issues"]}
    assert {"label_overflow", "label_collision"} <= kinds
    out = post(client, "tidy", {"canvas": body, "rules": ["fit_labels", "place_labels"]}).get_json()
    assert any(c["kind"] == "edge" and "label_offset" in c["to"] for c in out["changes"])
    assert out["canvas"]["windows"][0]["size"]["w"] > 120
    canvases.parse_canvas(out["canvas"])  # label_offset is part of the canvas format
    assert post(client, "tidy", {"canvas": body, "rules": ["fit"]}).status_code == 400
