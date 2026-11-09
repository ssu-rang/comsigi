import asyncio
import time

import anyio
import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect

from app.api.router import websocket_endpoint


def test_snapshot_delta_dedup_layout_and_place_isolation(api, client, setup_room):
    place, seat, device = setup_room
    other = api.place("other")
    api.seat(other)
    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        initial = ws.receive_json()
        assert initial["type"] == "snapshot"
        assert "layout" not in initial
        assert initial["state"]["seats"][0]["id"] == seat["id"]
        assert initial["state"]["summary"]["unknown"] == 1
        with client.websocket_connect("/api/v1/places/other/ws") as other_ws:
            other_ws.receive_json()
            session = api.session(device)
            online = ws.receive_json()
            assert online["devices"][0]["status"] == "online"
            api.report(device, session, 0, [{"number": 1, "occupied": True}])
            changed = ws.receive_json()
            assert changed["type"] == "state_changed"
            assert changed["seats"][0]["status"] == "occupied"
            assert changed["revision"] == online["revision"] + 1
            api.report(device, session, 0, [{"number": 1, "occupied": True}])
            api.report(device, session, 1, [{"number": 1, "occupied": True}])
            ws.send_json({"type": "ping"})
            assert ws.receive_json()["type"] == "pong"  # No redundant state event.
            other_ws.send_json({"type": "ping"})
            assert other_ws.receive_json()["type"] == "pong"  # No cross-place leak.
            api.patch(f"/places/{place['id']}/seats/{seat['id']}", {"x": 100})
            edited = ws.receive_json()
            assert edited["type"] == "state_reset"
            assert "layout" not in edited
            layout = client.get("/api/v1/places/library/layout").json()
            assert layout["seats"][0]["x"] == 100
            assert edited["state"]["layout_version"] == layout["place"]["layout_version"]
            assert edited["state"]["seats"][0]["status"] == "occupied"
    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        assert ws.receive_json()["state"]["seats"][0]["status"] == "occupied"
    assert client.app.state.runtime.subscribers == {}


def test_asgi_cancellation_finishes_subscription_cleanup(client, setup_room):
    async def cancel_connection():
        messages = asyncio.Queue()
        messages.put_nowait({"type": "websocket.connect"})
        snapshot_sent = asyncio.Event()

        async def send(message):
            if message["type"] == "websocket.send":
                snapshot_sent.set()

        websocket = WebSocket(
            {"type": "websocket", "app": client.app, "headers": []},
            receive=messages.get,
            send=send,
        )
        async with anyio.create_task_group() as group:
            group.start_soon(websocket_endpoint, websocket, "library")
            await snapshot_sent.wait()
            group.cancel_scope.cancel()
        assert client.app.state.runtime.subscribers == {}

    client.portal.call(cancel_connection)


def test_timeout_emits_event_without_an_http_request(api, client, setup_room):
    _, _, device = setup_room
    session = api.session(device)
    api.report(device, session, 0, [{"number": 1, "occupied": True}])
    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        ws.receive_json()
        client.portal.call(client.app.state.runtime.clock.advance, 31)
        changed = ws.receive_json()
        assert changed["type"] == "state_changed"
        assert changed["seats"][0]["status"] == "unknown"
        assert changed["devices"][0]["status"] == "offline"


def test_place_deleted_notifies_and_disconnects(api, client, setup_room):
    place, _, _ = setup_room
    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        ws.receive_json()
        api.delete(f"/places/{place['id']}")
        assert ws.receive_json()["type"] == "place_deleted"
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


@pytest.mark.parametrize(
    "path,origin",
    [
        ("missing", None),
        ("library", "https://untrusted.example"),
    ],
)
def test_websocket_rejects_missing_place_and_untrusted_origin(client, setup_room, path, origin):
    headers = {"Origin": origin} if origin else {}
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/v1/places/{path}/ws", headers=headers):
            pass


def test_invalid_client_message_disconnects(client, setup_room):
    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        ws.receive_json()
        ws.send_json({"type": "update", "occupied": True})
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 1008


def test_bounded_queue_disconnects_slow_consumer(client, setup_room):
    runtime = client.app.state.runtime

    async def overflow():
        queue = asyncio.Queue(maxsize=2)
        runtime.enqueue(queue, {"type": "one"})
        runtime.enqueue(queue, {"type": "two"})
        runtime.enqueue(queue, {"type": "three"})
        assert queue.qsize() == 1
        assert queue.get_nowait() == {"type": "disconnect", "code": 1013}

    client.portal.call(overflow)


def test_connection_limit_and_server_heartbeat(client, setup_room):
    settings = client.app.state.settings
    settings.max_ws_connections = 1
    settings.ws_heartbeat_seconds = 0.05
    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        ws.receive_json()
        assert ws.receive_json()["type"] == "ping"
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/api/v1/places/library/ws"):
                pass
    deadline = time.monotonic() + 1
    while client.app.state.runtime.subscribers and time.monotonic() < deadline:
        time.sleep(0.01)
    assert not client.app.state.runtime.subscribers


def test_editing_another_place_does_not_hide_expiration(api, client, setup_room):
    _, _, device = setup_room
    other = api.place("other")
    session = api.session(device)
    api.report(device, session, 0, [{"number": 1, "occupied": True}])

    async def stop_sweeper():
        client.app.state.sweeper.cancel()
        await asyncio.gather(client.app.state.sweeper, return_exceptions=True)

    # Force expiry to be first noticed while installing an unrelated configuration.
    client.portal.call(stop_sweeper)
    with client.websocket_connect("/api/v1/places/library/ws") as ws:
        ws.receive_json()
        client.portal.call(client.app.state.runtime.clock.advance, 31)
        api.patch(f"/places/{other['id']}", {"name": "Changed"})
        event = ws.receive_json()
        assert event["type"] == "state_changed"
        assert event["seats"][0]["status"] == "unknown"
        assert event["devices"][0]["status"] == "offline"
