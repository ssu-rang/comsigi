from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="COMSIGI_", env_file=".env", extra="ignore")

    database_url: str = "sqlite+aiosqlite:///./comsigi.db"
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    device_timeout_seconds: float = Field(default=30, gt=0)
    seat_timeout_seconds: float = Field(default=30, gt=0)
    sweep_interval_seconds: float = Field(default=1, gt=0)
    admin_token_ttl_seconds: int = Field(default=28800, ge=60)
    ws_heartbeat_seconds: float = Field(default=15, gt=0)
    ws_send_timeout_seconds: float = Field(default=5, gt=0)
    ws_queue_size: int = Field(default=64, ge=2)
    max_ws_connections: int = Field(default=1000, ge=1)

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
