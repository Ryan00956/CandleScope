from candlescope_backtest_sdk import Observation, StrategyContext, TargetPosition


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.fast = int(context.parameters["fast"])
        self.slow = int(context.parameters["slow"])
        self.closes: list[str] = []

    def warmup(self, observation: Observation) -> None:
        self.closes.append(observation.bar.close)

    def step(self, observation: Observation) -> TargetPosition:
        self.closes.append(observation.bar.close)
        fast = sum(map(float, self.closes[-self.fast :])) / self.fast
        slow = sum(map(float, self.closes[-self.slow :])) / self.slow
        return TargetPosition(quantity="1" if fast > slow else "-1")

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {"closes": list(self.closes)}

    def restore(self, payload: dict) -> None:
        self.closes = [str(value) for value in payload["closes"]]

    def close(self) -> None:
        return None
