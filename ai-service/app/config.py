"""Runtime configuration loaded from environment variables.

All fields have safe defaults so the service can boot in tests without env wiring.
"""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Postgres
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "postgres"
    db_password: str = "postgres"
    db_name: str = "postgres"

    # Kafka
    kafka_bootstrap_servers: str = "localhost:9092"
    kafka_topic_signals: str = "ai_signals"
    kafka_topic_audit: str = "ai_audit"
    kafka_topic_ticks_in: str = "trade_events"  # consumed for price awareness; reuse existing topic
    kafka_enabled: bool = True

    # Node trade endpoint (Path A from CLAUDE.md). Auto-execute path posts here.
    node_trade_url: str = "http://app:3000/api/v1/trading/trade"
    trade_http_timeout_seconds: float = 5.0

    # Service
    service_port: int = 8090
    model_artifacts_dir: str = "/app/models_artifacts"
    auto_apply_migrations: bool = True

    # Default user when a recommendation has no explicit user_id.
    default_user_id: int = 1


settings = Settings()
