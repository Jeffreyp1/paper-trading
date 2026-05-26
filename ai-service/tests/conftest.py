"""Pytest fixtures.

We use an in-memory SQLite DB instead of Postgres so the suite is hermetic and
runs without docker. The application's ``app.db.get_conn`` is monkey-patched to
yield a thin shim around the sqlite connection that mimics the psycopg API
surface we actually use:

- ``conn.cursor() -> cursor`` context manager
- ``cursor.execute(sql, params)``
- ``cursor.fetchone()``, ``cursor.fetchall()``
- ``cursor.description`` -> list of objects with ``.name``
- ``conn.commit()``, ``conn.rollback()``

Postgres-specific syntax in the application is normalised on the fly:
``%s`` placeholders -> ``?``; ``RETURNING`` is supported by sqlite>=3.35;
``::jsonb`` casts are stripped (sqlite stores JSON as text, which is fine for
test assertions); ``CURRENT_TIMESTAMP`` is honoured by sqlite natively.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


# --- sqlite shim --------------------------------------------------------------

class _Col:
    __slots__ = ("name",)

    def __init__(self, name: str) -> None:
        self.name = name


class _CursorShim:
    def __init__(self, cur: sqlite3.Cursor) -> None:
        self._cur = cur
        self.description: list[_Col] | None = None

    # context-manager protocol (psycopg cursor supports `with conn.cursor() as cur:`)
    def __enter__(self) -> "_CursorShim":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._cur.close()

    @staticmethod
    def _translate(sql: str) -> str:
        sql = sql.replace("%s", "?")
        sql = sql.replace("::jsonb", "")
        sql = re.sub(r"\bSERIAL\b", "INTEGER", sql, flags=re.I)
        sql = re.sub(r"\bBIGSERIAL\b", "INTEGER", sql, flags=re.I)
        sql = re.sub(r"\bNUMERIC\([^)]*\)", "REAL", sql, flags=re.I)
        sql = re.sub(r"\bVARCHAR\([^)]*\)", "TEXT", sql, flags=re.I)
        sql = re.sub(r"\bTIMESTAMP\b", "TEXT", sql, flags=re.I)
        sql = re.sub(r"\bJSONB\b", "TEXT", sql, flags=re.I)
        sql = re.sub(r"\bBOOLEAN\b", "INTEGER", sql, flags=re.I)
        return sql

    def execute(self, sql: str, params: tuple | list | None = None) -> "_CursorShim":
        translated = self._translate(sql)
        # Strip CHECK clauses with IN (...) — sqlite tolerates them but we don't need them.
        # Convert json-string params (we always pass dumps()) — already strings, fine.
        if params is None:
            self._cur.execute(translated)
        else:
            self._cur.execute(translated, tuple(params))
        if self._cur.description is not None:
            self.description = [_Col(d[0]) for d in self._cur.description]
        else:
            self.description = None
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()


class _ConnShim:
    """Wraps a sqlite3.Connection to look enough like a psycopg connection."""

    def __init__(self, sqlite_conn: sqlite3.Connection) -> None:
        self._c = sqlite_conn

    def cursor(self) -> _CursorShim:
        return _CursorShim(self._c.cursor())

    def commit(self) -> None:
        self._c.commit()

    def rollback(self) -> None:
        self._c.rollback()


# --- fixtures -----------------------------------------------------------------

@pytest.fixture
def sqlite_db(tmp_path):
    """A fresh sqlite database with the AI tables created."""
    db_path = tmp_path / "ai.db"
    conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")

    # Hand-rolled schema (sqlite-friendly).
    conn.executescript(
        """
        CREATE TABLE ai_strategies (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
            mode TEXT NOT NULL DEFAULT 'suggest',
            max_position_qty INTEGER NOT NULL DEFAULT 100,
            max_daily_notional REAL NOT NULL DEFAULT 5000.0,
            max_drawdown_pct REAL NOT NULL DEFAULT 0.15,
            cooldown_seconds INTEGER NOT NULL DEFAULT 300,
            enabled INTEGER NOT NULL DEFAULT 1,
            drawdown_tripped INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id TEXT NOT NULL,
            model_version TEXT NOT NULL,
            symbol TEXT NOT NULL,
            score REAL NOT NULL,
            direction TEXT NOT NULL,
            features_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE recommendations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id TEXT NOT NULL,
            signal_id INTEGER,
            user_id INTEGER,
            symbol TEXT NOT NULL,
            action TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            price_hint REAL,
            rationale TEXT,
            client_order_id TEXT UNIQUE,
            status TEXT NOT NULL DEFAULT 'PENDING',
            rejection_reason TEXT,
            executed_at TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE ai_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at TEXT,
            status TEXT NOT NULL DEFAULT 'RUNNING',
            signals_emitted INTEGER NOT NULL DEFAULT 0,
            recs_emitted INTEGER NOT NULL DEFAULT 0,
            notes TEXT
        );
        CREATE TABLE ai_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            strategy_id TEXT,
            recommendation_id INTEGER,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE ai_global_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO ai_global_state(key, value) VALUES ('killswitch', '{"engaged": false}');
        INSERT INTO ai_strategies(id, name, description, mode)
            VALUES ('momentum_v1', 'Momentum v1 (LightGBM baseline)', 'baseline', 'suggest');
        """
    )
    yield conn
    conn.close()


@pytest.fixture
def patched_db(sqlite_db, monkeypatch):
    """Monkey-patch ``app.db.get_conn`` to yield the sqlite shim."""
    from app import db as appdb

    @contextmanager
    def fake_get_conn():
        yield _ConnShim(sqlite_db)

    monkeypatch.setattr(appdb, "get_conn", fake_get_conn)

    # Also patch the names re-imported into other modules.
    import app.guardrails as gmod
    import app.orchestrator as omod
    monkeypatch.setattr(gmod, "get_conn", fake_get_conn)
    monkeypatch.setattr(omod, "get_conn", fake_get_conn)
    yield fake_get_conn


class _CapturingProducer:
    def __init__(self) -> None:
        self.events: list[tuple[str, str | None, dict]] = []

    def produce(self, *, topic, key, value):
        try:
            v = json.loads(value.decode("utf-8")) if isinstance(value, bytes) else value
        except Exception:
            v = {"_raw": value}
        k = key.decode("utf-8") if isinstance(key, (bytes, bytearray)) else key
        self.events.append((topic, k, v))

    def poll(self, *_a, **_k):
        return 0

    def flush(self, *_a, **_k):
        return 0


@pytest.fixture
def capturing_producer(monkeypatch):
    from app import kafka_io

    p = _CapturingProducer()
    kafka_io.reset_producer_for_tests(p)
    yield p
    kafka_io.reset_producer_for_tests(None)


@pytest.fixture(autouse=True)
def _disable_real_kafka(monkeypatch):
    monkeypatch.setenv("KAFKA_ENABLED", "false")
