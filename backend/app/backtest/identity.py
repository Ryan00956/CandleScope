from __future__ import annotations

import hashlib
import json
from typing import Mapping

from .models import RunIdentity


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def sha256_hex(value: object) -> str:
    payload = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def config_hash(identity: RunIdentity) -> str:
    payload = {
            "strategy_revision_id": identity.strategy_revision_id,
            "dataset_id": identity.dataset_id,
            "data_epoch": identity.data_epoch,
            "snapshot_hash": identity.snapshot_hash,
            "fidelity_mode": identity.fidelity_mode,
            "source_event_kind": identity.source_event_kind,
            "start_time_ms": identity.start_time_ms,
            "end_time_ms": identity.end_time_ms,
            "warmup_bars": identity.warmup_bars,
            "parameters_json": identity.parameters_json,
            "account_model": identity.account_model,
            "execution_json": identity.execution_json,
            "engine_version": identity.engine_version,
    }
    if identity.fidelity_mode == "AGG_TRADE_EXECUTION":
        payload.update(
            {
                "signal_clock": identity.signal_clock,
                "signal_interval": identity.signal_interval,
                "execution_clock": identity.execution_clock,
                "bar_builder": identity.bar_builder,
                "timezone": identity.timezone,
            }
        )
    return "sha256:" + sha256_hex(payload)


def parse_parameters(raw: str | Mapping[str, object]) -> str:
    if isinstance(raw, str):
        parsed = json.loads(raw)
    else:
        parsed = dict(raw)
    if not isinstance(parsed, dict):
        raise ValueError("parameters must be an object")
    return canonical_json(parsed)
