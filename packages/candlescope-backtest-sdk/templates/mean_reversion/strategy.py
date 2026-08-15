from candlescope_backtest_sdk import Observation, StrategyContext, TargetPosition


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.lookback = int(context.parameters["lookback"])
        self.band = float(context.parameters["band"])
        self.closes: list[float] = []

    def warmup(self, observation: Observation) -> None:
        self.closes.append(float(observation.bar.close))

    def step(self, observation: Observation) -> TargetPosition:
        close = float(observation.bar.close)
        self.closes.append(close)
        window = self.closes[-self.lookback :]
        mean = sum(window) / len(window)
        if close < mean - self.band:
            return TargetPosition(quantity="1")
        if close > mean + self.band:
            return TargetPosition(quantity="-1")
        return TargetPosition(quantity="0")

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {"closes": [str(value) for value in self.closes]}

    def restore(self, payload: dict) -> None:
        self.closes = [float(value) for value in payload["closes"]]

    def close(self) -> None:
        return None
