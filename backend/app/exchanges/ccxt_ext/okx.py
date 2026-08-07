"""Raw-observable pinned CCXT Pro OKX client for shadow qualification."""

from __future__ import annotations

import sys

import aiohttp
from ccxt.pro.okx import okx as CcxtOkx

from .binance_usdm import SUPPORTED_CCXT_VERSION
from .hooks import build_hooked_exchange_class

_HookedOkx = build_hooked_exchange_class(
    CcxtOkx,
    exchange_id="okx",
    market_type="futures",
    supported_ccxt_version=SUPPORTED_CCXT_VERSION,
)
_HookedOkxSpot = build_hooked_exchange_class(
    CcxtOkx,
    exchange_id="okx",
    market_type="spot",
    supported_ccxt_version=SUPPORTED_CCXT_VERSION,
)


class _OwnedOkxSession:
    def open(self) -> None:
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
        await super().close(clean_instance_data)


class CandleScopeOkx(_OwnedOkxSession, _HookedOkx):  # type: ignore[misc, valid-type]
    """OKX Swap client used only by the profile qualification matrix."""


class CandleScopeOkxSpot(  # type: ignore[misc, valid-type]
    _OwnedOkxSession,
    _HookedOkxSpot,
):
    """OKX Spot client used only by the profile qualification matrix."""
