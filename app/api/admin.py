"""Small CRUD handlers; one runtime lock serializes configuration and sensor updates."""

import secrets

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.errors import DomainError
from app.models import Device, Place, Seat, Table, utcnow
from app.schemas import (
    DeviceAdminOut,
    DeviceCreate,
    DevicePatch,
    DeviceWithCredential,
    LayoutOut,
    LayoutUpdate,
    PlaceCreate,
    PlaceOut,
    PlacePatch,
    SeatCreate,
    SeatOut,
    SeatPatch,
    TableCreate,
    TableOut,
    TablePatch,
)
from app.security import DB, require_admin, token_hash

router = APIRouter(prefix="/admin", tags=["administration"], dependencies=[Depends(require_admin)])


def public_device(device):
    return {key: value for key, value in device.items() if key != "credential_hash"}


async def required(db, model, item_id: int, place_id: int | None = None):
    obj = await db.get(model, item_id)
    if obj is None or (place_id is not None and obj.place_id != place_id):
        raise DomainError(404, "not_found", f"{model.__name__} not found")
    return obj


def apply_fields(obj, body):
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(obj, key, value)


def fits(obj, width: float, height: float):
    if obj.x + obj.width > width or obj.y + obj.height > height:
        raise DomainError(422, "outside_canvas", "Element's unrotated bounds exceed the canvas")


def bump(place: Place):
    place.layout_version += 1
    place.updated_at = utcnow()


async def check_table(db, table_id: int | None, place_id: int):
    if table_id is not None:
        await required(db, Table, table_id, place_id)


async def commit_reload(db, runtime, changed: set[int]):
    try:
        await db.flush()
        # Read FK cascades and validate the cache while the transaction can still roll back.
        db.expire_all()
        configuration = await runtime.load_configuration(db)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise DomainError(
            409, "constraint_conflict", "Duplicate slug, number, or device UID"
        ) from exc
    runtime.configure(configuration, changed)


@router.get("/places", response_model=list[PlaceOut])
async def list_places(request: Request):
    runtime = request.app.state.runtime
    async with runtime.lock:
        return [layout["place"] for layout in runtime.layouts.values()]


