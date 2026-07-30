from __future__ import annotations

from candlescope_plugin_sdk.platform_v2 import (
    ActivationRequest,
    CapabilityGrant,
    HostCallInvocation,
    InvokeRequest,
    RequestContext,
    RpcSuccess,
)
from candlescope_plugin_sdk.platform_v2.examples.scheduled_notification import (
    ScheduledNotificationPlugin,
    scheduled_notification_manifest,
)


def test_scheduled_notification_reference_uses_only_granted_host_call() -> None:
    plugin = ScheduledNotificationPlugin()
    manifest = scheduled_notification_manifest()
    assert [item.kind for item in manifest.contributions] == [
        "notification/1",
        "job/1",
    ]
    plugin.activate(
        ActivationRequest(
            "instance-reminder",
            1,
            (
                CapabilityGrant("cap-notification", "notifications.show", {"channels": ["toast"]}),
                CapabilityGrant(
                    "cap-job",
                    "jobs.schedule",
                    {"jobs": ["reminder-job"], "maxRunsPerHour": 60},
                ),
            ),
        )
    )
    request = InvokeRequest(
        "reminder-job",
        {
            "runId": "job-one",
            "reason": "user",
            "attempt": 1,
            "scheduledAt": "2026-07-22T00:00:00Z",
        },
        RequestContext("reminder-job", True, 1, "scheduled-notification-test"),
    )
    outcome = plugin.invoke(request)
    assert isinstance(outcome, HostCallInvocation)
    assert outcome.call.capability_handle == "cap-notification"
    assert outcome.call.method == "notifications.show"
    assert outcome.call.params["sourceId"] == "reminder-source"
    completed = plugin.complete_host_call(
        outcome.token,
        RpcSuccess("host-call", {"accepted": True}, 1),
    )
    assert completed["notified"] is True
