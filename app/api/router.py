import asyncio
import json

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.errors import DomainError
from app.schemas import LayoutOut, LegacySeats, PlaceOut, Snapshot, StateOut
from app.security import DB

api_router = APIRouter()


@api_router.get("/health", tags=["health"])
async def health_check():
    return {"status": "ok"}


@api_router.get("/ready", tags=["health"])
async def readiness(request: Request, db: DB):
    try:
        await db.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise DomainError(503, "database_unavailable", "Database unavailable") from exc
    if request.app.state.sweeper.done():
        raise DomainError(503, "sweeper_unavailable", "State expiration task stopped")
    return {"status": "ok", "server_id": request.app.state.runtime.server_id}


@api_router.get("/places", response_model=list[PlaceOut], tags=["public"])
async def places(request: Request):
    runtime = request.app.state.runtime
    async with runtime.lock:
        return [layout["place"] for layout in runtime.layouts.values()]


@api_router.get("/places/{slug}/layout", response_model=LayoutOut, tags=["public"])
async def layout(slug: str, request: Request):
    runtime = request.app.state.runtime
    async with runtime.lock:
        return runtime.layouts[runtime.place_id(slug)]


@api_router.get("/places/{slug}/state", response_model=StateOut, tags=["public"])
async def state(slug: str, request: Request):
    runtime = request.app.state.runtime
    async with runtime.lock:
        runtime.expire()
        return runtime.state(runtime.place_id(slug))


@api_router.get("/places/{slug}/snapshot", response_model=Snapshot, tags=["public"])
async def snapshot(slug: str, request: Request):
    runtime = request.app.state.runtime
    async with runtime.lock:
        runtime.expire()
        return runtime.snapshot(runtime.place_id(slug))


@api_router.get("/seats", response_model=LegacySeats, tags=["legacy"], deprecated=True)
async def legacy_seats(request: Request, place_slug: str | None = None):
    """Compatibility for the repository's existing polling frontend."""
    runtime = request.app.state.runtime
    async with runtime.lock:
        runtime.expire()
        if place_slug:
            place_id = runtime.place_id(place_slug)
        elif not runtime.layouts:
            return {"seats": []}
        elif len(runtime.layouts) == 1:
            place_id = next(iter(runtime.layouts))
        else:
            raise DomainError(400, "place_required", "Supply place_slug when multiple places exist")
        return {
            "seats": [
                {"id": seat["id"], "status": seat["status"]}
                for seat in runtime.state(place_id)["seats"]
            ]
        }


@api_router.websocket("/places/{slug}/ws")
async def websocket_endpoint(websocket: WebSocket, slug: str):
    runtime = websocket.app.state.runtime
    settings = websocket.app.state.settings
    origin = websocket.headers.get("origin")
    if origin and origin not in settings.cors_origins:
        await websocket.close(code=1008)
        return
    try:
        async with runtime.lock:
            place_id = runtime.place_id(slug)
            runtime.expire()
            queue = runtime.subscribe(place_id)
    except DomainError:
        await websocket.close(code=1008)
        return

    async def send_events():
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), settings.ws_heartbeat_seconds)
            except TimeoutError:
                event = {
                    "type": "ping",
                    "server_id": runtime.server_id,
                    "sent_at": runtime.clock()[1],
                }
            async with asyncio.timeout(settings.ws_send_timeout_seconds):
                if event["type"] == "disconnect":
                    await websocket.close(code=event["code"])
                    return
                await websocket.send_json(event)
                if event["type"] == "place_deleted":
                    await websocket.close(code=1008)
                    return

    async def receive_messages():
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            text_message = message.get("text", "")
            if message.get("bytes") is not None or len(text_message) > 1024:
                runtime.enqueue(queue, {"type": "disconnect", "code": 1009})
                await asyncio.Event().wait()
            try:
                body = json.loads(text_message)
            except (ValueError, TypeError):
                body = None
            if body == {"type": "ping"}:
                runtime.enqueue(queue, {"type": "pong", "sent_at": runtime.clock()[1]})
            elif body != {"type": "pong"}:
                runtime.enqueue(queue, {"type": "disconnect", "code": 1008})
                await asyncio.Event().wait()

    tasks = []
    try:
        await websocket.accept()
        tasks = [asyncio.create_task(send_events()), asyncio.create_task(receive_messages())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except (WebSocketDisconnect, OSError, TimeoutError):
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        async with runtime.lock:
            runtime.unsubscribe(place_id, queue)
