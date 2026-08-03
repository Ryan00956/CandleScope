"""Human-review gate before a GitHub Adapter may become a local bundle."""

from __future__ import annotations

import hashlib
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    PluginManifest,
    PythonModuleRuntime,
    RuntimeEntrypoint,
    loads_strict,
)

from app.plugin_installer_v2.bundle import (
    DEFAULT_HOST_VERSION,
    DEFAULT_PYTHON_REQUIRES,
    VerifiedPlatformBundle,
    build_platform_bundle,
)

from .errors import GitHubImportError, github_import_error
from .models import (
    ADAPTER_TEMPLATE_KINDS,
    ASSESSMENT_SCHEMA,
    BUILD_RECEIPT_SCHEMA,
    MAX_ASSESSMENT_BYTES,
    SOURCE_LOCK_SCHEMA,
    GitHubRepository,
    canonical_sha256,
    require_commit,
    require_sha256,
)


MAX_SOURCE_LOCK_BYTES = 4 * 1024 * 1024
MAX_BUILD_RECEIPT_BYTES = 4 * 1024 * 1024
MAX_REVIEWED_SOURCE_BYTES = 16 * 1024 * 1024
MAX_PACKAGE_INPUT_BYTES = 512 * 1024 * 1024
_PLUGIN_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_BUNDLE_SOURCE_PREFIXES = (
    "licenses/",
    "runtime/",
    "schemas/",
    "sbom/",
    "source-maps/",
    "web/",
    "wheels/",
)
_JSON_LIMITS = JsonLimits(
    max_message_bytes=MAX_SOURCE_LOCK_BYTES,
    max_depth=32,
    max_container_items=200_000,
    max_string_bytes=2 * 1024 * 1024,
)
_ASSESSMENT_LIMITS = JsonLimits(
    max_message_bytes=MAX_ASSESSMENT_BYTES,
    max_depth=32,
    max_container_items=200_000,
    max_string_bytes=2 * 1024 * 1024,
)


@dataclass(frozen=True, slots=True)
class ValidatedAdapterSource:
    root: Path
    plugin_id: str
    template_kind: str
    manifest: PluginManifest
    manifest_sha256: str
    source_lock_sha256: str
    assessment_sha256: str
    upstream_commit: str
    entry_path: str
    entry_sha256: str
    build_receipt_sha256: str
    artifact_pins: tuple[dict[str, Any], ...]
    license_files: tuple[dict[str, Any], ...]
    package_inputs: tuple[dict[str, Any], ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "pluginId": self.plugin_id,
            "templateKind": self.template_kind,
            "manifestSha256": self.manifest_sha256,
            "sourceLockSha256": self.source_lock_sha256,
            "assessmentSha256": self.assessment_sha256,
            "upstreamCommit": self.upstream_commit,
            "entryPath": self.entry_path,
            "entrySha256": self.entry_sha256,
            "buildReceiptSha256": self.build_receipt_sha256,
            "artifactPins": list(self.artifact_pins),
            "licenseFiles": list(self.license_files),
            "packageInputs": list(self.package_inputs),
            "status": "complete",
            "executionApprovedBySourceLock": True,
        }


def _sha256(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _mapping(
    value: Any,
    field: str,
    *,
    required: frozenset[str],
    optional: frozenset[str] = frozenset(),
) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must be an object",
            details={"field": field},
        )
    missing = sorted(required - set(value))
    unknown = sorted(set(value) - required - optional)
    if missing or unknown:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} has missing or unknown fields",
            details={"field": field, "missing": missing, "unknown": unknown},
        )
    return dict(value)


def _list(value: Any, field: str, *, maximum: int = 10_000) -> list[Any]:
    if not isinstance(value, list) or len(value) > maximum:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must be a bounded array",
            details={"field": field},
        )
    return list(value)


def _text(value: Any, field: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must be a non-empty bounded string",
            details={"field": field},
        )
    normalized = value.strip()
    if "\x00" in normalized or "\r" in normalized or "\n" in normalized:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} contains forbidden characters",
            details={"field": field},
        )
    return normalized


def _bool(value: Any, field: str, *, expected: bool | None = None) -> bool:
    if not isinstance(value, bool) or (expected is not None and value is not expected):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} is not the required boolean value",
            details={"field": field, **({"expected": expected} if expected is not None else {})},
        )
    return value


