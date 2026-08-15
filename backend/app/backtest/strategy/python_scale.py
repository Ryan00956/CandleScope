"""Official Python BAR scale. A raised env cap is not product evidence."""

from __future__ import annotations

OFFICIAL_BAR_CAPACITY = 200_000
EVIDENCED_MILLION_BAR = False


def official_bar_capacity() -> int:
    return OFFICIAL_BAR_CAPACITY


def million_bar_is_product_ready() -> bool:
    return EVIDENCED_MILLION_BAR
