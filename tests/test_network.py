"""Exercise real TCP HTTP/WebSocket framing, separate from the ASGI test client."""

import json
import os
import socket
import subprocess
import sys
import threading
import time

import httpx
import uvicorn
from conftest import API, PASSWORD, ROOT
from websockets.sync.client import connect

from app.main import create_app


def test_uvicorn_http_to_websocket_roundtrip(settings):
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(create_app(settings), log_level="error", ws="websockets-sansio")
    )
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.started
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5) as client:
            login = client.post(
                "/api/v1/auth/token", json={"username": "admin", "password": PASSWORD}
            )
            api = API(client, {"Authorization": "Bearer " + login.json()["access_token"]})
            place = api.place()
            api.seat(place)
            device = api.device(place)
            with connect(f"ws://127.0.0.1:{port}/api/v1/places/library/ws", open_timeout=5) as ws:
                assert json.loads(ws.recv(timeout=5))["type"] == "snapshot"
                session = api.session(device)
                assert json.loads(ws.recv(timeout=5))["devices"][0]["status"] == "online"
                api.report(device, session, 0, [{"number": 1, "occupied": True}])
                assert json.loads(ws.recv(timeout=5))["seats"][0]["status"] == "occupied"
            simulation = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts" / "simulate_device.py"),
                    "--base-url",
                    f"http://127.0.0.1:{port}",
                    "--device-uid",
                    "camera-1",
                    "--seats",
                    "1",
                    "--cycles",
                    "2",
                    "--interval",
                    "0.05",
                ],
                env=os.environ | {"COMSIGI_DEVICE_CREDENTIAL": device["credential"]},
                capture_output=True,
                text=True,
                timeout=15,
            )
            assert simulation.returncode == 0, simulation.stderr
            assert "sequence=1 accepted=True" in simulation.stdout
            assert api.state(place)["seats"][0]["status"] == "occupied"
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        listener.close()
    assert not thread.is_alive()
