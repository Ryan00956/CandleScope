from __future__ import annotations

from dataclasses import replace

import pytest

from app.replay.catalog import GapRange, ReplaySeriesIdentity
from app.replay.market_halts import (
    BINANCE_KLINE_BOUNDARY_SOURCE,
    DEFAULT_VERIFIED_MARKET_HALTS,
    MAINTENANCE_COMPLETION,
    MAINTENANCE_NOTICE,
    OFFICIAL_KLINES_BOUNDARY,
    REPLAY_BAR_HALT_SCHEMA_VERSION,
    ReplayBarHalt,
    match_verified_market_halt,
    validate_registered_bar_halts,
)


IDENTITY = ReplaySeriesIdentity("binance", "spot", "BTCUSDT")
START_MS = 1_557_889_200_000
RESUME_MS = 1_557_925_200_000

# Exact gaps after the eight real same-bucket early-close rows have been
# restored. The 2019-05 upgrade remains covered by the original registry case.
POST_NORMALIZATION_GAPS = (
    ("binance-system-maintenance-2019-06-07", 1_559_942_040_000, 1_559_945_700_000, 61),
    ("binance-system-upgrade-2019-08-15", 1_565_834_400_000, 1_565_863_200_000, 480),
    ("binance-system-upgrade-2019-11-13", 1_573_610_400_000, 1_573_618_800_000, 140),
    (
        "binance-temporary-maintenance-2019-11-13",
        1_573_623_000_000,
        1_573_623_180_000,
        3,
    ),
    ("binance-system-upgrade-2019-11-25", 1_574_647_200_000, 1_574_654_400_000, 120),
    ("binance-system-maintenance-2020-02-09", 1_581_213_600_000, 1_581_217_200_000, 60),
    (
        "binance-system-maintenance-2020-02-19",
        1_582_112_160_000,
        1_582_133_400_000,
        354,
    ),
    (
        "binance-system-maintenance-2020-03-04",
        1_583_313_720_000,
        1_583_321_400_000,
        128,
    ),
    ("binance-system-upgrade-2020-04-25", 1_587_780_000_000, 1_587_789_000_000, 150),
    (
        "binance-spot-system-upgrade-2020-06-28",
        1_593_309_600_000,
        1_593_322_200_000,
        210,
    ),
    ("binance-system-upgrade-2020-11-30", 1_606_716_000_000, 1_606_719_600_000, 60),
    (
        "binance-temporary-maintenance-2020-12-21",
        1_608_559_740_000,
        1_608_573_600_000,
        231,
    ),
    ("binance-system-upgrade-2020-12-25", 1_608_861_600_000, 1_608_865_200_000, 60),
    ("binance-system-maintenance-2021-02-11", 1_613_014_860_000, 1_613_019_600_000, 79),
    ("binance-system-upgrade-2021-03-06", 1_614_996_000_000, 1_615_001_400_000, 90),
    ("binance-system-upgrade-2021-04-20", 1_618_884_000_000, 1_618_893_000_000, 150),
    (
        "binance-temporary-maintenance-2021-04-25",
        1_619_323_260_000,
        1_619_340_300_000,
        284,
    ),
    (
        "binance-system-maintenance-2021-08-13",
        1_628_820_000_000,
        1_628_836_200_000,
        270,
    ),
    (
        "binance-system-maintenance-2021-09-29",
        1_632_898_800_000,
        1_632_906_000_000,
        120,
    ),
    (
        "binance-spot-temporary-maintenance-2023-03-24",
        1_679_661_600_000,
        1_679_666_400_000,
        80,
    ),
)

RESTORED_PARTIAL_BAR_OPENS = (
    1_559_941_980_000,
    1_582_112_100_000,
    1_583_313_660_000,
    1_613_014_800_000,
    1_619_323_200_000,
    1_628_819_940_000,
    1_640_321_940_000,
    1_679_661_540_000,
)


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
    assert halt.boundary_source == BINANCE_KLINE_BOUNDARY_SOURCE


