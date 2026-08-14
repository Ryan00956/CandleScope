from __future__ import annotations

from tests.backtest_contract.spec import BoundedBarView, ReferenceBarKernel, sample_bars


def _buy_first_bar(view: BoundedBarView) -> list[dict]:
    if view[-1].sequence == 1:
        return [{"side": "BUY", "type": "MARKET", "qty": "1"}]
    return []


def test_same_inputs_produce_identical_hashes() -> None:
    bars = sample_bars()
    first = ReferenceBarKernel().run(bars, _buy_first_bar)
    second = ReferenceBarKernel().run(bars, _buy_first_bar)
    assert first["decision_hash"] == second["decision_hash"]
    assert first["fill_hash"] == second["fill_hash"]
    assert first["ledger_hash"] == second["ledger_hash"]
    assert first["report_hash"] == second["report_hash"]


def test_pause_resume_matches_uninterrupted_run() -> None:
    bars = sample_bars()
    uninterrupted = ReferenceBarKernel().run(bars, _buy_first_bar)

    paused = ReferenceBarKernel()
    paused.run(bars[:2], _buy_first_bar)
    snapshot = paused.snapshot()
    resumed = ReferenceBarKernel()
    resumed.restore(snapshot)
    resumed.run(bars[2:], _buy_first_bar)

    assert resumed.result_hashes()["fill_hash"] == uninterrupted["fill_hash"]
    assert resumed.result_hashes()["ledger_hash"] == uninterrupted["ledger_hash"]
    assert resumed.result_hashes()["report_hash"] == uninterrupted["report_hash"]


def test_changing_slippage_changes_identity_hashes() -> None:
    bars = sample_bars()
    default = ReferenceBarKernel().run(bars, _buy_first_bar)
    wider = ReferenceBarKernel(slippage_bps=2).run(bars, _buy_first_bar)
    assert default["fill_hash"] != wider["fill_hash"]
    assert default["report_hash"] != wider["report_hash"]