def _integer(value: Any, field: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must be an integer",
            details={"field": field},
        )
    return value


def _relative(value: Any, field: str) -> str:
    path = _text(value, field, maximum=512)
    pure = PurePosixPath(path)
    if (
        path.startswith(("/", "\\"))
        or "\\" in path
        or pure.is_absolute()
        or any(part in {"", ".", ".."} for part in pure.parts)
        or ":" in path
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must be a safe relative path",
            details={"field": field},
        )
    return pure.as_posix()


def _file(root: Path, relative: str, *, maximum: int) -> tuple[Path, bytes]:
    path = root.joinpath(*PurePosixPath(relative).parts)
    try:
        resolved = path.resolve(strict=True)
        if root not in resolved.parents or path.is_symlink() or not resolved.is_file():
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_FILE_INVALID",
                "reviewed source file escaped the Adapter root or is not regular",
                details={"path": relative},
            )
        size = resolved.stat().st_size
        if size > maximum:
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_FILE_INVALID",
                "reviewed source file exceeds its size limit",
                details={"path": relative, "maxBytes": maximum},
            )
        return resolved, resolved.read_bytes()
    except GitHubImportError:
        raise
    except OSError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_FILE_INVALID",
            "reviewed source file could not be read",
            details={"path": relative, "errorType": type(exc).__name__},
        ) from exc


def _package_source_paths(root: Path) -> tuple[str, ...]:
    """Return the development-tree files eligible for the platform bundle.

    Review metadata and build sources deliberately remain outside the bundle. The
    completed build receipt still binds every returned file before it is copied to
    the platform builder's frozen layout.
    """

    paths: list[str] = ["manifest.json"]
    for candidate in sorted(root.rglob("*")):
        if candidate.is_symlink():
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_FILE_INVALID",
                "reviewed Adapter source must not contain symbolic links",
                details={"path": candidate.relative_to(root).as_posix()},
            )
        if candidate.is_dir():
            continue
        if not candidate.is_file():
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_FILE_INVALID",
                "reviewed Adapter source must contain regular files only",
                details={"path": candidate.relative_to(root).as_posix()},
            )
        relative = candidate.relative_to(root).as_posix()
        if relative.startswith(_BUNDLE_SOURCE_PREFIXES):
            paths.append(relative)
    return tuple(sorted(set(paths)))


def _validated_receipt_output(
    root: Path,
    value: Any,
    field: str,
) -> dict[str, Any]:
    data = _mapping(
        value,
        field,
        required=frozenset({"path", "sha256", "size"}),
    )
    relative = _relative(data["path"], f"{field}.path")
    digest = require_sha256(data["sha256"], f"{field}.sha256")
    size = _integer(data["size"], f"{field}.size", minimum=1)
    _, raw = _file(root, relative, maximum=MAX_PACKAGE_INPUT_BYTES)
    if len(raw) != size or _sha256(raw) != digest:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
            "build receipt output does not match the reviewed Adapter tree",
            details={"path": relative},
        )
    return {"path": relative, "sha256": digest, "size": size}


def _strict_json(raw: bytes, field: str, limits: JsonLimits) -> dict[str, Any]:
    try:
        value = loads_strict(raw, limits=limits)
    except PlatformContractError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} is not strict bounded JSON",
            details={"field": field, "contractCode": exc.code},
        ) from exc
    if not isinstance(value, dict):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must contain a JSON object",
        )
    return dict(value)


