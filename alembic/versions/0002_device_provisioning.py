"""Camera self-registration: pairing codes and pending registrations

Revision ID: 0002_device_provisioning
Revises: 0001_initial

Additive only: existing places, seats, tables, and devices are untouched, so
devices registered manually keep working with their current credentials.
"""

import sqlalchemy as sa

from alembic import op

revision = "0002_device_provisioning"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "pairing_tokens",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
        sqlite_autoincrement=True,
    )
    op.create_table(
        "device_registrations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("device_uid", sa.String(length=100), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("secret_hash", sa.String(length=64), nullable=False),
        sa.Column("pairing_token_id", sa.Integer(), nullable=True),
        sa.Column("seat_numbers", sa.JSON(), nullable=False),
        sa.Column("model", sa.String(length=100), nullable=False),
        sa.Column("firmware_version", sa.String(length=50), nullable=False),
        sa.Column("place_id", sa.Integer(), nullable=True),
        sa.Column("device_id", sa.Integer(), nullable=True),
        sa.Column("requested_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'completed', 'rejected')",
            name="ck_registration_status",
        ),
        sa.ForeignKeyConstraint(["device_id"], ["devices.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["pairing_token_id"], ["pairing_tokens.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["place_id"], ["places.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_uid"),
        sa.UniqueConstraint("secret_hash"),
        sqlite_autoincrement=True,
    )
    with op.batch_alter_table("device_registrations", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_device_registrations_device_id"), ["device_id"], unique=False
        )
        batch_op.create_index(
            batch_op.f("ix_device_registrations_pairing_token_id"),
            ["pairing_token_id"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_device_registrations_place_id"), ["place_id"], unique=False
        )


def downgrade():
    with op.batch_alter_table("device_registrations", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_device_registrations_place_id"))
        batch_op.drop_index(batch_op.f("ix_device_registrations_pairing_token_id"))
        batch_op.drop_index(batch_op.f("ix_device_registrations_device_id"))
    op.drop_table("device_registrations")
    op.drop_table("pairing_tokens")
