import asyncio
from logging.config import fileConfig

from alembic import context
from app.config import Settings
from app.db import create_database
from app.models import Base

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)
url = config.attributes.get("database_url") or Settings().database_url


def run_migrations(connection):
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        render_as_batch=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_online():
    engine, _ = create_database(url)
    try:
        async with engine.connect() as connection:
            await connection.run_sync(run_migrations)
    finally:
        await engine.dispose()


if context.is_offline_mode():
    context.configure(url=url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(run_online())
