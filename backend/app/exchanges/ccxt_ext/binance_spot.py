"""Raw-observable pinned CCXT Pro Binance Spot client."""

from __future__ import annotations

import sys

import aiohttp
from ccxt.pro.binance import binance as CcxtBinanceSpot

from .binance_usdm import SUPPORTED_CCXT_VERSION
from .hooks import build_hooked_exchange_class

_HookedBinanceSpot = build_hooked_exchange_class(
    CcxtBinanceSpot,
    exchange_id="binance",
    market_type="spot",
    supported_ccxt_version=SUPPORTED_CCXT_VERSION,
)


class CandleScopeBinanceSpot(_HookedBinanceSpot):  # type: ignore[misc, valid-type]
    """Pinned Binance Spot client that preserves complete decoded payloads.

    Production strict K-line, aggregate-trade, and full-depth sessions use this
    class; qualification tools exercise the same transport.
    """

    def open(self) -> None:
        """Use the operating-system DNS resolver on the Windows host."""

        if sys.platform != "win32" or self.session is not None or not self.own_session:
            super().open()
            return

        self.own_session = False
        try:
            super().open()
        finally:
            self.own_session = True
        self.tcp_connector = aiohttp.TCPConnector(
            ssl=self.ssl_context,
            loop=self.asyncio_loop,
            resolver=aiohttp.ThreadedResolver(loop=self.asyncio_loop),
        )
        self.session = aiohttp.ClientSession(
            loop=self.asyncio_loop,
            connector=self.tcp_connector,
            trust_env=self.aiohttp_trust_env,
        )

    async def close(self, clean_instance_data: bool = True) -> None:
        """Release both websocket clients and the owned REST session."""

        await super().close(clean_instance_data)
