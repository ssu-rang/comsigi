import pytest
from pydantic import ValidationError

from app.config import Settings


@pytest.fixture
def railway(monkeypatch):
    monkeypatch.delenv("COMSIGI_DATABASE_URL", raising=False)
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")
    monkeypatch.setenv("RAILWAY_VOLUME_MOUNT_PATH", "/data")
    return monkeypatch


def test_railway_defaults_to_the_volume(railway):
    assert Settings(_env_file=None).database_url == "sqlite+aiosqlite:////data/comsigi.db"


def test_railway_accepts_a_path_inside_the_volume(railway):
    url = "sqlite+aiosqlite:////data/db/comsigi.db"
    railway.setenv("COMSIGI_DATABASE_URL", url)
    assert Settings(_env_file=None).database_url == url


@pytest.mark.parametrize(
    "url",
    [
        "sqlite+aiosqlite:///./comsigi.db",
        "sqlite+aiosqlite:///data/comsigi.db",  # three slashes: relative to /app
        "sqlite+aiosqlite:////app/comsigi.db",
    ],
)
def test_railway_rejects_a_database_outside_the_volume(railway, url):
    railway.setenv("COMSIGI_DATABASE_URL", url)
    with pytest.raises(ValidationError, match="outside the Railway Volume"):
        Settings(_env_file=None)


def test_railway_refuses_to_start_without_a_volume(railway):
    railway.delenv("RAILWAY_VOLUME_MOUNT_PATH")
    with pytest.raises(ValidationError, match="No Railway Volume"):
        Settings(_env_file=None)


def test_local_runs_are_unaffected(monkeypatch):
    for name in ("RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID", "COMSIGI_DATABASE_URL"):
        monkeypatch.delenv(name, raising=False)
    assert Settings(_env_file=None).database_url == "sqlite+aiosqlite:///./comsigi.db"
