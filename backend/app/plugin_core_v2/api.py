"""Public safe catalog and guarded local management API for Plugin Platform v2."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import re
import secrets
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from candlescope_plugin_sdk.platform_v2 import PlatformContractError, loads_strict
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse

from app.plugin_installer_v2.errors import PlatformInstallerBaseError
from app.plugin_installer_v2.bundle import verify_platform_bundle
from app.plugin_live_v2 import LiveBrokerError
from app.plugin_marketplace_v2 import MarketplaceError
from app.plugin_marketplace_v2.models import MAX_INDEX_BYTES
from app.plugin_paper_v2.errors import PaperTradingError
from app.plugin_security_v2.errors import PlatformSecurityError
from app.plugin_security_v2.management import LocalManagementGuard

from .errors import CorePluginError
from .runtime import CorePluginPlatform, DisabledCorePluginPlatform


MAX_CORE_API_BODY_BYTES = 256 * 1024
MAX_PLUGIN_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_USER_FILE_BYTES = 128 * 1024
_BUNDLE_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_BUNDLE_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_FORWARDED_HEADERS = frozenset(
    {
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-real-ip",
    }
)


def _loopback_host(value: str | None) -> bool:
    if value is None:
        return False
    if value.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(value.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


def _endpoint_request_is_local(request: Request) -> bool:
    if (
        request.client is None
        or not _loopback_host(request.client.host)
        or not _loopback_host(request.url.hostname)
        or any(name in request.headers for name in _FORWARDED_HEADERS)
        or request.headers.get("sec-fetch-site", "same-origin")
        not in {"same-origin", "none"}
    ):
        return False
    origin = request.headers.get("origin")
    if origin is None:
        return True
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    return bool(
        parsed.scheme == request.url.scheme
        and parsed.netloc == request.url.netloc
        and _loopback_host(parsed.hostname)
        and parsed.username is None
        and parsed.password is None
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
    )


def _platform(request: Request) -> CorePluginPlatform | DisabledCorePluginPlatform:
    platform = getattr(request.app.state, "plugin_platform_v2", None)
    if platform is None:
        return DisabledCorePluginPlatform()
    return platform


async def _guarded_platform(request: Request) -> CorePluginPlatform:
    platform = _platform(request)
    guard = getattr(request.app.state, "plugin_platform_v2_management_guard", None)
    if not isinstance(platform, CorePluginPlatform) or not isinstance(
        guard, LocalManagementGuard
    ):
        raise HTTPException(status_code=503, detail="plugin platform v2 is disabled")
    await guard(request)
    return platform


async def _background_platform(request: Request) -> CorePluginPlatform:
    platform = _platform(request)
    guard = getattr(request.app.state, "plugin_platform_v2_management_guard", None)
    if not isinstance(platform, CorePluginPlatform) or not isinstance(
        guard, LocalManagementGuard
    ):
        raise HTTPException(status_code=503, detail="plugin platform v2 is disabled")
    await guard.authorize_background(request)
    return platform


def _v1_compatibility(platform: CorePluginPlatform) -> Any:
    compatibility = getattr(platform, "v1_compatibility", None)
    if compatibility is None:
        raise HTTPException(
            status_code=503,
            detail="v1 script runtime compatibility bridge is unavailable",
        )
    return compatibility


async def _body(
    request: Request,
    *,
    required: set[str],
    optional: set[str] | None = None,
) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
            if length < 0:
                raise ValueError
            if length > MAX_CORE_API_BODY_BYTES:
                raise HTTPException(status_code=413, detail="request body is too large")
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="invalid Content-Length"
            ) from exc
    raw = await request.body()
    if not 0 < len(raw) <= MAX_CORE_API_BODY_BYTES:
        raise HTTPException(status_code=400, detail="request body is required")
    try:
        value = loads_strict(raw)
    except PlatformContractError as exc:
        raise HTTPException(status_code=400, detail="body must be strict JSON") from exc
    optional = optional or set()
    if (
        not isinstance(value, dict)
        or not required <= set(value)
        or bool(set(value) - required - optional)
    ):
        raise HTTPException(status_code=400, detail="request body shape is invalid")
    return value


async def _bounded_binary_body(
    request: Request, *, maximum: int, allow_empty: bool
) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            length = int(content_length)
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="invalid Content-Length"
            ) from exc
        if length < 0:
            raise HTTPException(status_code=400, detail="invalid Content-Length")
        if length > maximum or (length == 0 and not allow_empty):
            raise HTTPException(status_code=413, detail="request body is too large")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > maximum:
            raise HTTPException(status_code=413, detail="request body is too large")
    if not body and not allow_empty:
        raise HTTPException(status_code=400, detail="request body is required")
    return bytes(body)


async def _bundle_upload(
    request: Request, platform: CorePluginPlatform
) -> tuple[Path, str]:
    expected_sha256 = request.headers.get("x-candlescope-bundle-sha256", "")
    if _BUNDLE_SHA256.fullmatch(expected_sha256) is None:
        raise HTTPException(status_code=400, detail="exact bundle SHA-256 is required")
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip()
    if content_type not in {
        "application/octet-stream",
        "application/vnd.candlescope.plugin+zip",
    }:
        raise HTTPException(
            status_code=415, detail="plugin bundle media type is invalid"
        )
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if not 0 < int(content_length) <= MAX_PLUGIN_BUNDLE_BYTES:
                raise HTTPException(
                    status_code=413, detail="plugin bundle is too large"
                )
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="invalid Content-Length"
            ) from exc
    incoming = platform.root / "incoming-v2"
    if incoming.exists() and (incoming.is_symlink() or not incoming.is_dir()):
        raise HTTPException(status_code=409, detail="plugin upload directory is unsafe")
    await asyncio.to_thread(incoming.mkdir, parents=True, exist_ok=True)
    if incoming.is_symlink() or not incoming.is_dir():
        raise HTTPException(status_code=409, detail="plugin upload directory is unsafe")
    upload = incoming / f"upload-{secrets.token_hex(16)}.cspkg"
    size = 0
    digest = hashlib.sha256()
    try:
        with upload.open("xb") as handle:
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if size > MAX_PLUGIN_BUNDLE_BYTES:
                    raise HTTPException(
                        status_code=413, detail="plugin bundle is too large"
                    )
                digest.update(chunk)
                handle.write(chunk)
            handle.flush()
        if size == 0:
            raise HTTPException(status_code=400, detail="plugin bundle is required")
        actual_sha256 = "sha256:" + digest.hexdigest()
        if not secrets.compare_digest(actual_sha256, expected_sha256):
            raise HTTPException(
                status_code=400, detail="plugin bundle SHA-256 mismatch"
            )
        return upload, expected_sha256
    except BaseException:
        await asyncio.to_thread(upload.unlink, missing_ok=True)
        raise


def _raise_api_error(exc: Exception) -> None:
    if isinstance(exc, PlatformContractError):
        raise HTTPException(
            status_code=400,
            detail={
                "code": exc.code,
                "message": exc.message,
                **({"path": exc.path} if exc.path is not None else {}),
            },
        ) from exc
    if isinstance(
        exc,
        (
            CorePluginError,
            PlatformInstallerBaseError,
            PlatformSecurityError,
            PaperTradingError,
            LiveBrokerError,
            MarketplaceError,
        ),
    ):
        status_code = exc.status_code if isinstance(exc, MarketplaceError) else 409
        raise HTTPException(status_code=status_code, detail=exc.to_dict()) from exc
    raise HTTPException(
        status_code=500, detail="plugin platform operation failed"
    ) from exc


def create_core_plugin_router() -> APIRouter:
    router = APIRouter(prefix="/api/v2/plugins", tags=["plugin-platform-v2"])

    @router.get("/catalog")
    async def catalog(request: Request) -> dict[str, Any]:
        return _platform(request).catalog()

    @router.get("/marketplace/catalog")
    async def marketplace_catalog(request: Request) -> dict[str, Any]:
        platform = _platform(request)
        if not isinstance(platform, CorePluginPlatform):
            raise HTTPException(status_code=404, detail="marketplace unavailable")
        try:
            return await asyncio.to_thread(platform.marketplace.public_catalog)
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/ui/snapshot")
    async def ui_snapshot(request: Request) -> dict[str, Any]:
        return await asyncio.to_thread(_platform(request).ui_snapshot)

    @router.get("/live/control/status")
    async def live_control_status(request: Request) -> dict[str, Any]:
        return _platform(request).live_control_public_status()

    @router.get("/assets/{plugin_id}/{bundle_digest}/{asset_path:path}")
    async def sandbox_asset(
        plugin_id: str,
        bundle_digest: str,
        asset_path: str,
        request: Request,
    ) -> Response:
        platform = _platform(request)
        if (
            not isinstance(platform, CorePluginPlatform)
            or _BUNDLE_DIGEST.fullmatch(bundle_digest) is None
        ):
            raise HTTPException(status_code=404, detail="plugin asset unavailable")
        try:
            asset = await asyncio.to_thread(
                platform.sandbox_asset, plugin_id, bundle_digest, asset_path
            )
        except CorePluginError as exc:
            status = 409 if exc.code == "PLUGIN_SANDBOX_ASSET_INTEGRITY_FAILED" else 404
            raise HTTPException(
                status_code=status, detail="plugin asset unavailable"
            ) from exc
        sentinel = "__candlescope_asset_root__"
        asset_url = str(
            request.url_for(
                "sandbox_asset",
                plugin_id=plugin_id,
                bundle_digest=bundle_digest,
                asset_path=sentinel,
            )
        )
        if not asset_url.endswith(sentinel):
            raise HTTPException(status_code=404, detail="plugin asset unavailable")
        try:
            headers = asset.headers(asset_base_url=asset_url[: -len(sentinel)])
        except ValueError as exc:
            raise HTTPException(
                status_code=404, detail="plugin asset unavailable"
            ) from exc
        if request.headers.get("if-none-match") == asset.etag:
            return Response(status_code=304, headers=headers)
        return Response(
            content=asset.body, media_type=asset.media_type, headers=headers
        )

    @router.api_route("/endpoints/{plugin_id}/{endpoint_id}", methods=["GET", "POST"])
    async def plugin_endpoint(
        plugin_id: str, endpoint_id: str, request: Request
    ) -> Response:
        platform = _platform(request)
        if not isinstance(
            platform, CorePluginPlatform
        ) or not _endpoint_request_is_local(request):
            raise HTTPException(status_code=404, detail="plugin endpoint unavailable")
        try:
            maximum, methods = platform.integration.endpoints.limits(
                plugin_id, endpoint_id
            )
            if request.method not in methods:
                raise HTTPException(
                    status_code=405,
                    detail="plugin endpoint method unavailable",
                    headers={"Allow": ", ".join(sorted(methods))},
                )
            body = await _bounded_binary_body(
                request, maximum=maximum, allow_empty=True
            )
            remote_host = request.client.host if request.client is not None else ""
            response = await platform.integration.endpoints.handle(
                plugin_id=plugin_id,
                endpoint_id=endpoint_id,
                remote_host=remote_host,
                method=request.method,
                headers={
                    key.lower(): value
                    for key, value in request.headers.items()
                    if key.lower()
                    in {"accept", "content-type", "x-candlescope-event-id"}
                },
                query=tuple(request.query_params.multi_items()),
                body=body,
                trace_id=f"endpoint-{secrets.token_hex(16)}",
            )
        except HTTPException:
            raise
        except PlatformSecurityError as exc:
            status = {
                "PLUGIN_ENDPOINT_NOT_FOUND": 404,
                "PLUGIN_ENDPOINT_METHOD_DENIED": 405,
                "PLUGIN_ENDPOINT_REQUEST_TOO_LARGE": 413,
                "PLUGIN_ENDPOINT_RATE_LIMITED": 429,
                "PLUGIN_ENDPOINT_CONCURRENCY_EXCEEDED": 429,
                "PLUGIN_ENDPOINT_REVOKED": 503,
            }.get(exc.code, 502)
            raise HTTPException(
                status_code=status, detail="plugin endpoint unavailable"
            ) from exc
        headers = {
            **response.headers,
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; sandbox",
            "cross-origin-resource-policy": "same-origin",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "x-content-type-options": "nosniff",
        }
        if response.body is not None:
            return Response(
                content=response.body, status_code=response.status, headers=headers
            )

        async def stream():
            for chunk in response.event_chunks:
                yield chunk

        return StreamingResponse(stream(), status_code=response.status, headers=headers)

    @router.get("/manage/diagnostics")
    async def diagnostics(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        return platform.diagnostics()

    @router.put("/manage/chart-context")
    async def update_chart_context(request: Request) -> dict[str, Any]:
        platform = await _background_platform(request)
        payload = await _body(
            request,
            required={"chartId", "active", "context", "series"},
        )
        try:
            return platform.update_chart_context(
                chart_id=payload["chartId"],
                active=payload["active"],
                context=payload["context"],
                series=payload["series"],
            )
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/compatibility/v1/status")
    async def v1_compatibility_status(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return await asyncio.to_thread(_v1_compatibility(platform).public_catalog)
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/compatibility/v1/import-preview")
    async def v1_compatibility_import_preview(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return await asyncio.to_thread(_v1_compatibility(platform).import_preview)
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/compatibility/v1/import")
    async def v1_compatibility_import(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        payload = await _body(request, required={"previewSha256"})
        try:
            return await asyncio.to_thread(
                platform.apply_v1_compatibility_import,
                payload["previewSha256"],
                trace_id=f"management-{request.state.plugin_user_action}",
            )
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/compatibility/v1/rollback-preview")
    async def v1_compatibility_rollback_preview(
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return await asyncio.to_thread(_v1_compatibility(platform).rollback_preview)
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/compatibility/v1/rollback")
    async def v1_compatibility_rollback(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        payload = await _body(request, required={"previewSha256"})
        try:
            return await asyncio.to_thread(
                platform.apply_v1_compatibility_rollback,
                payload["previewSha256"],
                trace_id=f"management-{request.state.plugin_user_action}",
            )
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/marketplace/status")
    async def marketplace_status(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return await asyncio.to_thread(platform.marketplace.status)
        except Exception as exc:
            _raise_api_error(exc)

    async def _reconcile_marketplace_policy(
        platform: CorePluginPlatform,
    ) -> list[str]:
        disabled = await asyncio.to_thread(platform.marketplace.enforce_trust_policy)
        for plugin_id in disabled:
            await platform.reconcile_plugin(plugin_id)
        return list(disabled)

    @router.post("/manage/marketplace/{marketplace_id}/refresh")
    async def refresh_marketplace(
        marketplace_id: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            result = await asyncio.to_thread(
                platform.marketplace.refresh,
                marketplace_id,
            )
            return {
                "refresh": result,
                "disabledPlugins": await _reconcile_marketplace_policy(platform),
            }
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/marketplace/{marketplace_id}/index")
    async def import_marketplace_index(
        marketplace_id: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        if (
            request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            != "application/json"
        ):
            raise HTTPException(
                status_code=415,
                detail="marketplace index media type is invalid",
            )
        data = await _bounded_binary_body(
            request,
            maximum=MAX_INDEX_BYTES,
            allow_empty=False,
        )
        try:
            result = await asyncio.to_thread(
                platform.marketplace.import_index,
                data,
                marketplace_id=marketplace_id,
            )
            return {
                "import": result,
                "disabledPlugins": await _reconcile_marketplace_policy(platform),
            }
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/marketplace/{plugin_id}/prepare")
    async def prepare_marketplace_release(
        plugin_id: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        value = await _body(request, required={"version"})
        if value["version"] is not None and not isinstance(value["version"], str):
            raise HTTPException(
                status_code=400,
                detail="marketplace version is invalid",
            )
        try:
            candidate = await asyncio.to_thread(
                platform.marketplace.prepare,
                plugin_id,
                version=value["version"],
            )
            return {"candidate": candidate}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/marketplace/{plugin_id}/{version}/artifact")
    async def import_marketplace_artifact(
        plugin_id: str,
        version: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        upload = None
        try:
            upload, _expected_sha256 = await _bundle_upload(request, platform)
            artifact = await asyncio.to_thread(upload.read_bytes)
            candidate = await asyncio.to_thread(
                platform.marketplace.prepare,
                plugin_id,
                version=version,
                artifact_bytes=artifact,
            )
            return {"candidate": candidate}
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)
        finally:
            if upload is not None:
                await asyncio.to_thread(upload.unlink, missing_ok=True)

    @router.post("/manage/marketplace/{plugin_id}/apply")
    async def apply_marketplace_release(
        plugin_id: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            result = await asyncio.to_thread(
                platform.marketplace.apply,
                plugin_id,
            )
            await platform.reconcile_plugin(plugin_id)
            return result
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/marketplace/{plugin_id}/activate")
    async def activate_marketplace_release(
        plugin_id: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            activation = await asyncio.to_thread(
                platform.marketplace.begin_activation,
                plugin_id,
            )
            try:
                await platform.reconcile_plugin(plugin_id)
                health_evidence = await platform.observe_plugin_health(plugin_id)
                observation = await asyncio.to_thread(
                    platform.marketplace.finish_observation,
                    plugin_id,
                    healthy=True,
                    detail=(
                        f"Host runtime health passed for {len(health_evidence)} "
                        "entrypoint(s)"
                    ),
                )
            except Exception as health_error:
                rollback_steps: list[dict[str, Any]] = []
                candidate_digest = activation["candidate"]["bundleSha256"]
                for _attempt in range(8):
                    current = next(
                        (
                            item
                            for item in await asyncio.to_thread(
                                platform.installer.list_plugins
                            )
                            if item["pluginId"] == plugin_id
                        ),
                        None,
                    )
                    if current is None or current["bundleSha256"] != candidate_digest:
                        break
                    rollback_status = await asyncio.to_thread(
                        platform.installer.rollback_status,
                        plugin_id,
                    )
                    if not rollback_status["available"]:
                        raise MarketplaceError(
                            "PLUGIN_MARKETPLACE_HEALTH_ROLLBACK_FAILED",
                            "failed marketplace activation could not reach its previous activation",
                            details={"reason": rollback_status.get("reason")},
                        ) from health_error
                    rollback = await asyncio.to_thread(
                        platform.installer.rollback,
                        plugin_id,
                    )
                    rollback_steps.append(rollback.to_wire())
                else:
                    raise MarketplaceError(
                        "PLUGIN_MARKETPLACE_HEALTH_ROLLBACK_FAILED",
                        "failed marketplace activation exceeded the bounded rollback chain",
                    ) from health_error
                await platform.reconcile_plugin(plugin_id)
                await asyncio.to_thread(
                    platform.marketplace.mark_rolled_back,
                    plugin_id,
                    detail="runtime health observation failed; activation rolled back",
                )
                raise MarketplaceError(
                    "PLUGIN_MARKETPLACE_HEALTH_ROLLBACK",
                    "marketplace activation failed runtime health observation and was rolled back",
                    details={
                        "rollbackSteps": rollback_steps,
                        "healthErrorType": type(health_error).__name__,
                    },
                ) from health_error
            return {
                "activation": activation,
                "observation": observation,
                "health": health_evidence,
                "rollback": platform.installer.rollback_status(plugin_id),
            }
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/files/open")
    async def open_user_file(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        parameters = request.query_params.multi_items()
        if len(parameters) != 2 or {key for key, _value in parameters} != {
            "contributionId",
            "field",
        }:
            raise HTTPException(
                status_code=400, detail="file selection query is invalid"
            )
        values = dict(parameters)
        name = request.headers.get("x-candlescope-file-name", "")
        media_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        body = await _bounded_binary_body(
            request, maximum=MAX_USER_FILE_BYTES, allow_empty=False
        )
        try:
            action = request.state.plugin_user_action
            selection = await asyncio.to_thread(
                platform.stage_user_file,
                values["contributionId"],
                values["field"],
                name=name,
                media_type=media_type,
                body=body,
                trace_id=f"management-{action}",
            )
            return {"fileSelection": selection.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/files/save")
    async def save_user_file(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        value = await _body(request, required={"contributionId", "field"})
        if not all(isinstance(value[key], str) for key in value):
            raise HTTPException(
                status_code=400, detail="file selection body is invalid"
            )
        try:
            action = request.state.plugin_user_action
            selection = await asyncio.to_thread(
                platform.prepare_user_file_save,
                value["contributionId"],
                value["field"],
                trace_id=f"management-{action}",
            )
            return {"fileSelection": selection.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/files/download")
    async def download_user_file(request: Request) -> Response:
        platform = await _guarded_platform(request)
        value = await _body(request, required={"pluginId", "downloadId"})
        if not all(isinstance(value[key], str) for key in value):
            raise HTTPException(status_code=400, detail="file download body is invalid")
        try:
            action = request.state.plugin_user_action
            download = await asyncio.to_thread(
                platform.download_user_file,
                value["pluginId"],
                value["downloadId"],
                trace_id=f"management-{action}",
            )
        except Exception as exc:
            _raise_api_error(exc)
        return Response(
            content=download.body,
            headers={
                "Cache-Control": "no-store",
                "Content-Disposition": f'attachment; filename="{download.name}"',
                "Content-Type": download.media_type,
                "Referrer-Policy": "no-referrer",
                "X-CandleScope-Content-SHA256": download.sha256,
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.post("/manage/install")
    async def install(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        upload = None
        try:
            upload, expected_sha256 = await _bundle_upload(request, platform)
            bundle = await asyncio.to_thread(
                verify_platform_bundle,
                upload,
                expected_sha256=expected_sha256,
                host_version=platform.installer.host_version,
            )
            await asyncio.to_thread(
                platform.marketplace.record_local_bundle,
                bundle,
            )
            result = await asyncio.to_thread(
                platform.installer.install,
                upload,
                expected_sha256=expected_sha256,
                enabled=True,
            )
            await platform.reconcile_plugin(result.plugin_id)
            return {"installation": result.to_wire()}
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)
        finally:
            if upload is not None:
                await asyncio.to_thread(upload.unlink, missing_ok=True)

    @router.get("/manage/{plugin_id}/detail")
    async def plugin_detail(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return await asyncio.to_thread(platform.management_detail, plugin_id)
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/permissions")
    async def permissions(
        request: Request, plugin_id: str | None = None
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            values = await asyncio.to_thread(
                platform.installer.permission_summary, plugin_id
            )
            return {"grants": list(values)}
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/live/control/status")
    async def protected_live_control_status(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return await platform.refresh_live_control_status()
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/control")
    async def set_live_control(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(
                request,
                required={"mode", "reason", "acknowledgeKill"},
            )
            if (
                value["mode"] not in {"armed", "disarmed"}
                or not isinstance(value["reason"], str)
                or not isinstance(value["acknowledgeKill"], bool)
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Live control values are invalid",
                )
            action = request.state.plugin_user_action
            return await platform.set_live_control(
                value["mode"],
                reason=value["reason"],
                acknowledge_kill=value["acknowledgeKill"],
                trace_id=f"management-{action}",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/kill")
    async def kill_live_control(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(request, required={"reason"})
            if not isinstance(value["reason"], str):
                raise HTTPException(
                    status_code=400,
                    detail="Live kill reason must be a string",
                )
            action = request.state.plugin_user_action
            return await platform.kill_live_control(
                reason=value["reason"],
                trace_id=f"management-{action}",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/revoke")
    async def revoke_live_authority(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(
                request,
                required={"scopeType", "subject", "reason"},
            )
            if (
                value["scopeType"] not in {"grant", "plugin", "publisher", "credential"}
                or not isinstance(value["subject"], str)
                or not isinstance(value["reason"], str)
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Live revoke values are invalid",
                )
            action = request.state.plugin_user_action
            return await platform.revoke_live_authority(
                scope_type=value["scopeType"],
                subject=value["subject"],
                reason=value["reason"],
                trace_id=f"management-{action}",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/confirmations/preview")
    async def preview_live_confirmation(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(
                request,
                required={"accountRef", "shadowRef"},
            )
            if not all(isinstance(value[key], str) for key in value):
                raise HTTPException(
                    status_code=400,
                    detail="Live confirmation references must be strings",
                )
            return await platform.preview_live_confirmation(
                account_ref=value["accountRef"],
                shadow_ref=value["shadowRef"],
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/confirmations/issue")
    async def issue_live_confirmation(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(
                request,
                required={
                    "accountRef",
                    "shadowRef",
                    "expectedIntentSha256",
                    "expectedPolicyEpoch",
                    "expectedControlGeneration",
                    "ttlSeconds",
                },
            )
            if (
                not isinstance(value["accountRef"], str)
                or not isinstance(value["shadowRef"], str)
                or not isinstance(value["expectedIntentSha256"], str)
                or any(
                    isinstance(value[key], bool) or not isinstance(value[key], int)
                    for key in (
                        "expectedPolicyEpoch",
                        "expectedControlGeneration",
                        "ttlSeconds",
                    )
                )
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Live confirmation issue values are invalid",
                )
            action = request.state.plugin_user_action
            return await platform.issue_live_confirmation(
                account_ref=value["accountRef"],
                shadow_ref=value["shadowRef"],
                expected_intent_sha256=value["expectedIntentSha256"],
                expected_policy_epoch=value["expectedPolicyEpoch"],
                expected_control_generation=value["expectedControlGeneration"],
                ttl_seconds=value["ttlSeconds"],
                trace_id=f"management-{action}",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/confirmations/revoke")
    async def revoke_live_confirmation(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(
                request,
                required={"receiptRef", "reason"},
            )
            if not all(isinstance(value[key], str) for key in value):
                raise HTTPException(
                    status_code=400,
                    detail="Live confirmation revoke values are invalid",
                )
            action = request.state.plugin_user_action
            return await platform.revoke_live_confirmation(
                receipt_ref=value["receiptRef"],
                reason=value["reason"],
                trace_id=f"management-{action}",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/live/execution/{shadow_ref}")
    async def describe_live_execution(
        shadow_ref: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        if not platform.live_testnet_execution_enabled:
            raise HTTPException(
                status_code=404,
                detail="Live Demo execution is disabled",
            )
        try:
            return await platform.describe_live_execution(
                shadow_ref=shadow_ref,
            )
        except Exception as exc:
            _raise_api_error(exc)

    async def _live_execution_mutation(
        request: Request,
        *,
        action_name: str,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        if not platform.live_testnet_execution_enabled:
            raise HTTPException(
                status_code=404,
                detail="Live Demo execution is disabled",
            )
        value = await _body(
            request,
            required={
                "accountRef",
                "shadowRef",
                "receiptRef",
                "expectedConfirmationSha256",
                "expectedPolicyEpoch",
                "expectedControlGeneration",
            },
        )
        if not all(
            isinstance(value[key], str)
            for key in (
                "accountRef",
                "shadowRef",
                "receiptRef",
                "expectedConfirmationSha256",
            )
        ) or any(
            isinstance(value[key], bool) or not isinstance(value[key], int)
            for key in (
                "expectedPolicyEpoch",
                "expectedControlGeneration",
            )
        ):
            raise HTTPException(
                status_code=400,
                detail="Live execution values are invalid",
            )
        trace_id = f"management-{request.state.plugin_user_action}"
        arguments = {
            "account_ref": value["accountRef"],
            "shadow_ref": value["shadowRef"],
            "receipt_ref": value["receiptRef"],
            "expected_confirmation_sha256": value["expectedConfirmationSha256"],
            "expected_policy_epoch": value["expectedPolicyEpoch"],
            "expected_control_generation": value["expectedControlGeneration"],
            "trace_id": trace_id,
        }
        if action_name == "submit":
            return await platform.submit_live_execution(**arguments)
        return await platform.cancel_live_execution(**arguments)

    @router.post("/manage/live/execution/submit")
    async def submit_live_execution(request: Request) -> dict[str, Any]:
        try:
            return await _live_execution_mutation(
                request,
                action_name="submit",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/execution/cancel")
    async def cancel_live_execution(request: Request) -> dict[str, Any]:
        try:
            return await _live_execution_mutation(
                request,
                action_name="cancel",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/live/execution/reconcile")
    async def reconcile_live_execution(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        if not platform.live_testnet_execution_enabled:
            raise HTTPException(
                status_code=404,
                detail="Live Demo execution is disabled",
            )
        try:
            value = await _body(
                request,
                required={"accountRef", "shadowRef"},
            )
            if not all(isinstance(value[key], str) for key in value):
                raise HTTPException(
                    status_code=400,
                    detail="Live execution references must be strings",
                )
            return await platform.reconcile_live_execution(
                account_ref=value["accountRef"],
                shadow_ref=value["shadowRef"],
                trace_id=(f"management-{request.state.plugin_user_action}"),
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/live/audit-export")
    async def export_live_audit(request: Request) -> Response:
        platform = await _guarded_platform(request)
        try:
            value = await platform.export_live_audit()
            body = json.dumps(
                value,
                ensure_ascii=True,
                allow_nan=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            return Response(
                content=body,
                media_type="application/json",
                headers={
                    "Cache-Control": "no-store",
                    "Content-Disposition": (
                        'attachment; filename="candlescope-live-audit.json"'
                    ),
                    "Referrer-Policy": "no-referrer",
                    "X-Content-Type-Options": "nosniff",
                    "X-CandleScope-Content-SHA256": (
                        "sha256:" + hashlib.sha256(body).hexdigest()
                    ),
                },
            )
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/paper/status")
    async def paper_status(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        return platform.paper.status()

    @router.get("/manage/paper/accounts/{broker_id}/{account_id}")
    async def paper_account(
        broker_id: str, account_id: str, request: Request
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return await platform.paper_account_snapshot(broker_id, account_id)
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/paper/orders/submit")
    async def paper_submit(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(request, required={"intent"})
            if not isinstance(value["intent"], dict):
                raise HTTPException(
                    status_code=400, detail="OrderIntent must be an object"
                )
            action = request.state.plugin_user_action
            return await platform.submit_paper_order(
                value["intent"], trace_id=f"management-{action}"
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/paper/orders/cancel")
    async def paper_cancel(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(
                request,
                required={"brokerId", "accountId", "orderId", "idempotencyKey"},
            )
            if not all(isinstance(value[key], str) for key in value):
                raise HTTPException(
                    status_code=400, detail="paper cancel identifiers must be strings"
                )
            action = request.state.plugin_user_action
            return await platform.cancel_paper_order(
                broker_id=value["brokerId"],
                account_id=value["accountId"],
                order_id=value["orderId"],
                idempotency_key=value["idempotencyKey"],
                trace_id=f"management-{action}",
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/paper/orders/recover")
    async def paper_recover(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(
                request,
                required={"brokerId", "accountId", "idempotencyKey"},
                optional={"targetOperation", "orderId"},
            )
            if not all(isinstance(value[key], str) for key in value):
                raise HTTPException(
                    status_code=400, detail="paper recovery identifiers must be strings"
                )
            target_operation = value.get("targetOperation", "orders.submit")
            order_id = value.get("orderId")
            if target_operation not in {"orders.submit", "orders.cancel"} or (
                target_operation == "orders.cancel"
            ) != (order_id is not None):
                raise HTTPException(
                    status_code=400,
                    detail="paper recovery target is invalid",
                )
            action = request.state.plugin_user_action
            return await platform.recover_paper_order(
                broker_id=value["brokerId"],
                account_id=value["accountId"],
                idempotency_key=value["idempotencyKey"],
                trace_id=f"management-{action}",
                target_operation=target_operation,
                order_id=order_id,
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/paper/kill-switch")
    async def paper_kill_switch(request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(request, required={"enabled"})
            if not isinstance(value["enabled"], bool):
                raise HTTPException(status_code=400, detail="enabled must be boolean")
            action = request.state.plugin_user_action
            return await platform.set_paper_kill_switch(
                value["enabled"], trace_id=f"management-{action}"
            )
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/enable")
    async def enable(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            result = await asyncio.to_thread(platform.installer.enable, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            return {"stateChange": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/disable")
    async def disable(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            action = request.state.plugin_user_action
            await platform.revoke_live_authority(
                scope_type="plugin",
                subject=plugin_id,
                reason="plugin-disable",
                trace_id=f"management-{action}",
            )
            result = await asyncio.to_thread(platform.installer.disable, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            return {"stateChange": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/rollback")
    async def rollback(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            action = request.state.plugin_user_action
            await platform.revoke_live_authority(
                scope_type="plugin",
                subject=plugin_id,
                reason="plugin-rollback",
                trace_id=f"management-{action}",
            )
            result = await asyncio.to_thread(platform.installer.rollback, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            await asyncio.to_thread(
                platform.marketplace.mark_rolled_back,
                plugin_id,
                detail="user requested rollback",
            )
            return {"rollback": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/uninstall")
    async def uninstall(plugin_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            action = request.state.plugin_user_action
            await platform.revoke_live_authority(
                scope_type="plugin",
                subject=plugin_id,
                reason="plugin-uninstall",
                trace_id=f"management-{action}",
            )
            result = await asyncio.to_thread(platform.installer.uninstall, plugin_id)
            await platform.reconcile_plugin(plugin_id)
            return {"stateChange": result.to_wire()}
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/{plugin_id}/permissions/{permission_id}/{decision}")
    async def permission_change(
        plugin_id: str,
        permission_id: str,
        decision: str,
        request: Request,
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        if decision not in {"grant", "deny", "revoke"}:
            raise HTTPException(
                status_code=404, detail="permission decision is unknown"
            )
        try:
            action = request.state.plugin_user_action
            if decision == "grant":
                value = await _body(request, required={"scope"})
                if value["scope"] is not None and not isinstance(value["scope"], dict):
                    raise HTTPException(
                        status_code=400, detail="scope must be an object or null"
                    )
                result = await asyncio.to_thread(
                    platform.installer.grant_permission,
                    plugin_id,
                    permission_id,
                    scope=value["scope"],
                    source="management-api",
                    trace_id=f"management-{action}",
                )
            else:
                if await request.body():
                    raise HTTPException(
                        status_code=400, detail="decision body must be empty"
                    )
                method = (
                    platform.installer.deny_permission
                    if decision == "deny"
                    else platform.installer.revoke_permission
                )
                if decision == "revoke":
                    await platform.revoke_live_authority(
                        scope_type="grant",
                        subject=f"{plugin_id}:{permission_id}",
                        reason="permission-revoke",
                        trace_id=f"management-{action}",
                    )
                result = await asyncio.to_thread(
                    method,
                    plugin_id,
                    permission_id,
                    source="management-api",
                    trace_id=f"management-{action}",
                )
            await platform.reconcile_plugin(plugin_id)
            return {"permissionChange": result.to_wire()}
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/commands/{contribution_id:path}/invoke")
    async def invoke_command(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(request, required={"input"})
            if not isinstance(value["input"], dict):
                raise HTTPException(
                    status_code=400, detail="command input must be an object"
                )
            action = request.state.plugin_user_action
            result = await platform.invoke_command(
                contribution_id,
                value["input"],
                user_action=True,
                trace_id=f"management-{action}",
            )
            return {"result": result}
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.post("/manage/jobs/{contribution_id:path}/run")
    async def run_job(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            if await request.body():
                raise HTTPException(
                    status_code=400, detail="job trigger body must be empty"
                )
            return {
                "jobRun": await platform.trigger_job(contribution_id, user_action=True)
            }
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/settings/{contribution_id:path}")
    async def read_settings(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            return {"settings": await platform.read_settings(contribution_id)}
        except Exception as exc:
            _raise_api_error(exc)

    @router.put("/manage/settings/{contribution_id:path}")
    async def write_settings(contribution_id: str, request: Request) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        try:
            value = await _body(request, required={"value"})
            if not isinstance(value["value"], dict):
                raise HTTPException(
                    status_code=400, detail="settings value must be an object"
                )
            return {
                "settings": await platform.write_settings(
                    contribution_id, value["value"]
                )
            }
        except HTTPException:
            raise
        except Exception as exc:
            _raise_api_error(exc)

    @router.get("/manage/notifications")
    async def notifications(
        request: Request, plugin_id: str | None = None
    ) -> dict[str, Any]:
        platform = await _guarded_platform(request)
        return {"notifications": platform.notifications.snapshot(plugin_id=plugin_id)}

    return router
