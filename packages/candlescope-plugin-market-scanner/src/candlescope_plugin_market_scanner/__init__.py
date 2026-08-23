"""Installable first-party CandleScope Market Scanner plugin."""

from .plugin import MarketScannerPlugin, main, market_scanner_manifest

__version__ = "0.1.0"

__all__ = ["MarketScannerPlugin", "__version__", "main", "market_scanner_manifest"]
