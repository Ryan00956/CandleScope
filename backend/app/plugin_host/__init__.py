"""Business-neutral process Host for CandleScope Plugin Platform protocols."""

from .errors import (
    PlatformHostError,
    PlatformHostRemoteError,
    PlatformHostRequestError,
    PlatformHostStateError,
    PlatformHostTransportError,
)
from .framing import (
    AsyncJsonLineConnection,
    JsonLineError,
    compact_json_bytes,
    strict_json_loads,
)
from .process import (
    ManagedSidecarProcess,
    SidecarProcessSpec,
    launch_sidecar_process,
    plugin_environment,
    signal_process,
    validate_launch_target,
)
from .transport import HostCallHandler, PlatformV2Transport
from .supervisor import (
    EntrypointProcessSpec,
    EntrypointSupervisor,
    GrantedHostCallHandler,
)

__all__ = [
    "AsyncJsonLineConnection",
    "JsonLineError",
    "HostCallHandler",
    "EntrypointProcessSpec",
    "EntrypointSupervisor",
    "GrantedHostCallHandler",
    "ManagedSidecarProcess",
    "PlatformHostError",
    "PlatformHostRemoteError",
    "PlatformHostRequestError",
    "PlatformHostStateError",
    "PlatformHostTransportError",
    "PlatformV2Transport",
    "SidecarProcessSpec",
    "compact_json_bytes",
    "launch_sidecar_process",
    "plugin_environment",
    "signal_process",
    "strict_json_loads",
    "validate_launch_target",
]
