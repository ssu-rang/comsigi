"""Run the production TypeScript adapter against an isolated real TCP backend."""

import os
import shutil
import socket
import subprocess
import threading
import time

import httpx
import pytest
import uvicorn
from conftest import API, PASSWORD, ROOT
from websockets.sync.client import connect

from app.main import create_app


@pytest.mark.parametrize("through_proxy", [False, True])
def test_frontend_backend_integration(settings, through_proxy):
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node 22+ is required for the frontend integration test")
    vite = ROOT / "frontend/node_modules/vite/bin/vite.js"
    if through_proxy and not vite.exists():
        pytest.skip("Install frontend dependencies to test the Vite proxy")
    settings.seat_timeout_seconds = 0.5
    settings.ws_heartbeat_seconds = 0.2
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(create_app(settings), log_level="error", ws="websockets-sansio")
    )
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    proxy = None
    try:
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        origin = f"http://127.0.0.1:{port}"
        if through_proxy:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                proxy_port = probe.getsockname()[1]
            settings.cors_origins.append(f"http://127.0.0.1:{proxy_port}")
            proxy = subprocess.Popen(
                [node, str(vite), "--host", "127.0.0.1", "--port", str(proxy_port)],
                cwd=ROOT / "frontend",
                env=os.environ | {"API_PROXY_TARGET": origin, "VITE_ENABLE_DEV_DATA": "false"},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            origin = f"http://127.0.0.1:{proxy_port}"
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                try:
                    if httpx.get(origin + "/api/v1/health", timeout=1).status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                time.sleep(0.05)
            else:
                pytest.fail("Vite HTTP proxy did not start")
        result = subprocess.run(
            [node, "--experimental-strip-types", "frontend/scripts/backend-integration.ts"],
            cwd=ROOT,
            env=os.environ
            | {
                "COMSIGI_TEST_ORIGIN": origin,
                "COMSIGI_TEST_PASSWORD": PASSWORD,
            },
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=45,
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert "PASS real frontend adapter" in result.stdout
        if through_proxy:
            with httpx.Client(base_url=origin, timeout=5) as client:
                login = client.post(
                    "/api/v1/auth/token", json={"username": "admin", "password": PASSWORD}
                )
                api = API(client, {"Authorization": "Bearer " + login.json()["access_token"]})
                api.place("origin-check")
                with connect(
                    origin.replace("http:", "ws:") + "/api/v1/places/origin-check/ws",
                    origin=origin,
                    open_timeout=5,
                ) as ws:
                    assert '"snapshot"' in ws.recv(timeout=5)
    finally:
        if proxy:
            proxy.terminate()
            proxy.wait(timeout=10)
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
    assert not thread.is_alive()
