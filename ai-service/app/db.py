"""Postgres connection pool + migration runner.

Uses psycopg 3 with a connection pool. Migrations are applied at startup if
``settings.auto_apply_migrations`` is true; they're idempotent SQL files.
"""
from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import psycopg
from psycopg_pool import ConnectionPool

from .config import settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None


def _conninfo() -> str:
    return (
        f"host={settings.db_host} port={settings.db_port} "
        f"user={settings.db_user} password={settings.db_password} "
        f"dbname={settings.db_name}"
    )


def init_pool(min_size: int = 1, max_size: int = 8) -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(_conninfo(), min_size=min_size, max_size=max_size, kwargs={"autocommit": False})
    return _pool


def get_pool() -> ConnectionPool:
    if _pool is None:
        return init_pool()
    return _pool


@contextmanager
def get_conn() -> Iterator[psycopg.Connection]:
    pool = get_pool()
    with pool.connection() as conn:
        yield conn


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def apply_migrations(migrations_dir: str | os.PathLike[str] | None = None) -> list[str]:
    """Apply every .sql file in the migrations directory in lexicographic order.

    Files are idempotent (use IF NOT EXISTS / ON CONFLICT) so reapplying is safe.
    Returns the list of files applied.
    """
    if migrations_dir is None:
        migrations_dir = Path(__file__).resolve().parent.parent / "migrations"
    migrations_dir = Path(migrations_dir)
    if not migrations_dir.exists():
        log.warning("Migrations directory not found: %s", migrations_dir)
        return []

    applied: list[str] = []
    files = sorted(p for p in migrations_dir.iterdir() if p.suffix == ".sql")
    with get_conn() as conn:
        for f in files:
            sql = f.read_text(encoding="utf-8")
            log.info("Applying migration %s", f.name)
            with conn.cursor() as cur:
                cur.execute(sql)
            conn.commit()
            applied.append(f.name)
    return applied
