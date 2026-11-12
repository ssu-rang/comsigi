from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select

from app.models import DeviceRegistration
from app.schemas import (
    HardwareReport,
    HardwareSession,
    HardwareSessionOut,
    RegistrationConfirmOut,
    ReportOut,
)
from app.security import DB, authenticate_device, device_bearer

router = APIRouter(prefix="/hardware", tags=["hardware"])
Credentials = Annotated[HTTPAuthorizationCredentials | None, Depends(device_bearer)]


@router.post("/session", response_model=HardwareSessionOut)
async def start_session(
    body: HardwareSession, request: Request, response: Response, token: Credentials
):
    runtime = request.app.state.runtime
    async with runtime.lock:
        device_id = authenticate_device(runtime, body.device_uid, token)
        result = runtime.begin_session(device_id)
    response.headers["Cache-Control"] = "no-store"
    return result


@router.post("/reports", response_model=ReportOut)
async def report(body: HardwareReport, request: Request, token: Credentials):
    runtime = request.app.state.runtime
    async with runtime.lock:
        device_id = authenticate_device(runtime, body.device_uid, token)
        return runtime.ingest(device_id, body)


@router.post("/registration/confirm", response_model=RegistrationConfirmOut)
async def confirm_registration(body: HardwareSession, request: Request, db: DB, token: Credentials):
    """Prove receipt of the delivered credential; status polls stop issuing new keys.

    Idempotent. Devices created manually by an administrator also receive "completed".
    Unlike session/report, this rare call writes to the database.
    """
    runtime = request.app.state.runtime
    async with runtime.lock:
        device_id = authenticate_device(runtime, body.device_uid, token)
        registration = await db.scalar(
            select(DeviceRegistration).where(DeviceRegistration.device_id == device_id)
        )
        if registration is not None and registration.status == "approved":
            registration.status = "completed"
            await db.commit()
    return {"status": "completed"}
