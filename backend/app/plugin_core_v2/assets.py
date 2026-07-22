"""Digest-addressed, fail-closed static assets for opaque-origin plugin frames."""

from __future__ import annotations

import hashlib
import re
import secrets
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

from app.plugin_installer_v2.bundle import VerifiedPlatformBundle

from .errors import core_error


MAX_SANDBOX_ASSET_BYTES = 8 * 1024 * 1024
SANDBOX_CSP_PROFILE = "opaque-origin-v1"
SANDBOX_ATTRIBUTE = "allow-scripts"

_ASSET_PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")
_MEDIA_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


@dataclass(frozen=True, slots=True)
class SandboxAsset:
    body: bytes
    media_type: str
    etag: str

    def headers(self, *, asset_base_url: str) -> dict[str, str]:
        return {
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Security-Policy": sandbox_content_security_policy(asset_base_url),
            "Cross-Origin-Resource-Policy": "cross-origin",
            "Permissions-Policy": (
                "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), "
                "clipboard-write=(), display-capture=(), encrypted-media=(), "
                "fullscreen=(), gamepad=(), geolocation=(), gyroscope=(), "
                "magnetometer=(), microphone=(), midi=(), payment=(), "
                "picture-in-picture=(), publickey-credentials-get=(), serial=(), "
                "usb=(), web-share=(), xr-spatial-tracking=()"
            ),
            "Referrer-Policy": "no-referrer",
            "X-DNS-Prefetch-Control": "off",
            "X-Content-Type-Options": "nosniff",
            "ETag": self.etag,
        }


def sandbox_content_security_policy(asset_base_url: str) -> str:
    """Bind executable subresources to one plugin's current digest directory."""

    if not isinstance(asset_base_url, str) or any(
        char.isspace() or char in {"'", '"', ";"} for char in asset_base_url
    ):
        raise ValueError("sandbox asset base URL is unsafe")
    parsed = urlsplit(asset_base_url)
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("sandbox asset base URL is unsafe") from exc
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.endswith("/")
        or "/api/v2/plugins/assets/" not in parsed.path
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise ValueError("sandbox asset base URL is unsafe")
    return "; ".join(
        (
            "default-src 'none'",
            f"script-src {asset_base_url}",
            f"style-src {asset_base_url}",
            f"img-src {asset_base_url} data:",
            "connect-src 'none'",
            "font-src 'none'",
            "media-src 'none'",
            "object-src 'none'",
            "frame-src 'none'",
            "child-src 'none'",
            "worker-src 'none'",
            "manifest-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* "
            "https://127.0.0.1:* https://localhost:*",
            "sandbox allow-scripts",
        )
    )


def _safe_asset_path(value: str, *, plugin_id: str) -> PurePosixPath:
    if (
        not isinstance(value, str)
        or _ASSET_PATH.fullmatch(value) is None
        or "//" in value
        or "\\" in value
        or "%" in value
        or ":" in value
    ):
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_NOT_FOUND",
            "sandbox asset is unavailable",
            plugin_id=plugin_id,
        )
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_NOT_FOUND",
            "sandbox asset is unavailable",
            plugin_id=plugin_id,
        )
    return path


def load_sandbox_asset(
    *,
    plugin_id: str,
    bundle: VerifiedPlatformBundle,
    installation: Path,
    asset_path: str,
) -> SandboxAsset:
    """Read one verified web asset without exposing an installation path."""

    if bundle.manifest.frontend is None:
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_NOT_FOUND",
            "sandbox asset is unavailable",
            plugin_id=plugin_id,
        )
    relative = _safe_asset_path(asset_path, plugin_id=plugin_id)
    suffix = relative.suffix.lower()
    media_type = _MEDIA_TYPES.get(suffix)
    if media_type is None:
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_NOT_FOUND",
            "sandbox asset is unavailable",
            plugin_id=plugin_id,
        )
    if suffix == ".html" and relative.as_posix() not in {
        surface.entry
        for surface in bundle.manifest.frontend.surfaces
        if surface.type == "sandbox"
    }:
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_NOT_FOUND",
            "sandbox asset is unavailable",
            plugin_id=plugin_id,
        )
    record_path = f"web/{relative.as_posix()}"
    record = next(
        (
            item
            for item in bundle.envelope.contents
            if item.kind == "web" and item.path == record_path
        ),
        None,
    )
    if record is None or not 0 < record.size <= MAX_SANDBOX_ASSET_BYTES:
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_NOT_FOUND",
            "sandbox asset is unavailable",
            plugin_id=plugin_id,
        )
    try:
        web_root = (installation / "content" / "web").resolve(strict=True)
        target = web_root.joinpath(*relative.parts).resolve(strict=True)
        if (
            not target.is_relative_to(web_root)
            or not target.is_file()
            or target.is_symlink()
        ):
            raise OSError("sandbox asset target is unsafe")
        with target.open("rb") as stream:
            body = stream.read(record.size + 1)
    except OSError as exc:
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_INTEGRITY_FAILED",
            "sandbox asset failed its installation integrity check",
            plugin_id=plugin_id,
        ) from exc
    actual = "sha256:" + hashlib.sha256(body).hexdigest()
    if len(body) != record.size or not secrets.compare_digest(actual, record.sha256):
        raise core_error(
            "PLUGIN_SANDBOX_ASSET_INTEGRITY_FAILED",
            "sandbox asset failed its installation integrity check",
            plugin_id=plugin_id,
        )
    return SandboxAsset(body=body, media_type=media_type, etag=f'"{record.sha256}"')
