from __future__ import annotations

import socket

import pytest

from app.local_data.network_guard import OfflineNetworkError, OfflineNetworkGuard


def test_offline_guard_allows_loopback_and_blocks_dns_before_resolution() -> None:
    guard = OfflineNetworkGuard()
    guard.install()
    try:
        assert socket.getaddrinfo("localhost", 8000)
        with pytest.raises(OfflineNetworkError):
            socket.getaddrinfo("example.com", 443)
        with pytest.raises(OfflineNetworkError):
            socket.gethostbyname("example.com")
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            with pytest.raises(OfflineNetworkError):
                udp.sendto(b"probe", ("8.8.8.8", 53))
        finally:
            udp.close()
        snapshot = guard.snapshot()
        assert snapshot["installed"] is True
        assert snapshot["blocked_attempts"] == 3
    finally:
        guard.uninstall()

    assert guard.snapshot()["installed"] is False
