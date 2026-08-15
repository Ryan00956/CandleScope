"""Local-only archive receipts for BAR/aggTrade/contract roles. No network."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Mapping

ALLOWED_VENUES = frozenset({"binance", "okx"})
ALLOWED_ROLES = frozenset(
    {"BARS", "AGG_TRADE", "MARK_INDEX", "FUNDING", "INSTRUMENT_RULES"}
)


class ArchiveReceiptError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def build_local_archive_receipt(
    *,
    venue: str,
    market_type: str,
    symbol: str,
    role: str,
    source_files: Mapping[str, Path],
) -> dict[str, object]:
    if venue.lower() not in ALLOWED_VENUES:
        raise ArchiveReceiptError("FIDELITY_UNSUPPORTED", f"unknown venue {venue}")
    if role not in ALLOWED_ROLES:
        raise ArchiveReceiptError("FIDELITY_UNSUPPORTED", f"unknown archive role {role}")
    if not source_files:
        raise ArchiveReceiptError(
            "DATA_QUALITY_FAILED", "local archive receipt requires source files"
        )
    files: dict[str, str] = {}
    for name, path in sorted(source_files.items()):
        target = Path(path)
        if not target.is_file():
            raise ArchiveReceiptError(
                "DATA_QUALITY_FAILED", f"missing local source file {name}"
            )
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        files[name] = f"sha256:{digest}"
    receipt = {
        "schemaVersion": "candlescope.local-archive-receipt/1",
        "venue": venue.lower(),
        "marketType": market_type,
        "symbol": symbol.upper(),
        "role": role,
        "online": False,
        "files": files,
    }
    payload = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
    receipt["receiptHash"] = "sha256:" + hashlib.sha256(payload).hexdigest()
    return receipt
