from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


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
        if not value.startswith("sqlite+aiosqlite:///"):
            raise ValueError("Use a sqlite+aiosqlite:/// database URL")
        return value

    @field_validator("cors_origins")
    @classmethod
    def explicit_origins(cls, value: list[str]) -> list[str]:
        if "*" in value:
            raise ValueError("Specify explicit browser origins, not '*'")
        return value


class AdminSettings(Settings):
    """Read the bootstrap password only for administrator CLI commands."""

    admin_password: SecretStr | None = Field(default=None, repr=False, exclude=True)
