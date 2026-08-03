"""Atomic, non-executable Adapter scaffolds for reviewed GitHub projects."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from candlescope_plugin_sdk.platform_v2 import (
    JsonLimits,
    PlatformContractError,
    PluginManifest,
    loads_strict,
)

from .errors import GitHubImportError, github_import_error
from .models import (
    ADAPTER_TEMPLATE_KINDS,
    ASSESSMENT_SCHEMA,
    BUILD_RECEIPT_SCHEMA,
    MAX_ASSESSMENT_BYTES,
    SOURCE_LOCK_SCHEMA,
    canonical_sha256,
)


SCAFFOLD_SCHEMA = "candlescope.adapter-scaffold/1"
_PLUGIN_ID = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$")
_LOCAL_ID = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_ASSESSMENT_LIMITS = JsonLimits(
    max_message_bytes=MAX_ASSESSMENT_BYTES,
    max_depth=32,
    max_container_items=200_000,
    max_string_bytes=2 * 1024 * 1024,
)


@dataclass(frozen=True, slots=True)
class ScaffoldResult:
    root: Path
    template_kind: str
    plugin_id: str
    manifest_sha256: str
    source_lock_sha256: str
    files: tuple[dict[str, Any], ...]

    def to_wire(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCAFFOLD_SCHEMA,
            "root": str(self.root),
            "templateKind": self.template_kind,
            "pluginId": self.plugin_id,
            "manifestSha256": self.manifest_sha256,
            "sourceLockSha256": self.source_lock_sha256,
            "status": "pending-human-review",
            "executable": False,
            "files": list(self.files),
        }


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            indent=2,
        )
        + "\n"
    ).encode("utf-8")


def _sha256(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _safe_relative(path: str) -> str:
    candidate = PurePosixPath(path)
    if (
        not path
        or path.startswith(("/", "\\"))
        or "\\" in path
        or candidate.is_absolute()
        or any(part in {"", ".", ".."} for part in candidate.parts)
        or ":" in path
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_INTERNAL_PATH_INVALID",
            "scaffold template contains an unsafe path",
            details={"path": path},
        )
    return candidate.as_posix()


def _plugin_name(value: str | None, plugin_id: str) -> str:
    if value is None:
        value = plugin_id.replace(".", " ").replace("-", " ").title()
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 128:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID",
            "plugin name must contain 1 to 128 characters",
        )
    return value.strip()


def _local_id(plugin_id: str) -> str:
    candidate = re.sub(r"[^a-z0-9]+", "-", plugin_id.casefold()).strip("-")
    candidate = candidate[-64:].lstrip("0123456789-") or "adapter-command"
    if _LOCAL_ID.fullmatch(candidate) is None:
        return "adapter-command"
    return candidate


def _load_assessment(path: Path | None) -> tuple[dict[str, Any] | None, bytes | None]:
    if path is None:
        return None, None
    source = path.expanduser().resolve(strict=False)
    try:
        if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_ASSESSMENT_BYTES:
            raise github_import_error(
                "PLUGIN_ADAPTER_SCAFFOLD_ASSESSMENT_INVALID",
                "assessment must be a regular JSON file no larger than 8 MiB",
            )
        raw = source.read_bytes()
    except GitHubImportError:
        raise
    except OSError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ASSESSMENT_INVALID",
            "assessment could not be read",
            details={"errorType": type(exc).__name__},
        ) from exc
    try:
        value = loads_strict(raw, limits=_ASSESSMENT_LIMITS)
    except PlatformContractError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ASSESSMENT_INVALID",
            "assessment is not strict bounded JSON",
            details={"contractCode": exc.code},
        ) from exc
    if not isinstance(value, dict) or value.get("schemaVersion") != ASSESSMENT_SCHEMA:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ASSESSMENT_INVALID",
            "assessment schema is unsupported",
        )
    identity = value.get("assessmentSha256")
    unsigned = dict(value)
    unsigned.pop("assessmentSha256", None)
    if identity != canonical_sha256(unsigned):
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ASSESSMENT_INVALID",
            "assessment identity does not match its canonical content",
        )
    decision = value.get("decision")
    behavior = value.get("behavior")
    if (
        not isinstance(decision, dict)
        or decision.get("status") != "assessment-only"
        or decision.get("mayExecute") is not False
        or not isinstance(behavior, dict)
        or behavior.get("executedRepositoryCode") is not False
    ):
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ASSESSMENT_INVALID",
            "assessment does not preserve the non-execution boundary",
        )
    return dict(value), raw


def _runtime(template_kind: str) -> tuple[dict[str, Any], str]:
    if template_kind == "java-library":
        return (
            {
                "kind": "java-jar",
                "artifact": "runtime/adapter.jar",
                "runtimeId": "temurin-21.0.12.8",
                "mainClass": "io.candlescope.adapter.Main",
            },
            "runtime/adapter.jar",
        )
    if template_kind == "native-cli":
        return (
            {
                "kind": "native-executable",
                "artifact": "runtime/adapter.exe",
                "operatingSystems": ["windows"],
                "architectures": ["x86_64"],
            },
            "runtime/adapter.exe",
        )
    if template_kind in {"python-package", "service", "sandbox-view"}:
        module = "adapter.service" if template_kind == "service" else "adapter.main"
        return (
            {
                "kind": "python-module",
                "module": module,
                "runtimeId": "python-v2-compat",
            },
            module,
        )
    if template_kind == "node-library":
        return (
            {
                "kind": "node-module",
                "artifact": "runtime/main.mjs",
                "runtimeId": "node-24.19.0",
                "nodeArgs": ["--enable-source-maps", "--max-old-space-size=128"],
            },
            "runtime/main.mjs",
        )
    if template_kind == "wasm-computation":
        return (
            {
                "kind": "wasm-component",
                "artifact": "runtime/main.wasm",
                "runtimeId": "wasmtime-47.0.3",
                "export": "wasi:cli.run",
                "wasiProfile": "wasi-preview2",
            },
            "runtime/main.wasm",
        )
    raise github_import_error(
        "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID",
        "unknown Adapter template kind",
        details={"templateKind": template_kind},
    )


def _conformance(plugin_id: str, contribution_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": "candlescope.adapter-conformance-plan/1",
        "status": "pending-human-review",
        "protocol": "candlescope.plugin/2",
        "transport": "jsonl/1",
        "pluginId": plugin_id,
        "contributionId": contribution_id,
        "requiredCases": [
            "handshake",
            "describe",
            "activate",
            "invoke",
            "healthCheck",
            "cancel",
            "prepareUpgrade",
            "deactivate",
            "shutdown",
            "invalidUtf8",
            "duplicateJsonKey",
            "oversizedMessage",
            "staleGeneration",
        ],
        "expectedTranscriptSha256": None,
    }


def _manifest(
    *,
    template_kind: str,
    plugin_id: str,
    plugin_name: str,
    publisher: str,
    license_spdx: str,
    probe_sha256: str,
) -> tuple[dict[str, Any], str]:
    runtime, artifact = _runtime(template_kind)
    contribution_id = _local_id(plugin_id)
    contributions = []
    if template_kind != "sandbox-view":
        contributions = [
            {
                "id": contribution_id,
                "kind": "command/1",
                "title": f"Run {plugin_name}",
                "entrypoint": "main",
                "configuration": {
                    "requiresUserAction": True,
                    "placements": ["commandPalette"],
                },
            }
        ]
    manifest: dict[str, Any] = {
        "schemaVersion": 3,
        "plugin": {
            "id": plugin_id,
            "name": plugin_name,
            "version": "0.1.0",
            "publisher": publisher,
            "license": license_spdx,
            "engines": {"candlescope": ">=0.4.0 <0.5.0"},
        },
        "backend": {
            "entrypoints": [
                {
                    "id": "main",
                    "runtime": runtime,
                    "transport": "jsonl/1",
                    "resourceProfile": "standard",
                    "activationEvents": ["onCommand"],
                }
            ]
        },
        "contributions": contributions,
        "permissions": {"required": [], "optional": []},
        "probes": [
            {
                "id": "control-transcript",
                "kind": "controlTranscript",
                "sha256": probe_sha256,
                "entrypoint": "main",
            }
        ],
    }
    if template_kind == "sandbox-view":
        manifest["frontend"] = {
            "assetsRoot": "web",
            "surfaces": [
                {
                    "id": "main-view",
                    "type": "sandbox",
                    "entry": "index.html",
                    "slot": "side-panel",
                }
            ],
        }
    try:
        PluginManifest.from_wire(manifest)
    except PlatformContractError as exc:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_INTERNAL_MANIFEST_INVALID",
            "generated manifest failed the schema-v3 contract",
            details={"contractCode": exc.code, "path": exc.path},
        ) from exc
    return manifest, artifact


def _python_source(class_name: str = "GeneratedAdapter") -> str:
    return f'''"""Generated Adapter skeleton; review the upstream API before completing the source lock."""

from __future__ import annotations

from pathlib import Path

from candlescope_plugin_sdk.platform_v2 import (
    BasePlatformPlugin,
    InvokeRequest,
    PluginManifest,
    RuntimeDescriptor,
    descriptor_from_manifest,
    loads_strict,
    serve_platform_plugin,
)


class {class_name}(BasePlatformPlugin):
    def __init__(self) -> None:
        manifest_path = Path(__file__).resolve().parents[1] / "manifest.json"
        self._manifest = PluginManifest.from_wire(loads_strict(manifest_path.read_bytes()))

    def manifest(self) -> PluginManifest:
        return self._manifest

    def describe(self) -> RuntimeDescriptor:
        return descriptor_from_manifest(self._manifest, entrypoint_id="main")

    def invoke(self, request: InvokeRequest) -> dict[str, object]:
        # TODO: validate input, call only the reviewed public upstream API, and return canonical data.
        return {{"status": "adapter-not-implemented", "contributionId": request.contribution_id}}

    def health_check(self) -> dict[str, object]:
        return {{"status": "ready", "sourceLock": "pending-human-review"}}


def main() -> int:
    return serve_platform_plugin({class_name}())


if __name__ == "__main__":
    raise SystemExit(main())
'''


def _source_files(template_kind: str) -> dict[str, bytes]:
    if template_kind == "java-library":
        return {
            "src/main/java/io/candlescope/adapter/Main.java": b'''package io.candlescope.adapter;

// Generated skeleton. Add only the public CandleScope Java SDK and the reviewed upstream library.
// TODO: implement strict JSONL lifecycle, input validation, cancellation, and canonical output.
public final class Main {
    private Main() {}

    public static void main(String[] args) {
        throw new IllegalStateException("complete source lock and Adapter implementation before build");
    }
}
''',
            "build.gradle.kts": b'''plugins { java }

repositories { /* Add only reviewed, digest-pinned repositories after human approval. */ }
dependencies { /* Add exact CandleScope SDK and upstream artifacts after license review. */ }
''',
        }
    if template_kind == "native-cli":
        return {
            "Cargo.toml": b'''[package]
name = "candlescope-generated-native-adapter"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
# Add exact reviewed dependencies, generate Cargo.lock, and record crate checksums in source-lock.json.
''',
            "src/main.rs": b'''fn main() {
    // TODO: use a public CandleScope SDK and the reviewed upstream API to implement JSONL lifecycle.
    panic!("complete source lock and Adapter implementation before build");
}
''',
        }
    if template_kind == "python-package":
        return {
            "adapter/__init__.py": b"\"\"\"Generated public Adapter package.\"\"\"\n",
            "adapter/main.py": _python_source().encode("utf-8"),
            "pyproject.toml": b'''[build-system]
requires = []
build-backend = ""

[project]
name = "candlescope-generated-adapter"
version = "0.1.0"
dependencies = []
''',
        }
    if template_kind == "node-library":
        return {
            "package.json": _json_bytes(
                {
                    "name": "candlescope-generated-node-adapter",
                    "version": "0.1.0",
                    "private": True,
                    "type": "module",
                    "scripts": {},
                    "dependencies": {},
                    "devDependencies": {},
                }
            ),
            "src/main.ts": b'''// Generated skeleton. Import only the public CandleScope Node SDK and reviewed upstream package.
// TODO: implement strict JSONL lifecycle without install scripts, dynamic imports, workers, or child processes.
throw new Error("complete source lock and Adapter implementation before build");
''',
            "tsconfig.json": _json_bytes(
                {
                    "compilerOptions": {
                        "target": "ES2024",
                        "module": "NodeNext",
                        "moduleResolution": "NodeNext",
                        "strict": True,
                        "outDir": "runtime",
                    },
                    "include": ["src/**/*.ts"],
                }
            ),
        }
    if template_kind == "wasm-computation":
        return {
            "Cargo.toml": b'''[package]
name = "candlescope-generated-wasm-adapter"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
# Add exact reviewed dependencies and the public CandleScope Rust/WASM SDK.
''',
            "src/main.rs": b'''fn main() {
    // TODO: expose wasi:cli/run and use stdin/stdout strict JSONL only.
    panic!("complete source lock and Adapter implementation before build");
}
''',
        }
    if template_kind == "service":
        return {
            "adapter/__init__.py": b"\"\"\"Generated managed service Adapter package.\"\"\"\n",
            "adapter/service.py": _python_source("GeneratedServiceAdapter").encode("utf-8"),
            "SERVICE_BOUNDARY.md": b'''# Managed service boundary

- Keep health/lifecycle on the CandleScope JSONL process.
- Do not spawn a daemon until process count, shutdown, ports, authentication, and cleanup are reviewed.
- Never inherit secrets, network, or filesystem authority from the assessment.
''',
        }
    if template_kind == "sandbox-view":
        return {
            "adapter/__init__.py": b"\"\"\"Generated sandbox-view descriptor package.\"\"\"\n",
            "adapter/main.py": _python_source("GeneratedSandboxViewAdapter").encode("utf-8"),
            "web/index.html": b'''<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Adapter view</title></head>
  <body><main id="app">Review UI bridge messages before enabling this view.</main><script src="app.js"></script></body>
</html>
''',
            "web/app.js": b'''"use strict";
// Use only the documented CandleScope UI bridge. Do not fetch remote code or access the parent DOM.
window.addEventListener("message", () => {});
''',
        }
    raise github_import_error(
        "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID",
        "unknown Adapter template kind",
        details={"templateKind": template_kind},
    )


def _readme(template_kind: str, plugin_id: str, artifact: str) -> bytes:
    return f"""# {plugin_id} Adapter scaffold

