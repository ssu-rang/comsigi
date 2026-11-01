"""Process-local state. Call mutations/subscription while holding Runtime.lock.

No HTTP or WebSocket objects enter the state processor. Another transport can
authenticate a device and call begin_session/ingest with the same validated data.
"""

import asyncio
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.errors import DomainError
from app.models import Device, Place, Seat, Table
from app.schemas import DeviceOut, HardwareReport, PlaceOut, SeatOut, TableOut


def clock() -> tuple[float, str]:
    return time.monotonic(), datetime.now(UTC).isoformat()


@dataclass
class Observation:
    occupied: bool
    received: float
    received_at: str


@dataclass
class DeviceRuntime:
    session_id: str
    last_seen: float
    last_seen_at: str
    sequence: int = -1
    fingerprint: tuple = ()


class Runtime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.lock = asyncio.Lock()
        self.server_id = str(uuid4())
        self.clock = clock
        self.layouts: dict[int, dict] = {}
        self.seats: dict[int, dict] = {}
        self.devices: dict[int, dict] = {}
        self.device_sessions: dict[int, DeviceRuntime] = {}
        self.observations: dict[int, dict[int, Observation]] = {}
        self.last_received: dict[int, str] = {}
        self.revisions: dict[int, int] = {}
        self.published: dict[int, tuple[dict, dict]] = {}
        self.subscribers: dict[int, set[asyncio.Queue]] = {}

    @staticmethod
    async def load_configuration(db: AsyncSession) -> tuple[dict, dict, dict]:
        """Read and validate a candidate configuration before committing a mutation."""
        places = (await db.scalars(select(Place).order_by(Place.id))).all()
        seats = (await db.scalars(select(Seat).order_by(Seat.number))).all()
        tables = (await db.scalars(select(Table).order_by(Table.number))).all()
        devices = (await db.scalars(select(Device).order_by(Device.id))).all()
        new_seats = {s.id: SeatOut.model_validate(s).model_dump(mode="json") for s in seats}
        new_devices = {
            d.id: {
                **DeviceOut.model_validate(d).model_dump(mode="json"),
                "credential_hash": d.credential_hash,
            }
            for d in devices
        }
        layouts = {
            p.id: {
                "place": PlaceOut.model_validate(p).model_dump(mode="json"),
                "seats": [s for s in new_seats.values() if s["place_id"] == p.id],
                "tables": [
                    TableOut.model_validate(t).model_dump(mode="json")
                    for t in tables
                    if t.place_id == p.id
                ],
            }
            for p in places
        }
        return layouts, new_seats, new_devices

    async def reload(self, db: AsyncSession):
        self.configure(await self.load_configuration(db))

    def configure(self, configuration: tuple[dict, dict, dict], changed: set[int] | None = None):
        """Install a committed configuration without I/O, preserving compatible state."""
        layouts, new_seats, new_devices = configuration
        # Reject delayed packets after a seat-number mapping change.
        mapping_changed = {
            pid
            for pid in self.layouts
            if {s["number"]: s["id"] for s in self.seats.values() if s["place_id"] == pid}
            != {s["number"]: s["id"] for s in new_seats.values() if s["place_id"] == pid}
        }
        for seat_id, old in self.seats.items():
            new = new_seats.get(seat_id)
            if new is None or (old["place_id"], old["number"]) != (new["place_id"], new["number"]):
                self.observations.pop(seat_id, None)
                self.last_received.pop(seat_id, None)
        for device_id, old in self.devices.items():
            new = new_devices.get(device_id)
            keys = ("place_id", "enabled", "credential_hash")
            if (
                new is None
                or any(old[k] != new[k] for k in keys)
                or old["place_id"] in mapping_changed
            ):
                self.device_sessions.pop(device_id, None)
                self.remove_observations(device_id)
        old_places = set(self.layouts)
        self.seats, self.devices = new_seats, new_devices
        self.layouts = layouts
        for place_id in old_places - self.layouts.keys():
            self.revisions[place_id] = self.revisions.get(place_id, 0) + 1
            self.broadcast(place_id, self.envelope(place_id, "place_deleted"))
            self.subscribers.pop(place_id, None)
            self.revisions.pop(place_id, None)
            self.published.pop(place_id, None)
        for place_id in self.layouts:
            self.revisions.setdefault(place_id, 0)
            if changed is not None and place_id in changed:
                self.revisions[place_id] += 1
                event = self.envelope(place_id, "layout_changed")
                event.update(self.snapshot(place_id))
                self.broadcast(place_id, event)
                self.published[place_id] = self.status_maps(event["state"])
            elif changed is not None:
                # Do not silently swallow a timeout in an unrelated place during DB I/O.
                self.publish_changes(place_id)
            else:
                self.published[place_id] = self.status_maps(self.state(place_id))

    def remove_observations(self, device_id: int):
        for observations in self.observations.values():
            observations.pop(device_id, None)

    def place_id(self, slug: str) -> int:
        for place_id, layout in self.layouts.items():
            if layout["place"]["slug"] == slug:
                return place_id
        raise DomainError(404, "place_not_found", "Place not found")

    def device_status(self, device_id: int, now: float | None = None) -> dict:
        now = self.clock()[0] if now is None else now
        config = self.devices[device_id]
        session = self.device_sessions.get(device_id)
        status = "offline"
        if not config["enabled"]:
            status = "disabled"
        elif session and now - session.last_seen < self.settings.device_timeout_seconds:
            status = "online"
        return {
            "id": device_id,
            "status": status,
            "last_seen_at": session.last_seen_at if session else None,
        }

    def state(self, place_id: int) -> dict:
        now = self.clock()[0]
        device_states = [
            self.device_status(did, now)
            for did, d in self.devices.items()
            if d["place_id"] == place_id
        ]
        online = {d["id"] for d in device_states if d["status"] == "online"}
        seats = []
        summary = {"total": 0, "available": 0, "occupied": 0, "unknown": 0}
        for seat in self.layouts[place_id]["seats"]:
            valid = [
                obs
                for did, obs in self.observations.get(seat["id"], {}).items()
                if did in online and now - obs.received < self.settings.seat_timeout_seconds
            ]
            status = "unknown"
            if valid:
                status = "occupied" if any(obs.occupied for obs in valid) else "available"
            seats.append(
                {
                    "id": seat["id"],
                    "number": seat["number"],
                    "status": status,
                    "last_received_at": self.last_received.get(seat["id"]),
                }
            )
            summary[status] += 1
            summary["total"] += 1
        return {
            "server_id": self.server_id,
            "place_id": place_id,
            "revision": self.revisions[place_id],
            "layout_version": self.layouts[place_id]["place"]["layout_version"],
            "seats": seats,
            "devices": device_states,
            "summary": summary,
        }

    def snapshot(self, place_id: int) -> dict:
        return {"layout": self.layouts[place_id], "state": self.state(place_id)}

    @staticmethod
    def status_maps(state: dict) -> tuple[dict, dict]:
        return (
            {s["id"]: s["status"] for s in state["seats"]},
            {d["id"]: d["status"] for d in state["devices"]},
        )

    def publish_changes(self, place_id: int):
        state = self.state(place_id)
        seat_statuses, device_statuses = self.status_maps(state)
        old_seats, old_devices = self.published.get(place_id, ({}, {}))
        changed_seats = [s for s in state["seats"] if old_seats.get(s["id"]) != s["status"]]
        changed_devices = [d for d in state["devices"] if old_devices.get(d["id"]) != d["status"]]
        self.published[place_id] = seat_statuses, device_statuses
        if changed_seats or changed_devices:
            self.revisions[place_id] += 1
            event = self.envelope(place_id, "state_changed")
            event.update(
                seats=changed_seats,
                devices=changed_devices,
                summary=state["summary"],
                layout_version=state["layout_version"],
            )
            self.broadcast(place_id, event)

    def begin_session(self, device_id: int) -> dict:
        self.expire()
        now, timestamp = self.clock()
        session_id = secrets.token_urlsafe(32)
        self.remove_observations(device_id)
        self.device_sessions[device_id] = DeviceRuntime(session_id, now, timestamp)
        self.publish_changes(self.devices[device_id]["place_id"])
        return {
            "session_id": session_id,
            "server_id": self.server_id,
            "device_timeout_seconds": self.settings.device_timeout_seconds,
            "seat_timeout_seconds": self.settings.seat_timeout_seconds,
        }

    def ingest(self, device_id: int, report: HardwareReport) -> dict:
        """Validate the entire batch before applying it; duplicate retries have no side effects."""
        self.expire()
        session = self.device_sessions.get(device_id)
        if session is None or not secrets.compare_digest(session.session_id, report.session_id):
            raise DomainError(409, "session_required", "Start a new hardware session")
        place_id = self.devices[device_id]["place_id"]
        fingerprint = tuple(sorted((s.number, s.occupied) for s in report.seats))
        if report.sequence < session.sequence:
            raise DomainError(
                409, "stale_sequence", "Sequence is older than the last accepted report"
            )
        if report.sequence == session.sequence:
            if fingerprint != session.fingerprint:
                raise DomainError(
                    409, "sequence_conflict", "Sequence already used with another body"
                )
            return {
                "accepted": False,
                "duplicate": True,
                "sequence": report.sequence,
                "revision": self.revisions[place_id],
            }
        by_number = {s["number"]: s["id"] for s in self.layouts[place_id]["seats"]}
        unknown = sorted({s.number for s in report.seats} - by_number.keys())
        if unknown:
            raise DomainError(422, "unknown_seat_numbers", f"Unknown seat numbers: {unknown}")
        now, timestamp = self.clock()
        session.last_seen, session.last_seen_at = now, timestamp
        session.sequence, session.fingerprint = report.sequence, fingerprint
        for seat in report.seats:
            seat_id = by_number[seat.number]
            self.observations.setdefault(seat_id, {})[device_id] = Observation(
                seat.occupied, now, timestamp
            )
            self.last_received[seat_id] = timestamp
        self.publish_changes(place_id)
        return {
            "accepted": True,
            "duplicate": False,
            "sequence": report.sequence,
            "revision": self.revisions[place_id],
        }

    def expire(self):
        now = self.clock()[0]
        for observations in self.observations.values():
            expired = [
                did
                for did, obs in observations.items()
                if now - obs.received >= self.settings.seat_timeout_seconds
                or self.device_status(did, now)["status"] != "online"
            ]
            for did in expired:
                del observations[did]
        for place_id in self.layouts:
            self.publish_changes(place_id)

    def envelope(self, place_id: int, kind: str) -> dict:
        return {
            "type": kind,
            "server_id": self.server_id,
            "place_id": place_id,
            "revision": self.revisions[place_id],
            "sent_at": self.clock()[1],
        }

    @staticmethod
    def enqueue(queue: asyncio.Queue, event: dict):
        if queue.full():
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait({"type": "disconnect", "code": 1013})
        else:
            queue.put_nowait(event)

    def broadcast(self, place_id: int, event: dict):
        for queue in self.subscribers.get(place_id, ()):
            self.enqueue(queue, event)

    def subscribe(self, place_id: int) -> asyncio.Queue:
        if sum(map(len, self.subscribers.values())) >= self.settings.max_ws_connections:
            raise DomainError(503, "connection_limit", "Too many WebSocket connections")
        queue: asyncio.Queue = asyncio.Queue(maxsize=self.settings.ws_queue_size)
        self.subscribers.setdefault(place_id, set()).add(queue)
        event = self.envelope(place_id, "snapshot")
        event.update(self.snapshot(place_id))
        queue.put_nowait(event)
        return queue

    def unsubscribe(self, place_id: int, queue: asyncio.Queue):
        subscribers = self.subscribers.get(place_id)
        if subscribers is not None:
            subscribers.discard(queue)
            if not subscribers:
                self.subscribers.pop(place_id, None)

    async def sweep(self):
        while True:
            await asyncio.sleep(self.settings.sweep_interval_seconds)
            async with self.lock:
                self.expire()
