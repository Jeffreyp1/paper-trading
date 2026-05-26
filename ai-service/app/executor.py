"""Auto-execution path: post a paper trade to the Node API.

We keep this small and defensive. The Node trade endpoint is the
``POST /api/v1/trading/trade`` documented in CLAUDE.md (Path A). Body shape
expected: ``{userId, action, stock: [{symbol, quantity}, ...]}``.

Idempotency: the caller supplies a ``client_order_id`` which we send as a
header (``X-Client-Order-Id``). The downstream Node service does not currently
honour it (see Known upstream issues in README); we still attach it so retries
don't multi-trade on our side because we look up the recommendation by
client_order_id before posting.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import settings

log = logging.getLogger(__name__)


class ExecutionError(RuntimeError):
    pass


def post_paper_trade(
    *,
    user_id: int,
    action: str,
    symbol: str,
    quantity: int,
    client_order_id: str,
    source_tag: str,
    http_client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Place a single-symbol paper trade. Returns the upstream JSON response.

    Raises :class:`ExecutionError` on non-2xx.
    """
    body = {
        "userId": user_id,
        "action": action.lower(),
        "stock": [{"symbol": symbol, "quantity": int(quantity)}],
        "source": source_tag,             # informational; downstream may ignore
        "client_order_id": client_order_id,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Client-Order-Id": client_order_id,
        "X-Source": source_tag,
    }
    client = http_client or httpx.Client(timeout=settings.trade_http_timeout_seconds)
    try:
        resp = client.post(settings.node_trade_url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise ExecutionError(f"upstream_unreachable: {exc}") from exc
    finally:
        if http_client is None:
            client.close()

    if resp.status_code >= 300:
        raise ExecutionError(f"upstream_status_{resp.status_code}: {resp.text[:200]}")

    try:
        return resp.json()
    except Exception:
        return {"raw": resp.text}
