"""Kafka producer wrapper.

Thin convenience layer around confluent_kafka.Producer. Falls back to a no-op
producer if Kafka is disabled or the library cannot reach a broker — important
so unit tests run without Kafka up.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from .config import settings

log = logging.getLogger(__name__)


class _NullProducer:
    def produce(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401
        log.debug("Kafka disabled: dropping produce(%s, %s)", args, kwargs)

    def flush(self, *_: Any, **__: Any) -> int:
        return 0

    def poll(self, *_: Any, **__: Any) -> int:
        return 0


_producer: Any | None = None


def get_producer() -> Any:
    global _producer
    if _producer is not None:
        return _producer
    if not settings.kafka_enabled:
        _producer = _NullProducer()
        return _producer
    try:
        from confluent_kafka import Producer  # type: ignore

        _producer = Producer({"bootstrap.servers": settings.kafka_bootstrap_servers})
    except Exception as exc:  # pragma: no cover - exercised in env without librdkafka
        log.warning("Kafka producer unavailable (%s); using null producer", exc)
        _producer = _NullProducer()
    return _producer


def produce_json(topic: str, key: str | None, value: dict[str, Any]) -> None:
    p = get_producer()
    payload = json.dumps(value, default=str).encode("utf-8")
    try:
        p.produce(topic=topic, key=(key.encode() if key else None), value=payload)
        p.poll(0)
    except Exception as exc:  # pragma: no cover
        log.warning("Failed to produce to %s: %s", topic, exc)


def flush(timeout: float = 2.0) -> None:
    p = get_producer()
    try:
        p.flush(timeout)
    except Exception:
        pass


def reset_producer_for_tests(producer: Any | None) -> None:
    """Inject a custom (e.g. capturing) producer in tests."""
    global _producer
    _producer = producer