def _verify_pinned_file(
    root: Path,
    value: dict[str, Any],
    field: str,
    *,
    require_local: bool,
) -> dict[str, Any]:
    data = _mapping(
        value,
        field,
        required=frozenset({"name", "role", "url", "sha256", "size", "licenseSpdx"}),
        optional=frozenset({"localPath"}),
    )
    name = _text(data["name"], f"{field}.name", maximum=512)
    role = _text(data["role"], f"{field}.role", maximum=64)
    url = _text(data["url"], f"{field}.url", maximum=2048)
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname is None or parsed.username is not None:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field}.url must be a public HTTPS URL",
        )
    digest = require_sha256(data["sha256"], f"{field}.sha256")
    size = _integer(data["size"], f"{field}.size", minimum=1)
    license_spdx = _text(data["licenseSpdx"], f"{field}.licenseSpdx", maximum=256)
    local_path = data.get("localPath")
    if require_local and local_path is None:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must bind a local reviewed file",
        )
    if local_path is not None:
        relative = _relative(local_path, f"{field}.localPath")
        _, raw = _file(root, relative, maximum=MAX_REVIEWED_SOURCE_BYTES)
        if len(raw) != size or _sha256(raw) != digest:
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
                "reviewed local artifact does not match its source lock",
                details={"path": relative},
            )
    else:
        relative = None
    return {
        "name": name,
        "role": role,
        "url": url,
        "sha256": digest,
        "size": size,
        "licenseSpdx": license_spdx,
        **({"localPath": relative} if relative is not None else {}),
    }


def _canonical_timestamp(value: Any, field: str) -> str:
    text = _text(value, field, maximum=64)
    if not text.endswith("Z"):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} must be a UTC timestamp ending in Z",
        )
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00")
    except ValueError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} is not an ISO-8601 timestamp",
        ) from exc
    if parsed.isoformat().replace("+00:00", "Z") != text:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            f"{field} is not a canonical UTC timestamp",
        )
    return text


