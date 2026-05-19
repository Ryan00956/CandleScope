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
    return report


def assert_exchange_plugin_contract(
    plugin: ExchangePlugin,
    cases: list[ExchangeContractCase],
) -> None:
    """Raise AssertionError with a compact message if the plugin contract fails."""

    report = validate_exchange_plugin_contract(plugin, cases)
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
