"""Tie strategy + guardrails + executor together.

The single public entry point is :func:`run_strategy_once`, called by the HTTP
``/strategies/{id}/run`` endpoint and (in the future) by a Kafka tick consumer.
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime
from typing import Any

import httpx

from . import guardrails as gr
from . import strategy as strat
from .config import settings
from .db import get_conn
from .executor import ExecutionError, post_paper_trade
from .kafka_io import produce_json

log = logging.getLogger(__name__)


def _client_order_id(strategy_id: str, symbol: str, ts: datetime) -> str:
    h = hashlib.sha256(
        f"{strategy_id}|{symbol}|{ts.isoformat()}".encode("utf-8")
    ).hexdigest()
    return f"ai-{strategy_id}-{h[:24]}"


def _insert_signal(strategy_id: str, sig: strat.SignalResult) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO signals(strategy_id, model_version, symbol, score, direction, features_json)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                RETURNING id
                """,
                (
                    strategy_id,
                    sig.model_version,
                    sig.symbol,
                    sig.score,
                    sig.direction,
                    json.dumps(sig.features),
                ),
            )
            sid = cur.fetchone()[0]
        conn.commit()
    return int(sid)


def _insert_recommendation(
    *,
    strategy_id: str,
    signal_id: int,
    user_id: int | None,
    symbol: str,
    action: str,
    quantity: int,
    price_hint: float,
    rationale: str,
    client_order_id: str,
    status: str,
) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO recommendations
                    (strategy_id, signal_id, user_id, symbol, action, quantity,
                     price_hint, rationale, client_order_id, status)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (client_order_id) DO UPDATE
                    SET status = EXCLUDED.status
                RETURNING id
                """,
                (
                    strategy_id, signal_id, user_id, symbol, action, quantity,
                    float(price_hint), rationale, client_order_id, status,
                ),
            )
            rid = cur.fetchone()[0]
        conn.commit()
    return int(rid)


def _set_recommendation_status(
    rec_id: int, status: str, *, executed_at: datetime | None = None, reason: str | None = None
) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE recommendations
                   SET status = %s,
                       executed_at = COALESCE(%s, executed_at),
                       rejection_reason = COALESCE(%s, rejection_reason)
                 WHERE id = %s
                """,
                (status, executed_at, reason, rec_id),
            )
        conn.commit()


def _fetch_recommendation(rec_id: int) -> dict[str, Any] | None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, strategy_id, signal_id, user_id, symbol, action, quantity,
                       price_hint, rationale, client_order_id, status, rejection_reason,
                       executed_at, created_at
                FROM recommendations WHERE id = %s
                """,
                (rec_id,),
            )
            row = cur.fetchone()
            if not row:
                return None
            cols = [d.name for d in cur.description]
            return {c: (float(v) if c == "price_hint" and v is not None else v) for c, v in zip(cols, row)}


def _open_run(strategy_id: str) -> int:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO ai_runs(strategy_id, status) VALUES (%s, 'RUNNING') RETURNING id",
                (strategy_id,),
            )
            rid = cur.fetchone()[0]
        conn.commit()
    return int(rid)


def _close_run(run_id: int, status: str, signals: int, recs: int, notes: str | None = None) -> None:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE ai_runs SET finished_at = CURRENT_TIMESTAMP, status = %s,
                       signals_emitted = %s, recs_emitted = %s, notes = %s
                 WHERE id = %s
                """,
                (status, signals, recs, notes, run_id),
            )
        conn.commit()


def _quantity_for(strategy: dict[str, Any], score: float) -> int:
    """Position sizing rule: scale linearly with |score| up to max_position_qty."""
    cap = int(strategy["max_position_qty"])
    return max(1, min(cap, int(round(abs(score) * cap))))


def _notional_price_hint(symbol: str) -> float:
    """A deterministic synthetic spot price.

    Real wiring would HGET ``stockPrices`` from Redis. We avoid a hard Redis
    dependency in the AI service for v1; the price_hint is informational and
    only feeds the daily-notional guardrail.
    """
    seed = abs(hash(("price", symbol))) % 1000
    return round(50 + seed * 0.37, 2)


