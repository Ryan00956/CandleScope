from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .ws_protocol import WsSubscriptionSpec


@dataclass(slots=True)
class RestRequestSpec:
    """Complete exchange-specific REST request for the transport layer."""

    base_urls: list[str]
    path: str
    params: dict[str, Any]
    headers: dict[str, str] | None = None
    method: str = "GET"
    weight: int = 1


@dataclass(slots=True)
class WsConnectionSpec:
    """Complete exchange-specific WS connection plan for the transport layer."""

    base_urls: list[str]
    subscription: WsSubscriptionSpec
    connection_model: str = "path_per_stream"


class ExchangeProtocol(Protocol):
    """Exchange-specific REST/WS protocol behavior."""

    def rest_request(self, req: Any, config: Any | None = None) -> RestRequestSpec | None:
        ...

    def ws_connection(self, descriptor: Any, config: Any | None = None) -> WsConnectionSpec:
        ...

    def rest_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        ...

    def ws_base_urls(self, descriptor: Any, config: Any | None = None) -> list[str]:
        ...

    def rest_path(self, stream_type: Any, market_type: str = "spot") -> str | None:
        ...

    def build_http_params(self, req: Any) -> dict[str, Any]:
        ...

    def build_ws_subscription(self, descriptor: Any) -> WsSubscriptionSpec:
        ...

    def extract_http_rows(self, payload: Any, stream_type: Any) -> list[Any]:
        ...

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        ...

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        ...

    def sanitize_http_urls(self, urls: list[str]) -> list[str]:
        ...

    def sanitize_ws_urls(self, urls: list[str]) -> list[str]:
        ...


class AdapterBackedProtocol:
    """Compatibility protocol backed by the legacy ExchangeAdapter API."""

    def __init__(
        self,
        adapter: Any,
        *,
        blocked_http_substrings: tuple[str, ...] = (),
        blocked_ws_substrings: tuple[str, ...] = (),
    ) -> None:
        self._adapter = adapter
        self._blocked_http_substrings = blocked_http_substrings
        self._blocked_ws_substrings = blocked_ws_substrings

    def rest_base_urls(self, market_type: str = "spot", config: Any | None = None) -> list[str]:
        return self.sanitize_http_urls(
            list(self._adapter.get_http_base_urls(market_type, config=config))
        )

    def rest_request(self, req: Any, config: Any | None = None) -> RestRequestSpec | None:
        descriptor = req.descriptor
        market_type = getattr(descriptor, "market_type", "spot")
        path = self.rest_path(descriptor.stream_type, market_type)
        if path is None:
            return None
        return RestRequestSpec(
            base_urls=self.rest_base_urls(market_type, config=config),
            path=path,
            params=self.build_http_params(req),
        )

    def ws_base_urls(self, descriptor: Any, config: Any | None = None) -> list[str]:
        market_type = getattr(descriptor, "market_type", "spot")
        get_descriptor_ws_urls = getattr(self._adapter, "get_ws_base_urls_for_descriptor", None)
        if callable(get_descriptor_ws_urls):
            urls = list(
                get_descriptor_ws_urls(
                    descriptor,
                    market_type=market_type,
                    config=config,
                ) or []
            )
            if urls:
                return self.sanitize_ws_urls(urls)

        stream_type = getattr(getattr(descriptor, "stream_type", ""), "value", "")
        if stream_type in ("ticker", "miniTicker"):
            get_ticker_ws_urls = getattr(self._adapter, "get_ticker_ws_urls", None)
            if callable(get_ticker_ws_urls):
                urls = list(get_ticker_ws_urls(market_type) or [])
                if urls:
                    return self.sanitize_ws_urls(urls)

        return self.sanitize_ws_urls(
            list(
                self._adapter.get_ws_base_urls(
                    market_type,
                    config=config,
                )
            )
        )

    def ws_connection(self, descriptor: Any, config: Any | None = None) -> WsConnectionSpec:
        return WsConnectionSpec(
            base_urls=self.ws_base_urls(descriptor, config=config),
            subscription=self.build_ws_subscription(descriptor),
            connection_model="shared_multiplex"
            if self._capability_ws_model() == "shared_multiplex"
            else "path_per_stream",
        )

    def rest_path(self, stream_type: Any, market_type: str = "spot") -> str | None:
        return self._adapter.get_rest_path(stream_type, market_type)

    def build_http_params(self, req: Any) -> dict[str, Any]:
        return self._adapter.build_http_params(req)

    def build_ws_subscription(self, descriptor: Any) -> WsSubscriptionSpec:
        return self._adapter.build_ws_subscription(descriptor)

    def extract_http_rows(self, payload: Any, stream_type: Any) -> list[Any]:
        actual_stream_type = getattr(stream_type, "stream_type", stream_type)
        return self._adapter.extract_http_rows(payload, actual_stream_type)

    def build_combined_subscribe(self, descriptors: list[Any]) -> dict[str, Any]:
        args: list[dict[str, Any]] = []
        seen: set[tuple[tuple[str, str], ...]] = set()
        for descriptor in descriptors:
            spec = self.build_ws_subscription(descriptor)
            payload = spec.subscribe_payload or {}
            payload_args = payload.get("args") if isinstance(payload.get("args"), list) else []
            for arg in payload_args:
                if not isinstance(arg, dict):
                    continue
                key = tuple(sorted((str(k), str(v)) for k, v in arg.items()))
                if not key or key in seen:
                    continue
                seen.add(key)
                args.append(dict(arg))
        if not args:
            return {}
        return {"op": "subscribe", "args": args}

    def payload_matches_descriptor(self, payload: Any, descriptor: Any) -> bool:
        if not isinstance(payload, dict):
            return False
        arg = payload.get("arg") if isinstance(payload.get("arg"), dict) else {}
        payload_args = self._subscription_args(descriptor)
        if not payload_args:
            return False

        for expected in payload_args:
            if not isinstance(expected, dict):
                continue
            for field in ("channel", "instId", "symbol", "topic"):
                if field not in expected:
                    continue
                expected_value = str(expected.get(field, "")).upper()
                actual_value = str(arg.get(field, "")).upper()
                if not expected_value or expected_value != actual_value:
                    break
            else:
                return True
        return False

    def _subscription_args(self, descriptor: Any) -> list[Any]:
        spec = self.build_ws_subscription(descriptor)
        payload = spec.subscribe_payload or {}
        payload_args = payload.get("args") if isinstance(payload.get("args"), list) else []
        return list(payload_args)

    def sanitize_http_urls(self, urls: list[str]) -> list[str]:
        return self._sanitize_urls(urls, self._blocked_http_substrings)

    def sanitize_ws_urls(self, urls: list[str]) -> list[str]:
        return self._sanitize_urls(urls, self._blocked_ws_substrings)

    @staticmethod
    def _sanitize_urls(urls: list[str], blocked_substrings: tuple[str, ...]) -> list[str]:
        cleaned = [
            url for url in urls
            if url and not any(blocked in url for blocked in blocked_substrings)
        ]
        return list(dict.fromkeys(cleaned))

    def _capability_ws_model(self) -> str:
        capabilities = getattr(self._adapter, "capabilities", None)
        if not callable(capabilities):
            return "path_per_stream"
        return str(getattr(capabilities(), "ws_connection_model", "path_per_stream"))
