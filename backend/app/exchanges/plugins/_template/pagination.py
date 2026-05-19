from __future__ import annotations

from app.exchanges.pagination import ReverseTimePaginationPolicy


class TemplateHistoricalPaginationPolicy(ReverseTimePaginationPolicy):
    """Override when the exchange does not use inclusive reverse-time windows."""