def run_strategy_once(
    strategy_id: str,
    *,
    symbol: str | None = None,
    user_id: int | None = None,
    http_client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Generate exactly one recommendation and (if mode=auto) try to execute it."""
    strategy = gr.get_strategy(strategy_id)
    if strategy is None:
        raise KeyError(f"strategy_not_found: {strategy_id}")

    run_id = _open_run(strategy_id)
    recs_count = 0
    sigs_count = 0
    try:
        sym = symbol or "AAPL"
        sig = strat.score(sym)
        sigs_count = 1

        signal_id = _insert_signal(strategy_id, sig)
        produce_json(
            settings.kafka_topic_signals,
            key=sym,
            value={
                "strategy_id": strategy_id,
                "signal_id": signal_id,
                "symbol": sym,
                "score": sig.score,
                "direction": sig.direction,
                "model_version": sig.model_version,
                "features": sig.features,
                "ts": datetime.utcnow().isoformat(),
            },
        )

        if sig.direction == "HOLD":
            gr.write_audit(strategy_id, None, "signal_hold", {"symbol": sym, "score": sig.score})
            recs_count = 0
            _close_run(run_id, "OK", sigs_count, recs_count, "hold")
            return {
                "strategy_id": strategy_id,
                "signal": sig.__dict__,
                "recommendation": None,
                "executed": False,
            }

        qty = _quantity_for(strategy, sig.score)
        price_hint = _notional_price_hint(sym)
        now = datetime.utcnow()
        coid = _client_order_id(strategy_id, sym, now)
        rationale = (
            f"{sig.direction} {sym}: model={sig.model_version} score={sig.score:+.4f}; "
            f"top features ret_5={sig.features['ret_5']:+.4f}, "
            f"sma_ratio={sig.features['sma_ratio_5_20']:+.4f}"
        )

        rec_id = _insert_recommendation(
            strategy_id=strategy_id,
            signal_id=signal_id,
            user_id=user_id if user_id is not None else settings.default_user_id,
            symbol=sym,
            action=sig.direction,
            quantity=qty,
            price_hint=price_hint,
            rationale=rationale,
            client_order_id=coid,
            status="SUGGESTED",
        )
        recs_count = 1

        executed = False

        if strategy["mode"] == "auto":
            ok, reason = gr.check_all(strategy, sym, qty, price_hint)
            if not ok:
                _set_recommendation_status(rec_id, "REJECTED", reason=reason)
                gr.write_audit(
                    strategy_id, rec_id, "auto_rejected",
                    {"reason": reason, "symbol": sym, "qty": qty, "price_hint": price_hint},
                )
            else:
                try:
                    post_paper_trade(
                        user_id=user_id if user_id is not None else settings.default_user_id,
                        action=sig.direction,
                        symbol=sym,
                        quantity=qty,
                        client_order_id=coid,
                        source_tag=f"ai:{strategy_id}",
                        http_client=http_client,
                    )
                    _set_recommendation_status(rec_id, "EXECUTED", executed_at=datetime.utcnow())
                    gr.write_audit(strategy_id, rec_id, "auto_executed",
                                   {"symbol": sym, "qty": qty, "price_hint": price_hint, "client_order_id": coid})
                    executed = True
                except ExecutionError as exc:
                    _set_recommendation_status(rec_id, "FAILED", reason=str(exc))
                    gr.write_audit(strategy_id, rec_id, "auto_failed", {"error": str(exc)})

        rec = _fetch_recommendation(rec_id)
        _close_run(run_id, "OK", sigs_count, recs_count, None)
        return {
            "strategy_id": strategy_id,
            "signal": sig.__dict__,
            "recommendation": rec,
            "executed": executed,
        }

    except Exception as exc:
        _close_run(run_id, "ERROR", sigs_count, recs_count, str(exc)[:500])
        raise
