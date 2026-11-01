from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials

from app.schemas import HardwareReport, HardwareSession, HardwareSessionOut, ReportOut
from app.security import authenticate_device, device_bearer

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
