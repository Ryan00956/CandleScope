from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.data_engine.market_data import DeliveryClass, MarketChannel, TransportMode

from .plugin import ExchangePlugin


_CONNECTION_MODELS = {
    "path_per_stream",
    "shared_multiplex",
    "message_per_stream",
    "polling_only",
}
_SEQUENCE_MODES = {
    "none",
    "timestamp",
    "monotonic_id",
    "range",
    "previous_link",
    "checksum",
}
_RESYNC_MODES = {
    "none",
    "replace_snapshot",
    "snapshot_replay",
}
_DELIVERY_CLASSES = {item.value for item in DeliveryClass}
_MARKET_CHANNELS = {item.value for item in MarketChannel}
_TRANSPORT_MODES = {item.value for item in TransportMode}
_SUPPORTED_CAPABILITY_SCHEMA_VERSION = 2


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
    capabilities = _validate_capabilities(plugin, report)
    _validate_policy_accessors(plugin, report)

    protocol = _safe_call(report, "protocol", plugin.protocol)
    if protocol is None:
        return report

    for case in cases:
        report.cases_checked += 1
        channel_capability = _capability_for_descriptor(capabilities, case.descriptor)
        if channel_capability is None:
            # Preserve the schema-v1 harness, whose transport support is not
            # expressed as a per-channel matrix.
            _validate_rest_contract(protocol, case, report)
            _validate_ws_contract(
                protocol,
                case,
                report,
                capabilities=capabilities,
            )
            _validate_pagination_contract(plugin, case, report)
        else:
            realtime_transports = {
                _enum_value(value)
                for value in getattr(channel_capability, "realtime_transports", ()) or ()
            }
            history_transports = {
                _enum_value(value)
                for value in getattr(channel_capability, "history_transports", ()) or ()
            }
            declared_transports = realtime_transports | history_transports
            if declared_transports & {
                TransportMode.REST_POLL.value,
                TransportMode.REST_SNAPSHOT.value,
                TransportMode.REST_HISTORY.value,
            }:
                _validate_rest_contract(protocol, case, report)
            if TransportMode.WEBSOCKET.value in realtime_transports:
                _validate_ws_contract(
                    protocol,
                    case,
                    report,
                    capabilities=capabilities,
                )
            if TransportMode.REST_HISTORY.value in history_transports:
                _validate_pagination_contract(plugin, case, report)
        _validate_normalizer_contract(plugin, case, report, config=config)
    if capabilities is not None:
        _validate_declared_channel_coverage(capabilities, cases, report)
    return report


def validate_exchange_capabilities(
    capabilities: Any,
    *,
    plugin_id: str | None = None,
) -> ExchangeContractReport:
    """Validate one capability document without invoking the full plugin.

    Registry admission and the executable plugin contract intentionally share
    this validator so schema v2 cannot be accepted by one boundary and rejected
    by another.  Schema v1 keeps its legacy meaning: an absent/empty channel
    list is unknown support, not an authoritative denial.
    """

    exchange = str(plugin_id or getattr(capabilities, "exchange", "unknown"))
    report = ExchangeContractReport(exchange=exchange)
    _validate_capability_values(capabilities, report, plugin_id=plugin_id)
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


def _validate_capabilities(
    plugin: ExchangePlugin,
    report: ExchangeContractReport,
) -> Any | None:
    capabilities = _safe_call(report, "capabilities", plugin.capabilities)
    if capabilities is None:
        return None
    _validate_capability_values(capabilities, report, plugin_id=plugin.id)
    return capabilities


