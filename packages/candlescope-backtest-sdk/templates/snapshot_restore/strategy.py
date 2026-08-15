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
        fast = sum(map(float, self.closes[-self.fast :])) / min(self.fast, len(self.closes))
        slow = sum(map(float, self.closes[-self.slow :])) / min(self.slow, len(self.closes))
        return TargetPosition(quantity="1" if fast >= slow else "0")

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {"closes": list(self.closes), "fast": str(self.fast), "slow": str(self.slow)}

    def restore(self, payload: dict) -> None:
        self.closes = [str(value) for value in payload["closes"]]
        self.fast = int(payload["fast"])
        self.slow = int(payload["slow"])

    def close(self) -> None:
        return None
