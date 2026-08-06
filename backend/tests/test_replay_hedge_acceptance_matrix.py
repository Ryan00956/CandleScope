from scripts.verify_replay_hedge_acceptance import validate_matrix


def test_hedge_exchange_parity_acceptance_matrix_is_complete() -> None:
    result = validate_matrix()
    assert result["passed"] is True
    assert result["scenario_count"] == 22
    assert [item["id"] for item in result["scenarios"]] == list(range(1, 23))
