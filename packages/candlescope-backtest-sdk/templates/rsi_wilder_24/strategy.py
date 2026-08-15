from candlescope_backtest_sdk import Observation, Signal, StrategyContext


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.length = int(context.parameters["length"])
        self.oversold = float(context.parameters["oversold"])
        self.overbought = float(context.parameters["overbought"])
        self.prev_close: float | None = None
        self.avg_gain: float | None = None
        self.avg_loss: float | None = None
        self.seed_gains: list[float] = []
        self.seed_losses: list[float] = []

    def _update(self, close: float) -> float | None:
        if self.prev_close is None:
            self.prev_close = close
            return None
        change = close - self.prev_close
        self.prev_close = close
        gain = change if change > 0 else 0.0
        loss = -change if change < 0 else 0.0
        if self.avg_gain is None:
            self.seed_gains.append(gain)
            self.seed_losses.append(loss)
            if len(self.seed_gains) < self.length:
                return None
            self.avg_gain = sum(self.seed_gains) / self.length
            self.avg_loss = sum(self.seed_losses) / self.length
        else:
            self.avg_gain = (self.avg_gain * (self.length - 1) + gain) / self.length
            self.avg_loss = (self.avg_loss * (self.length - 1) + loss) / self.length
        if self.avg_loss == 0:
            return 100.0
        return 100.0 - (100.0 / (1.0 + self.avg_gain / self.avg_loss))

    def warmup(self, observation: Observation) -> None:
        self._update(float(observation.bar.close))

    def step(self, observation: Observation) -> Signal | None:
        rsi = self._update(float(observation.bar.close))
        if rsi is None:
            return None
        if rsi <= self.oversold:
            return Signal(direction="LONG", score=str(rsi), confidence="1", horizon="1")
        if rsi >= self.overbought:
            return Signal(direction="SHORT", score=str(rsi), confidence="1", horizon="1")
        return None

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {
            "prev_close": None if self.prev_close is None else str(self.prev_close),
            "avg_gain": None if self.avg_gain is None else str(self.avg_gain),
            "avg_loss": None if self.avg_loss is None else str(self.avg_loss),
            "seed_gains": [str(value) for value in self.seed_gains],
            "seed_losses": [str(value) for value in self.seed_losses],
        }

    def restore(self, payload: dict) -> None:
        self.prev_close = None if payload["prev_close"] is None else float(payload["prev_close"])
        self.avg_gain = None if payload["avg_gain"] is None else float(payload["avg_gain"])
        self.avg_loss = None if payload["avg_loss"] is None else float(payload["avg_loss"])
        self.seed_gains = [float(value) for value in payload["seed_gains"]]
        self.seed_losses = [float(value) for value in payload["seed_losses"]]

    def close(self) -> None:
        return None
