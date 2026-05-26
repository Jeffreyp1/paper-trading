"""FastAPI entrypoint for the AI trading service."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Query

from . import guardrails as gr
from . import orchestrator
from .config import settings
from .db import apply_migrations, close_pool, get_conn, init_pool
from .models import (
    HealthOut,
    KillSwitchState,
    LimitsUpdate,
    ModeUpdate,
    RecommendationOut,
    RunRequest,
    StrategyOut,
)

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    if settings.auto_apply_migrations:
        try:
            applied = apply_migrations()
            log.info("Applied migrations: %s", applied)
        except Exception as exc:
            log.error("Migration error: %s", exc)
    yield
    close_pool()


app = FastAPI(title="AI Trading Service", version="0.1.0", lifespan=lifespan)


# ---------- helpers ----------

def _row_to_strategy(row: dict[str, Any]) -> StrategyOut:
    return StrategyOut(
        id=row["id"],
        name=row["name"],
        description=row.get("description"),
        mode=row["mode"],
        enabled=row["enabled"],
        drawdown_tripped=row["drawdown_tripped"],
        max_position_qty=int(row["max_position_qty"]),
        max_daily_notional=float(row["max_daily_notional"]),
        max_drawdown_pct=float(row["max_drawdown_pct"]),
        cooldown_seconds=int(row["cooldown_seconds"]),
    )


# ---------- routes ----------

@app.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    db_ok = True
    n = 0
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM ai_strategies")
                n = int(cur.fetchone()[0])
    except Exception as exc:
        db_ok = False
        log.warning("health: db check failed: %s", exc)
    ks = False
    try:
        ks = gr.killswitch_engaged()
    except Exception:
        pass
    return HealthOut(status="ok" if db_ok else "degraded", db=db_ok, killswitch=ks, strategies_loaded=n)


@app.get("/strategies", response_model=list[StrategyOut])
def list_strategies() -> list[StrategyOut]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, name, description, mode, enabled, drawdown_tripped,
                       max_position_qty, max_daily_notional, max_drawdown_pct, cooldown_seconds
                FROM ai_strategies ORDER BY id
                """
            )
            cols = [d.name for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    return [_row_to_strategy(r) for r in rows]


@app.post("/strategies/{strategy_id}/mode", response_model=StrategyOut)
def update_mode(strategy_id: str, body: ModeUpdate) -> StrategyOut:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE ai_strategies SET mode = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s RETURNING id",
                (body.mode, strategy_id),
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="strategy_not_found")
        conn.commit()
    gr.write_audit(strategy_id, None, "mode_changed", {"mode": body.mode})
    s = gr.get_strategy(strategy_id)
    assert s is not None
    return _row_to_strategy(s)


@app.post("/strategies/{strategy_id}/limits", response_model=StrategyOut)
def update_limits(strategy_id: str, body: LimitsUpdate) -> StrategyOut:
    fields: list[str] = []
    values: list[Any] = []
    for col in ("max_position_qty", "max_daily_notional", "max_drawdown_pct", "cooldown_seconds"):
        v = getattr(body, col)
        if v is not None:
            fields.append(f"{col} = %s")
            values.append(v)
    if not fields:
        raise HTTPException(status_code=400, detail="no_fields_supplied")
    values.append(strategy_id)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE ai_strategies SET {', '.join(fields)}, updated_at = CURRENT_TIMESTAMP "
                f"WHERE id = %s RETURNING id",
                values,
            )
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="strategy_not_found")
        conn.commit()
    gr.write_audit(strategy_id, None, "limits_changed", body.model_dump(exclude_none=True))
    s = gr.get_strategy(strategy_id)
    assert s is not None
    return _row_to_strategy(s)


@app.post("/strategies/{strategy_id}/run")
def run_strategy(strategy_id: str, body: RunRequest | None = None) -> dict[str, Any]:
    body = body or RunRequest()
    try:
        return orchestrator.run_strategy_once(
            strategy_id, symbol=body.symbol, user_id=body.user_id
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/recommendations", response_model=list[RecommendationOut])
def list_recommendations(
    strategy_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=500),
) -> list[RecommendationOut]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            if strategy_id:
                cur.execute(
                    """
                    SELECT id, strategy_id, signal_id, user_id, symbol, action, quantity,
                           price_hint, rationale, client_order_id, status, rejection_reason,
                           executed_at, created_at
                    FROM recommendations
                    WHERE strategy_id = %s
                    ORDER BY id DESC LIMIT %s
                    """,
                    (strategy_id, limit),
                )
            else:
                cur.execute(
                    """
                    SELECT id, strategy_id, signal_id, user_id, symbol, action, quantity,
                           price_hint, rationale, client_order_id, status, rejection_reason,
                           executed_at, created_at
                    FROM recommendations
                    ORDER BY id DESC LIMIT %s
                    """,
                    (limit,),
                )
            cols = [d.name for d in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    out: list[RecommendationOut] = []
    for r in rows:
        if r.get("price_hint") is not None:
            r["price_hint"] = float(r["price_hint"])
        out.append(RecommendationOut(**r))
    return out


@app.post("/killswitch", response_model=KillSwitchState)
def killswitch_engage() -> KillSwitchState:
    gr.set_killswitch(True)
    gr.write_audit(None, None, "killswitch_engaged", {})
    return KillSwitchState(engaged=True)


@app.post("/killswitch/clear", response_model=KillSwitchState)
def killswitch_clear() -> KillSwitchState:
    gr.set_killswitch(False)
    gr.write_audit(None, None, "killswitch_cleared", {})
    return KillSwitchState(engaged=False)
