import sqlite3

import pytest
from conftest import API, PASSWORD, migration_config
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url

from alembic import command
from app.config import Settings
from app.main import create_app


def test_restart_preserves_layout_credentials_and_resets_runtime(settings):
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
        headers = {"Authorization": "Bearer " + login.json()["access_token"]}
        api = API(client, headers)
        place = api.place()
        table = api.table(place)
        api.seat(place, table_id=table["id"], x=150, y=200)
        device = api.device(place)
        session = api.session(device)
        api.report(device, session, 10, [{"number": 1, "occupied": True}])
        before = client.get("/api/v1/places/library/snapshot").json()
        assert before["state"]["seats"][0]["status"] == "occupied"
    with TestClient(create_app(settings)) as client:
        after = client.get("/api/v1/places/library/snapshot").json()
        assert after["layout"] == before["layout"]
        assert after["state"]["server_id"] != before["state"]["server_id"]
        assert after["state"]["revision"] == 0
        assert after["state"]["seats"][0]["status"] == "unknown"
        assert after["state"]["seats"][0]["last_received_at"] is None
        assert after["state"]["devices"][0]["last_seen_at"] is None
        assert client.get("/api/v1/auth/me", headers=headers).status_code == 401
        api = API(client, headers)
        api.report(device, session, 11, [], expected=409)
        session = api.session(device)
        api.report(device, session, 0, [{"number": 1, "occupied": False}])
        assert api.state(place)["summary"]["available"] == 1
    connection = sqlite3.connect(make_url(settings.database_url).database)
    try:
        names = {row[1] for row in connection.execute("PRAGMA table_info(seats)")}
        assert not names & {"occupied", "status", "last_received_at"}
        saved = connection.execute("SELECT credential_hash FROM devices").fetchone()[0]
        assert len(saved) == 64 and saved != device["credential"]
        assert (
            connection.execute("SELECT password_hash FROM admins")
            .fetchone()[0]
            .startswith("$argon2id$")
        )
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        connection.close()


def test_migration_upgrade_downgrade_and_schema_match(settings):
    config = migration_config(settings.database_url)
    command.check(config)
    command.downgrade(config, "base")
    command.upgrade(config, "head")
    command.check(config)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/places").json() == []


def test_missing_schema_fails_with_actionable_message(tmp_path):
    settings = Settings(
        _env_file=None, database_url=f"sqlite+aiosqlite:///{(tmp_path / 'empty.db').as_posix()}"
    )
    with pytest.raises(RuntimeError, match="alembic upgrade head"):
        with TestClient(create_app(settings)):
            pass
