"""Fail-closed webhook delivery policy and HTTP sender."""
from __future__ import annotations

from app.core.config import getenv as app_getenv

import asyncio
import hashlib
import hmac
import ipaddress
import json
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

import httpx


HostResolver = Callable[[str, int], Awaitable[list[str]]]


def _env_bool(name: str, default: bool = False) -> bool:
    raw = app_getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = app_getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return min(maximum, max(minimum, value))


@dataclass(frozen=True, slots=True)
class WebhookSettings:
    """Runtime policy. Webhook delivery is unavailable unless ``ready`` is true."""

    enabled: bool = False
    secret: str = ""
    require_signature: bool = True
    allow_http: bool = False
    allow_private_network: bool = False
    allowed_hosts: tuple[str, ...] = ()
    request_timeout_ms: int = 5_000
    max_attempts: int = 5
    base_retry_delay_ms: int = 1_000
    max_retry_delay_ms: int = 300_000
    poll_interval_ms: int = 1_000
    max_payload_bytes: int = 262_144
    retain_delivered: int = 5_000
    retain_dead_letter: int = 1_000
    outbox_path: Path | None = None

    @classmethod
    def from_env(cls) -> "WebhookSettings":
        outbox_raw = app_getenv("ALERT_WEBHOOK_OUTBOX_PATH", "").strip()
        allowed_hosts = tuple(
            sorted(
                {
                    host.strip().lower().rstrip(".")
                    for host in app_getenv("ALERT_WEBHOOK_ALLOWED_HOSTS", "").split(",")
                    if host.strip()
                }
            )
        )
        return cls(
            enabled=_env_bool("ALERT_WEBHOOK_ENABLED"),
            secret=app_getenv("ALERT_WEBHOOK_SECRET", ""),
            require_signature=_env_bool("ALERT_WEBHOOK_REQUIRE_SIGNATURE", True),
            allow_http=_env_bool("ALERT_WEBHOOK_ALLOW_HTTP"),
            allow_private_network=_env_bool("ALERT_WEBHOOK_ALLOW_PRIVATE_NETWORK"),
            allowed_hosts=allowed_hosts,
            request_timeout_ms=_env_int(
                "ALERT_WEBHOOK_TIMEOUT_MS", 5_000, minimum=250, maximum=30_000
            ),
            max_attempts=_env_int(
                "ALERT_WEBHOOK_MAX_ATTEMPTS", 5, minimum=1, maximum=20
            ),
            base_retry_delay_ms=_env_int(
                "ALERT_WEBHOOK_BASE_RETRY_MS", 1_000, minimum=100, maximum=60_000
            ),
            max_retry_delay_ms=_env_int(
                "ALERT_WEBHOOK_MAX_RETRY_MS", 300_000, minimum=1_000, maximum=3_600_000
            ),
            poll_interval_ms=_env_int(
                "ALERT_WEBHOOK_POLL_MS", 1_000, minimum=100, maximum=10_000
            ),
            max_payload_bytes=_env_int(
                "ALERT_WEBHOOK_MAX_PAYLOAD_BYTES",
                262_144,
                minimum=1_024,
                maximum=1_048_576,
            ),
            retain_delivered=_env_int(
                "ALERT_WEBHOOK_RETAIN_DELIVERED", 5_000, minimum=100, maximum=100_000
            ),
            retain_dead_letter=_env_int(
                "ALERT_WEBHOOK_RETAIN_DEAD_LETTER", 1_000, minimum=10, maximum=10_000
            ),
            outbox_path=Path(outbox_raw) if outbox_raw else None,
        )

    @property
    def configuration_error(self) -> str | None:
        if self.enabled and self.require_signature and len(self.secret.encode("utf-8")) < 16:
            return "ALERT_WEBHOOK_SECRET must contain at least 16 UTF-8 bytes"
        if self.enabled and not self.allowed_hosts:
            return "ALERT_WEBHOOK_ALLOWED_HOSTS must contain at least one exact hostname"
        return None

    @property
    def ready(self) -> bool:
        return self.enabled and self.configuration_error is None

    def public_status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "ready": self.ready,
            "signatureConfigured": bool(self.secret),
            "requireSignature": self.require_signature,
            "allowHttp": self.allow_http,
            "allowPrivateNetwork": self.allow_private_network,
            "allowedHostCount": len(self.allowed_hosts),
            "maxAttempts": self.max_attempts,
            "retainDelivered": self.retain_delivered,
            "retainDeadLetter": self.retain_dead_letter,
            "configurationError": self.configuration_error,
        }


@dataclass(frozen=True, slots=True)
class WebhookDeliveryResult:
    delivered: bool
    retryable: bool
    detail: str
    status_code: int | None = None
    retry_after_ms: int | None = None


