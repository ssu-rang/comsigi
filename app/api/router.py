from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

api_router = APIRouter()


class Seat(BaseModel):
    id: int = Field(gt=0)
    status: Literal["available", "occupied", "unknown"]


class SeatsResponse(BaseModel):
    seats: list[Seat]


@api_router.get("/health", tags=["health"])
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@api_router.get("/seats", tags=["seats"], response_model=SeatsResponse)
def get_seats() -> SeatsResponse:
    # TODO: Populate seats from the data source once it is connected.
    return SeatsResponse(seats=[])
