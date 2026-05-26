"""Server-side guardrail enforcement for AI auto-execution.

Each check returns ``(ok, reason)``. The orchestrator persists every breach
to ``ai_audit`` so failures are reviewable.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any

from .db import get_conn

log = logging.getLogger(__name__)


def killswitch_engaged() -> bool:
    import json as _json

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT value FROM ai_global_state WHERE key = 'killswitch'")
            row = cur.fetchone()
            if not row:
                return False
            value = row[0]
            if isinstance(value, str):
                try:
                    value = _json.loads(value)
                except Exception:
                    return False
            return bool(value.get("engaged"))


def set_killswitch(engaged: bool) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ai_global_state(key, value, updated_at)
                VALUES ('killswitch', %s::jsonb, CURRENT_TIMESTAMP)
                ON CONFLICT (key) DO UPDATE
                  SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
                """,
                (f'{{"engaged": {str(engaged).lower()}}}',),
            )
        conn.commit()


def get_strategy(strategy_id: str) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, description, mode, enabled, drawdown_tripped,
                       max_position_qty, max_daily_notional, max_drawdown_pct, cooldown_seconds
                FROM ai_strategies WHERE id = %s
                """,
                (strategy_id,),
            )
            row = cur.fetchone()
            if not row:
                return None
            cols = [d.name for d in cur.description]
            return dict(zip(cols, row))


def daily_notional_used(strategy_id: str) -> float:
    """Sum of executed notional from this strategy in the last 24h."""
    cutoff = datetime.utcnow() - timedelta(hours=24)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT COALESCE(SUM(quantity * COALESCE(price_hint, 0)), 0)::float
                FROM recommendations
                WHERE strategy_id = %s
                  AND status = 'EXECUTED'
                  AND executed_at >= %s
                """,
                (strategy_id, cutoff),
            )
            return float(cur.fetchone()[0] or 0)


def last_trade_time_for_symbol(strategy_id: str, symbol: str) -> datetime | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT MAX(executed_at) FROM recommendations
                WHERE strategy_id = %s AND symbol = %s AND status = 'EXECUTED'
                """,
                (strategy_id, symbol),
            )
            row = cur.fetchone()
            return row[0] if row else None


def write_audit(strategy_id: str | None, recommendation_id: int | None, event_type: str, payload: dict[str, Any]) -> None:
    import json

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ai_audit(strategy_id, recommendation_id, event_type, payload)
                VALUES (%s, %s, %s, %s::jsonb)
                """,
                (strategy_id, recommendation_id, event_type, json.dumps(payload)),
            )
        conn.commit()


def check_all(
    strategy: dict[str, Any],
    symbol: str,
    quantity: int,
    price_hint: float | None,
) -> tuple[bool, str | None]:
    """Run all guardrails for an auto-execute attempt.

    Returns (ok, reason). reason is set iff ok is False.
    """
    if not strategy.get("enabled"):
        return False, "strategy_disabled"
    if strategy.get("drawdown_tripped"):
        return False, "drawdown_tripped"
    if killswitch_engaged():
        return False, "killswitch_engaged"

    if quantity <= 0:
        return False, "quantity_non_positive"
    if quantity > int(strategy["max_position_qty"]):
        return False, "max_position_exceeded"

    notional = quantity * (price_hint or 0)
    used = daily_notional_used(strategy["id"])
    if notional + used > float(strategy["max_daily_notional"]):
        return False, "max_daily_notional_exceeded"

    last = last_trade_time_for_symbol(strategy["id"], symbol)
    if last is not None:
        cooldown = int(strategy["cooldown_seconds"])
        elapsed = (datetime.utcnow() - last).total_seconds()
        if elapsed < cooldown:
            return False, "symbol_cooldown_active"

    return True, None
