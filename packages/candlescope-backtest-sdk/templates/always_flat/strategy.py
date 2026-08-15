from candlescope_backtest_sdk import Observation, StrategyContext, TargetPosition


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        return None

    def warmup(self, observation: Observation) -> None:
        return None

    def step(self, observation: Observation) -> TargetPosition:
        return TargetPosition(quantity="0")

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {}

    def restore(self, payload: dict) -> None:
        return None

    def close(self) -> None:
        return None
