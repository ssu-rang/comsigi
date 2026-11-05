"""Prepare and run both local development servers (Windows entry point: dev.cmd)."""

import asyncio
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


async def admin_exists():
    from sqlalchemy import select

    from app.config import Settings
    from app.db import create_database
    from app.models import Admin

    engine, factory = create_database(Settings().database_url)
    try:
        async with factory() as db:
            return await db.scalar(select(Admin.id).where(Admin.username == "admin")) is not None
    finally:
        await engine.dispose()


def check_port(port):
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError as exc:
            raise RuntimeError(
                f"Port {port} is already in use. Stop the existing server first."
            ) from exc


def start_process(command, cwd, env=None):
    options = (
        {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
        if os.name == "nt"
        else {"start_new_session": True}
    )
    return subprocess.Popen(command, cwd=cwd, env=env, **options)


def stop_process(process):
    if os.name == "nt":
        if process.poll() is None:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
        process.wait()


def main():
    os.chdir(ROOT)
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        raise RuntimeError("Install Node.js 22.12+ (including npm), then run dev.cmd again.")
    for port in (8000, 8443):
        check_port(port)

    print("Preparing frontend dependencies and database...", flush=True)
    subprocess.run([npm, "install", "--include=dev"], cwd=ROOT / "frontend", check=True)
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True)
    if not asyncio.run(admin_exists()):
        print("Create the admin account (password: 12 characters minimum).", flush=True)
        subprocess.run(
            [sys.executable, "-m", "app.cli", "create-admin", "--username", "admin"],
            check=True,
        )

    processes = []
    try:
        processes.append(
            start_process(
                [
                    sys.executable,
                    "-m",
                    "app.cli",
                    "serve",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    "8000",
                    "--reload",
                ],
                ROOT,
            )
        )
        env = {**os.environ, "PORT": "8443", "API_PROXY_TARGET": "http://127.0.0.1:8000"}
        processes.append(start_process([npm, "run", "dev"], ROOT / "frontend", env))
        print(
            "\nWeb: http://localhost:8443\nAdmin: http://localhost:8443/#/admin/login"
            "\nPress Ctrl+C to stop both servers.\n",
            flush=True,
        )
        while True:
            for process in processes:
                code = process.poll()
                if code is not None:
                    print(f"A development server exited (code {code}); stopping both servers.")
                    return code or 1
            time.sleep(0.25)
    finally:
        for process in reversed(processes):
            stop_process(process)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nDevelopment servers stopped.")
        sys.exit(0)
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"\nStartup failed: {exc}", file=sys.stderr)
        sys.exit(1)
