"""Camera self-registration.

Flow: an administrator issues a one-time pairing code -> the camera registers its
hardware UID with that code and receives a registration secret -> the camera polls
its status -> an administrator approves it into a place (device and missing seats
are created in one transaction) -> the next poll delivers a fresh device credential
-> the camera confirms with that credential, which retires further deliveries.

Pairing codes, registration secrets, and device credentials are stored only as
SHA-256 hashes. Every pending registration is persisted, so it survives a restart.
"""

import secrets
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError

from app.api.admin import bump, commit_reload, public_device, required
from app.errors import DomainError
from app.models import Device, DeviceRegistration, PairingToken, Place, Seat, Table, utcnow
from app.provisioning import SEAT_SIZE, aware, plan_seat_positions
from app.schemas import (
    PairingCodeIssued,
    PairingCodeOut,
    ProvisioningFailureOut,
    RegistrationAccepted,
    RegistrationAdminOut,
    RegistrationApprove,
    RegistrationApproved,
    RegistrationRequest,
    RegistrationStatus,
    RegistrationStatusOut,
    RegistrationStatusRequest,
)
from app.security import DB, require_admin, token_hash

router = APIRouter(prefix="/provisioning", tags=["camera provisioning"])
admin_router = APIRouter(
    prefix="/admin", tags=["camera provisioning"], dependencies=[Depends(require_admin)]
)
pairing_bearer = HTTPBearer(auto_error=False, scheme_name="PairingCodeBearer")
registration_bearer = HTTPBearer(auto_error=False, scheme_name="RegistrationSecretBearer")
PairingCredentials = Annotated[HTTPAuthorizationCredentials | None, Depends(pairing_bearer)]
RegistrationCredentials = Annotated[
    HTTPAuthorizationCredentials | None, Depends(registration_bearer)
]
TOKEN_RETENTION = timedelta(days=7)


