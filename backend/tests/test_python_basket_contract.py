from __future__ import annotations

import pytest

from app.backtest.strategy.python_basket import basket_identities, refuse_portfolio_sum
from app.core.config import load_backtest_settings
from pathlib import Path


def test_basket_keeps_independent_accounts_and_refuses_sum(tmp_path: Path) -> None:
    items = basket_identities(["BTCUSDT", "ETHUSDT"], {"revision": "rev"})
    assert items[0]["independentAccount"] is True
    assert items[0]["symbol"] != items[1]["symbol"]
    with pytest.raises(ValueError, match="must not be summed"):
        refuse_portfolio_sum([{"hash": "a"}, {"hash": "b"}])
    settings = load_backtest_settings(
        {},
        data_dir=tmp_path,
        klines_db_path=tmp_path / "k.db",
        replay_db_path=tmp_path / "r.db",
    )
    assert settings.multi_market_enabled is False
