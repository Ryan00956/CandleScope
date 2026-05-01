from app.exchanges.plugin import DefaultSymbolNormalizer


class TemplateSymbolNormalizer(DefaultSymbolNormalizer):
    """Customize if the exchange uses non-trivial symbol formats."""

    def normalize(self, symbol: str, market_type: str = "spot") -> str:
        return super().normalize(symbol, market_type)
