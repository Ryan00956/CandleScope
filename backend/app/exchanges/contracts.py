from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .plugin import ExchangePlugin


@dataclass(slots=True)
class ExchangeContractCase:
    """One protocol fixture used to validate an exchange plugin contract."""

    descriptor: Any
    request: Any
    sample_http_payload: Any | None = None
    expected_http_rows: int | None = None
    normalizer_samples: list[NormalizerContractSample] = field(default_factory=list)


@dataclass(slots=True)
class NormalizerContractSample:
    """One raw payload sample expected to parse into a MarketEvent."""

    payload: Any
    source: Any
    stream_type: Any | None = None
    received_at_ms: int = 123_456_789
    required_data_fields: set[str] = field(default_factory=set)
    expected_event_type: Any | None = None


@dataclass(slots=True)
class ExchangeContractIssue:
    """A single contract validation issue."""

    code: str
    message: str
    severity: str = "error"

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "severity": self.severity,
        }


@dataclass(slots=True)
class ExchangeContractReport:
    """Contract validation result for one exchange plugin."""

    exchange: str
    cases_checked: int = 0
    issues: list[ExchangeContractIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)

    def add(self, code: str, message: str, *, severity: str = "error") -> None:
        self.issues.append(ExchangeContractIssue(code, message, severity))

    def to_dict(self) -> dict[str, Any]:
        return {
            "exchange": self.exchange,
            "ok": self.ok,
            "cases_checked": self.cases_checked,
            "issues": [issue.to_dict() for issue in self.issues],
        }


def validate_exchange_plugin_contract(
    plugin: ExchangePlugin,
    cases: list[ExchangeContractCase],
    *,
    config: Any | None = None,
) -> ExchangeContractReport:
    """Validate the stable runtime contract expected from an exchange plugin."""

    report = ExchangeContractReport(exchange=getattr(plugin, "id", "unknown"))
    _validate_capabilities(plugin, report)
    _validate_policy_accessors(plugin, report)

    protocol = _safe_call(report, "protocol", plugin.protocol)
    if protocol is None:
        return report

    for case in cases:
        report.cases_checked += 1
        _validate_rest_contract(protocol, case, report)
        _validate_ws_contract(protocol, case, report)
        _validate_pagination_contract(plugin, case, report)
        _validate_normalizer_contract(plugin, case, report, config=config)
    return report


def assert_exchange_plugin_contract(
    plugin: ExchangePlugin,
    cases: list[ExchangeContractCase],
    *,
    config: Any | None = None,
) -> None:
    """Raise AssertionError with a compact message if the plugin contract fails."""

    report = validate_exchange_plugin_contract(plugin, cases, config=config)
    if report.ok:
        return
    lines = [f"{issue.code}: {issue.message}" for issue in report.issues]
    raise AssertionError(f"{plugin.id} exchange plugin contract failed:\n" + "\n".join(lines))


def _validate_capabilities(plugin: ExchangePlugin, report: ExchangeContractReport) -> None:
    capabilities = _safe_call(report, "capabilities", plugin.capabilities)
    if capabilities is None:
        return
    if getattr(capabilities, "exchange", None) != plugin.id:
        report.add(
            "capabilities.exchange_mismatch",
            f"capabilities.exchange={getattr(capabilities, 'exchange', None)!r} "
            f"does not match plugin id {plugin.id!r}",
        )
    if not getattr(capabilities, "name", ""):
        report.add("capabilities.name_missing", "capabilities.name must be non-empty")
    if not getattr(capabilities, "plugin_api_version", ""):
        report.add(
            "capabilities.plugin_api_version_missing",
            "capabilities.plugin_api_version must be non-empty",
        )
    if not getattr(capabilities, "native_intervals", []):
        report.add(
            "capabilities.native_intervals_missing",
            "capabilities.native_intervals should declare supported bar intervals",
            severity="warning",
        )
    if getattr(capabilities, "ws_connection_model", "") not in {
        "path_per_stream",
        "shared_multiplex",
        "message_per_stream",
        "polling_only",
    }:
        report.add(
            "capabilities.ws_connection_model_unknown",
            f"unknown ws_connection_model={getattr(capabilities, 'ws_connection_model', None)!r}",
        )


