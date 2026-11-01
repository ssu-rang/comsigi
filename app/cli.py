import argparse
import asyncio
from getpass import getpass

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.db import create_database
from app.models import Admin
from app.security import password_hasher


async def save_admin(settings: Settings, username: str, password: str, reset: bool = False):
    if not username.strip() or len(username) > 100:
        raise ValueError("Username must contain 1–100 non-blank characters")
    if not 12 <= len(password) <= 1024:
        raise ValueError("Password must contain 12–1024 characters")
    engine, factory = create_database(settings.database_url)
    try:
        async with factory() as db:
            admin = await db.scalar(select(Admin).where(Admin.username == username))
            if reset and admin is None:
                raise ValueError("Administrator not found")
            if not reset and admin is not None:
                raise ValueError("Administrator already exists; use set-password")
            hashed = password_hasher.hash(password)
            if admin:
                admin.password_hash = hashed
            else:
                db.add(Admin(username=username, password_hash=hashed))
            await db.commit()
    finally:
        await engine.dispose()


def main():
    parser = argparse.ArgumentParser(description="Comsigi backend administration")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("create-admin", "set-password"):
        action = sub.add_parser(command)
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
    password = getpass("Password (minimum 12 characters): ")
    if password != getpass("Confirm password: "):
        parser.error("Passwords do not match")
    try:
        asyncio.run(save_admin(Settings(), args.username, password, args.command == "set-password"))
    except ValueError as exc:
        parser.error(str(exc))
    except SQLAlchemyError:
        parser.error("Database unavailable; run 'uv run alembic upgrade head' first")
    print("Administrator saved.")


if __name__ == "__main__":
    main()
