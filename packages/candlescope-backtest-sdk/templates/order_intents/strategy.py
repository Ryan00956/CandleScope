from candlescope_backtest_sdk import Observation, OrderIntent, StrategyContext


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.seen = 0

    def warmup(self, observation: Observation) -> None:
        return None

    def step(self, observation: Observation) -> OrderIntent:
        self.seen += 1
        close = observation.bar.close
        kind = ("MARKET", "LIMIT", "STOP", "STOP_LIMIT")[(self.seen - 1) % 4]
        if kind == "MARKET":
            return OrderIntent(side="BUY", type="MARKET", quantity="1", client_tag="mkt")
        if kind == "LIMIT":
            return OrderIntent(
                side="BUY", type="LIMIT", quantity="1", limit_price=close, client_tag="lmt"
            )
        if kind == "STOP":
            return OrderIntent(
                side="SELL", type="STOP", quantity="1", stop_price=close, client_tag="stp"
            )
        return OrderIntent(
            side="SELL",
            type="STOP_LIMIT",
            quantity="1",
            limit_price=close,
            stop_price=close,
            client_tag="stl",
        )

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {"seen": str(self.seen)}

    def restore(self, payload: dict) -> None:
        self.seen = int(payload["seen"])

    def close(self) -> None:
        return None
