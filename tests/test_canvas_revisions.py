"""Canvas revisions, agent snapshots and undo, and the two routes the page uses for live sync."""
import copy

import pytest

import app as app_module
import canvases

BASE = {
    "version": 2, "name": "sk", "profile": None,
    "windows": [{"id": "a", "type": "shape", "shape": "rect", "label": "A",
                 "position": {"x": 0, "y": 0}, "size": {"w": 100, "h": 50}}],
    "edges": [],
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


def with_label(label):
    c = copy.deepcopy(BASE)
    c["windows"][0]["label"] = label
    return c


def test_every_save_bumps_the_revision_and_records_who(cdir):
    assert canvases.write_canvas(with_label("1")) == ("sk", 1)
    assert canvases.write_canvas(with_label("2"), by="agent") == ("sk", 2)
    info = canvases.revision_info("sk")
    assert info == {"name": "sk", "revision": 2, "by": "agent", "snapshots": 0}
    assert canvases.save_canvas(with_label("3")) == "sk"  # the old entry point still returns the name
    assert canvases.revision_info("sk")["revision"] == 3 and canvases.revision_info("sk")["by"] == "ui"


def test_the_revision_is_not_inside_the_canvas_file(cdir):
    canvases.write_canvas(with_label("1"))
    assert canvases.load_canvas("sk") == with_label("1")  # stored exactly as received


def test_a_canvas_saved_before_revisions_starts_at_one_on_its_next_save(cdir):
    (cdir / "sk.json").write_text('{"version": 2, "name": "sk", "windows": []}')
    assert canvases.revision_info("sk")["revision"] == 0
    assert canvases.write_canvas(with_label("1"))[1] == 1


def test_unknown_canvas_has_no_revision(cdir):
    with pytest.raises(canvases.CanvasNotFound):
        canvases.revision_info("nope")


def test_snapshot_keeps_the_replaced_file_and_undo_restores_it(cdir):
    canvases.write_canvas(with_label("mine"))
    canvases.write_canvas(with_label("agent 1"), by="agent", snapshot=True)
    canvases.write_canvas(with_label("agent 2"), by="agent", snapshot=True)
    assert canvases.revision_info("sk")["snapshots"] == 2
    out = canvases.undo_canvas("sk")
    assert out == {"name": "sk", "revision": 4, "snapshots": 1}
    assert canvases.load_canvas("sk") == with_label("agent 1")
    assert canvases.revision_info("sk")["by"] == "undo"
    canvases.undo_canvas("sk")
    assert canvases.load_canvas("sk") == with_label("mine")
    with pytest.raises(canvases.CanvasInvalid, match="nothing to undo"):
        canvases.undo_canvas("sk")


def test_first_write_has_nothing_to_snapshot(cdir):
    canvases.write_canvas(with_label("new"), by="agent", snapshot=True)
    assert canvases.revision_info("sk")["snapshots"] == 0


def test_only_the_last_twenty_snapshots_are_kept(cdir):
    canvases.write_canvas(with_label("0"))
    for i in range(1, 26):
        canvases.write_canvas(with_label(str(i)), by="agent", snapshot=True)
    assert canvases.revision_info("sk")["snapshots"] == canvases.KEEP_SNAPSHOTS == 20
    for _ in range(20):
        canvases.undo_canvas("sk")
    assert canvases.load_canvas("sk") == with_label("5")  # snapshots 0 to 4 were dropped


def test_invalid_data_changes_nothing(cdir):
    canvases.write_canvas(with_label("1"))
    bad = with_label("2")
    bad["windows"][0]["size"]["w"] = -1
    with pytest.raises(canvases.CanvasInvalid):
        canvases.write_canvas(bad, by="agent", snapshot=True)
    assert canvases.revision_info("sk") == {"name": "sk", "revision": 1, "by": "ui", "snapshots": 0}


def test_history_files_do_not_show_up_as_canvases(cdir):
    canvases.write_canvas(with_label("1"), snapshot=True)
    canvases.write_canvas(with_label("2"), snapshot=True)
    assert canvases.list_canvases() == ["sk"]


def test_routes_save_returns_the_revision_and_revision_and_undo_work(client):
    r = client.post("/api/canvases", json=with_label("1"))
    assert r.get_json() == {"saved": "sk", "revision": 1}
    assert client.get("/api/canvases/sk/revision").get_json() == {"name": "sk", "revision": 1, "by": "ui", "snapshots": 0}
    canvases.write_canvas(with_label("2"), by="agent", snapshot=True)
    assert client.get("/api/canvases/sk/revision").get_json() == {"name": "sk", "revision": 2, "by": "agent", "snapshots": 1}
    undone = client.post("/api/canvases/sk/undo")
    assert undone.status_code == 200 and undone.get_json()["revision"] == 3
    assert client.get("/api/canvases/sk").get_json() == with_label("1")
    again = client.post("/api/canvases/sk/undo")
    assert again.status_code == 400 and "nothing to undo" in again.get_json()["error"]


def test_routes_unknown_canvas_is_404(client):
    assert client.get("/api/canvases/nope/revision").status_code == 404
    assert client.post("/api/canvases/nope/undo").status_code == 404


def test_expect_refuses_a_write_over_a_newer_save(cdir):
    canvases.write_canvas(with_label("1"))
    canvases.write_canvas(with_label("agent"), by="agent", snapshot=True)
    with pytest.raises(canvases.CanvasConflict) as e:
        canvases.write_canvas(with_label("stale page"), expect=1)
    assert e.value.info == {"name": "sk", "revision": 2, "by": "agent", "snapshots": 1}
    assert "saved by agent since revision 1" in str(e.value)
    assert canvases.load_canvas("sk") == with_label("agent")
    assert canvases.write_canvas(with_label("up to date"), expect=2) == ("sk", 3)


def test_expect_does_not_apply_to_a_canvas_that_does_not_exist_yet(cdir):
    assert canvases.write_canvas(with_label("new"), expect=7) == ("sk", 1)


def test_route_returns_409_with_the_current_revision_and_accepts_a_matching_base(client):
    client.post("/api/canvases", json=with_label("1"))
    canvases.write_canvas(with_label("agent"), by="agent", snapshot=True)
    stale = client.post("/api/canvases", json=with_label("page"), headers={"X-Base-Revision": "1"})
    assert stale.status_code == 409
    body = stale.get_json()
    assert body["revision"] == 2 and body["by"] == "agent" and "since revision 1" in body["error"]
    assert client.get("/api/canvases/sk").get_json() == with_label("agent")
    ok = client.post("/api/canvases", json=with_label("page"), headers={"X-Base-Revision": "2"})
    assert ok.status_code == 200 and ok.get_json() == {"saved": "sk", "revision": 3}
    assert client.post("/api/canvases", json=with_label("x"), headers={"X-Base-Revision": "abc"}).status_code == 400
    assert client.post("/api/canvases", json=with_label("no header")).status_code == 200  # the check is opt-in
