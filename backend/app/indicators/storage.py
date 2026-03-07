"""
Persistent storage for user-defined custom indicators.

Uses a simple JSON file so there are no extra database dependencies.
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from threading import Lock

_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "indicators"
_STORAGE_FILE = _STORAGE_DIR / "custom_indicators.json"
_lock = Lock()


def _ensure_dir() -> None:
    _STORAGE_DIR.mkdir(parents=True, exist_ok=True)


def _load_all() -> list[dict]:
    if not _STORAGE_FILE.exists():
        return []
    try:
        with open(_STORAGE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save_all(data: list[dict]) -> None:
    _ensure_dir()
    with open(_STORAGE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def list_custom_indicators() -> list[dict]:
    """Return all saved custom indicators."""
    with _lock:
        return _load_all()


def get_custom_indicator(indicator_id: str) -> dict | None:
    """Return a single custom indicator by id."""
    with _lock:
        for item in _load_all():
            if item.get("id") == indicator_id:
                return item
    return None


def save_custom_indicator(
    name: str,
    script: str,
    indicator_id: str | None = None,
    params: dict | None = None,
    param_schema: list | None = None,
    description: str = "",
) -> dict:
    """Create or update a custom indicator.  Returns the saved record."""
    with _lock:
        all_items = _load_all()
        now = time.time()

        if indicator_id:
            # Update existing
            for item in all_items:
                if item["id"] == indicator_id:
                    item["name"] = name
                    item["script"] = script
                    item["params"] = params or {}
                    item["paramSchema"] = param_schema or []
                    item["description"] = description
                    item["updatedAt"] = now
                    _save_all(all_items)
                    return item

        # Create new (if caller supplied indicator_id, preserve it)
        new_item = {
            "id": indicator_id or str(uuid.uuid4())[:8],
            "name": name,
            "description": description,
            "script": script,
            "params": params or {},
            "paramSchema": param_schema or [],
            "createdAt": now,
            "updatedAt": now,
        }
        all_items.append(new_item)
        _save_all(all_items)
        return new_item


def delete_custom_indicator(indicator_id: str) -> bool:
    """Delete a custom indicator by id.  Returns True if found and deleted."""
    with _lock:
        all_items = _load_all()
        before = len(all_items)
        all_items = [i for i in all_items if i.get("id") != indicator_id]
        if len(all_items) < before:
            _save_all(all_items)
            return True
        return False
