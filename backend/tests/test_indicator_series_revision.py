from app.indicator.series_revision import SeriesRevisionRegistry


def test_closed_append_does_not_advance_correction_revision():
    revisions = SeriesRevisionRegistry(server_epoch="test")

    first = revisions.observe_closed("BTCUSDT", "1m", 100)
    second = revisions.observe_closed("BTCUSDT", "1m", 160)

    assert first == {
        "serverEpoch": "test",
        "correctionRevision": 0,
        "closedThrough": 100,
    }
    assert second["correctionRevision"] == 0
    assert second["closedThrough"] == 160


def test_correction_journal_returns_dirty_range_since_client_revision():
    revisions = SeriesRevisionRegistry(server_epoch="test")
    revisions.record_correction("BTCUSDT", "1m", 100, 120, event_id="a")
    revisions.record_correction("BTCUSDT", "1m", 300, 360, event_id="b")

    snapshot = revisions.snapshot(
        "BTCUSDT",
        "1m",
        since_correction_revision=0,
    )

    assert snapshot["correctionRevision"] == 2
    assert snapshot["dirtyRange"] == {"start": 100, "end": 360}


def test_duplicate_event_does_not_advance_revision_twice():
    revisions = SeriesRevisionRegistry(server_epoch="test")

    first = revisions.record_correction("BTCUSDT", "1m", 100, event_id="same")
    second = revisions.record_correction("BTCUSDT", "1m", 100, event_id="same")

    assert first["correctionRevision"] == 1
    assert second["correctionRevision"] == 1


def test_expired_revision_journal_requires_full_validation():
    revisions = SeriesRevisionRegistry(server_epoch="test", journal_limit=1)
    revisions.record_correction("BTCUSDT", "1m", 100)
    revisions.record_correction("BTCUSDT", "1m", 200)

    snapshot = revisions.snapshot(
        "BTCUSDT",
        "1m",
        since_correction_revision=0,
    )

    assert snapshot["historyInvalid"] is True
    assert "dirtyRange" not in snapshot
