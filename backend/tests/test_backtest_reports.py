from __future__ import annotations

from app.backtest.reports import build_report, export_bundle


def test_bar_report_always_labels_approximate_and_lists_limits() -> None:
    report = build_report(
        {
            "run_id": "bt_1",
            "state": "COMPLETED",
            "fidelity_mode": "BAR_APPROX",
            "source_event_kind": "BAR",
            "strategy_revision_id": "rev",
            "dataset_id": "ds",
            "data_epoch": "sha256:aa",
            "snapshot_hash": "sha256:bb",
            "config_hash": "sha256:cc",
            "engine_version": "backtest.engine.control-plane.v1",
        },
        {"fills": [{"order_id": "ord-1", "sequence": 2, "price": "1", "qty": "1", "reason": "NEXT_BAR_OPEN"}],
         "ambiguity_count": 1,
         "report_hash": "sha256:dd"},
    )
    assert report["report_label"] == "APPROXIMATE"
    assert "queue-exact fills" in report["not_suitable_for"]
    bundle = export_bundle({"run_id": "bt_1", "fidelity_mode": "BAR_APPROX", "source_event_kind": "BAR"}, report)
    assert bundle["manifest"]["reportLabel"] == "APPROXIMATE"
    assert "ord-1" in bundle["csv"]
