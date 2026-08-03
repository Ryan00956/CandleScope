"""Size-bounded GitHub API reader that never clones or executes repositories."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import quote, urlencode

import httpx
from candlescope_plugin_sdk.platform_v2 import JsonLimits, PlatformContractError, loads_strict

from .errors import github_import_error
from .models import MAX_GITHUB_RESPONSE_BYTES


GITHUB_API_ORIGIN = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"
GITHUB_USER_AGENT = "CandleScope-Plugin-Assessment/1"
GITHUB_TIMEOUT_SECONDS = 20.0
_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_GITHUB_RESPONSE_BYTES,
    max_depth=32,
    max_container_items=200_000,
    max_string_bytes=2 * 1024 * 1024,
)


@dataclass(frozen=True, slots=True)
class GitHubApiResult:
    status_code: int
    value: dict[str, Any] | None
    rate_limit_remaining: int | None


class GitHubMetadataClient(Protocol):
    def get_object(
        self,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        allow_not_found: bool = False,
    ) -> GitHubApiResult: ...


def repository_api_path(owner: str, repository: str, suffix: str = "") -> str:
    base = f"/repos/{quote(owner, safe='')}/{quote(repository, safe='')}"
    if not suffix:
        return base
    if not suffix.startswith("/") or "?" in suffix or "#" in suffix or "\\" in suffix:
        raise github_import_error(
            "PLUGIN_GITHUB_IMPORT_INTERNAL_ENDPOINT_INVALID",
            "GitHub API suffix is invalid",
        )
    return base + suffix


class GitHubApiClient:
    """Fixed-origin reader for public GitHub metadata with optional API auth."""

    def __init__(
        self,
        *,
        timeout_seconds: float = GITHUB_TIMEOUT_SECONDS,
        token: str | None = None,
    ) -> None:
        if not isinstance(timeout_seconds, (int, float)) or not 1 <= timeout_seconds <= 60:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_CONFIGURATION_INVALID",
                "GitHub timeout must be between 1 and 60 seconds",
            )
        if token is not None and (
            not isinstance(token, str)
            or not token
            or len(token) > 4096
            or token != token.strip()
            or any(character.isspace() or ord(character) < 32 for character in token)
        ):
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_CONFIGURATION_INVALID",
                "GitHub API token is malformed",
            )
        self._timeout_seconds = float(timeout_seconds)
        self._token = token

    def _request_headers(self) -> dict[str, str]:
        return {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": GITHUB_USER_AGENT,
            **({"Authorization": f"Bearer {self._token}"} if self._token else {}),
        }

    @staticmethod
    def _url(path: str, params: Mapping[str, str] | None) -> str:
        if (
            not path.startswith("/repos/")
            or "://" in path
            or "?" in path
            or "#" in path
            or "\\" in path
            or any(part in {".", ".."} for part in path.split("/"))
        ):
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_INTERNAL_ENDPOINT_INVALID",
                "GitHub API path escaped the fixed repository endpoint",
            )
        query: dict[str, str] = {}
        for key, value in dict(params or {}).items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise github_import_error(
                    "PLUGIN_GITHUB_IMPORT_INTERNAL_ENDPOINT_INVALID",
                    "GitHub API query must contain strings",
                )
            if len(key) > 64 or len(value) > 512 or "\x00" in key or "\x00" in value:
                raise github_import_error(
                    "PLUGIN_GITHUB_IMPORT_INTERNAL_ENDPOINT_INVALID",
                    "GitHub API query exceeds its bounds",
                )
            query[key] = value
        return GITHUB_API_ORIGIN + path + ("?" + urlencode(query) if query else "")

    def get_object(
        self,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        allow_not_found: bool = False,
    ) -> GitHubApiResult:
        url = self._url(path, params)
        headers = self._request_headers()
        try:
            with httpx.Client(
                timeout=self._timeout_seconds,
                follow_redirects=False,
                trust_env=True,
            ) as client:
                with client.stream("GET", url, headers=headers) as response:
                    remaining_raw = response.headers.get("x-ratelimit-remaining")
                    remaining = (
                        int(remaining_raw)
                        if remaining_raw is not None and remaining_raw.isdecimal()
                        else None
                    )
                    if response.status_code == 404 and allow_not_found:
                        return GitHubApiResult(404, None, remaining)
                    if response.status_code != 200:
                        code = (
                            "PLUGIN_GITHUB_IMPORT_RATE_LIMITED"
                            if response.status_code in {403, 429} and remaining == 0
                            else "PLUGIN_GITHUB_IMPORT_HTTP_FAILED"
                        )
                        raise github_import_error(
                            code,
                            "GitHub metadata request failed",
                            details={
                                "statusCode": response.status_code,
                                "path": path,
                                **(
                                    {"rateLimitRemaining": remaining}
                                    if remaining is not None
                                    else {}
                                ),
                            },
                        )
                    length_raw = response.headers.get("content-length")
                    if (
                        length_raw is not None
                        and length_raw.isdecimal()
                        and int(length_raw) > MAX_GITHUB_RESPONSE_BYTES
                    ):
                        raise github_import_error(
                            "PLUGIN_GITHUB_IMPORT_RESPONSE_TOO_LARGE",
                            "GitHub metadata response exceeds 4 MiB",
                            details={"path": path},
                        )
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_GITHUB_RESPONSE_BYTES:
                            raise github_import_error(
                                "PLUGIN_GITHUB_IMPORT_RESPONSE_TOO_LARGE",
                                "GitHub metadata response exceeds 4 MiB",
                                details={"path": path},
                            )
        except httpx.HTTPError as exc:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_NETWORK_FAILED",
                "GitHub metadata request could not be completed",
                details={"errorType": type(exc).__name__, "path": path},
            ) from exc
        try:
            value = loads_strict(bytes(body), limits=_JSON_LIMITS)
        except PlatformContractError as exc:
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
                "GitHub returned invalid or over-limit JSON metadata",
                details={"contractCode": exc.code, "path": path},
            ) from exc
        if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
            raise github_import_error(
                "PLUGIN_GITHUB_IMPORT_METADATA_INVALID",
                "GitHub metadata endpoint did not return an object",
                details={"path": path},
            )
        return GitHubApiResult(200, dict(value), remaining)
__all__ = [
    "GITHUB_API_ORIGIN",
    "GITHUB_API_VERSION",
    "GitHubApiClient",
    "GitHubApiResult",
    "GitHubMetadataClient",
    "repository_api_path",
]
