"""Independent per-symbol robustness. Not a shared-capital portfolio."""

from __future__ import annotations

from typing import Any, Mapping


def basket_identities(symbols: list[str], base: Mapping[str, Any]) -> list[dict[str, Any]]:
    if not symbols:
        raise ValueError("basket requires at least one symbol")
    return [
        {
            **dict(base),
            "symbol": symbol,
            "independentAccount": True,
            "portfolioSumForbidden": True,
        }
        for symbol in symbols
    ]


def refuse_portfolio_sum(reports: list[Mapping[str, Any]]) -> None:
    if len(reports) > 1:
        raise ValueError("independent symbol reports must not be summed as a portfolio")
