from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from app.errors import DomainError
from app.models import Admin
from app.schemas import Login, TokenOut
from app.security import (
    DB,
    admin_bearer,
    dummy_password_hash,
    password_hasher,
    require_admin,
    token_hash,
)

router = APIRouter(prefix="/auth", tags=["admin authentication"])


@router.post("/token", response_model=TokenOut)
async def login(body: Login, request: Request, response: Response, db: DB):
    auth = request.app.state.auth
    auth.check_login_limit(request.client.host if request.client else "unknown")
    admin = await db.scalar(select(Admin).where(Admin.username == body.username))
    valid = await run_in_threadpool(
        password_hasher.verify,
        body.password.get_secret_value(),
        admin.password_hash if admin else dummy_password_hash,
    )
    if not valid or admin is None or not admin.enabled:
        raise DomainError(401, "invalid_credentials", "Invalid username or password")
    ttl = request.app.state.settings.admin_token_ttl_seconds
    token = auth.issue(admin, ttl)
    response.headers["Cache-Control"] = "no-store"
    return TokenOut(access_token=token, expires_in=ttl)


@router.delete("/token", status_code=204, dependencies=[Depends(require_admin)])
async def logout(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(admin_bearer)],
):
    request.app.state.auth.sessions.pop(token_hash(credentials.credentials), None)
    return Response(status_code=204)


@router.get("/me")
async def me(admin: Annotated[Admin, Depends(require_admin)]):
    return {"id": admin.id, "username": admin.username}
