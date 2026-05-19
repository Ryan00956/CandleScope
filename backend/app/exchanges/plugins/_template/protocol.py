from __future__ import annotations

from typing import Any

from app.exchanges.protocol import RestRequestSpec, WsConnectionSpec
from app.exchanges.ws_protocol import WsSubscriptionMode, WsSubscriptionSpec


class TemplateExchangeProtocol:
    """Replace with exchange-specific REST/WS protocol behavior."""

    def rest_request(self, req: Any, config: Any | None = None) -> RestRequestSpec | None:
        raise NotImplementedError

    def extract_http_rows(self, payload: Any, descriptor: Any) -> list[Any]:
        raise NotImplementedError

    def ws_connection(self, descriptor: Any, config: Any | None = None) -> WsConnectionSpec:
        return WsConnectionSpec(
            base_urls=[],
            subscription=WsSubscriptionSpec(mode=WsSubscriptionMode.PATH),
        )

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        return {}

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        return False
