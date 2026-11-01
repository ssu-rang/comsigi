import argparse
import asyncio
from getpass import getpass
from pathlib import Path

from alembic.config import Config
from alembic.util.exc import CommandError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from alembic import command
from app.config import AdminSettings, Settings
from app.db import create_database
from app.models import Admin
from app.security import password_hasher


async def save_admin(
    settings: Settings,
    username: str,
    password: str | None,
    reset: bool = False,
    *,
    skip_existing: bool = False,
) -> bool:
    if not username.strip() or len(username) > 100:
        raise ValueError("Username must contain 1–100 non-blank characters")
    engine, factory = create_database(settings.database_url)
    try:
        async with factory() as db:
            admin = await db.scalar(select(Admin).where(Admin.username == username))
            if reset and admin is None:
                raise ValueError("Administrator not found")
            if not reset and admin is not None:
                if skip_existing:
                    return False
                raise ValueError("Administrator already exists; use set-password")
            if password is None:
                raise ValueError("Set COMSIGI_ADMIN_PASSWORD to create the administrator")
            if not 12 <= len(password) <= 1024:
                raise ValueError("Password must contain 12–1024 characters")
            hashed = password_hasher.hash(password)
            if admin:
                admin.password_hash = hashed
            else:
                db.add(Admin(username=username, password_hash=hashed))
            await db.commit()
            return True
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="Comsigi backend administration")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("create-admin", "set-password", "prepare-deploy"):
        action = sub.add_parser(name)
        action.add_argument("--username", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    if args.command == "serve":
        import uvicorn

        uvicorn.run(
            "app.main:app",
            host=args.host,
            port=args.port,
            reload=args.reload,
            workers=1,
            ws_max_size=4096,
            ws_ping_interval=20,
            ws_ping_timeout=20,
        )
        return
    try:
        settings = AdminSettings()
        if args.command == "prepare-deploy":
            config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
            config.attributes["database_url"] = settings.database_url
            command.upgrade(config, "head")
        password = (
            settings.admin_password.get_secret_value()
            if settings.admin_password is not None
            else None
        )
        if args.command != "prepare-deploy" and password is None:
            password = getpass("Password (minimum 12 characters): ")
            if password != getpass("Confirm password: "):
                parser.error("Passwords do not match")
        saved = asyncio.run(
            save_admin(
                settings,
                args.username,
                password,
                args.command == "set-password",
                skip_existing=args.command == "prepare-deploy",
            )
        )
    except ValueError as exc:
        parser.error(str(exc))
    except EOFError:
        parser.error("Set COMSIGI_ADMIN_PASSWORD or run from an interactive terminal")
    except CommandError as exc:
        parser.error(f"Migration failed: {exc}")
    except SQLAlchemyError:
        parser.error("Database unavailable; run 'uv run alembic upgrade head' first")
    print("Administrator saved." if saved else "Administrator already exists; kept unchanged.")


if __name__ == "__main__":
    main()
