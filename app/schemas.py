from datetime import UTC, datetime
from typing import Annotated, ClassVar, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)

PositiveInt = Annotated[StrictInt, Field(gt=0, le=2147483647)]
Size = Annotated[float, Field(gt=0, le=100000, allow_inf_nan=False)]
Position = Annotated[float, Field(ge=0, le=100000, allow_inf_nan=False)]
Rotation = Annotated[float, Field(ge=0, lt=360, allow_inf_nan=False)]
Name = Annotated[str, Field(min_length=1, max_length=100, pattern=r"\S")]
Label = Annotated[str, Field(max_length=100)]
Slug = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")]
DeviceUID = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")]
Shape = Literal["rectangle", "circle"]


class Schema(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)


class Patch(Schema):
    nullable_fields: ClassVar[frozenset[str]] = frozenset()

    @model_validator(mode="after")
    def reject_nulls(self):
        if not self.model_fields_set:
            raise ValueError("At least one field is required")
        for field in self.model_fields_set - self.nullable_fields:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class PlaceCreate(Schema):
    name: Name
    slug: Slug
    description: Annotated[str, Field(max_length=2000)] = ""
    canvas_width: Size = 1200
    canvas_height: Size = 800


class PlacePatch(Patch):
    name: Name | None = None
    slug: Slug | None = None
    description: Annotated[str, Field(max_length=2000)] | None = None
    canvas_width: Size | None = None
    canvas_height: Size | None = None


class PlaceOut(PlaceCreate):
    id: int
    layout_version: int
    created_at: datetime
    updated_at: datetime

    @field_validator("created_at", "updated_at")
    @classmethod
    def utc_dates(cls, value: datetime) -> datetime:
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value


class Geometry(Schema):
    x: Position = 0
    y: Position = 0
    width: Size = 40
    height: Size = 40
    rotation: Rotation = 0


class GeometryPatch(Patch):
    x: Position | None = None
    y: Position | None = None
    width: Size | None = None
    height: Size | None = None
    rotation: Rotation | None = None


class SeatCreate(Geometry):
    number: PositiveInt
    label: Label = ""
    table_id: PositiveInt | None = None


class SeatPatch(GeometryPatch):
    nullable_fields: ClassVar[frozenset[str]] = frozenset({"table_id"})
    number: PositiveInt | None = None
    label: Label | None = None
    table_id: PositiveInt | None = None


class SeatOut(SeatCreate):
    id: int
    place_id: int


class TableCreate(Geometry):
    number: PositiveInt
    label: Label = ""
    shape: Shape = "rectangle"
    width: Size = 120
    height: Size = 80


class TablePatch(GeometryPatch):
    number: PositiveInt | None = None
    label: Label | None = None
    shape: Shape | None = None


class TableOut(TableCreate):
    id: int
    place_id: int


class LayoutOut(Schema):
    place: PlaceOut
    seats: list[SeatOut]
    tables: list[TableOut]


class ElementPosition(Geometry):
    id: PositiveInt
    x: Position
    y: Position
    width: Size
    height: Size
    rotation: Rotation


class LayoutUpdate(Schema):
    expected_version: PositiveInt
    canvas_width: Size
    canvas_height: Size
    seats: list[ElementPosition] = Field(max_length=10000)
    tables: list[ElementPosition] = Field(max_length=10000)

    @model_validator(mode="after")
    def unique_ids(self):
        for elements in (self.seats, self.tables):
            if len({element.id for element in elements}) != len(elements):
                raise ValueError("Duplicate element IDs")
        return self


class DeviceCreate(Schema):
    device_uid: DeviceUID
    name: Name
    place_id: PositiveInt
    enabled: StrictBool = True


class DevicePatch(Patch):
    name: Name | None = None
    place_id: PositiveInt | None = None
    enabled: StrictBool | None = None


class DeviceOut(DeviceCreate):
    id: int
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def utc_dates(cls, value: datetime) -> datetime:
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value


class DeviceWithCredential(Schema):
    device: DeviceOut
    credential: str


class DeviceStatus(Schema):
    id: int
    status: Literal["online", "offline", "disabled"]
    last_seen_at: datetime | None


class DeviceAdminOut(DeviceOut):
    status: Literal["online", "offline", "disabled"]
    last_seen_at: datetime | None


class Login(Schema):
    username: Name
    password: SecretStr = Field(min_length=1, max_length=1024)


class TokenOut(Schema):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class HardwareSession(Schema):
    device_uid: DeviceUID


class HardwareSessionOut(Schema):
    session_id: str
    server_id: str
    device_timeout_seconds: float
    seat_timeout_seconds: float


class SeatReport(Schema):
    number: PositiveInt
    occupied: StrictBool


class HardwareReport(HardwareSession):
    session_id: Annotated[str, Field(min_length=20, max_length=100)]
    sequence: Annotated[StrictInt, Field(ge=0, le=9007199254740991)]
    seats: list[SeatReport] = Field(max_length=500)

    @model_validator(mode="after")
    def unique_numbers(self):
        if len({seat.number for seat in self.seats}) != len(self.seats):
            raise ValueError("Duplicate seat numbers")
        return self


class ReportOut(Schema):
    accepted: bool
    duplicate: bool
    sequence: int
    revision: int


class SeatState(Schema):
    id: int
    number: int
    status: Literal["available", "occupied", "unknown"]
    last_received_at: datetime | None


class Summary(Schema):
    total: int
    available: int
    occupied: int
    unknown: int


class StateOut(Schema):
    server_id: str
    place_id: int
    revision: int
    layout_version: int
    seats: list[SeatState]
    devices: list[DeviceStatus]
    summary: Summary


class Snapshot(Schema):
    layout: LayoutOut
    state: StateOut


class LegacySeat(Schema):
    id: int
    status: Literal["available", "occupied", "unknown"]


class LegacySeats(Schema):
    seats: list[LegacySeat]
