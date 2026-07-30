"""Persistent storage for user-defined indicator scripts."""
from __future__ import annotations

import json
import os
import re
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from app.core.config import DATA_DIR


_SCRIPT_LANGUAGE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")


class CustomIndicatorStore:
    """Small JSON-backed store for local custom indicators.

    This is intentionally simple and local-first. Writes are atomic so an
    interrupted save does not leave a partially-written JSON file behind.
    """

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (DATA_DIR / "custom_indicators.json")
        self._lock = threading.RLock()

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._load().values())

    def get(self, indicator_id: str) -> dict[str, Any] | None:
        with self._lock:
            return self._load().get(indicator_id)

    def upsert(self, item: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            items = self._load()
            now = int(time.time())
            indicator_id = (item.get("id") or "").strip() or self._new_id()
            existing = items.get(indicator_id, {})
            raw_language = item.get("language")
            if raw_language is not None and not _SCRIPT_LANGUAGE.fullmatch(
                str(raw_language).strip().lower()
            ):
                raise ValueError(
                    "Custom indicator language must be a lowercase identifier"
                )
            language = str(
                item.get("language") or existing.get("language") or "pyne"
            ).strip().lower()

            record = {
                "schemaVersion": int(item.get("schemaVersion") or existing.get("schemaVersion") or 1),
                "id": indicator_id,
                "kind": item.get("kind") or existing.get("kind") or "script",
                "name": (item.get("name") or existing.get("name") or "Untitled Indicator").strip(),
                "description": item.get("description") if item.get("description") is not None else existing.get("description", ""),
                "script": item.get("script") if item.get("script") is not None else existing.get("script", ""),
                "params": item.get("params") if isinstance(item.get("params"), dict) else existing.get("params", {}),
                "paramSchema": item.get("paramSchema") if isinstance(item.get("paramSchema"), list) else existing.get("paramSchema", []),
                "renderHints": item.get("renderHints") if isinstance(item.get("renderHints"), dict) else existing.get("renderHints", {}),
                "securityMode": item.get("securityMode") or existing.get("securityMode") or None,
                "created_at": int(existing.get("created_at") or item.get("created_at") or now),
                "updated_at": now,
            }
            if language != "pyne":
                record["language"] = language

            self._validate(record)
            items[indicator_id] = record
            self._save(items)
            return record

    def delete(self, indicator_id: str) -> bool:
        with self._lock:
            items = self._load()
            if indicator_id not in items:
                return False
            del items[indicator_id]
            self._save(items)
            return True

    def _load(self) -> dict[str, dict[str, Any]]:
        if not self.path.exists():
            return {}
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Custom indicator store is corrupt: {self.path}") from exc

        if isinstance(raw, list):
            items = raw
        elif isinstance(raw, dict) and isinstance(raw.get("items"), list):
            items = raw["items"]
        else:
            raise ValueError(f"Custom indicator store has invalid format: {self.path}")

        result: dict[str, dict[str, Any]] = {}
        for item in items:
            if isinstance(item, dict) and item.get("id"):
                result[str(item["id"])] = item
        return result

    def _save(self, items: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": 1,
            "items": sorted(items.values(), key=lambda item: item.get("updated_at", 0), reverse=True),
        }
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp_path, self.path)

    @staticmethod
    def _new_id() -> str:
        return f"custom-{uuid.uuid4().hex[:12]}"

    @staticmethod
    def _validate(item: dict[str, Any]) -> None:
        if not item.get("id"):
            raise ValueError("Custom indicator id is required")
        if not item.get("name"):
            raise ValueError("Custom indicator name is required")
        if not item.get("script"):
            raise ValueError("Custom indicator script is required")
        if item.get("kind") not in {"script", "custom"}:
            raise ValueError("Custom indicator kind must be 'script' or 'custom'")
        if item.get("securityMode") not in {None, "safe", "research", "unsafe"}:
            raise ValueError("Custom indicator securityMode must be 'safe', 'research', or 'unsafe'")
        language = item.get("language")
        if language is not None and not _SCRIPT_LANGUAGE.fullmatch(str(language)):
            raise ValueError("Custom indicator language must be a lowercase identifier")