def _validate_policy_accessors(plugin: ExchangePlugin, report: ExchangeContractReport) -> None:
    _safe_call(report, "symbol_normalizer", plugin.symbol_normalizer)
    _safe_call(report, "rate_limit_policy", plugin.rate_limit_policy)
    _safe_call(report, "pagination_policy", plugin.pagination_policy)
    _safe_call(report, "realtime_policy", plugin.realtime_policy)


def _validate_rest_contract(
    protocol: Any,
    case: ExchangeContractCase,
    report: ExchangeContractReport,
) -> None:
    spec = _safe_call(report, "protocol.rest_request", lambda: protocol.rest_request(case.request))
    if spec is None:
        return
    if not getattr(spec, "base_urls", None):
        report.add("rest.base_urls_empty", "REST request spec must include base_urls")
    if not str(getattr(spec, "path", "")).startswith("/"):
        report.add("rest.path_invalid", f"REST path must start with /, got {getattr(spec, 'path', None)!r}")
    if not isinstance(getattr(spec, "params", None), dict):
        report.add("rest.params_invalid", "REST params must be a dict")
    if str(getattr(spec, "method", "GET")).upper() != getattr(spec, "method", "GET"):
        report.add("rest.method_not_uppercase", "REST method should be uppercase", severity="warning")

    if case.sample_http_payload is None:
        return
    rows = _safe_call(
        report,
        "protocol.extract_http_rows",
        lambda: protocol.extract_http_rows(case.sample_http_payload, case.descriptor),
    )
    if rows is None:
        return
    if not isinstance(rows, list):
        report.add("rest.rows_not_list", "extract_http_rows must return a list")
        return
    if case.expected_http_rows is not None and len(rows) != case.expected_http_rows:
        report.add(
            "rest.rows_count_mismatch",
            f"expected {case.expected_http_rows} HTTP rows, got {len(rows)}",
        )


def _validate_ws_contract(
    protocol: Any,
    case: ExchangeContractCase,
    report: ExchangeContractReport,
) -> None:
    spec = _safe_call(
        report,
        "protocol.ws_connection",
        lambda: protocol.ws_connection(case.descriptor),
    )
    if spec is None:
        return
    if not getattr(spec, "base_urls", None):
        report.add("ws.base_urls_empty", "WS connection spec must include base_urls")
    subscription = getattr(spec, "subscription", None)
    if subscription is None:
        report.add("ws.subscription_missing", "WS connection spec must include a subscription")
        return
    stream_name = getattr(subscription, "stream_name", None)
    payload = getattr(subscription, "subscribe_payload", None)
    if not stream_name and not payload:
        report.add(
            "ws.subscription_empty",
            "WS subscription must include either stream_name or subscribe_payload",
        )


def _validate_pagination_contract(
    plugin: ExchangePlugin,
    case: ExchangeContractCase,
    report: ExchangeContractReport,
) -> None:
    from app.data_engine.backfill.models import BackfillTask

    policy = _safe_call(report, "pagination_policy", plugin.pagination_policy)
    if policy is None:
        return
    task = BackfillTask(
        symbol=case.descriptor.symbol,
        interval=case.descriptor.interval or "1m",
        start_ms=1_700_000_000_000,
        end_ms=1_700_000_060_000,
        exchange=case.descriptor.exchange,
        market_type=case.descriptor.market_type,
    )
    first = _safe_call(
        report,
        "pagination_policy.first_request",
        lambda: policy.first_request(task, batch_size=100, now_ms=1_700_000_120_000),
    )
    if first is None:
        return
    if getattr(first, "descriptor", None) is None:
        report.add("pagination.descriptor_missing", "first_request must return a TransportRequest")
    elif first.descriptor.exchange != plugin.id:
        report.add(
            "pagination.exchange_mismatch",
            f"pagination request exchange {first.descriptor.exchange!r} does not match plugin id",
        )


