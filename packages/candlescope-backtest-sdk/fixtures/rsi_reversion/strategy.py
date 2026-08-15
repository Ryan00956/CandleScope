from candlescope_backtest_sdk import Observation, Signal, StrategyContext


class Strategy:
    def prepare(self, context: StrategyContext) -> None:
        self.length = int(context.parameters["length"])
        self.oversold = float(context.parameters["oversold"])
        self.overbought = float(context.parameters["overbought"])
        self.closes: list[float] = []

    def warmup(self, observation: Observation) -> None:
        self.closes.append(float(observation.bar.close))

    def step(self, observation: Observation) -> Signal | None:
        self.closes.append(float(observation.bar.close))
        if len(self.closes) <= self.length:
            return None
        window = self.closes[-self.length - 1 :]
        gains = 0.0
        losses = 0.0
        for previous, current in zip(window, window[1:]):
            change = current - previous
            if change >= 0:
                gains += change
            else:
                losses -= change
        average_gain = gains / self.length
        average_loss = losses / self.length
        if average_loss == 0:
            rsi = 100.0
        else:
            rsi = 100.0 - (100.0 / (1.0 + average_gain / average_loss))
        if rsi <= self.oversold:
            return Signal(direction="LONG", score=str(rsi), confidence="1", horizon="1")
        if rsi >= self.overbought:
            return Signal(direction="SHORT", score=str(rsi), confidence="1", horizon="1")
        return None

    def on_execution_report(self, report) -> None:
        return None

    def snapshot(self) -> dict:
        return {"closes": [str(value) for value in self.closes]}

    def restore(self, payload: dict) -> None:
        self.closes = [float(value) for value in payload["closes"]]

    def close(self) -> None:
        return None
