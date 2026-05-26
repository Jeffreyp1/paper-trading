"""Pydantic v2 schemas for the AI service HTTP surface."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

Mode = Literal["suggest", "auto"]
Action = Literal["BUY", "SELL", "HOLD"]


class StrategyOut(BaseModel):
    id: str
    name: str
    description: str | None = None
    mode: Mode
    enabled: bool
    drawdown_tripped: bool
    max_position_qty: int
    max_daily_notional: float
    max_drawdown_pct: float
    cooldown_seconds: int


class ModeUpdate(BaseModel):
    mode: Mode


class LimitsUpdate(BaseModel):
    max_position_qty: int | None = Field(default=None, ge=0)
    max_daily_notional: float | None = Field(default=None, ge=0)
    max_drawdown_pct: float | None = Field(default=None, ge=0, le=1)
    cooldown_seconds: int | None = Field(default=None, ge=0)


class RunRequest(BaseModel):
    symbol: str | None = None
    user_id: int | None = None


class RecommendationOut(BaseModel):
    id: int
    strategy_id: str
    signal_id: int | None
    user_id: int | None
    symbol: str
    action: Action
    quantity: int
    price_hint: float | None
    rationale: str | None
    client_order_id: str | None
    status: str
    rejection_reason: str | None
    executed_at: datetime | None
    created_at: datetime


class KillSwitchState(BaseModel):
    engaged: bool


class HealthOut(BaseModel):
    status: str
    db: bool
    killswitch: bool
    strategies_loaded: int
    extra: dict[str, Any] = Field(default_factory=dict)
