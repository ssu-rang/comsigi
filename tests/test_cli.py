import os
import sqlite3
import subprocess
import sys

import pytest
from conftest import PASSWORD, ROOT, migration_config
from fastapi.testclient import TestClient

from alembic import command
from app.cli import main
from app.config import Settings
from app.main import create_app
from app.security import password_hasher

NEW_PASSWORD = "updated-deployment-password"


def database_url(tmp_path):
    return f"sqlite+aiosqlite:///{(tmp_path / 'deploy.db').as_posix()}"


def run_cli(tmp_path, action, *, password=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith("COMSIGI_")}
    env["COMSIGI_DATABASE_URL"] = database_url(tmp_path)
    env["PYTHONPATH"] = os.pathsep.join([str(ROOT), env.get("PYTHONPATH", "")])
    env["PYTHONIOENCODING"] = "utf-8"
    if password is not None:
        env["COMSIGI_ADMIN_PASSWORD"] = password
    return subprocess.run(
        [sys.executable, "-m", "app.cli", action, "--username", "admin"],
        cwd=tmp_path,
        env=env,
        input="",
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )


def saved_admins(tmp_path):
    with sqlite3.connect(tmp_path / "deploy.db") as db:
        return db.execute("SELECT id, username, password_hash, enabled FROM admins").fetchall()


@pytest.mark.parametrize("source", ["environment", "dotenv", "both"])
def test_create_admin_reads_password_and_environment_overrides_dotenv(tmp_path, source):
    command.upgrade(migration_config(database_url(tmp_path)), "head")
    dotenv_password = "관리자용-테스트-비밀번호"
    if source != "environment":
        (tmp_path / ".env").write_text(
            f"COMSIGI_ADMIN_PASSWORD={dotenv_password}\n", encoding="utf-8"
        )
    password = dotenv_password if source == "dotenv" else PASSWORD
    result = run_cli(tmp_path, "create-admin", password=None if source == "dotenv" else password)
    assert result.returncode == 0, result.stdout + result.stderr
    admins = saved_admins(tmp_path)
    assert len(admins) == 1
    assert admins[0][1] == "admin"
    assert password_hasher.verify(password, admins[0][2])
    assert PASSWORD not in result.stdout + result.stderr
    assert dotenv_password not in result.stdout + result.stderr


def test_prepare_deploy_migrates_and_preserves_password_across_restarts(tmp_path):
    result = run_cli(tmp_path, "prepare-deploy", password=PASSWORD)
    assert result.returncode == 0, result.stdout + result.stderr
    before = saved_admins(tmp_path)
    assert len(before) == 1
    settings = Settings(_env_file=None, database_url=database_url(tmp_path))
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
        assert login.status_code == 200
    for password in (NEW_PASSWORD, None, ""):
        result = run_cli(tmp_path, "prepare-deploy", password=password)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "kept unchanged" in result.stdout
        assert saved_admins(tmp_path) == before
    with TestClient(create_app(settings)) as client:
        login = client.post("/api/v1/auth/token", json={"username": "admin", "password": PASSWORD})
        assert login.status_code == 200
        rejected = client.post(
            "/api/v1/auth/token", json={"username": "admin", "password": NEW_PASSWORD}
        )
        assert rejected.status_code == 401


def test_prepare_deploy_does_not_reenable_existing_admin(tmp_path):
    result = run_cli(tmp_path, "prepare-deploy", password=PASSWORD)
    assert result.returncode == 0, result.stdout + result.stderr
    with sqlite3.connect(tmp_path / "deploy.db") as db:
        db.execute("UPDATE admins SET enabled = 0")
    before = saved_admins(tmp_path)
    result = run_cli(tmp_path, "prepare-deploy", password=NEW_PASSWORD)
    assert result.returncode == 0, result.stdout + result.stderr
    assert saved_admins(tmp_path) == before


@pytest.mark.parametrize("password", [None, "", "too-short", "x" * 1025])
def test_prepare_deploy_rejects_missing_or_invalid_password_without_prompt(tmp_path, password):
    result = run_cli(tmp_path, "prepare-deploy", password=password)
    assert result.returncode == 2
    assert saved_admins(tmp_path) == []
    output = result.stdout + result.stderr
    assert "Password (minimum" not in output
    assert "Traceback" not in output
    if password is None:
        assert "COMSIGI_ADMIN_PASSWORD" in output
    else:
        assert "12–1024" in output
    if password:
        assert password not in output


def test_only_set_password_changes_existing_password(tmp_path):
    result = run_cli(tmp_path, "prepare-deploy", password=PASSWORD)
    assert result.returncode == 0, result.stdout + result.stderr
    before = saved_admins(tmp_path)
    duplicate = run_cli(tmp_path, "create-admin", password=NEW_PASSWORD)
    assert duplicate.returncode == 2
    assert "use set-password" in duplicate.stderr
    assert saved_admins(tmp_path) == before
    reset = run_cli(tmp_path, "set-password", password=NEW_PASSWORD)
    assert reset.returncode == 0, reset.stdout + reset.stderr
    after = saved_admins(tmp_path)
    assert password_hasher.verify(NEW_PASSWORD, after[0][2])
    result = run_cli(tmp_path, "prepare-deploy", password=PASSWORD)
    assert result.returncode == 0, result.stdout + result.stderr
    assert saved_admins(tmp_path) == after


def test_prepare_deploy_stops_on_database_failure_without_exposing_password(tmp_path):
    (tmp_path / "deploy.db").mkdir()
    result = run_cli(tmp_path, "prepare-deploy", password=PASSWORD)
    assert result.returncode == 2
    assert "Database unavailable" in result.stderr
    assert "Administrator saved" not in result.stdout
    assert "Traceback" not in result.stderr
    assert PASSWORD not in result.stdout + result.stderr


def test_create_admin_still_supports_hidden_interactive_input(tmp_path, monkeypatch, capsys):
    command.upgrade(migration_config(database_url(tmp_path)), "head")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("COMSIGI_DATABASE_URL", database_url(tmp_path))
    monkeypatch.delenv("COMSIGI_ADMIN_PASSWORD", raising=False)
    monkeypatch.setattr(sys, "argv", ["comsigi", "create-admin", "--username", "admin"])
    passwords = iter([PASSWORD, PASSWORD])
    monkeypatch.setattr("app.cli.getpass", lambda _prompt: next(passwords))
    main()
    assert password_hasher.verify(PASSWORD, saved_admins(tmp_path)[0][2])
    captured = capsys.readouterr()
    assert PASSWORD not in captured.out + captured.err
