from candlescope_backtest_sdk import Observation, StrategyContext, TargetPosition


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.lookback = int(context.parameters["lookback"])
        self.highs: list[float] = []
        self.lows: list[float] = []

    def warmup(self, observation: Observation) -> None:
        self.highs.append(float(observation.bar.high))
        self.lows.append(float(observation.bar.low))

    def step(self, observation: Observation) -> TargetPosition:
        close = float(observation.bar.close)
        window_high = max(self.highs[-self.lookback :]) if self.highs else close
        window_low = min(self.lows[-self.lookback :]) if self.lows else close
        self.highs.append(float(observation.bar.high))
        self.lows.append(float(observation.bar.low))
        if close > window_high:
            return TargetPosition(quantity="1")
        if close < window_low:
            return TargetPosition(quantity="-1")
        return TargetPosition(quantity="0")

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {
            "highs": [str(value) for value in self.highs],
            "lows": [str(value) for value in self.lows],
        }

    def restore(self, payload: dict) -> None:
        self.highs = [float(value) for value in payload["highs"]]
        self.lows = [float(value) for value in payload["lows"]]

    def close(self) -> None:
        return None