def _validate_normalizer_contract(
    plugin: ExchangePlugin,
    case: ExchangeContractCase,
    report: ExchangeContractReport,
    *,
    config: Any | None,
) -> None:
    if not case.normalizer_samples:
        return

    from app.data_engine.ingestion.config import IngestionConfig
    from app.data_engine.ingestion.models import MarketEvent, RawMessage

    normalizer = _safe_call(
        report,
        "plugin.normalizer",
        lambda: plugin.normalizer(config or IngestionConfig(), case.descriptor),
    )
    if normalizer is None:
        return

    for sample in case.normalizer_samples:
        stream_type = sample.stream_type or case.descriptor.stream_type
        expected_event_type = sample.expected_event_type or stream_type
        raw = RawMessage(
            payload=sample.payload,
            source=sample.source,
            stream_type=stream_type,
            received_at_ms=sample.received_at_ms,
        )
        event = _safe_call(report, "normalizer.parse", lambda: normalizer.parse(raw))
        if event is None:
            report.add(
                "normalizer.no_event",
                f"normalizer returned no event for {stream_type!r}",
            )
            continue
        if not isinstance(event, MarketEvent):
            report.add(
                "normalizer.event_type_invalid",
                f"normalizer returned {type(event).__name__}, expected MarketEvent",
            )
            continue
        _validate_market_event_shape(event, expected_event_type, sample, report)


def _validate_market_event_shape(
    event: Any,
    expected_event_type: Any,
    sample: NormalizerContractSample,
    report: ExchangeContractReport,
) -> None:
    from app.data_engine.ingestion.models import StreamType

    if event.event_type != expected_event_type:
        report.add(
            "normalizer.event_type_mismatch",
            f"expected event_type {expected_event_type!r}, got {event.event_type!r}",
        )
    if not event.symbol:
        report.add("normalizer.symbol_missing", "MarketEvent.symbol must be non-empty")
    if not event.exchange:
        report.add("normalizer.exchange_missing", "MarketEvent.exchange must be non-empty")
    if not isinstance(event.event_time_ms, int):
        report.add("normalizer.event_time_invalid", "MarketEvent.event_time_ms must be int")
    if event.received_at_ms != sample.received_at_ms:
        report.add(
            "normalizer.received_at_mismatch",
            f"expected received_at_ms {sample.received_at_ms}, got {event.received_at_ms}",
        )
    if not isinstance(event.data, dict):
        report.add("normalizer.data_invalid", "MarketEvent.data must be a dict")
        return

    required = set(sample.required_data_fields)
    required.update(_schema_required_fields(event.event_type, event.data))
    missing = sorted(field for field in required if field not in event.data)
    if missing:
        report.add(
            "normalizer.data_fields_missing",
            f"missing required data fields for {event.event_type!r}: {', '.join(missing)}",
        )

    if event.event_type == StreamType.KLINE:
        open_time = event.data.get("open_time")
        close_time = event.data.get("close_time")
        if not isinstance(open_time, int) or not isinstance(close_time, int):
            report.add(
                "normalizer.kline_time_invalid",
                "kline open_time and close_time must be integers",
            )
        elif close_time < open_time:
            report.add(
                "normalizer.kline_time_order",
                "kline close_time must be greater than or equal to open_time",
            )


def _schema_required_fields(stream_type: Any, data: dict[str, Any]) -> set[str]:
    from app.data_engine.ingestion.models import StreamType

    if stream_type == StreamType.KLINE:
        return {
            "interval",
            "open_time",
            "close_time",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "is_closed",
        }
    if stream_type == StreamType.AGG_TRADE:
        return {
            "agg_trade_id",
            "price",
            "quantity",
            "first_trade_id",
            "last_trade_id",
            "trade_time_ms",
        }
    if stream_type == StreamType.TRADE:
        return {"trade_id", "price", "quantity", "trade_time_ms"}
    if stream_type in (StreamType.TICKER, StreamType.MINI_TICKER):
        required = {"open_price", "high_price", "low_price", "volume"}
        if "last_price" in data:
            required.add("last_price")
        else:
            required.add("close_price")
        return required
    if stream_type == StreamType.DEPTH:
        return {"bids", "asks"}
    return set()


def _safe_call(
    report: ExchangeContractReport,
    code: str,
    callback,
) -> Any | None:
    try:
        return callback()
    except Exception as exc:
        report.add(code, str(exc))
        return None