def client_of(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def status_of(registration: DeviceRegistration, now, runtime) -> RegistrationStatus:
    if registration.status == "pending":
        return "expired" if aware(registration.expires_at) <= now else "pending"
    if registration.status in ("approved", "completed") and (
        registration.device_id is None or registration.device_id not in runtime.devices
    ):
        return "removed"  # The device or its place was deleted; the camera must pair again.
    return registration.status


def registration_out(registration: DeviceRegistration, now, runtime) -> dict:
    return {
        "id": registration.id,
        "device_uid": registration.device_uid,
        "status": status_of(registration, now, runtime),
        "model": registration.model,
        "firmware_version": registration.firmware_version,
        "seat_numbers": list(registration.seat_numbers),
        "requested_at": aware(registration.requested_at),
        "expires_at": aware(registration.expires_at),
        "decided_at": aware(registration.decided_at),
        "place_id": registration.place_id,
        "device_id": registration.device_id,
    }


def pairing_out(token: PairingToken, now) -> dict:
    if token.revoked_at is not None:
        status = "revoked"
    elif token.used_at is not None:
        status = "used"
    elif aware(token.expires_at) <= now:
        status = "expired"
    else:
        status = "active"
    return {
        "id": token.id,
        "status": status,
        "created_at": aware(token.created_at),
        "expires_at": aware(token.expires_at),
        "used_at": aware(token.used_at),
        "revoked_at": aware(token.revoked_at),
    }


# Camera-facing endpoints ----------------------------------------------------------------


@router.post("/register", response_model=RegistrationAccepted, status_code=201)
async def register(
    body: RegistrationRequest,
    request: Request,
    response: Response,
    db: DB,
    pairing_code: PairingCredentials,
):
    """Create or refresh a pending registration. Retrying with the same code is safe."""
    runtime = request.app.state.runtime
    state = request.app.state.provisioning
    settings = request.app.state.settings
    client, uid = client_of(request), body.device_uid
    async with runtime.lock:
        state.check(client)
        now = utcnow()
        token = None
        if pairing_code is not None:
            token = await db.scalar(
                select(PairingToken).where(
                    PairingToken.token_hash == token_hash(pairing_code.credentials)
                )
            )
        if token is None or token.revoked_at is not None:
            raise state.fail(
                client, uid, 401, "pairing_unauthorized", "Pairing code invalid or revoked"
            )
        if aware(token.expires_at) <= now:
            raise state.fail(client, uid, 401, "pairing_code_expired", "Pairing code expired")
        if uid in runtime.devices_by_uid:
            # Do not consume the code: the administrator can reuse it after removing the device.
            raise state.fail(
                client,
                uid,
                409,
                "device_already_registered",
                "Device already registered; use its credential or ask for a rotation",
            )
        registration = await db.scalar(
            select(DeviceRegistration).where(DeviceRegistration.device_uid == uid)
        )
        retry = token.used_at is not None
        if retry and not (
            registration is not None
            and registration.pairing_token_id == token.id
            and status_of(registration, now, runtime) == "pending"
        ):
            raise state.fail(client, uid, 401, "pairing_code_used", "Pairing code already used")
        if registration is None:
            registration = DeviceRegistration(device_uid=uid)
            db.add(registration)
        if not retry:
            # A new code restarts the registration, also after rejection/expiry/removal.
            token.used_at = now
            registration.requested_at = now
            registration.expires_at = now + timedelta(seconds=settings.registration_ttl_seconds)
        secret = secrets.token_urlsafe(32)
        registration.status = "pending"
        registration.secret_hash = token_hash(secret)  # Replaces any earlier secret.
        registration.pairing_token_id = token.id
        registration.seat_numbers = body.inventory()
        registration.model = body.model
        registration.firmware_version = body.firmware_version
        registration.place_id = None
        registration.device_id = None
        registration.decided_at = None
        try:
            await db.commit()
        except IntegrityError as exc:
            await db.rollback()
            raise DomainError(409, "registration_conflict", "Retry the registration") from exc
    if retry:
        response.status_code = 200
    return {
        "status": "pending",
        "registration_secret": secret,
        "retry_after_seconds": settings.registration_poll_seconds,
        "expires_at": aware(registration.expires_at),
    }


@router.post("/status", response_model=RegistrationStatusOut)
async def registration_status(
    body: RegistrationStatusRequest,
    request: Request,
    response: Response,
    db: DB,
    secret: RegistrationCredentials,
):
    """Poll until approved. Each approved poll issues a new credential and revokes the last
    undelivered one, so a lost response is recovered by polling again."""
    runtime = request.app.state.runtime
    state = request.app.state.provisioning
    settings = request.app.state.settings
    client = client_of(request)
    async with runtime.lock:
        state.check(client)
        registration = None
        if secret is not None:
            registration = await db.scalar(
                select(DeviceRegistration).where(
                    DeviceRegistration.secret_hash == token_hash(secret.credentials)
                )
            )
        if registration is None or not secrets.compare_digest(
            registration.device_uid, body.device_uid
        ):
            raise state.fail(
                client,
                body.device_uid,
                401,
                "registration_unauthorized",
                "Registration secret invalid or replaced",
            )
        now = utcnow()
        status = status_of(registration, now, runtime)
        if status == "pending":
            response.headers["Retry-After"] = str(settings.registration_poll_seconds)
            return {
                "status": status,
                "retryable": True,
                "retry_after_seconds": settings.registration_poll_seconds,
                "expires_at": aware(registration.expires_at),
            }
        if status != "approved":
            return {"status": status, "retryable": False}
        device = await db.get(Device, registration.device_id)
        credential = secrets.token_urlsafe(32)
        device.credential_hash = token_hash(credential)
        await commit_reload(db, runtime, {device.place_id})
    return {"status": "approved", "retryable": False, "credential": credential}


# Administrator endpoints ----------------------------------------------------------------


@admin_router.post("/pairing-codes", response_model=PairingCodeIssued, status_code=201)
async def issue_pairing_code(request: Request, db: DB):
    """The code is returned only in this response."""
    runtime = request.app.state.runtime
    settings = request.app.state.settings
    async with runtime.lock:
        now = utcnow()
        await db.execute(
            delete(PairingToken).where(PairingToken.expires_at < now - TOKEN_RETENTION)
        )
        active = await db.scalar(
            select(func.count())
            .select_from(PairingToken)
            .where(
                PairingToken.used_at.is_(None),
                PairingToken.revoked_at.is_(None),
                PairingToken.expires_at > now,
            )
        )
        if active >= settings.max_active_pairing_codes:
            raise DomainError(
                409, "too_many_pairing_codes", "Revoke or use existing pairing codes first"
            )
        code = secrets.token_urlsafe(18)
        token = PairingToken(
            token_hash=token_hash(code),
            created_at=now,
            expires_at=now + timedelta(seconds=settings.pairing_code_ttl_seconds),
        )
        db.add(token)
        await db.commit()
    return {**pairing_out(token, now), "code": code}


@admin_router.get("/pairing-codes", response_model=list[PairingCodeOut])
async def list_pairing_codes(db: DB):
    now = utcnow()
    tokens = (
        await db.scalars(select(PairingToken).order_by(PairingToken.id.desc()).limit(100))
    ).all()
    return [pairing_out(token, now) for token in tokens]


@admin_router.delete("/pairing-codes/{code_id}", status_code=204)
async def revoke_pairing_code(code_id: int, request: Request, db: DB):
    """Revoking also stops retries that would refresh the linked registration's secret."""
    async with request.app.state.runtime.lock:
        token = await required(db, PairingToken, code_id)
        if token.revoked_at is None:
            token.revoked_at = utcnow()
            await db.commit()
    return Response(status_code=204)


@admin_router.get("/device-registrations", response_model=list[RegistrationAdminOut])
async def list_registrations(request: Request, db: DB, status: RegistrationStatus | None = None):
    runtime = request.app.state.runtime
    async with runtime.lock:
        now = utcnow()
        registrations = (
            await db.scalars(
                select(DeviceRegistration).order_by(DeviceRegistration.requested_at.desc())
            )
        ).all()
        items = [registration_out(r, now, runtime) for r in registrations]
    return [item for item in items if status is None or item["status"] == status]


@admin_router.get("/provisioning-failures", response_model=list[ProvisioningFailureOut])
async def list_failures(request: Request):
    """Recent rejected pairing attempts since the server started (diagnostics only)."""
    return list(request.app.state.provisioning.recent)


def approval_out(registration, runtime, now, created, existing) -> dict:
    device_id = registration.device_id
    return {
        "registration": registration_out(registration, now, runtime),
        "device": {**public_device(runtime.devices[device_id]), **runtime.device_status(device_id)},
        "seats_created": created,
        "seats_existing": existing,
    }


@admin_router.post(
    "/device-registrations/{registration_id}/approve", response_model=RegistrationApproved
)
async def approve_registration(
    registration_id: int, body: RegistrationApprove, request: Request, db: DB
):
    """Create the device and any missing reported seats in one transaction.

    Idempotent: approving again into the same place returns the current result without
    creating anything. Existing seats are never moved, renumbered, or deleted.
    """
    runtime = request.app.state.runtime
    async with runtime.lock:
        now = utcnow()
        registration = await required(db, DeviceRegistration, registration_id)
        status = status_of(registration, now, runtime)
        if status in ("approved", "completed"):
            if registration.place_id != body.place_id:
                raise DomainError(
                    409, "registration_already_approved", "Already connected to another place"
                )
            numbers = set(runtime.seat_ids_by_number.get(body.place_id, {}))
            existing = [n for n in registration.seat_numbers if n in numbers]
            return approval_out(registration, runtime, now, [], existing)
        if status != "pending":
            raise DomainError(409, f"registration_{status}", f"Registration is {status}")
        place = await required(db, Place, body.place_id)
        if registration.device_uid in runtime.devices_by_uid:
            raise DomainError(409, "device_already_registered", "Device UID already registered")
        # Unusable until the camera's next status poll replaces it with a delivered key.
        device = Device(
            device_uid=registration.device_uid,
            name=body.name,
            place_id=place.id,
            enabled=True,
            credential_hash=token_hash(secrets.token_urlsafe(32)),
        )
        db.add(device)
        created: list[int] = []
        existing: list[int] = []
        if body.create_seats and registration.seat_numbers:
            with db.no_autoflush:
                seats = (await db.scalars(select(Seat).where(Seat.place_id == place.id))).all()
                tables = (await db.scalars(select(Table).where(Table.place_id == place.id))).all()
            numbers = {seat.number for seat in seats}
            created = [n for n in registration.seat_numbers if n not in numbers]
            existing = [n for n in registration.seat_numbers if n in numbers]
            positions, height = plan_seat_positions(
                place.canvas_width,
                place.canvas_height,
                [(item.x, item.y, item.width, item.height) for item in (*seats, *tables)],
                len(created),
            )
            for number, (x, y) in zip(created, positions, strict=True):
                db.add(
                    Seat(
                        place_id=place.id,
                        number=number,
                        x=x,
                        y=y,
                        width=SEAT_SIZE,
                        height=SEAT_SIZE,
                        rotation=0,
                    )
                )
            if created:
                place.canvas_height = height
                bump(place)
        try:
            await db.flush()
        except IntegrityError as exc:
            await db.rollback()
            raise DomainError(409, "constraint_conflict", "Duplicate seat number or UID") from exc
        registration.status = "approved"
        registration.place_id = place.id
        registration.device_id = device.id
        registration.decided_at = now
        # Device, seats, canvas, and registration commit together or not at all.
        await commit_reload(db, runtime, {place.id})
        await db.refresh(registration)  # commit_reload expired every loaded object.
        return approval_out(registration, runtime, now, created, existing)


@admin_router.post(
    "/device-registrations/{registration_id}/reject", response_model=RegistrationAdminOut
)
async def reject_registration(registration_id: int, request: Request, db: DB):
    runtime = request.app.state.runtime
    async with runtime.lock:
        now = utcnow()
        registration = await required(db, DeviceRegistration, registration_id)
        status = status_of(registration, now, runtime)
        if status in ("approved", "completed"):
            raise DomainError(
                409, "registration_already_approved", "Delete the device to disconnect it"
            )
        if status != "rejected":
            registration.status = "rejected"
            registration.decided_at = now
            await db.commit()
        return registration_out(registration, now, runtime)
