"""
Indicator Registry — central catalog of all available indicator types.

The registry maps indicator names to their implementation classes.
It is used by the engine to create instances, and by the API to
list available indicators and their parameter schemas.

Usage::

    from app.indicator.registry import registry
    from app.indicator.indicators.ma import MAIndicator

    registry.register(MAIndicator)

    cls = registry.get("MA")
    spec = registry.get_spec("MA")
    all_specs = registry.list_specs()
"""
from __future__ import annotations

import logging
from typing import Type

from .base import Indicator
from .types import IndicatorSpec

logger = logging.getLogger("candlescope.indicator.registry")


class IndicatorRegistry:
    """Central registry for indicator type definitions.

    Thread-safe for reads (registration is expected at startup only).
    """

    def __init__(self) -> None:
        self._indicators: dict[str, Type[Indicator]] = {}

    def register(self, cls: Type[Indicator]) -> None:
        """Register an indicator class.

        Args:
            cls: A subclass of ``Indicator``.

        Raises:
            ValueError: If the indicator name is already registered.
        """
        name = cls.name.upper()
        if name in self._indicators:
            logger.warning("Overwriting indicator registration: %s", name)
        self._indicators[name] = cls
        logger.debug("Registered indicator: %s", name)

    def get(self, name: str) -> Type[Indicator] | None:
        """Look up an indicator class by name.

        Returns:
            The indicator class, or None if not found.
        """
        return self._indicators.get(name.upper())

    def get_spec(self, name: str) -> IndicatorSpec | None:
        """Get the specification for a registered indicator.

        Returns:
            The IndicatorSpec, or None if not found.
        """
        cls = self.get(name)
        if cls is None:
            return None
        return cls.get_spec()

    def list_names(self) -> list[str]:
        """Return sorted list of registered indicator names."""
        return sorted(self._indicators.keys())

    def list_specs(self) -> list[IndicatorSpec]:
        """Return specifications for all registered indicators."""
        return [cls.get_spec() for cls in self._indicators.values()]

    def has(self, name: str) -> bool:
        """Check if an indicator is registered."""
        return name.upper() in self._indicators

    def unregister(self, name: str) -> bool:
        """Remove an indicator from the registry.

        Returns:
            True if removed, False if not found.
        """
        return self._indicators.pop(name.upper(), None) is not None

    @property
    def count(self) -> int:
        return len(self._indicators)

    def snapshot(self) -> dict:
        return {
            "registered_count": self.count,
            "indicators": self.list_names(),
        }


# ── Module-level singleton ───────────────────────────────────
registry = IndicatorRegistry()
