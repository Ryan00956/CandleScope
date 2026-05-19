from __future__ import annotations

from app.data_engine.ingestion.models import DataSource, StreamDescriptor, StreamType, TransportRequest
from app.exchanges.contracts import ExchangeContractCase, NormalizerContractSample


def builtin_exchange_contract_cases() -> dict[str, list[ExchangeContractCase]]:
    """Contract fixtures for built-in exchange plugins."""

    return {
        "binance": [
            ExchangeContractCase(
                descriptor=_descriptor("binance", "BTCUSDT"),
                request=_request("binance", "BTCUSDT"),
                sample_http_payload=[
                    [
                        1_700_000_000_000,
                        "1",
                        "2",
                        "0.5",
                        "1.5",
                        "10",
                        1_700_000_059_999,
                        "15",
                        42,
                        "6",
                        "9",
                        "0",
                    ],
                ],
                expected_http_rows=1,
                normalizer_samples=[
                    NormalizerContractSample(
                        payload=[
                            1_700_000_000_000,
                            "1",
                            "2",
                            "0.5",
                            "1.5",
                            "10",
                            1_700_000_059_999,
                            "15",
                            42,
                            "6",
                            "9",
                            "0",
                        ],
                        source=DataSource.HTTP_BACKFILL,
                        required_data_fields={"quote_volume", "trades"},
                    )
                ],
            )
        ],
        "okx": [
            ExchangeContractCase(
                descriptor=_descriptor("okx", "BTC-USDT"),
                request=_request("okx", "BTC-USDT"),
                sample_http_payload={
                    "code": "0",
                    "data": [
                        [
                            "1700000060000",
                            "1",
                            "2",
                            "0.5",
                            "1.5",
                            "10",
                            "10",
                            "15",
                            "1",
                        ],
                        [
                            "1700000000000",
                            "1",
                            "2",
                            "0.5",
                            "1.5",
                            "10",
                            "10",
                            "15",
                            "1",
                        ],
                    ],
                },
                expected_http_rows=2,
                normalizer_samples=[
                    NormalizerContractSample(
                        payload=[
                            "1700000000000",
                            "1",
                            "2",
                            "0.5",
                            "1.5",
                            "10",
                            "10",
                            "15",
                            "1",
                        ],
                        source=DataSource.HTTP_BACKFILL,
                        required_data_fields={"quote_volume", "trades"},
                    )
                ],
            )
        ],
    }


def _descriptor(exchange: str, symbol: str) -> StreamDescriptor:
    return StreamDescriptor(
        symbol,
        StreamType.KLINE,
        interval="1m",
        exchange=exchange,
        market_type="spot",
    )


def _request(exchange: str, symbol: str) -> TransportRequest:
    return TransportRequest(
        _descriptor(exchange, symbol),
        limit=100,
        start_ms=1_700_000_000_000,
        end_ms=1_700_000_060_000,
    )
