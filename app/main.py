import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.api import admin, auth, hardware
from app.api.router import api_router
from app.config import Settings
from app.db import create_database
from app.errors import DomainError
from app.realtime import Runtime
from app.security import AuthState

logger = logging.getLogger(__name__)
SCHEMA_REVISION = "0001_initial"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine, session_factory = create_database(settings.database_url)
        app.state.session_factory = session_factory
        app.state.settings = settings
        app.state.auth = AuthState()
        app.state.runtime = runtime = Runtime(settings)
        try:
            try:
                async with session_factory() as db:
                    revisions = set(
                        (await db.scalars(text("SELECT version_num FROM alembic_version"))).all()
                    )
                    if revisions != {SCHEMA_REVISION}:
                        raise RuntimeError("Schema mismatch: run 'uv run alembic upgrade head'")
                    await runtime.reload(db)
            except SQLAlchemyError as exc:
                raise RuntimeError(
                    "Database not initialized: run 'uv run alembic upgrade head'"
                ) from exc
            app.state.sweeper = asyncio.create_task(runtime.sweep(), name="seat-expiration")
            logger.info("Started seat runtime server_id=%s", runtime.server_id)
            try:
                yield
            finally:
                app.state.sweeper.cancel()
                await asyncio.gather(app.state.sweeper, return_exceptions=True)
                for place_id in list(runtime.subscribers):
                    runtime.broadcast(place_id, {"type": "disconnect", "code": 1001})
                app.state.auth.sessions.clear()
        finally:
            await engine.dispose()

    app = FastAPI(title="Comsigi Seat API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.exception_handler(DomainError)
    async def domain_error(_request: Request, exc: DomainError):
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else {}
        if exc.status == 429:
            headers["Retry-After"] = "60"
        return JSONResponse(
            status_code=exc.status,
            content={"error": {"code": exc.code, "message": exc.message}},
            headers=headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        # Never echo credentials from Pydantic input/context.
        details = [{"loc": e["loc"], "type": e["type"], "msg": e["msg"]} for e in exc.errors()]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "Invalid request",
                    "details": details,
                }
            },
        )

    @app.exception_handler(SQLAlchemyError)
    async def database_error(_request: Request, exc: SQLAlchemyError):
        logger.error("Database operation failed: %s", type(exc).__name__)
        return JSONResponse(
            status_code=503,
            content={
                "error": {
                    "code": "database_unavailable",
                    "message": "Database temporarily unavailable",
                }
            },
        )

    @app.middleware("http")
    async def prevent_stale_caches(request: Request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    for router in (api_router, auth.router, admin.router, hardware.router):
        app.include_router(router, prefix="/api/v1")
    return app


app = create_app()
