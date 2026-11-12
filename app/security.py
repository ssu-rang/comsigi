import hashlib
import secrets
import time
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pwdlib import PasswordHash
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import DomainError
from app.models import Admin

password_hasher = PasswordHash.recommended()
# Equal-cost verification for unknown usernames; no default account is created.
dummy_password_hash = password_hasher.hash(secrets.token_urlsafe(32))
admin_bearer = HTTPBearer(auto_error=False, scheme_name="AdminBearer")
device_bearer = HTTPBearer(auto_error=False, scheme_name="DeviceBearer")
DB = Annotated[AsyncSession, Depends(get_db)]


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class AdminSession:
    admin_id: int
    password_hash: str
    expires: float


class AuthState:
    def __init__(self):
        self.sessions: dict[str, AdminSession] = {}
        self.attempts: dict[str, tuple[float, int]] = {}

    def check_login_limit(self, client: str):
        now = time.monotonic()
        self.attempts = {k: v for k, v in self.attempts.items() if now - v[0] < 60}
        if client not in self.attempts and len(self.attempts) >= 4096:
            raise DomainError(429, "login_rate_limited", "Try again in 60 seconds")
        start, count = self.attempts.get(client, (now, 0))
        if count >= 10:
            raise DomainError(429, "login_rate_limited", "Try again in 60 seconds")
        self.attempts[client] = start, count + 1

    def issue(self, admin: Admin, ttl: int) -> str:
        now = time.monotonic()
        self.sessions = {k: v for k, v in self.sessions.items() if v.expires > now}
        if len(self.sessions) >= 1024:
            raise DomainError(429, "session_limit", "Too many active administrator sessions")
        token = secrets.token_urlsafe(32)
        self.sessions[token_hash(token)] = AdminSession(admin.id, admin.password_hash, now + ttl)
        return token


async def require_admin(
    request: Request,
    db: DB,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(admin_bearer)],
) -> Admin:
    if credentials is None:
        raise DomainError(401, "admin_unauthorized", "Administrator authentication required")
    key = token_hash(credentials.credentials)
    state = request.app.state.auth
    session = state.sessions.get(key)
    if session is None or session.expires <= time.monotonic():
        state.sessions.pop(key, None)
        raise DomainError(401, "admin_unauthorized", "Session expired or invalid")
    admin = await db.get(Admin, session.admin_id)
    if admin is None or not admin.enabled or admin.password_hash != session.password_hash:
        state.sessions.pop(key, None)
        raise DomainError(401, "admin_unauthorized", "Session expired or invalid")
    return admin


def authenticate_device(runtime, uid: str, credentials: HTTPAuthorizationCredentials | None) -> int:
    device = runtime.devices_by_uid.get(uid)
    provided_hash = token_hash(credentials.credentials if credentials else "")
    expected_hash = device["credential_hash"] if device else "0" * 64
    valid = secrets.compare_digest(provided_hash, expected_hash)
    if not valid or device is None or not device["enabled"]:
        raise DomainError(401, "device_unauthorized", "Device credentials invalid or disabled")
    return device["id"]


class HardwareRequestGuard:
    """Reject unknown credentials and oversized bodies before the JSON body is parsed.

    authenticate_device still binds the credential to the device_uid in the body.
    """

    max_body_bytes = 64 * 1024  # A 500-seat report is well under 32 KiB.

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope["path"] if scope["type"] == "http" else ""
        hardware = path.startswith("/api/v1/hardware/")
        # Pairing endpoints authenticate in the handler but share the body size limit.
        if not hardware and not path.startswith("/api/v1/provisioning/"):
            return await self.app(scope, receive, send)
        headers = dict(scope["headers"])
        scheme, _, token = headers.get(b"authorization", b"").decode("latin-1").partition(" ")
        known = scope["app"].state.runtime.enabled_credential_hashes
        if hardware and (scheme.lower() != "bearer" or token_hash(token) not in known):
            return await self.reject(
                scope,
                receive,
                send,
                401,
                "device_unauthorized",
                "Device credentials invalid or disabled",
            )
        length = headers.get(b"content-length", b"0")
        if not length.isdigit() or int(length) > self.max_body_bytes:
            return await self.reject(
                scope, receive, send, 413, "body_too_large", "Request body too large"
            )
        body = b""
        while True:
            message = await receive()
            if message["type"] != "http.request":
                return  # Client disconnected.
            body += message.get("body", b"")
            if len(body) > self.max_body_bytes:  # Chunked bodies have no Content-Length.
                return await self.reject(
                    scope, receive, send, 413, "body_too_large", "Request body too large"
                )
            if not message.get("more_body"):
                break
        replayed = False

        async def replay():
            nonlocal replayed
            if replayed:
                return await receive()
            replayed = True
            return {"type": "http.request", "body": body, "more_body": False}

        await self.app(scope, replay, send)

    @staticmethod
    async def reject(scope, receive, send, status, code, message):
        headers = {"WWW-Authenticate": "Bearer"} if status == 401 else {}
        response = JSONResponse(
            {"error": {"code": code, "message": message}}, status_code=status, headers=headers
        )
        await response(scope, receive, send)