def test_registry_covers_all_twenty_post_normalization_maintenance_gaps() -> None:
    assert len(DEFAULT_VERIFIED_MARKET_HALTS) == len(POST_NORMALIZATION_GAPS) + 1
    assert tuple(item.start_ms for item in DEFAULT_VERIFIED_MARKET_HALTS) == tuple(
        sorted(item.start_ms for item in DEFAULT_VERIFIED_MARKET_HALTS)
    )

    for halt_id, start_ms, resume_ms, missing_bars in POST_NORMALIZATION_GAPS:
        gap = GapRange(
            start_ms=start_ms,
            end_ms=resume_ms - 60_000,
            missing_bars=missing_bars,
            reason="replay_archive_gap",
        )

        halt = match_verified_market_halt(IDENTITY, gap, interval_ms=60_000)

        assert halt is not None
        assert halt.halt_id == halt_id
        assert halt.boundary_source == BINANCE_KLINE_BOUNDARY_SOURCE
        roles = {item.role for item in halt.evidence}
        assert OFFICIAL_KLINES_BOUNDARY in roles
        assert roles & {MAINTENANCE_NOTICE, MAINTENANCE_COMPLETION}
        boundary = next(
            item for item in halt.evidence if item.role == OFFICIAL_KLINES_BOUNDARY
        )
        assert f"startTime={start_ms - 60_000}" in boundary.url
        assert f"endTime={resume_ms}" in boundary.url

    numeric_notice = DEFAULT_VERIFIED_MARKET_HALTS[1].evidence[0]
    assert numeric_notice.url == (
        "https://www.binance.com/en/support/articles/360029308091"
    )
    hashed_notice = next(
        item
        for item in DEFAULT_VERIFIED_MARKET_HALTS
        if item.halt_id == "binance-spot-system-upgrade-2020-06-28"
    ).evidence[0]
    assert hashed_notice.url == (
        "https://www.binance.com/en/support/announcement/"
        "a9d34695cd9345c7a648a882fcd3bcc0"
    )


def test_registry_does_not_swallow_restored_partial_bars_or_removed_gap() -> None:
    for open_time_ms in RESTORED_PARTIAL_BAR_OPENS:
        assert not any(
            notice.start_ms <= open_time_ms < notice.resume_ms
            for notice in DEFAULT_VERIFIED_MARKET_HALTS
        )

    # The real 2019-06-07 21:13 bar has an early same-bucket close_time. The
    # maintenance waiver begins at 21:14 only, after that bar is normalized.
    including_real_partial = GapRange(
        start_ms=1_559_941_980_000,
        end_ms=1_559_945_640_000,
        missing_bars=62,
        reason="replay_archive_gap",
    )
    assert (
        match_verified_market_halt(
            IDENTITY,
            including_real_partial,
            interval_ms=60_000,
        )
        is None
    )

    # 2021-12-24 04:59 is also a real partial bar. Restoring it removes the
    # one-minute catalog gap completely, so no waiver may exist for it.
    restored_single_bar = GapRange(
        start_ms=1_640_321_940_000,
        end_ms=1_640_321_940_000,
        missing_bars=1,
        reason="replay_archive_gap",
    )
    assert (
        match_verified_market_halt(
            IDENTITY,
            restored_single_bar,
            interval_ms=60_000,
        )
        is None
    )


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
    assert (
        match_verified_market_halt(
            ReplaySeriesIdentity("binance", "spot", "ETHUSDT"),
            exact_gap,
            interval_ms=60_000,
        )
        is None
    )

    halt = match_verified_market_halt(IDENTITY, exact_gap, interval_ms=60_000)
    assert halt is not None
    payload = halt.to_dict()
    assert payload["schema_version"] == REPLAY_BAR_HALT_SCHEMA_VERSION
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

    tampered_evidence = {
        **payload,
        "evidence": [
            *payload["evidence"][:-1],
            {
                "role": OFFICIAL_KLINES_BOUNDARY,
                "url": "https://api.binance.com/api/v3/klines?tampered=true",
            },
        ],
    }
    with pytest.raises(ValueError, match="exact reviewed notice"):
        validate_registered_bar_halts(
            [tampered_evidence],
            identity=IDENTITY,
            interval_ms=60_000,
        )


def test_retired_halt_v1_payload_is_rejected() -> None:
    retired = {
        "schema_version": "replay-bar-halt.v1",
        "halt_id": "binance-system-upgrade-2019-05-15",
        "start_open_ms": START_MS,
        "end_open_ms": RESUME_MS - 60_000,
        "resume_ms": RESUME_MS,
        "reason": "exchange_scheduled_system_upgrade",
        "evidence_url": "https://example.com/retired-single-evidence",
    }

    with pytest.raises(ValueError, match="fields do not match"):
        ReplayBarHalt.from_dict(retired)
