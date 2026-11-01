import pytest
from conftest import API, PASSWORD
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def frontend_client(settings, tmp_path):
    settings.frontend_dist = tmp_path / "frontend-dist"
    settings.frontend_dist.mkdir()
    (settings.frontend_dist / "assets").mkdir()
    (settings.frontend_dist / "index.html").write_text(
        '<!doctype html><div id="root"></div><script src="/assets/app.js"></script>',
        encoding="utf-8",
    )
    (settings.frontend_dist / "assets/app.js").write_text("console.log('app')", encoding="utf-8")
    (tmp_path / ".env").write_text("PRIVATE_TEST_VALUE=hidden", encoding="utf-8")
    with TestClient(create_app(settings)) as client:
        yield client


def test_serves_html_and_assets_without_exposing_files_outside_build(frontend_client):
    home = frontend_client.get("/")
    assert home.status_code == 200
    assert home.headers["content-type"].startswith("text/html")
    assert '<div id="root">' in home.text
    assert home.headers["cache-control"] == "no-store"
    asset = frontend_client.get("/assets/app.js")
    assert asset.status_code == 200
    assert "javascript" in asset.headers["content-type"]
    for path in ("/assets/missing.js", "/.env", "/%2e%2e/.env", "/api/v1/not-found"):
        missing = frontend_client.get(path)
        assert missing.status_code == 404
        assert "text/html" not in missing.headers["content-type"]
        assert "PRIVATE_TEST_VALUE" not in missing.text


def test_api_docs_authentication_and_websocket_work_alongside_frontend(frontend_client):
    client = frontend_client
    assert client.get("/api/v1/ready").status_code == 200
    assert client.get("/docs").status_code == 200
    assert "/api/v1/auth/token" in client.get("/openapi.json").json()["paths"]
    login = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
    assert login.status_code == 200
    api = API(client, {"Authorization": "Bearer " + login.json()["access_token"]})
    api.place("library")
    assert client.get("/api/v1/places").json()[0]["slug"] == "library"
    with client.websocket_connect(
        "/api/v1/places/library/ws", headers={"Origin": "http://localhost:5173"}
    ) as ws:
        assert ws.receive_json()["type"] == "snapshot"


def test_backend_still_runs_without_a_frontend_build(settings, tmp_path):
    settings.frontend_dist = tmp_path / "not-built"
    with TestClient(create_app(settings)) as client:
        assert client.get("/").status_code == 404
        assert client.get("/api/v1/health").json() == {"status": "ok"}
