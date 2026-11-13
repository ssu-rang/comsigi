import os
from pathlib import Path, PurePosixPath

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

SQLITE_PREFIX = "sqlite+aiosqlite:///"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="COMSIGI_", env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = "sqlite+aiosqlite:///./comsigi.db"
    frontend_dist: Path = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    cors_origins: list[str] = [
        f"http://{host}:{port}"
        for host in ("localhost", "127.0.0.1")
        for port in (5173, 8443, 4173)
    ]
    device_timeout_seconds: float = Field(default=30, gt=0)
    seat_timeout_seconds: float = Field(default=30, gt=0)
    sweep_interval_seconds: float = Field(default=1, gt=0)
    admin_token_ttl_seconds: int = Field(default=28800, ge=60)
    ws_heartbeat_seconds: float = Field(default=15, gt=0)
    ws_send_timeout_seconds: float = Field(default=5, gt=0)
    ws_queue_size: int = Field(default=64, ge=2)
    max_ws_connections: int = Field(default=1000, ge=1)
    pairing_code_ttl_seconds: int = Field(default=900, ge=60, le=86400)
    registration_ttl_seconds: int = Field(default=86400, ge=60, le=604800)
    registration_poll_seconds: int = Field(default=10, ge=1, le=300)
    max_active_pairing_codes: int = Field(default=50, ge=1, le=1000)

    @field_validator("database_url")
    @classmethod
    def sqlite_only(cls, value: str) -> str:
        if not value.startswith(SQLITE_PREFIX):
            raise ValueError("Use a sqlite+aiosqlite:/// database URL")
        return value

    @model_validator(mode="after")
    def persistent_on_railway(self):
        """Railway containers are rebuilt on every deploy; only the Volume survives."""
        if not any(os.environ.get(k) for k in ("RAILWAY_ENVIRONMENT_NAME", "RAILWAY_PROJECT_ID")):
            return self
        mount = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH")
        if not mount:
            raise ValueError(
                "No Railway Volume is attached, so the database would be erased on every "
                "deploy. Attach a Volume to this service (Mount Path /data)."
            )
        if "database_url" not in self.model_fields_set:
            self.database_url = f"{SQLITE_PREFIX}{PurePosixPath(mount) / 'comsigi.db'}"
            return self
        path = PurePosixPath(self.database_url[len(SQLITE_PREFIX) :].split("?")[0])
        if not path.is_absolute() or not path.is_relative_to(mount):
            raise ValueError(
                f"COMSIGI_DATABASE_URL points outside the Railway Volume ({mount}), so the "
                "database would be erased on every deploy. Remove the variable or set it to "
                f"{SQLITE_PREFIX}{PurePosixPath(mount) / 'comsigi.db'}"
            )
        return self

    @field_validator("cors_origins")
    @classmethod
    def explicit_origins(cls, value: list[str]) -> list[str]:
        if "*" in value:
            raise ValueError("Specify explicit browser origins, not '*'")
        return value


class AdminSettings(Settings):
    """Read the bootstrap password only for administrator CLI commands."""

    admin_password: SecretStr | None = Field(default=None, repr=False, exclude=True)
