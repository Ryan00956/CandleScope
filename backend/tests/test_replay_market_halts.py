from __future__ import annotations

from dataclasses import replace

import pytest

from app.replay.catalog import GapRange, ReplaySeriesIdentity
from app.replay.market_halts import (
    match_verified_market_halt,
    validate_registered_bar_halts,
)


IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")
START_MS = 1_557_889_200_000
RESUME_MS = 1_557_925_200_000


@pytest.mark.parametrize(
    ("interval_ms", "end_open_ms", "missing_bars"),
    [
        (60_000, RESUME_MS - 60_000, 600),
        (300_000, RESUME_MS - 300_000, 120),
        (3_600_000, RESUME_MS - 3_600_000, 10),
    ],
)
def test_registry_matches_only_exact_binance_upgrade_gap(
    interval_ms: int,
    end_open_ms: int,
    missing_bars: int,
) -> None:
    gap = GapRange(
        start_ms=START_MS,
        end_ms=end_open_ms,
        missing_bars=missing_bars,
        reason="replay_archive_gap",
    )

    halt = match_verified_market_halt(IDENTITY, gap, interval_ms=interval_ms)

    assert halt is not None
    assert halt.start_open_ms == START_MS
    assert halt.end_open_ms == end_open_ms
    assert halt.resume_ms == RESUME_MS


def test_registry_rejects_partial_overlap_wrong_market_and_tampered_manifest() -> None:
    exact_gap = GapRange(
        start_ms=START_MS,
        end_ms=RESUME_MS - 60_000,
        missing_bars=600,
        reason="replay_archive_gap",
    )
    assert (
        match_verified_market_halt(
            IDENTITY,
            replace(exact_gap, start_ms=START_MS + 60_000, missing_bars=599),
            interval_ms=60_000,
        )
        is None
    )
    assert (
        match_verified_market_halt(
            ReplaySeriesIdentity("binance", "futures", "BTCUSDT"),
            exact_gap,
            interval_ms=60_000,
        )
        is None
    )

    halt = match_verified_market_halt(IDENTITY, exact_gap, interval_ms=60_000)
    assert halt is not None
    payload = halt.to_dict()
    assert validate_registered_bar_halts(
        [payload],
        identity=IDENTITY,
        interval_ms=60_000,
    ) == (halt,)

    tampered = {**payload, "resume_ms": RESUME_MS + 60_000}
    with pytest.raises(ValueError, match="exact reviewed notice"):
        validate_registered_bar_halts(
            [tampered],
            identity=IDENTITY,
            interval_ms=60_000,
        )
