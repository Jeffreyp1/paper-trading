"""Baseline momentum strategy + LightGBM training utility.

This is the strategy v1 referenced in ai-component-constraints.md. It ships
with a deterministic momentum fallback so the pipeline works even if no model
file is present. If a LightGBM artifact is found at MODEL_ARTIFACTS_DIR, it is
loaded and used to score features.

Features (5):
    ret_1, ret_5, vol_5, sma_ratio_5_20, rsi_14
The synthetic training data is OHLCV simulated from a random walk + a hidden
momentum signal so the model can learn something real but cheaply.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .config import settings

log = logging.getLogger(__name__)

MODEL_VERSION = "momentum_v1.0.0"
FEATURE_NAMES = ["ret_1", "ret_5", "vol_5", "sma_ratio_5_20", "rsi_14"]


@dataclass
class SignalResult:
    symbol: str
    score: float                 # in [-1, 1]
    direction: str               # BUY / SELL / HOLD
    features: dict[str, float]
    model_version: str


def _rsi(prices: np.ndarray, period: int = 14) -> float:
    if len(prices) < period + 1:
        return 50.0
    diffs = np.diff(prices[-(period + 1):])
    gains = diffs[diffs > 0].sum()
    losses = -diffs[diffs < 0].sum()
    if losses == 0:
        return 100.0
    rs = gains / losses
    return float(100 - (100 / (1 + rs)))


def compute_features(prices: list[float] | np.ndarray) -> dict[str, float]:
    """Compute the 5 features from a list of recent close prices (oldest first)."""
    p = np.asarray(prices, dtype=float)
    if len(p) < 20:
        # pad with the first price so we always get something.
        pad = np.full(20 - len(p), p[0] if len(p) else 100.0)
        p = np.concatenate([pad, p])

    ret_1 = float(p[-1] / p[-2] - 1.0) if p[-2] != 0 else 0.0
    ret_5 = float(p[-1] / p[-6] - 1.0) if p[-6] != 0 else 0.0
    vol_5 = float(np.std(np.diff(p[-6:]) / p[-6:-1])) if p[-6:-1].all() else 0.0
    sma5 = float(np.mean(p[-5:]))
    sma20 = float(np.mean(p[-20:]))
    sma_ratio = sma5 / sma20 - 1.0 if sma20 else 0.0
    rsi = _rsi(p)

    return {
        "ret_1": ret_1,
        "ret_5": ret_5,
        "vol_5": vol_5,
        "sma_ratio_5_20": sma_ratio,
        "rsi_14": rsi,
    }


def _generate_synthetic(seed: int = 42, n_series: int = 50, length: int = 250) -> tuple[np.ndarray, np.ndarray]:
    """Return (X, y) for training. y is 1 if next-day return positive, else 0."""
    rng = np.random.default_rng(seed)
    X_rows: list[list[float]] = []
    y_rows: list[int] = []
    for _ in range(n_series):
        # Random walk with mild momentum.
        returns = rng.normal(0, 0.01, length)
        for i in range(5, length - 1):
            returns[i] += 0.3 * returns[i - 1]  # AR(1) component → momentum
        prices = 100 * np.exp(np.cumsum(returns))
        for t in range(20, length - 1):
            feats = compute_features(prices[: t + 1].tolist())
            X_rows.append([feats[k] for k in FEATURE_NAMES])
            y_rows.append(1 if prices[t + 1] > prices[t] else 0)
    return np.asarray(X_rows), np.asarray(y_rows)


_model_cache: Any | None = None


def _model_path() -> Path:
    return Path(settings.model_artifacts_dir) / f"{MODEL_VERSION}.joblib"


def train_and_save_model() -> Path:
    """Train a LightGBM classifier on synthetic momentum data and persist it.

    Falls back to a sklearn GradientBoostingClassifier if lightgbm import fails.
    """
    import joblib

    X, y = _generate_synthetic()
    try:
        import lightgbm as lgb  # type: ignore

        model = lgb.LGBMClassifier(
            n_estimators=80,
            learning_rate=0.05,
            num_leaves=15,
            max_depth=4,
            min_child_samples=20,
            verbosity=-1,
        )
    except Exception:
        from sklearn.ensemble import GradientBoostingClassifier

        model = GradientBoostingClassifier(n_estimators=60, max_depth=3, learning_rate=0.05)

    model.fit(X, y)
    out = _model_path()
    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, out)
    log.info("Trained baseline model -> %s (n_train=%d)", out, len(y))
    return out


def load_model() -> Any | None:
    global _model_cache
    if _model_cache is not None:
        return _model_cache
    p = _model_path()
    if not p.exists():
        try:
            train_and_save_model()
        except Exception as exc:
            log.warning("Could not train model on demand: %s", exc)
            return None
    try:
        import joblib

        _model_cache = joblib.load(p)
        return _model_cache
    except Exception as exc:
        log.warning("Could not load model: %s", exc)
        return None


def _deterministic_score(features: dict[str, float]) -> float:
    """Fallback scorer used when no model is available.

    Long when 5-day return positive AND short-term SMA above long-term;
    bounded to [-1, 1]. This is honest: not a great alpha, just a real signal.
    """
    raw = features["ret_5"] * 4.0 + features["sma_ratio_5_20"] * 2.0
    return max(-1.0, min(1.0, raw))


def score(symbol: str, prices: list[float] | None = None) -> SignalResult:
    """Score a single symbol given a price history.

    If ``prices`` is None we fabricate a price series seeded by the symbol name.
    This makes /run usable end-to-end without external data dependencies.
    """
    if prices is None or len(prices) < 5:
        seed = abs(hash(symbol)) % (2**31 - 1)
        rng = np.random.default_rng(seed)
        returns = rng.normal(0, 0.012, 60)
        for i in range(1, len(returns)):
            returns[i] += 0.25 * returns[i - 1]
        prices = (100 * np.exp(np.cumsum(returns))).tolist()

    feats = compute_features(prices)
    model = load_model()
    if model is not None and hasattr(model, "predict_proba"):
        try:
            x = np.asarray([[feats[k] for k in FEATURE_NAMES]])
            prob_up = float(model.predict_proba(x)[0, 1])
            raw = prob_up * 2 - 1  # [-1, 1]
        except Exception as exc:
            log.warning("Model scoring failed (%s); falling back", exc)
            raw = _deterministic_score(feats)
    else:
        raw = _deterministic_score(feats)

    if raw > 0.15:
        direction = "BUY"
    elif raw < -0.15:
        direction = "SELL"
    else:
        direction = "HOLD"

    return SignalResult(
        symbol=symbol,
        score=round(raw, 6),
        direction=direction,
        features=feats,
        model_version=MODEL_VERSION,
    )