状态：`PENDING_HUMAN_REVIEW_NOT_EXECUTABLE`

模板：`{template_kind}`；计划入口：`{artifact}`。

1. 审核 `assessment/github-assessment.json` 的固定 tag/commit、许可证和包元数据；
2. 独立获取上游 source/package/release artifact，记录 URL、size、SHA-256 和许可证；
3. 只调用稳定公共 API，实现输入验证、canonical output、取消和诊断；
4. 完成 conformance/golden/boundary 测试；
5. 生成确定性运行产物、SBOM、完整 licenses/notices 和 build receipt；
6. 人工把 `source-lock.json` 改成 `complete`，填写确认者、时间、全部 artifact pin；
7. 显式运行 `candlescope-plugin v3 build`；pending lock 会被拒绝；
8. inspect 后按 digest 执行本地 install/check/update/rollback。

assessment、scaffold 和 CI 模板都不会 clone 或执行第三方代码。`ci/` 下的 workflow 不是活动的
GitHub Actions 文件；审核并固定所有 action commit 后，贡献者才可自行复制到 `.github/workflows/`。
""".encode("utf-8")


def _ci_template() -> bytes:
    return b'''name: CandleScope Adapter review
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      # TODO: pin every action to a reviewed full commit SHA before activating this workflow.
      # TODO: run only repository-owned validation; never execute assessment output.
      - run: echo "pending human review; no third-party build executed"
'''


def _source_lock(
    *,
    template_kind: str,
    plugin_id: str,
    artifact: str,
    assessment: dict[str, Any] | None,
    assessment_bytes: bytes | None,
) -> dict[str, Any]:
    repository = assessment.get("repository", {}) if assessment else {}
    pin = assessment.get("resolvedPin", {}) if assessment else {}
    return {
        "schemaVersion": SOURCE_LOCK_SCHEMA,
        "status": "pending-human-review",
        "templateKind": template_kind,
        "pluginId": plugin_id,
        "assessment": {
            "present": assessment is not None,
            "schemaVersion": assessment.get("schemaVersion") if assessment else None,
            "sha256": _sha256(assessment_bytes) if assessment_bytes is not None else None,
            "assessmentIdentity": assessment.get("assessmentSha256") if assessment else None,
        },
        "upstream": {
            "repository": repository.get("url"),
            "pinKind": pin.get("kind"),
            "requestedPin": pin.get("requested"),
            "commit": pin.get("commitSha"),
        },
        "artifactPins": [],
        "licenses": {
            "reviewed": False,
            "redistributionApproved": False,
            "files": [],
        },
        "adapter": {
            "entryArtifact": artifact,
            "entryArtifactSha256": None,
            "buildReceipt": "build-receipt.json",
            "buildReceiptSha256": None,
            "conformanceTranscriptSha256": None,
        },
        "review": {
            "confirmedBy": None,
            "confirmedAt": None,
            "stablePublicApi": False,
            "capabilities": [],
            "generatedSourceContainsHostInternalImports": False,
            "thirdPartyCodeExecutionApproved": False,
            "marketplaceApproved": False,
        },
    }


def scaffold_adapter(
    template_kind: str,
    plugin_id: str,
    output: Path,
    *,
    name: str | None = None,
    publisher: str = "local-developer",
    license_spdx: str = "GPL-3.0-only",
    assessment_path: Path | None = None,
) -> ScaffoldResult:
    if template_kind not in ADAPTER_TEMPLATE_KINDS:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID",
            "template kind is unsupported",
            details={"supported": list(ADAPTER_TEMPLATE_KINDS)},
        )
    if not isinstance(plugin_id, str) or _PLUGIN_ID.fullmatch(plugin_id) is None:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID",
            "plugin id is invalid",
        )
    plugin_name = _plugin_name(name, plugin_id)
    for field, value, maximum in (
        ("publisher", publisher, 64),
        ("license", license_spdx, 64),
    ):
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
            raise github_import_error(
                "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID",
                f"{field} is invalid",
            )
    if _LOCAL_ID.fullmatch(publisher.strip()) is None:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_ARGUMENT_INVALID",
            "publisher must be a lowercase local identifier",
        )
    assessment, assessment_bytes = _load_assessment(assessment_path)
    contribution_id = _local_id(plugin_id)
    conformance_bytes = _json_bytes(_conformance(plugin_id, contribution_id))
    manifest, artifact = _manifest(
        template_kind=template_kind,
        plugin_id=plugin_id,
        plugin_name=plugin_name,
        publisher=publisher.strip(),
        license_spdx=license_spdx.strip(),
        probe_sha256=_sha256(conformance_bytes),
    )
    manifest_bytes = _json_bytes(manifest)
    source_lock = _source_lock(
        template_kind=template_kind,
        plugin_id=plugin_id,
        artifact=artifact,
        assessment=assessment,
        assessment_bytes=assessment_bytes,
    )
    source_lock_bytes = _json_bytes(source_lock)
    build_receipt_bytes = _json_bytes(
        {
            "schemaVersion": BUILD_RECEIPT_SCHEMA,
            "status": "pending-human-review",
            "pluginId": plugin_id,
            "templateKind": template_kind,
            "reviewedCommit": None,
            "networkAccessDuringBuild": None,
            "sourceCompilation": None,
            "reproducibleBuilds": 0,
            "outputs": [],
        }
    )
    files: dict[str, bytes] = {
        "manifest.json": manifest_bytes,
        "source-lock.json": source_lock_bytes,
        "build-receipt.json": build_receipt_bytes,
        "conformance/control-transcript.json": conformance_bytes,
        "sbom/cyclonedx.json": _json_bytes(
            {
                "bomFormat": "CycloneDX",
                "specVersion": "1.5",
                "serialNumber": "urn:uuid:00000000-0000-0000-0000-000000000000",
                "version": 1,
                "metadata": {"properties": [{"name": "status", "value": "pending-human-review"}]},
                "components": [],
                "dependencies": [],
            }
        ),
        "licenses/THIRD_PARTY_NOTICES.txt": (
            "PENDING HUMAN REVIEW\n\nList every upstream and transitive dependency, version, "
            "copyright, SPDX expression, source URL, digest, and required notice before build.\n"
        ).encode("utf-8"),
        "licenses/UPSTREAM_LICENSE.pending": b"Replace with verified upstream license bytes.\n",
        "ci/candlescope-adapter-ci.yml": _ci_template(),
        "README_zh.md": _readme(template_kind, plugin_id, artifact),
        **_source_files(template_kind),
    }
    if assessment_bytes is not None:
        files["assessment/github-assessment.json"] = assessment_bytes
    for path in tuple(files):
        _safe_relative(path)
    source_text = "\n".join(
        content.decode("utf-8", errors="ignore")
        for path, content in files.items()
        if path.startswith(("src/", "adapter/"))
    ).casefold()
    forbidden = ("from app.", "import app.", "backend/app/", "backend\\app\\")
    if any(value in source_text for value in forbidden):
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_INTERNAL_IMPORT_FORBIDDEN",
            "generated source imports CandleScope Host internals",
        )

    root = output.expanduser().resolve(strict=False)
    if root.exists():
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_OUTPUT_EXISTS",
            "scaffold output already exists; choose an empty new directory",
            details={"path": str(root)},
        )
    root.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(
        tempfile.mkdtemp(prefix=f".{root.name}.scaffold-", dir=str(root.parent))
    ).resolve(strict=True)
    if temporary.parent != root.parent:
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_OUTPUT_INVALID",
            "scaffold staging directory escaped the output parent",
        )
    try:
        for relative, content in sorted(files.items()):
            target = temporary / Path(*PurePosixPath(relative).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        os.replace(temporary, root)
    except OSError as exc:
        if temporary.exists() and temporary.parent == root.parent:
            shutil.rmtree(temporary)
        raise github_import_error(
            "PLUGIN_ADAPTER_SCAFFOLD_WRITE_FAILED",
            "scaffold could not be written atomically",
            details={"errorType": type(exc).__name__},
        ) from exc
    inventory = tuple(
        {
            "path": path,
            "size": len(content),
            "sha256": _sha256(content),
        }
        for path, content in sorted(files.items())
    )
    return ScaffoldResult(
        root=root,
        template_kind=template_kind,
        plugin_id=plugin_id,
        manifest_sha256=_sha256(manifest_bytes),
        source_lock_sha256=_sha256(source_lock_bytes),
        files=inventory,
    )


__all__ = ["SCAFFOLD_SCHEMA", "ScaffoldResult", "scaffold_adapter"]
