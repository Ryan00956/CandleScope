from __future__ import annotations

from app.data_engine.series_identity import KlineSeriesIdentity


def supports_history_identity(
    *,
    exchange: str,
    market_type: str,
    interval: str,
    identity: KlineSeriesIdentity,
) -> bool:
    """Return whether an installed plugin owns this non-legacy history identity."""

    if identity.is_legacy_default_for(exchange):
        return True
    from .registry import bootstrap_default_adapters, get_exchange_registry

    bootstrap_default_adapters()
    try:
        plugin = get_exchange_registry().get_plugin(exchange)
    except KeyError:
        return False
    validator = getattr(plugin, "supports_history_identity", None)
    if not callable(validator):
        return False
    try:
        return bool(validator(
            market_type=market_type,
            interval=interval,
            identity=identity,
        ))
    except Exception:
        return False


__all__ = ["supports_history_identity"]