def _validate_capability_values(
    capabilities: Any,
    report: ExchangeContractReport,
    *,
    plugin_id: str | None,
) -> None:
    if plugin_id is not None and getattr(capabilities, "exchange", None) != plugin_id:
        report.add(
            "capabilities.exchange_mismatch",
            f"capabilities.exchange={getattr(capabilities, 'exchange', None)!r} "
            f"does not match plugin id {plugin_id!r}",
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
    if getattr(capabilities, "ws_connection_model", "") not in _CONNECTION_MODELS:
        report.add(
            "capabilities.ws_connection_model_unknown",
            f"unknown ws_connection_model={getattr(capabilities, 'ws_connection_model', None)!r}",
        )
    schema_version = getattr(capabilities, "capability_schema_version", 1)
    if isinstance(schema_version, bool) or not isinstance(schema_version, int):
        report.add(
            "capabilities.schema_version_invalid",
            "capability_schema_version must be a non-boolean integer",
        )
        return
    if schema_version < 1:
        report.add(
            "capabilities.schema_version_invalid",
            "capability_schema_version must be at least 1",
        )
        return
    if schema_version > _SUPPORTED_CAPABILITY_SCHEMA_VERSION:
        report.add(
            "capabilities.schema_version_unsupported",
            f"capability schema {schema_version} is newer than supported "
            f"version {_SUPPORTED_CAPABILITY_SCHEMA_VERSION}",
        )
        return
    if schema_version >= 2:
        _validate_channel_capabilities(capabilities, report)


def _validate_channel_capabilities(
    capabilities: Any,
    report: ExchangeContractReport,
) -> None:
    raw_channels = getattr(capabilities, "channels", ()) or ()
    if isinstance(raw_channels, (str, bytes, dict)):
        report.add(
            "capabilities.channels_invalid",
            "capability schema v2 channels must be a list or tuple",
        )
        return
    try:
        channels = list(raw_channels)
    except TypeError:
        report.add(
            "capabilities.channels_invalid",
            "capability schema v2 channels must be iterable",
        )
        return
    if not channels:
        report.add(
            "capabilities.channels_missing",
            "capability schema v2 requires at least one channel declaration",
        )
        return

    raw_markets = getattr(capabilities, "markets", ()) or ()
    try:
        advertised_markets = {
            str(getattr(market, "market_type", "")).strip().lower()
            for market in raw_markets
            if str(getattr(market, "market_type", "")).strip()
        }
    except TypeError:
        advertised_markets = set()
        report.add(
            "capabilities.markets_invalid",
            "capability schema v2 markets must be iterable",
        )
    seen: set[tuple[str, str]] = set()

    for item in channels:
        channel = _enum_value(getattr(item, "channel", None))
        if channel not in _MARKET_CHANNELS:
            report.add(
                "capabilities.channel_invalid",
                f"channel capability must declare a canonical MarketChannel, got {channel!r}",
            )
            continue

        raw_market_types = getattr(item, "market_types", ()) or ()
        if isinstance(raw_market_types, (str, bytes)):
            market_types: tuple[Any, ...] = ()
        else:
            try:
                market_types = tuple(raw_market_types)
            except TypeError:
                market_types = ()
        if not market_types:
            report.add(
                "capabilities.channel_markets_missing",
                f"channel {channel!r} must declare at least one market_type",
            )

        for market_type in market_types:
            canonical_market = str(market_type).strip().lower()
            if canonical_market not in advertised_markets:
                report.add(
                    "capabilities.channel_market_unknown",
                    f"channel {channel!r} references unadvertised market {canonical_market!r}",
                )
            identity = (canonical_market, channel)
            if identity in seen:
                report.add(
                    "capabilities.channel_duplicate",
                    f"duplicate capability for market/channel {identity!r}",
                )
            seen.add(identity)

        realtime_value = getattr(item, "realtime", False)
        history_value = getattr(item, "history", False)
        if not isinstance(realtime_value, bool) or not isinstance(history_value, bool):
            report.add(
                "capabilities.channel_availability_invalid",
                f"channel {channel!r} realtime/history flags must be booleans",
            )
        realtime = realtime_value is True
        history = history_value is True
        if not realtime and not history:
            report.add(
                "capabilities.channel_unavailable",
                f"channel {channel!r} must support realtime or history delivery",
            )
        try:
            realtime_transports = tuple(
                getattr(item, "realtime_transports", ()) or (),
            )
            history_transports = tuple(
                getattr(item, "history_transports", ()) or (),
            )
        except TypeError:
            realtime_transports = ()
            history_transports = ()
            report.add(
                "capabilities.transports_invalid",
                f"channel {channel!r} transports must be iterable",
            )
        realtime_transport_values = tuple(_enum_value(value) for value in realtime_transports)
        history_transport_values = tuple(_enum_value(value) for value in history_transports)
        invalid_transports = sorted(
            {
                value
                for value in (*realtime_transport_values, *history_transport_values)
                if value not in _TRANSPORT_MODES
            },
            key=lambda value: repr(value),
        )
        if invalid_transports:
            report.add(
                "capabilities.transport_unknown",
                f"channel {channel!r} has unknown transports: {invalid_transports}",
            )
        if realtime and not realtime_transports:
            report.add(
                "capabilities.realtime_transport_missing",
                f"realtime channel {channel!r} must declare a transport",
            )
        if not realtime and realtime_transports:
            report.add(
                "capabilities.realtime_transport_unexpected",
                f"non-realtime channel {channel!r} declares realtime transports",
            )
        if history and not history_transports:
            report.add(
                "capabilities.history_transport_missing",
                f"historical channel {channel!r} must declare a transport",
            )
        if not history and history_transports:
            report.add(
                "capabilities.history_transport_unexpected",
                f"non-historical channel {channel!r} declares history transports",
            )

        connection_model = getattr(item, "connection_model", None)
        if connection_model is not None and connection_model not in _CONNECTION_MODELS:
            report.add(
                "capabilities.channel_connection_model_unknown",
                f"channel {channel!r} has unknown connection_model={connection_model!r}",
            )
        if TransportMode.WEBSOCKET.value in realtime_transport_values and connection_model is None:
            report.add(
                "capabilities.channel_connection_model_missing",
                f"WebSocket channel {channel!r} must declare its connection model",
            )

        sequence = str(getattr(item, "sequence", "none") or "none")
        if sequence not in _SEQUENCE_MODES:
            report.add(
                "capabilities.sequence_unknown",
                f"channel {channel!r} has unknown sequence mode {sequence!r}",
            )
        resync = str(getattr(item, "resync", "none") or "none")
        if resync not in _RESYNC_MODES:
            report.add(
                "capabilities.resync_unknown",
                f"channel {channel!r} has unknown resync mode {resync!r}",
            )

        delivery = _enum_value(getattr(item, "delivery", None))
        if delivery not in _DELIVERY_CLASSES:
            report.add(
                "capabilities.delivery_unknown",
                f"channel {channel!r} has unknown delivery class {delivery!r}",
            )
        snapshot_value = getattr(item, "snapshot", False)
        delta_value = getattr(item, "delta", False)
        checksum_value = getattr(item, "checksum", False)
        for field_name, field_value in (
            ("snapshot", snapshot_value),
            ("delta", delta_value),
            ("checksum", checksum_value),
        ):
            if not isinstance(field_value, bool):
                report.add(
                    "capabilities.channel_flag_invalid",
                    f"channel {channel!r} {field_name} must be a boolean",
                )
        delta = delta_value is True
        if delivery == "ordered_delta" and not delta:
            report.add(
                "capabilities.ordered_delta_flag_missing",
                f"ordered-delta channel {channel!r} must set delta=true",
            )
        if delta and sequence == "none":
            report.add(
                "capabilities.delta_sequence_missing",
                f"delta channel {channel!r} must declare sequence semantics",
            )
        if delta and resync == "none":
            report.add(
                "capabilities.delta_resync_missing",
                f"delta channel {channel!r} must declare a resync strategy",
            )

        raw_available_fields = getattr(item, "available_fields", ()) or ()
        raw_unavailable_fields = getattr(item, "unavailable_fields", ()) or ()
        raw_derived_fields = getattr(item, "derived_fields", ()) or ()
        if isinstance(raw_available_fields, (str, bytes, dict)) or isinstance(
            raw_unavailable_fields,
            (str, bytes, dict),
        ) or isinstance(raw_derived_fields, (str, bytes, dict)):
            available_fields = set()
            unavailable_fields = set()
            derived_fields = set()
            report.add(
                "capabilities.channel_fields_invalid",
                f"channel {channel!r} field declarations must be iterable",
            )
        else:
            try:
                available_fields = set(raw_available_fields)
                unavailable_fields = set(raw_unavailable_fields)
                derived_fields = set(raw_derived_fields)
            except TypeError:
                available_fields = set()
                unavailable_fields = set()
                derived_fields = set()
                report.add(
                    "capabilities.channel_fields_invalid",
                    f"channel {channel!r} field declarations must be iterable",
                )
        invalid_fields = sorted(
            (
                field
                for field in (*available_fields, *unavailable_fields, *derived_fields)
                if not isinstance(field, str) or not field.strip()
            ),
            key=lambda value: repr(value),
        )
        if invalid_fields:
            report.add(
                "capabilities.channel_fields_invalid",
                f"channel {channel!r} field declarations must contain non-empty strings",
            )
        if not available_fields:
            report.add(
                "capabilities.channel_fields_missing",
                f"channel {channel!r} must declare available normalized fields",
            )
        overlap = sorted(available_fields & unavailable_fields, key=lambda value: repr(value))
        if overlap:
            report.add(
                "capabilities.channel_fields_overlap",
                f"channel {channel!r} marks fields both available and unavailable: {overlap}",
            )

        params = getattr(item, "params", None)
        if not isinstance(params, dict):
            report.add(
                "capabilities.channel_params_invalid",
                f"channel {channel!r} params must be a dict",
            )
        else:
            _validate_depth_params(channel, params, report)
        if not isinstance(getattr(item, "limits", None), dict):
            report.add(
                "capabilities.channel_limits_invalid",
                f"channel {channel!r} limits must be a dict",
            )
        try:
            update_intervals = tuple(getattr(item, "update_intervals_ms", ()) or ())
        except TypeError:
            update_intervals = ()
            report.add(
                "capabilities.update_intervals_invalid",
                f"channel {channel!r} update intervals must be iterable",
            )
        invalid_intervals = [
            value
            for value in update_intervals
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0
        ]
        if invalid_intervals:
            report.add(
                "capabilities.update_intervals_invalid",
                f"channel {channel!r} has invalid update intervals: {invalid_intervals}",
            )
        elif tuple(sorted(set(update_intervals))) != update_intervals:
            report.add(
                "capabilities.update_intervals_not_canonical",
                f"channel {channel!r} update intervals must be unique and increasing",
            )


def _validate_depth_params(
    channel: str,
    params: dict[str, Any],
    report: ExchangeContractReport,
) -> None:
    for key in ("depth_levels", "levels"):
        if key not in params:
            continue
        if channel != MarketChannel.DEPTH.value:
            report.add(
                "capabilities.depth_levels_wrong_channel",
                f"parameter {key!r} is only valid for the depth channel",
            )
            continue
        raw_levels = params[key]
        if isinstance(raw_levels, int) and not isinstance(raw_levels, bool):
            levels = (raw_levels,)
        elif isinstance(raw_levels, (list, tuple)):
            levels = tuple(raw_levels)
        else:
            levels = ()
        invalid = [
            value
            for value in levels
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0
        ]
        if not levels or invalid or tuple(sorted(set(levels))) != levels:
            report.add(
                "capabilities.depth_levels_invalid",
                f"depth levels must be positive, unique, and increasing; got {raw_levels!r}",
            )


def _validate_declared_channel_coverage(
    capabilities: Any,
    cases: list[ExchangeContractCase],
    report: ExchangeContractReport,
) -> None:
    schema_version = getattr(capabilities, "capability_schema_version", 1)
    if (
        isinstance(schema_version, bool)
        or not isinstance(schema_version, int)
        or schema_version != 2
    ):
        return

    declared: set[tuple[str, str]] = set()
    try:
        channel_items = tuple(getattr(capabilities, "channels", ()) or ())
    except TypeError:
        return
    for item in channel_items:
        channel = _enum_value(getattr(item, "channel", None))
        if channel not in _MARKET_CHANNELS:
            continue
        raw_market_types = getattr(item, "market_types", ()) or ()
        if isinstance(raw_market_types, (str, bytes)):
            continue
        try:
            market_types = tuple(raw_market_types)
        except TypeError:
            continue
        for market_type in market_types:
            declared.add((str(market_type).strip().lower(), channel))

    cases_by_identity: dict[tuple[str, str], list[ExchangeContractCase]] = {}
    for case in cases:
        descriptor = getattr(case, "descriptor", None)
        channel = _descriptor_channel(descriptor)
        market_type = str(getattr(descriptor, "market_type", "")).strip().lower()
        if market_type and channel in _MARKET_CHANNELS:
            cases_by_identity.setdefault((market_type, channel), []).append(case)

    missing = sorted(declared - set(cases_by_identity))
    if missing:
        report.add(
            "capabilities.channel_fixture_missing",
            f"declared market/channel pairs lack contract fixtures: {missing}",
        )
    undeclared = sorted(set(cases_by_identity) - declared)
    if undeclared:
        report.add(
            "capabilities.fixture_channel_undeclared",
            f"contract fixtures cover undeclared market/channel pairs: {undeclared}",
        )
    duplicated = sorted(
        identity
        for identity, identity_cases in cases_by_identity.items()
        if len(identity_cases) > 1
    )
    if duplicated:
        report.add(
            "capabilities.channel_fixture_duplicate",
            f"market/channel pairs have multiple contract fixtures: {duplicated}",
        )

    for item in channel_items:
        channel = _enum_value(getattr(item, "channel", None))
        if channel not in _MARKET_CHANNELS:
            continue
        realtime_transports = {
            _enum_value(value)
            for value in getattr(item, "realtime_transports", ()) or ()
        }
        history_transports = {
            _enum_value(value)
            for value in getattr(item, "history_transports", ()) or ()
        }
        for market_type in getattr(item, "market_types", ()) or ():
            identity = (str(market_type).strip().lower(), channel)
            identity_cases = cases_by_identity.get(identity, ())
            sample_sources = {
                _enum_value(getattr(sample, "source", None))
                for case in identity_cases
                for sample in case.normalizer_samples
            }
            if (
                TransportMode.WEBSOCKET.value in realtime_transports
                and "websocket" not in sample_sources
            ):
                report.add(
                    "capabilities.websocket_fixture_missing",
                    f"declared realtime WebSocket pair lacks a normalizer fixture: {identity}",
                )
            if (
                {
                    TransportMode.REST_POLL.value,
                    TransportMode.REST_SNAPSHOT.value,
                }
                & realtime_transports
                and "http" not in sample_sources
            ):
                report.add(
                    "capabilities.realtime_rest_fixture_missing",
                    f"declared realtime REST pair lacks an HTTP normalizer fixture: {identity}",
                )
            if (
                TransportMode.REST_HISTORY.value in history_transports
                and "http_backfill" not in sample_sources
            ):
                report.add(
                    "capabilities.history_fixture_missing",
                    f"declared history pair lacks an HTTP-backfill normalizer fixture: {identity}",
                )


def _capability_for_descriptor(capabilities: Any | None, descriptor: Any) -> Any | None:
    if capabilities is None:
        return None
    schema_version = getattr(capabilities, "capability_schema_version", 1)
    if isinstance(schema_version, bool) or schema_version != 2:
        return None
    channel = _descriptor_channel(descriptor)
    market_type = str(getattr(descriptor, "market_type", "")).strip().lower()
    try:
        channel_items = tuple(getattr(capabilities, "channels", ()) or ())
    except TypeError:
        return None
    for item in channel_items:
        if _enum_value(getattr(item, "channel", None)) != channel:
            continue
        raw_market_types = getattr(item, "market_types", ()) or ()
        if isinstance(raw_market_types, (str, bytes)):
            continue
        try:
            market_types = {
                str(value).strip().lower()
                for value in raw_market_types
            }
        except TypeError:
            continue
        if market_type in market_types:
            return item
    return None


def _descriptor_channel(descriptor: Any) -> str | None:
    stream_type = _enum_value(getattr(descriptor, "stream_type", None))
    return {
        "aggTrade": MarketChannel.AGG_TRADE.value,
        "miniTicker": MarketChannel.MINI_TICKER.value,
    }.get(stream_type, stream_type)


def _enum_value(value: Any) -> str | None:
    raw = getattr(value, "value", value)
    if not isinstance(raw, str):
        return None
    normalized = raw.strip()
    return normalized or None


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
    *,
    capabilities: Any | None,
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
    channel_capability = _capability_for_descriptor(capabilities, case.descriptor)
    expected_connection_model = getattr(channel_capability, "connection_model", None)
    actual_connection_model = getattr(spec, "connection_model", None)
    if (
        expected_connection_model is not None
        and actual_connection_model != expected_connection_model
    ):
        report.add(
            "ws.connection_model_mismatch",
            f"declared connection_model={expected_connection_model!r}, "
            f"protocol returned {actual_connection_model!r}",
        )


def _validate_pagination_contract(
    plugin: ExchangePlugin,
    case: ExchangeContractCase,
    report: ExchangeContractReport,
) -> None:
    from app.data_engine.ingestion.models import StreamType

    if case.descriptor.stream_type != StreamType.KLINE:
        return

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
