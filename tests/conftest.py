import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from alembic.config import Config
from fastapi.testclient import TestClient

from alembic import command
from app.cli import save_admin
from app.config import Settings
from app.main import create_app

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "integration-test-password"


def migration_config(url):
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["database_url"] = url
    return config


class FakeClock:
    seconds = 1000.0

    def __call__(self):
        stamp = datetime(2026, 1, 1, tzinfo=UTC) + timedelta(seconds=self.seconds)
        return self.seconds, stamp.isoformat()

    def advance(self, seconds):
        self.seconds += seconds


@pytest.fixture
def settings(tmp_path):
    settings = Settings(
        _env_file=None,
        database_url=f"sqlite+aiosqlite:///{(tmp_path / 'test.db').as_posix()}",
        sweep_interval_seconds=0.05,
    )
    command.upgrade(migration_config(settings.database_url), "head")
    asyncio.run(save_admin(settings, "admin", PASSWORD))
    return settings


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as client:
        client.app.state.runtime.clock = FakeClock()
        yield client


@pytest.fixture
def admin_headers(client):
    response = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["access_token"]}


@pytest.fixture
def api(client, admin_headers):
    return API(client, admin_headers)


class API:
    def __init__(self, client, admin_headers):
        self.client = client
        self.headers = admin_headers

    def post(self, path, body, expected=201):
        response = self.client.post("/api/v1/admin" + path, json=body, headers=self.headers)
        assert response.status_code == expected, response.text
        return response.json()

    def place(self, slug="library"):
        return self.post("/places", {"name": slug, "slug": slug})

    def seat(self, place, number=1, **kwargs):
        return self.post(f"/places/{place['id']}/seats", {"number": number, **kwargs})

    def table(self, place, number=1, **kwargs):
        return self.post(f"/places/{place['id']}/tables", {"number": number, **kwargs})

    def device(self, place, uid="camera-1"):
        return self.post("/devices", {"device_uid": uid, "name": uid, "place_id": place["id"]})

    @staticmethod
    def device_headers(device):
        return {"Authorization": "Bearer " + device["credential"]}

    def session(self, device):
        response = self.client.post(
            "/api/v1/hardware/session",
            json={"device_uid": device["device"]["device_uid"]},
            headers=self.device_headers(device),
        )
        assert response.status_code == 200, response.text
        return response.json()["session_id"]

    def report(self, device, session, sequence, seats, expected=200):
        response = self.client.post(
            "/api/v1/hardware/reports",
            headers=self.device_headers(device),
            json={
                "device_uid": device["device"]["device_uid"],
                "session_id": session,
                "sequence": sequence,
                "seats": seats,
            },
        )
        assert response.status_code == expected, response.text
        return response.json()

    def state(self, place):
        response = self.client.get(f"/api/v1/places/{place['slug']}/state")
        assert response.status_code == 200, response.text
        return response.json()

    def patch(self, path, body, expected=200):
        response = self.client.patch("/api/v1/admin" + path, json=body, headers=self.headers)
        assert response.status_code == expected, response.text
        return response.json()

    def delete(self, path):
        response = self.client.delete("/api/v1/admin" + path, headers=self.headers)
        assert response.status_code == 204, response.text


@pytest.fixture
def setup_room(api):
    place = api.place()
    seat = api.seat(place)
    device = api.device(place)
    return place, seat, device
