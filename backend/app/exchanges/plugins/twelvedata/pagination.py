from app.exchanges.pagination import ReverseTimePaginationPolicy


class TwelveDataHistoricalPaginationPolicy(ReverseTimePaginationPolicy):
    """Twelve Data returns the newest outputsize rows inside a bounded range."""


__all__ = ["TwelveDataHistoricalPaginationPolicy"]