def validate_adapter_source(source: Path | str) -> ValidatedAdapterSource:
    candidate = Path(source).expanduser()
    try:
        root = candidate.resolve(strict=True)
    except OSError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_INVALID",
            "Adapter source directory does not exist",
        ) from exc
    if candidate.is_symlink() or not root.is_dir():
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_INVALID",
            "Adapter source must be a regular directory, not a symlink",
        )

    _, manifest_raw = _file(root, "manifest.json", maximum=4 * 1024 * 1024)
    try:
        manifest_value = loads_strict(manifest_raw)
        manifest = PluginManifest.from_wire(manifest_value)
    except PlatformContractError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_MANIFEST_INVALID",
            "Adapter manifest failed the schema-v3 contract",
            details={"contractCode": exc.code, "path": exc.path},
        ) from exc
    if (
        manifest.schema_version != 3
        or len(manifest.backend_entrypoints) != 1
        or len(manifest.probes) != 1
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_MANIFEST_INVALID",
            "Phase 9 source lock supports exactly one schema-v3 entrypoint and probe",
        )
    entrypoint = manifest.backend_entrypoints[0]
    if not isinstance(entrypoint, RuntimeEntrypoint):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_MANIFEST_INVALID",
            "Phase 9 source lock requires a typed runtime entrypoint",
        )

    _, lock_raw = _file(root, "source-lock.json", maximum=MAX_SOURCE_LOCK_BYTES)
    lock = _mapping(
        _strict_json(lock_raw, "source-lock.json", _JSON_LIMITS),
        "sourceLock",
        required=frozenset(
            {
                "schemaVersion",
                "status",
                "templateKind",
                "pluginId",
                "assessment",
                "upstream",
                "artifactPins",
                "licenses",
                "adapter",
                "review",
            }
        ),
    )
    if lock["schemaVersion"] != SOURCE_LOCK_SCHEMA or lock["status"] != "complete":
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "source lock must be explicitly completed by a human before build",
        )
    template_kind = _text(lock["templateKind"], "sourceLock.templateKind", maximum=64)
    if template_kind not in ADAPTER_TEMPLATE_KINDS:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source lock template kind is unsupported",
        )
    plugin_id = _text(lock["pluginId"], "sourceLock.pluginId", maximum=128)
    if _PLUGIN_ID.fullmatch(plugin_id) is None or plugin_id != manifest.plugin.id:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source lock plugin id does not match the manifest",
        )

    assessment_lock = _mapping(
        lock["assessment"],
        "sourceLock.assessment",
        required=frozenset({"present", "schemaVersion", "sha256", "assessmentIdentity"}),
    )
    _bool(assessment_lock["present"], "sourceLock.assessment.present", expected=True)
    if assessment_lock["schemaVersion"] != ASSESSMENT_SCHEMA:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source lock assessment schema is unsupported",
        )
    assessment_digest = require_sha256(
        assessment_lock["sha256"], "sourceLock.assessment.sha256"
    )
    _, assessment_raw = _file(
        root,
        "assessment/github-assessment.json",
        maximum=MAX_ASSESSMENT_BYTES,
    )
    if _sha256(assessment_raw) != assessment_digest:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
            "copied GitHub assessment does not match the source lock",
        )
    assessment = _strict_json(
        assessment_raw, "assessment/github-assessment.json", _ASSESSMENT_LIMITS
    )
    if assessment.get("schemaVersion") != ASSESSMENT_SCHEMA:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "copied GitHub assessment schema is unsupported",
        )
    unsigned_assessment = dict(assessment)
    unsigned_assessment.pop("assessmentSha256", None)
    if assessment.get("assessmentSha256") != canonical_sha256(unsigned_assessment):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
            "GitHub assessment canonical identity does not match its content",
        )
    assessment_identity = require_sha256(
        assessment_lock["assessmentIdentity"],
        "sourceLock.assessment.assessmentIdentity",
    )
    if assessment.get("assessmentSha256") != assessment_identity:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
            "GitHub assessment identity does not match the source lock",
        )
    decision = assessment.get("decision")
    behavior = assessment.get("behavior")
    if (
        not isinstance(decision, dict)
        or decision.get("status") != "assessment-only"
        or decision.get("mayExecute") is not False
        or not isinstance(behavior, dict)
        or behavior.get("executedRepositoryCode") is not False
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source assessment no longer preserves its non-execution statement",
        )

    upstream = _mapping(
        lock["upstream"],
        "sourceLock.upstream",
        required=frozenset({"repository", "pinKind", "requestedPin", "commit"}),
    )
    repository = GitHubRepository.parse(
        _text(upstream["repository"], "sourceLock.upstream.repository", maximum=512)
    )
    pin_kind = _text(upstream["pinKind"], "sourceLock.upstream.pinKind", maximum=16)
    if pin_kind not in {"tag", "commit"}:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source lock pin kind must be tag or commit",
        )
    _text(upstream["requestedPin"], "sourceLock.upstream.requestedPin", maximum=255)
    commit = require_commit(upstream["commit"], "sourceLock.upstream.commit")
    assessment_repository = assessment.get("repository")
    assessment_pin = assessment.get("resolvedPin")
    if (
        not isinstance(assessment_repository, dict)
        or assessment_repository.get("url") != repository.url
        or not isinstance(assessment_pin, dict)
        or assessment_pin.get("commitSha") != commit
        or assessment_pin.get("kind") != pin_kind
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source lock upstream identity does not match the GitHub assessment",
        )

    raw_pins = _list(lock["artifactPins"], "sourceLock.artifactPins", maximum=512)
    if not raw_pins:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "source lock must include at least one upstream artifact pin",
        )
    pins = tuple(
        _verify_pinned_file(
            root,
            _mapping(
                raw,
                f"sourceLock.artifactPins[{index}]",
                required=frozenset(),
                optional=frozenset(
                    {"name", "role", "url", "sha256", "size", "licenseSpdx", "localPath"}
                ),
            ),
            f"sourceLock.artifactPins[{index}]",
            require_local=False,
        )
        for index, raw in enumerate(raw_pins)
    )
    if len({(item["name"], item["role"]) for item in pins}) != len(pins):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source lock artifact pins must be unique",
        )

    licenses = _mapping(
        lock["licenses"],
        "sourceLock.licenses",
        required=frozenset({"reviewed", "redistributionApproved", "files"}),
    )
    _bool(licenses["reviewed"], "sourceLock.licenses.reviewed", expected=True)
    _bool(
        licenses["redistributionApproved"],
        "sourceLock.licenses.redistributionApproved",
        expected=True,
    )
    raw_licenses = _list(licenses["files"], "sourceLock.licenses.files", maximum=512)
    if not raw_licenses:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "source lock must include reviewed license files",
        )
    license_files = tuple(
        _verify_pinned_file(
            root,
            _mapping(
                raw,
                f"sourceLock.licenses.files[{index}]",
                required=frozenset(),
                optional=frozenset(
                    {"name", "role", "url", "sha256", "size", "licenseSpdx", "localPath"}
                ),
            ),
            f"sourceLock.licenses.files[{index}]",
            require_local=True,
        )
        for index, raw in enumerate(raw_licenses)
    )

    adapter = _mapping(
        lock["adapter"],
        "sourceLock.adapter",
        required=frozenset(
            {
                "entryArtifact",
                "entryArtifactSha256",
                "buildReceipt",
                "buildReceiptSha256",
                "conformanceTranscriptSha256",
            }
        ),
    )
    runtime = entrypoint.runtime
    expected_entry = (
        runtime.module
        if isinstance(runtime, PythonModuleRuntime)
        else str(getattr(runtime, "artifact", ""))
    )
    entry_artifact = _text(
        adapter["entryArtifact"], "sourceLock.adapter.entryArtifact", maximum=512
    )
    if entry_artifact != expected_entry:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "source lock entry artifact does not match the manifest runtime",
        )
    entry_path = (
        entry_artifact.replace(".", "/") + ".py"
        if isinstance(runtime, PythonModuleRuntime)
        else _relative(entry_artifact, "sourceLock.adapter.entryArtifact")
    )
    _, entry_raw = _file(root, entry_path, maximum=256 * 1024 * 1024)
    entry_digest = require_sha256(
        adapter["entryArtifactSha256"], "sourceLock.adapter.entryArtifactSha256"
    )
    if _sha256(entry_raw) != entry_digest:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
            "Adapter entry artifact does not match the source lock",
        )

    receipt_path = _relative(adapter["buildReceipt"], "sourceLock.adapter.buildReceipt")
    receipt_digest = require_sha256(
        adapter["buildReceiptSha256"], "sourceLock.adapter.buildReceiptSha256"
    )
    _, receipt_raw = _file(root, receipt_path, maximum=MAX_BUILD_RECEIPT_BYTES)
    if _sha256(receipt_raw) != receipt_digest:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
            "Adapter build receipt does not match the source lock",
        )
    receipt = _mapping(
        _strict_json(receipt_raw, receipt_path, _JSON_LIMITS),
        "buildReceipt",
        required=frozenset(
            {
                "schemaVersion",
                "status",
                "pluginId",
                "templateKind",
                "reviewedCommit",
                "networkAccessDuringBuild",
                "sourceCompilation",
                "reproducibleBuilds",
                "outputs",
            }
        ),
        optional=frozenset({"commands", "sourceDateEpoch", "toolchain"}),
    )
    if (
        receipt.get("schemaVersion") != BUILD_RECEIPT_SCHEMA
        or receipt.get("status") != "complete"
        or receipt.get("pluginId") != plugin_id
        or receipt.get("templateKind") != template_kind
        or receipt.get("reviewedCommit") != commit
        or receipt.get("networkAccessDuringBuild") is not False
        or not isinstance(receipt.get("sourceCompilation"), bool)
        or not isinstance(receipt.get("reproducibleBuilds"), int)
        or receipt.get("reproducibleBuilds") < 2
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_BUILD_RECEIPT_INVALID",
            "Adapter build receipt is incomplete or does not match the source lock",
        )
    raw_outputs = _list(receipt["outputs"], "buildReceipt.outputs", maximum=512)
    outputs = tuple(
        _validated_receipt_output(root, raw, f"buildReceipt.outputs[{index}]")
        for index, raw in enumerate(raw_outputs)
    )
    output_paths = [item["path"] for item in outputs]
    if output_paths != sorted(output_paths) or len(set(output_paths)) != len(output_paths):
        raise github_import_error(
            "PLUGIN_ADAPTER_BUILD_RECEIPT_INVALID",
            "build receipt outputs must be path-sorted and unique",
        )
    matching_outputs = [item for item in outputs if item["path"] == entry_path]
    if (
        len(matching_outputs) != 1
        or matching_outputs[0]["sha256"] != entry_digest
        or matching_outputs[0]["size"] != len(entry_raw)
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_BUILD_RECEIPT_INVALID",
            "build receipt does not bind the exact Adapter entry artifact",
        )

    transcript_digest = require_sha256(
        adapter["conformanceTranscriptSha256"],
        "sourceLock.adapter.conformanceTranscriptSha256",
    )
    _, transcript_raw = _file(
        root,
        "conformance/control-transcript.json",
        maximum=MAX_REVIEWED_SOURCE_BYTES,
    )
    if _sha256(transcript_raw) != transcript_digest:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
            "conformance transcript does not match the source lock",
        )
    transcript = _strict_json(
        transcript_raw,
        "conformance/control-transcript.json",
        _JSON_LIMITS,
    )
    expected_transcript = transcript.get("expected")
    requests = transcript.get("requests")
    if (
        transcript.get("schemaVersion") != "candlescope.plugin-v2-transcript.v1"
        or transcript.get("protocol") != "candlescope.plugin/2"
        or transcript.get("transport") != "jsonl/1"
        or not isinstance(requests, list)
        or not requests
        or not isinstance(expected_transcript, dict)
        or not isinstance(expected_transcript.get("responseSha256"), list)
        or len(expected_transcript["responseSha256"]) != len(requests)
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "conformance plan must be replaced by a completed language-neutral transcript",
        )
    expected_transcript_sha256 = require_sha256(
        expected_transcript.get("transcriptSha256"),
        "conformance.expected.transcriptSha256",
    )
    for index, value in enumerate(expected_transcript["responseSha256"]):
        require_sha256(value, f"conformance.expected.responseSha256[{index}]")
    entrypoint_probes = [
        probe.sha256 for probe in manifest.probes if probe.entrypoint == entrypoint.id
    ]
    if expected_transcript_sha256 not in entrypoint_probes:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "manifest semantic probe does not bind the completed transcript digest",
        )

    package_paths = _package_source_paths(root)
    if isinstance(runtime, PythonModuleRuntime):
        if not any(path.startswith("wheels/") and path.endswith(".whl") for path in package_paths):
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
                "Python Adapter build must produce at least one reviewed wheel",
            )
    elif entry_path not in package_paths:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "typed runtime entry artifact is outside the packageable platform layout",
            details={"path": entry_path},
        )
    expected_output_paths = sorted(
        set(package_paths) | {entry_path, "conformance/control-transcript.json"}
    )
    if output_paths != expected_output_paths:
        raise github_import_error(
            "PLUGIN_ADAPTER_BUILD_RECEIPT_INVALID",
            "build receipt must bind every package input and reviewed entry source exactly once",
            details={
                "missing": sorted(set(expected_output_paths) - set(output_paths)),
                "extra": sorted(set(output_paths) - set(expected_output_paths)),
            },
        )

    _, sbom_raw = _file(root, "sbom/cyclonedx.json", maximum=MAX_REVIEWED_SOURCE_BYTES)
    sbom = _strict_json(sbom_raw, "sbom/cyclonedx.json", _JSON_LIMITS)
    if (
        sbom.get("bomFormat") != "CycloneDX"
        or sbom.get("specVersion") not in {"1.5", "1.6"}
        or not isinstance(sbom.get("components"), list)
        or not sbom.get("components")
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "CycloneDX SBOM must identify the Adapter and reviewed dependencies",
        )
    _, notices_raw = _file(
        root,
        "licenses/THIRD_PARTY_NOTICES.txt",
        maximum=MAX_REVIEWED_SOURCE_BYTES,
    )
    if not notices_raw.strip() or b"PENDING HUMAN REVIEW" in notices_raw.upper():
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "third-party notices are still pending human review",
        )
    pending_paths = [
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.name.casefold().endswith(".pending")
    ]
    if pending_paths:
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INCOMPLETE",
            "pending placeholder files remain in the Adapter source",
            details={"paths": sorted(pending_paths)},
        )

    review = _mapping(
        lock["review"],
        "sourceLock.review",
        required=frozenset(
            {
                "confirmedBy",
                "confirmedAt",
                "stablePublicApi",
                "capabilities",
                "generatedSourceContainsHostInternalImports",
                "thirdPartyCodeExecutionApproved",
                "marketplaceApproved",
            }
        ),
    )
    _text(review["confirmedBy"], "sourceLock.review.confirmedBy", maximum=256)
    _canonical_timestamp(review["confirmedAt"], "sourceLock.review.confirmedAt")
    _bool(review["stablePublicApi"], "sourceLock.review.stablePublicApi", expected=True)
    _bool(
        review["generatedSourceContainsHostInternalImports"],
        "sourceLock.review.generatedSourceContainsHostInternalImports",
        expected=False,
    )
    _bool(
        review["thirdPartyCodeExecutionApproved"],
        "sourceLock.review.thirdPartyCodeExecutionApproved",
        expected=True,
    )
    _bool(review["marketplaceApproved"], "sourceLock.review.marketplaceApproved")
    capabilities = _list(review["capabilities"], "sourceLock.review.capabilities", maximum=256)
    if not all(isinstance(item, str) and item for item in capabilities):
        raise github_import_error(
            "PLUGIN_ADAPTER_SOURCE_LOCK_INVALID",
            "reviewed capabilities must be strings",
        )

    total_source = 0
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink() or path.suffix.casefold() not in {
            ".c",
            ".cc",
            ".cpp",
            ".go",
            ".java",
            ".js",
            ".mjs",
            ".py",
            ".rs",
            ".ts",
        }:
            continue
        raw = path.read_bytes()
        total_source += len(raw)
        if total_source > MAX_REVIEWED_SOURCE_BYTES:
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_FILE_INVALID",
                "reviewed Adapter source exceeds 16 MiB",
            )
        text = raw.decode("utf-8", errors="ignore").casefold()
        if any(token in text for token in ("from app.", "import app.", "backend/app/")):
            raise github_import_error(
                "PLUGIN_ADAPTER_SOURCE_HOST_IMPORT_FORBIDDEN",
                "Adapter source imports CandleScope Host internals",
                details={"path": path.relative_to(root).as_posix()},
            )

    return ValidatedAdapterSource(
        root=root,
        plugin_id=plugin_id,
        template_kind=template_kind,
        manifest=manifest,
        manifest_sha256=_sha256(manifest_raw),
        source_lock_sha256=_sha256(lock_raw),
        assessment_sha256=assessment_digest,
        upstream_commit=commit,
        entry_path=entry_path,
        entry_sha256=entry_digest,
        build_receipt_sha256=receipt_digest,
        artifact_pins=pins,
        license_files=license_files,
        package_inputs=outputs,
    )


