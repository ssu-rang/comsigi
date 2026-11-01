from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class Place(Base):
    __tablename__ = "places"
    __table_args__ = (
        CheckConstraint("canvas_width > 0 AND canvas_height > 0", name="ck_place_canvas"),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    slug: Mapped[str] = mapped_column(String(100), unique=True)
    description: Mapped[str] = mapped_column(String(2000), default="")
    canvas_width: Mapped[float] = mapped_column(Float, default=1200)
    canvas_height: Mapped[float] = mapped_column(Float, default=800)
    layout_version: Mapped[int] = mapped_column(default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class Geometry:
    x: Mapped[float] = mapped_column(Float, default=0)
    y: Mapped[float] = mapped_column(Float, default=0)
    width: Mapped[float] = mapped_column(Float)
    height: Mapped[float] = mapped_column(Float)
    rotation: Mapped[float] = mapped_column(Float, default=0)


class Table(Geometry, Base):
    __tablename__ = "tables"
    __table_args__ = (
        UniqueConstraint("place_id", "number", name="uq_table_place_number"),
        CheckConstraint("number > 0", name="ck_table_number"),
        CheckConstraint("shape IN ('rectangle', 'circle')", name="ck_table_shape"),
        CheckConstraint(
            "x >= 0 AND y >= 0 AND width > 0 AND height > 0 AND rotation >= 0 AND rotation < 360",
            name="ck_table_geometry",
        ),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    place_id: Mapped[int] = mapped_column(ForeignKey("places.id", ondelete="CASCADE"), index=True)
    number: Mapped[int]
    label: Mapped[str] = mapped_column(String(100), default="")
    shape: Mapped[str] = mapped_column(String(20), default="rectangle")


class Seat(Geometry, Base):
    __tablename__ = "seats"
    __table_args__ = (
        UniqueConstraint("place_id", "number", name="uq_seat_place_number"),
        CheckConstraint("number > 0", name="ck_seat_number"),
        CheckConstraint(
            "x >= 0 AND y >= 0 AND width > 0 AND height > 0 AND rotation >= 0 AND rotation < 360",
            name="ck_seat_geometry",
        ),
        {"sqlite_autoincrement": True},
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    place_id: Mapped[int] = mapped_column(ForeignKey("places.id", ondelete="CASCADE"), index=True)
    number: Mapped[int]
    label: Mapped[str] = mapped_column(String(100), default="")
    table_id: Mapped[int | None] = mapped_column(ForeignKey("tables.id", ondelete="SET NULL"))


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    device_uid: Mapped[str] = mapped_column(String(100), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    place_id: Mapped[int] = mapped_column(ForeignKey("places.id", ondelete="CASCADE"), index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    credential_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Admin(Base):
    __tablename__ = "admins"
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(100), unique=True)
    password_hash: Mapped[str] = mapped_column(String(300))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