def validate_webhook_action_config(
    config: dict[str, Any],
    settings: WebhookSettings,
) -> str:
    url = str(config.get("url") or "").strip()
    return validate_webhook_url_syntax(url, settings)


def validate_webhook_url_syntax(url: str, settings: WebhookSettings) -> str:
    if not url:
        raise ValueError("Alert webhook URL is required")
    if len(url) > 2_048:
        raise ValueError("Alert webhook URL exceeds 2048 characters")
    parsed = urlsplit(url)
    allowed_schemes = {"https", "http"} if settings.allow_http else {"https"}
    if parsed.scheme.lower() not in allowed_schemes:
        suffix = "http or https" if settings.allow_http else "https"
        raise ValueError(f"Alert webhook URL must use {suffix}")
    if not parsed.hostname:
        raise ValueError("Alert webhook URL hostname is required")
    hostname = parsed.hostname.lower().rstrip(".")
    if hostname not in settings.allowed_hosts:
        raise ValueError("Alert webhook hostname is not in ALERT_WEBHOOK_ALLOWED_HOSTS")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Alert webhook URL must not contain user credentials")
    if parsed.fragment:
        raise ValueError("Alert webhook URL must not contain a fragment")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("Alert webhook URL port is invalid") from exc
    return url


async def _default_resolver(host: str, port: int) -> list[str]:
    def _resolve() -> list[str]:
        records = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        return sorted({str(record[4][0]) for record in records})

    return await asyncio.to_thread(_resolve)


def _address_is_public(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_global
    except ValueError:
        return False


class WebhookSender:
    """Send one canonical JSON webhook without redirects or ambient proxies."""

    def __init__(
        self,
        settings: WebhookSettings,
        *,
        resolver: HostResolver | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self._resolver = resolver or _default_resolver
        self._transport = transport

    async def send(self, entry: dict[str, Any]) -> WebhookDeliveryResult:
        destination = validate_webhook_url_syntax(
            str(entry.get("destination") or ""),
            self.settings,
        )
        parsed = urlsplit(destination)
        host = str(parsed.hostname or "")
        port = int(parsed.port or (443 if parsed.scheme.lower() == "https" else 80))
        if not self.settings.allow_private_network:
            try:
                addresses = await asyncio.wait_for(
                    self._resolver(host, port),
                    timeout=self.settings.request_timeout_ms / 1000,
                )
            except TimeoutError:
                return WebhookDeliveryResult(False, True, "dns_error:timeout")
            except (OSError, socket.gaierror) as exc:
                return WebhookDeliveryResult(False, True, f"dns_error:{type(exc).__name__}")
            if not addresses:
                return WebhookDeliveryResult(False, True, "dns_error:no_addresses")
            if any(not _address_is_public(address) for address in addresses):
                return WebhookDeliveryResult(False, False, "destination_not_public")

        payload = entry.get("payload") if isinstance(entry.get("payload"), dict) else {}
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
            allow_nan=False,
        ).encode("utf-8")
        if len(body) > self.settings.max_payload_bytes:
            return WebhookDeliveryResult(False, False, "payload_too_large")

        timestamp = str(int(time.time()))
        delivery_id = str(entry.get("deliveryId") or "")
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "CandleScope-Alerts/1",
            "X-CandleScope-Delivery": delivery_id,
            "X-CandleScope-Timestamp": timestamp,
        }
        if self.settings.secret:
            digest = hmac.new(
                self.settings.secret.encode("utf-8"),
                timestamp.encode("ascii") + b"." + body,
                hashlib.sha256,
            ).hexdigest()
            headers["X-CandleScope-Signature"] = f"sha256={digest}"

        try:
            async with httpx.AsyncClient(
                timeout=self.settings.request_timeout_ms / 1000,
                follow_redirects=False,
                trust_env=False,
                transport=self._transport,
            ) as client:
                response = await client.post(destination, content=body, headers=headers)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            return WebhookDeliveryResult(False, True, f"transport_error:{type(exc).__name__}")

        status = int(response.status_code)
        if 200 <= status < 300:
            return WebhookDeliveryResult(True, False, f"http_{status}", status_code=status)

        retryable = status in {408, 425, 429} or 500 <= status < 600
        retry_after_ms: int | None = None
        if retryable:
            raw_retry_after = response.headers.get("Retry-After", "").strip()
            try:
                retry_after_ms = max(0, int(raw_retry_after) * 1_000)
            except ValueError:
                retry_after_ms = None
        return WebhookDeliveryResult(
            False,
            retryable,
            f"http_{status}",
            status_code=status,
            retry_after_ms=retry_after_ms,
        )
