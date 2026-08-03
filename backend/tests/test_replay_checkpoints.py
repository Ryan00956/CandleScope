from __future__ import annotations

import json

import pytest

from app.replay.checkpoints import (
    CHECKPOINT_COMPRESSION_MIN_BYTES,
    CHECKPOINT_SCHEMA_VERSION,
    CHECKPOINT_ZLIB_MAGIC,
    CheckpointCodec,
    CheckpointError,
    CheckpointRing,
)
from app.replay.errors import ReplayDomainError, ReplayErrorCode


DIGEST_A = "sha256:" + ("a" * 64)
DIGEST_B = "sha256:" + ("b" * 64)


def _payload(sequence: int, *, data_epoch: str = DIGEST_A) -> dict[str, object]:
    return {
        "core_version": "replay-core.v1",
        "execution_version": "paper_linear_v1",
        "data_epoch": data_epoch,
        "session_config_hash": DIGEST_B,
        "virtual_time_ms": 1_710_000_000_000 + sequence,
        "source_sequence": sequence,
        "revision": 4,
        "event_sequence": 9,
        "state_hash": DIGEST_A,
        "state": {"event_chain_hash": DIGEST_B, "components": {}},
    }


def test_checkpoint_codec_is_canonical_deterministic_and_checksum_bound() -> None:
    codec = CheckpointCodec()
    first = codec.encode(_payload(3))
    second = codec.encode(dict(reversed(list(_payload(3).items()))))
    assert first == second
    assert codec.decode(first) == _payload(3)
    assert json.loads(first)["schema_version"] == CHECKPOINT_SCHEMA_VERSION

    corrupted = json.loads(first)
    corrupted["payload"]["source_sequence"] = 4
    corrupted_bytes = json.dumps(
        corrupted,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    with pytest.raises(CheckpointError, match="checksum"):
        codec.decode(corrupted_bytes)


def test_checkpoint_codec_rejects_incompatible_schema_and_noncanonical_wire() -> None:
    future = CheckpointCodec(schema_version="replay-checkpoint.v2")
    stable = CheckpointCodec()
    with pytest.raises(CheckpointError, match="schema"):
        stable.decode(future.encode(_payload(1)))

    encoded = stable.encode(_payload(1))
    with pytest.raises(CheckpointError, match="canonical"):
        stable.decode(b"  " + encoded)


def test_checkpoint_codec_compresses_large_payload_and_reads_legacy_json() -> None:
    codec = CheckpointCodec()
    payload = {
        **_payload(7),
        "state": {
            "event_chain_hash": DIGEST_B,
            "components": {
                "closed_bars": [
                    {"open_time_ms": index, "close": "100"}
                    for index in range(CHECKPOINT_COMPRESSION_MIN_BYTES // 8)
                ]
            },
        },
    }
    compressed = codec.encode(payload)
    assert compressed.startswith(CHECKPOINT_ZLIB_MAGIC)
    assert codec.decode(compressed) == payload

    # The logical v1 envelope is unchanged, so checkpoints written by earlier
    # versions remain recoverable after the storage optimization ships.
    checksum = codec.encode(_payload(8))
    assert not checksum.startswith(CHECKPOINT_ZLIB_MAGIC)
    assert codec.decode(checksum) == _payload(8)


def test_checkpoint_codec_rejects_truncated_compressed_wire() -> None:
    codec = CheckpointCodec()
    payload = {**_payload(9), "padding": "x" * CHECKPOINT_COMPRESSION_MIN_BYTES}
    encoded = codec.encode(payload)
    assert encoded.startswith(CHECKPOINT_ZLIB_MAGIC)
    with pytest.raises(CheckpointError, match="compressed checkpoint"):
        codec.decode(encoded[:-3])


def test_checkpoint_ring_falls_back_from_corrupt_or_mismatched_newest_record() -> None:
    codec = CheckpointCodec()
    ring = CheckpointRing(max_recent=3)
    ring.add(
        codec.encode(_payload(0)),
        virtual_time_ms=1_710_000_000_000,
        source_sequence=0,
        state_hash=DIGEST_A,
        initial=True,
    )
    ring.add(
        codec.encode(_payload(1)),
        virtual_time_ms=1_710_000_000_001,
        source_sequence=1,
        state_hash=DIGEST_A,
    )
    ring.add(
        b"not-json",
        virtual_time_ms=1_710_000_000_002,
        source_sequence=2,
        state_hash=DIGEST_A,
    )
    ring.add(
        codec.encode(_payload(3, data_epoch=DIGEST_B)),
        virtual_time_ms=1_710_000_000_003,
        source_sequence=3,
        state_hash=DIGEST_A,
    )

    selected = ring.select_valid(
        codec,
        target_virtual_time_ms=1_710_000_000_003,
        validator=lambda payload: payload["data_epoch"] == DIGEST_A,
    )
    assert selected.payload == _payload(1)
    assert selected.record.source_sequence == 1
    assert ring.diagnostics()["corrupt_fallbacks"] == 1
    assert ring.diagnostics()["mismatch_fallbacks"] == 1


def test_checkpoint_ring_retains_initial_plus_bounded_recent_and_fails_closed() -> None:
    codec = CheckpointCodec()
    ring = CheckpointRing(max_recent=2)
    ring.add(codec.encode(_payload(0)), virtual_time_ms=0, source_sequence=0, state_hash=DIGEST_A, initial=True)
    for sequence in range(1, 5):
        ring.add(
            codec.encode(_payload(sequence)),
            virtual_time_ms=sequence,
            source_sequence=sequence,
            state_hash=DIGEST_A,
        )
    assert [record.source_sequence for record in ring.records()] == [0, 3, 4]
    assert ring.diagnostics()["recent_evictions"] == 2

    broken = CheckpointRing(max_recent=1)
    broken.add(b"broken", virtual_time_ms=0, source_sequence=0, state_hash=DIGEST_A, initial=True)
    with pytest.raises(ReplayDomainError) as error:
        broken.select_valid(codec, target_virtual_time_ms=0)
    assert error.value.code is ReplayErrorCode.DATASET_MISMATCH