@router.post("/places", response_model=PlaceOut, status_code=201)
async def create_place(body: PlaceCreate, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = Place(**body.model_dump())
        db.add(place)
        try:
            await db.flush()
        except IntegrityError as exc:
            await db.rollback()
            raise DomainError(409, "constraint_conflict", "Place slug already exists") from exc
        place_id = place.id
        await commit_reload(db, runtime, {place_id})
        return runtime.layouts[place_id]["place"]


@router.get("/places/{place_id}", response_model=PlaceOut)
async def get_place(place_id: int, db: DB):
    return await required(db, Place, place_id)


@router.patch("/places/{place_id}", response_model=PlaceOut)
async def update_place(place_id: int, body: PlacePatch, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        apply_fields(place, body)
        # Do not autoflush before the shared integrity error handler.
        with db.no_autoflush:
            for model in (Seat, Table):
                for item in await db.scalars(select(model).where(model.place_id == place_id)):
                    fits(item, place.canvas_width, place.canvas_height)
        bump(place)
        await commit_reload(db, runtime, {place_id})
        return runtime.layouts[place_id]["place"]


@router.delete("/places/{place_id}", status_code=204)
async def delete_place(place_id: int, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        await db.delete(await required(db, Place, place_id))
        await commit_reload(db, runtime, {place_id})
    return Response(status_code=204)


@router.get("/places/{place_id}/layout", response_model=LayoutOut)
async def get_layout(place_id: int, request: Request):
    runtime = request.app.state.runtime
    async with runtime.lock:
        if place_id not in runtime.layouts:
            raise DomainError(404, "not_found", "Place not found")
        return runtime.layouts[place_id]


@router.put("/places/{place_id}/layout", response_model=LayoutOut)
async def update_layout(place_id: int, body: LayoutUpdate, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        if place.layout_version != body.expected_version:
            raise DomainError(409, "layout_version_conflict", "Reload layout before saving")
        for model, positions in ((Seat, body.seats), (Table, body.tables)):
            objects = {
                obj.id: obj
                for obj in await db.scalars(select(model).where(model.place_id == place_id))
            }
            if set(objects) != {position.id for position in positions}:
                raise DomainError(
                    422, "layout_ids_mismatch", "Include every existing seat and table"
                )
            for position in positions:
                fits(position, body.canvas_width, body.canvas_height)
                for key, value in position.model_dump(exclude={"id"}).items():
                    setattr(objects[position.id], key, value)
        place.canvas_width, place.canvas_height = body.canvas_width, body.canvas_height
        bump(place)
        await commit_reload(db, runtime, {place_id})
        return runtime.layouts[place_id]


@router.get("/places/{place_id}/seats", response_model=list[SeatOut])
async def list_seats(place_id: int, db: DB):
    await required(db, Place, place_id)
    return (
        await db.scalars(select(Seat).where(Seat.place_id == place_id).order_by(Seat.number))
    ).all()


@router.post("/places/{place_id}/seats", response_model=SeatOut, status_code=201)
async def create_seat(place_id: int, body: SeatCreate, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        await check_table(db, body.table_id, place_id)
        fits(body, place.canvas_width, place.canvas_height)
        seat = Seat(place_id=place_id, **body.model_dump())
        db.add(seat)
        bump(place)
        await commit_reload(db, runtime, {place_id})
        return next(s for s in runtime.layouts[place_id]["seats"] if s["number"] == body.number)


@router.get("/places/{place_id}/seats/{seat_id}", response_model=SeatOut)
async def get_seat(place_id: int, seat_id: int, db: DB):
    return await required(db, Seat, seat_id, place_id)


@router.patch("/places/{place_id}/seats/{seat_id}", response_model=SeatOut)
async def update_seat(place_id: int, seat_id: int, body: SeatPatch, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        seat = await required(db, Seat, seat_id, place_id)
        if "table_id" in body.model_fields_set:
            await check_table(db, body.table_id, place_id)
        apply_fields(seat, body)
        fits(seat, place.canvas_width, place.canvas_height)
        bump(place)
        await commit_reload(db, runtime, {place_id})
        return runtime.seats[seat_id]


@router.delete("/places/{place_id}/seats/{seat_id}", status_code=204)
async def delete_seat(place_id: int, seat_id: int, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        await db.delete(await required(db, Seat, seat_id, place_id))
        bump(place)
        await commit_reload(db, runtime, {place_id})
    return Response(status_code=204)


@router.get("/places/{place_id}/tables", response_model=list[TableOut])
async def list_tables(place_id: int, db: DB):
    await required(db, Place, place_id)
    return (
        await db.scalars(select(Table).where(Table.place_id == place_id).order_by(Table.number))
    ).all()


@router.post("/places/{place_id}/tables", response_model=TableOut, status_code=201)
async def create_table(place_id: int, body: TableCreate, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        fits(body, place.canvas_width, place.canvas_height)
        db.add(Table(place_id=place_id, **body.model_dump()))
        bump(place)
        await commit_reload(db, runtime, {place_id})
        return next(t for t in runtime.layouts[place_id]["tables"] if t["number"] == body.number)


@router.get("/places/{place_id}/tables/{table_id}", response_model=TableOut)
async def get_table(place_id: int, table_id: int, db: DB):
    return await required(db, Table, table_id, place_id)


@router.patch("/places/{place_id}/tables/{table_id}", response_model=TableOut)
async def update_table(place_id: int, table_id: int, body: TablePatch, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        table = await required(db, Table, table_id, place_id)
        apply_fields(table, body)
        fits(table, place.canvas_width, place.canvas_height)
        bump(place)
        await commit_reload(db, runtime, {place_id})
        return next(t for t in runtime.layouts[place_id]["tables"] if t["id"] == table_id)


@router.delete("/places/{place_id}/tables/{table_id}", status_code=204)
async def delete_table(place_id: int, table_id: int, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        place = await required(db, Place, place_id)
        await db.delete(await required(db, Table, table_id, place_id))
        bump(place)
        await commit_reload(db, runtime, {place_id})
    return Response(status_code=204)


@router.get("/devices", response_model=list[DeviceAdminOut])
async def list_devices(request: Request, place_id: int | None = None):
    runtime = request.app.state.runtime
    async with runtime.lock:
        return [
            {**public_device(device), **runtime.device_status(did)}
            for did, device in runtime.devices.items()
            if place_id is None or device["place_id"] == place_id
        ]


@router.get("/devices/{device_id}", response_model=DeviceAdminOut)
async def get_device(device_id: int, request: Request):
    runtime = request.app.state.runtime
    async with runtime.lock:
        if device_id not in runtime.devices:
            raise DomainError(404, "not_found", "Device not found")
        return {**public_device(runtime.devices[device_id]), **runtime.device_status(device_id)}


@router.post("/devices", response_model=DeviceWithCredential, status_code=201)
async def create_device(body: DeviceCreate, request: Request, response: Response, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        await required(db, Place, body.place_id)
        credential = secrets.token_urlsafe(32)
        db.add(Device(**body.model_dump(), credential_hash=token_hash(credential)))
        await commit_reload(db, runtime, {body.place_id})
        device = next(d for d in runtime.devices.values() if d["device_uid"] == body.device_uid)
    response.headers["Cache-Control"] = "no-store"
    return {"device": public_device(device), "credential": credential}


@router.patch("/devices/{device_id}", response_model=DeviceAdminOut)
async def update_device(device_id: int, body: DevicePatch, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        device = await required(db, Device, device_id)
        old_place = device.place_id
        if body.place_id is not None:
            await required(db, Place, body.place_id)
        apply_fields(device, body)
        await commit_reload(db, runtime, {old_place, device.place_id})
        return {**public_device(runtime.devices[device_id]), **runtime.device_status(device_id)}


@router.post("/devices/{device_id}/rotate-credential", response_model=DeviceWithCredential)
async def rotate_credential(device_id: int, request: Request, response: Response, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        device = await required(db, Device, device_id)
        credential = secrets.token_urlsafe(32)
        device.credential_hash = token_hash(credential)
        await commit_reload(db, runtime, {device.place_id})
    response.headers["Cache-Control"] = "no-store"
    return {"device": public_device(runtime.devices[device_id]), "credential": credential}


@router.delete("/devices/{device_id}", status_code=204)
async def delete_device(device_id: int, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        device = await required(db, Device, device_id)
        place_id = device.place_id
        await db.delete(device)
        await commit_reload(db, runtime, {place_id})
    return Response(status_code=204)
