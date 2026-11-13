"""Error handling: unknown routes are 404 and wrong methods are 405, both as JSON; other exceptions stay 500."""
import pytest

import app as app_module


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setitem(app_module.STATE, "ex", None)
    return app_module.app.test_client()


def test_unknown_api_route_is_404_json(client):
    for method in (client.get, client.post, client.delete):
        r = method("/api/nope")
        assert r.status_code == 404, method
        assert "error" in r.get_json()
    assert client.get("/api").status_code == 404


def test_wrong_method_on_a_real_route_is_405_with_allow(client):
    r = client.post("/api/profiles")
    assert r.status_code == 405
    assert "error" in r.get_json() and "GET" in r.headers["Allow"]
    r = client.put("/api/canvases")
    assert r.status_code == 405 and "POST" in r.headers["Allow"]
    assert client.get("/api/canvases/a/b").status_code == 404


def test_other_exceptions_are_still_500(client):
    r = client.get("/api/catalogs")
    assert r.status_code == 500 and "Not connected" in r.get_json()["error"]


def test_a_body_that_is_not_json_is_a_client_error(client):
    assert client.post("/api/connect", data="[", content_type="application/json").status_code == 400
    assert client.post("/api/connect", data="x", content_type="text/plain").status_code == 415
