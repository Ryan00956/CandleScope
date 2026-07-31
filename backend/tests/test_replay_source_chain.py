from decimal import Decimal

from app.replay.canonical import canonical_sha256
from app.replay.source_chain import (
    SOURCE_CHAIN_SCHEMA_VERSION,
    next_source_chain_hash,
    source_event_payload,
)
from tests.fixtures.replay.actor_fakes import FixtureEvent


def test_fast_source_chain_encoding_preserves_canonical_digest() -> None:
    previous = "sha256:" + ("1" * 64)
    event = FixtureEvent(event_time_ms=1_234, value=7)
    material = {
        "schema_version": SOURCE_CHAIN_SCHEMA_VERSION,
        "previous": previous,
        "source_sequence": 9,
        "event": source_event_payload(event),
    }

    assert next_source_chain_hash(previous, event, 9) == canonical_sha256(material)


def test_source_chain_falls_back_for_non_json_canonical_values() -> None:
    previous = "sha256:" + ("2" * 64)
    event = {"event_time_ms": 1_234, "price": Decimal("1.2300")}
    material = {
        "schema_version": SOURCE_CHAIN_SCHEMA_VERSION,
        "previous": previous,
        "source_sequence": 10,
        "event": source_event_payload(event),
    }

    assert next_source_chain_hash(previous, event, 10) == canonical_sha256(material)
