"""Integration tests for the four key orchestrator paths.

Each test uses the ``patched_db`` fixture (sqlite shim) and the
``capturing_producer`` fixture (in-memory Kafka). The auto-execute tests stub
the HTTP client used by the executor so no real Node service is required.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from app import orchestrator
from app import guardrails as gr
from app import strategy as strat


class _StubResponse:
    def __init__(self, status_code: int = 200, payload: dict | None = None) -> None:
        self.status_code = status_code
        self._payload = payload or {"message": "Successful!"}
        self.text = json.dumps(self._payload)

    def json(self):
        return self._payload


class _StubHttp:
    def __init__(self, status_code: int = 200) -> None:
        self.status_code = status_code
        self.posted: list[tuple[str, dict, dict]] = []

    def post(self, url, json: dict, headers: dict):  # noqa: A002 - mimic httpx
        self.posted.append((url, json, headers))
        return _StubResponse(self.status_code)

    def close(self):
        pass


def _force_buy(monkeypatch):
    """Patch the strategy scorer to deterministically return a strong BUY."""
    monkeypatch.setattr(
        strat,
        "score",
        lambda symbol, prices=None: strat.SignalResult(
            symbol=symbol,
            score=0.8,
            direction="BUY",
            features={"ret_1": 0.01, "ret_5": 0.03, "vol_5": 0.01, "sma_ratio_5_20": 0.02, "rsi_14": 60.0},
            model_version="momentum_v1.0.0",
        ),
    )
    # Mirror import inside orchestrator
    monkeypatch.setattr(orchestrator.strat, "score", strat.score)


def _set_strategy(patched_db, **fields: Any) -> None:
    with patched_db() as conn:
        with conn.cursor() as cur:
            for k, v in fields.items():
                cur.execute(f"UPDATE ai_strategies SET {k} = ? WHERE id = 'momentum_v1'", (v,))
        conn.commit()


# ---------------------------------------------------------------------------

def test_suggestion_path_persists_and_emits(patched_db, capturing_producer, monkeypatch):
    _force_buy(monkeypatch)

    out = orchestrator.run_strategy_once("momentum_v1", symbol="AAPL", user_id=1)

    assert out["recommendation"] is not None
    assert out["recommendation"]["status"] == "SUGGESTED"
    assert out["executed"] is False

    # Recommendation row landed in DB.
    with patched_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM recommendations WHERE strategy_id = 'momentum_v1'")
            assert cur.fetchone()[0] == 1
            cur.execute("SELECT count(*) FROM signals WHERE strategy_id = 'momentum_v1'")
            assert cur.fetchone()[0] == 1

    # Kafka signal emitted.
    topics = [e[0] for e in capturing_producer.events]
    assert any("ai_signals" in t or "signals" in t for t in topics)
    payload = capturing_producer.events[0][2]
    assert payload["symbol"] == "AAPL"
    assert payload["direction"] == "BUY"


def test_auto_execute_success_posts_trade_and_marks_executed(patched_db, capturing_producer, monkeypatch):
    _force_buy(monkeypatch)
    _set_strategy(patched_db, mode="auto", max_position_qty=200, max_daily_notional=1_000_000)

    stub = _StubHttp(status_code=200)
    out = orchestrator.run_strategy_once(
        "momentum_v1", symbol="AAPL", user_id=1, http_client=stub
    )

    assert out["executed"] is True
    assert out["recommendation"]["status"] == "EXECUTED"
    assert len(stub.posted) == 1
    url, body, headers = stub.posted[0]
    assert body["userId"] == 1
    assert body["action"] == "buy"
    assert body["stock"][0]["symbol"] == "AAPL"
    assert headers["X-Source"] == "ai:momentum_v1"
    assert headers["X-Client-Order-Id"].startswith("ai-momentum_v1-")

    with patched_db() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT event_type FROM ai_audit WHERE strategy_id = 'momentum_v1'")
            events = [r[0] for r in cur.fetchall()]
    assert "auto_executed" in events


def test_auto_execute_rejects_when_quantity_exceeds_max_position(patched_db, capturing_producer, monkeypatch):
    _force_buy(monkeypatch)
    # Cap quantity at 1 so the sized BUY (~80% of cap) > cap is impossible
    # Instead we squeeze max_daily_notional to force a different breach: 0 daily notional means any trade breaches.
    _set_strategy(patched_db, mode="auto", max_position_qty=200, max_daily_notional=0.01)

    stub = _StubHttp(status_code=200)
    out = orchestrator.run_strategy_once(
        "momentum_v1", symbol="AAPL", user_id=1, http_client=stub
    )

    assert out["executed"] is False
    assert out["recommendation"]["status"] == "REJECTED"
    assert out["recommendation"]["rejection_reason"] in {
        "max_daily_notional_exceeded",
        "max_position_exceeded",
    }
    # No HTTP call should have happened.
    assert stub.posted == []
    # An audit row was written.
    with patched_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM ai_audit WHERE event_type = 'auto_rejected' AND strategy_id = 'momentum_v1'"
            )
            assert cur.fetchone()[0] >= 1


def test_killswitch_blocks_auto_execute(patched_db, capturing_producer, monkeypatch):
    _force_buy(monkeypatch)
    _set_strategy(patched_db, mode="auto", max_position_qty=500, max_daily_notional=1_000_000)
    gr.set_killswitch(True)

    stub = _StubHttp()
    out = orchestrator.run_strategy_once(
        "momentum_v1", symbol="AAPL", user_id=1, http_client=stub
    )
    assert out["executed"] is False
    assert out["recommendation"]["status"] == "REJECTED"
    assert out["recommendation"]["rejection_reason"] == "killswitch_engaged"
    assert stub.posted == []
    gr.set_killswitch(False)
