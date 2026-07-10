from app.indicator.resume import plan_indicator_resume
from app.api.v1.stream_indicators import _indicator_subscription_revision
from app.indicator.range_result_service import IndicatorRangeResultService
from app.indicator.series_revision import SeriesRevisionRegistry


REVISION = {
    "serverEpoch": "server-a",
    "correctionRevision": 4,
    "closedThrough": 280,
}


def _plan(**overrides):
    values = {
        "resume_from": 100,
        "client_server_epoch": "server-a",
        "client_correction_revision": 4,
        "data_revision": REVISION,
        "closed_bar_times": [100, 160, 220, 280],
        "max_patch_bars": 3,
        "interval_seconds": 60,
    }
    values.update(overrides)
    return plan_indicator_resume(**values)


def test_resume_small_contiguous_gap_uses_ws_patch():
    plan = _plan()

    assert plan.status == "patch"
    assert (plan.start, plan.end, plan.bars) == (160, 280, 3)


def test_resume_with_no_new_closed_bar_is_up_to_date():
    plan = _plan(resume_from=280)

    assert plan.status == "up_to_date"


def test_resume_without_seed_times_requires_history_when_closed_tail_advanced():
    plan = _plan(closed_bar_times=[], resume_from=220)

    assert plan.status == "history_required"
    assert plan.reason == "closed-tail-missing"


def test_resume_revision_mismatch_requires_history():
    plan = _plan(client_correction_revision=3)

    assert plan.status == "history_required"
    assert plan.reason == "correction-revision-mismatch"


def test_resume_large_or_non_contiguous_gap_requires_history():
    assert _plan(max_patch_bars=2).reason == "resume-gap-too-large"
    assert _plan(closed_bar_times=[100, 220]).reason == "resume-gap-not-contiguous"


def test_subscription_revision_returns_dirty_range_since_client_version():
    revisions = SeriesRevisionRegistry(server_epoch="server-a")
    service = IndicatorRangeResultService(revision_registry=revisions)
    meta = {
        "exchange": "binance",
        "market_type": "spot",
        "symbol": "BTCUSDT",
        "interval": "1m",
    }
    service.note_correction(series_key="binance:spot:BTCUSDT:1m", start=120, end=180)

    payload = _indicator_subscription_revision(
        service,
        meta,
        client_server_epoch="server-a",
        client_correction_revision=0,
    )

    assert payload["correctionRevision"] == 1
    assert payload["dirtyRange"] == {"start": 120, "end": 180}


def test_subscription_revision_marks_server_restart_as_history_invalid():
    service = IndicatorRangeResultService(
        revision_registry=SeriesRevisionRegistry(server_epoch="server-new"),
    )

    payload = _indicator_subscription_revision(
        service,
        {"symbol": "BTCUSDT", "interval": "1m"},
        client_server_epoch="server-old",
        client_correction_revision=0,
    )

    assert payload["serverEpoch"] == "server-new"
    assert payload["historyInvalid"] is True