def build_reviewed_adapter_bundle(
    source: Path | str,
    output: Path | str,
    *,
    python_requires: str = DEFAULT_PYTHON_REQUIRES,
    operating_systems: tuple[str, ...] = ("windows",),
    architectures: tuple[str, ...] = ("x86_64",),
    host_version: str = DEFAULT_HOST_VERSION,
    force: bool = False,
) -> tuple[ValidatedAdapterSource, VerifiedPlatformBundle]:
    validated = validate_adapter_source(source)
    inputs = {item["path"]: item for item in validated.package_inputs}
    probe = validated.manifest.probes[0]
    with tempfile.TemporaryDirectory(prefix="candlescope-adapter-package-") as value:
        staging = Path(value).resolve(strict=True)
        for source_path, item in sorted(inputs.items()):
            if source_path == "conformance/control-transcript.json":
                destination_path = f"probes/{probe.id}.json"
            elif source_path == "manifest.json" or source_path.startswith(
                _BUNDLE_SOURCE_PREFIXES
            ):
                destination_path = source_path
            else:
                # Reviewed source entries are receipt-bound but are not distributable
                # platform content. Their built wheel/runtime counterpart is copied by
                # one of the branches above.
                continue
            _, raw = _file(
                validated.root,
                source_path,
                maximum=MAX_PACKAGE_INPUT_BYTES,
            )
            if len(raw) != item["size"] or _sha256(raw) != item["sha256"]:
                raise github_import_error(
                    "PLUGIN_ADAPTER_SOURCE_DIGEST_MISMATCH",
                    "package input changed after source-lock validation",
                    details={"path": source_path},
                )
            destination = staging.joinpath(*PurePosixPath(destination_path).parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        bundle = build_platform_bundle(
            staging,
            Path(output),
            python_requires=python_requires,
            operating_systems=operating_systems,
            architectures=architectures,
            host_version=host_version,
            force=force,
        )
    if bundle.manifest.schema_version != 3 or bundle.manifest.plugin.id != validated.plugin_id:
        raise github_import_error(
            "PLUGIN_ADAPTER_BUILD_OUTPUT_INVALID",
            "built bundle identity changed after source-lock validation",
        )
    return validated, bundle


__all__ = [
    "ValidatedAdapterSource",
    "build_reviewed_adapter_bundle",
    "validate_adapter_source",
]
