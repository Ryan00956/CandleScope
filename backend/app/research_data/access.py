"""Trusted-local access policy for /api/v1/local.

CORS is not authentication. X-Forwarded-For is never used to grant access.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

logger = logging.getLogger("candlescope.research_data.access")

LOCAL_RESEARCH_ORIGIN_REQUIRED = "local_research_origin_required"
LOCAL_RESEARCH_MESSAGE = (
    "Local research data is available only from the trusted local application."
)

_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}


@dataclass(frozen=True, slots=True)
class AccessDecision:
    allowed: bool
    category: str
    reason: str

    def wire(self) -> dict[str, str]:
        return {"category": self.category, "reason": self.reason}


def _is_loopback_host(value: str | None) -> bool:
    if not value:
        return False
    host = value.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if "%" in host:
        host = host.split("%", 1)[0]
    if host in _LOOPBACK_HOSTS:
        return True
    return host.startswith("127.")


def _hostname(value: str | None) -> str:
    if not value:
        return ""
    raw = value.strip()
    if "://" in raw:
        parsed = urlsplit(raw)
        return (parsed.hostname or "").lower()
    if raw.startswith("[") and "]" in raw:
        return raw[1:raw.index("]")].lower()
    if raw.count(":") == 1:
        return raw.split(":", 1)[0].lower()
    return raw.lower()


def is_trusted_local_origin(origin: str | None) -> bool:
    if not origin:
        return False
    parsed = urlsplit(origin.strip())
    if parsed.scheme not in {"http", "https"}:
        return False
    return _is_loopback_host(parsed.hostname)


def evaluate_local_research_access(
    *,
    client_host: str | None,
    host_header: str | None,
    origin: str | None,
    forwarded_for: str | None = None,
) -> AccessDecision:
    del forwarded_for  # never used for authorization
    client_loopback = _is_loopback_host(client_host)
    host_loopback = _is_loopback_host(_hostname(host_header))
    if origin:
        if is_trusted_local_origin(origin) and client_loopback:
            return AccessDecision(True, "trusted_local_origin", "origin_and_client_loopback")
        return AccessDecision(False, "untrusted_origin", "origin_not_trusted")
    if client_loopback and host_loopback:
        return AccessDecision(True, "loopback_cli", "no_origin_loopback_client_and_host")
    return AccessDecision(False, "untrusted_client", "origin_required_or_client_not_loopback")


def access_from_request(request: Request) -> AccessDecision:
    client_host = request.client.host if request.client is not None else None
    return evaluate_local_research_access(
        client_host=client_host,
        host_header=request.headers.get("host"),
        origin=request.headers.get("origin"),
        forwarded_for=request.headers.get("x-forwarded-for"),
    )


def require_local_research_access(request: Request) -> None:
    decision = access_from_request(request)
    if decision.allowed:
        return
    logger.info(
        "local_research_access deny category=%s reason=%s",
        decision.category,
        decision.reason,
    )
    raise HTTPException(
        status_code=403,
        detail={
            "code": LOCAL_RESEARCH_ORIGIN_REQUIRED,
            "message": LOCAL_RESEARCH_MESSAGE,
        },
    )


def deny_payload() -> dict[str, Any]:
    return {
        "code": LOCAL_RESEARCH_ORIGIN_REQUIRED,
        "message": LOCAL_RESEARCH_MESSAGE,
    }
