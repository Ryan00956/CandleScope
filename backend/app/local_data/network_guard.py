"""Fail-closed process guard for the LOCAL_OFFLINE runtime profile.

The guard is intentionally installed only for the lifetime of an offline app
process.  Loopback remains available so the browser can reach the local API;
DNS and non-loopback connection attempts fail before any packet is sent.
"""

from __future__ import annotations

import ipaddress
import socket
import threading
from typing import Any


class OfflineNetworkError(OSError):
    """Raised when code attempts external networking in local mode."""


class OfflineNetworkGuard:
    def __init__(self) -> None:
        self._installed = False
        self._lock = threading.Lock()
        self._blocked_attempts = 0
        self._original_getaddrinfo = socket.getaddrinfo
        self._original_gethostbyname = socket.gethostbyname
        self._original_gethostbyname_ex = socket.gethostbyname_ex
        self._original_connect = socket.socket.connect
        self._original_connect_ex = socket.socket.connect_ex
        self._original_sendto = socket.socket.sendto

    @staticmethod
    def _is_loopback_host(host: Any) -> bool:
        if host is None:
            return True
        if isinstance(host, bytes):
            host = host.decode("ascii", errors="strict")
        normalized = str(host).strip().lower().strip("[]")
        if normalized == "localhost":
            return True
        try:
            return ipaddress.ip_address(normalized).is_loopback
        except ValueError:
            return False

    def _deny(self, target: Any) -> None:
        with self._lock:
            self._blocked_attempts += 1
        raise OfflineNetworkError(
            f"External networking is disabled in LOCAL_OFFLINE mode: {target!r}"
        )

    def _check_address(self, family: int, address: Any) -> None:
        if family == getattr(socket, "AF_UNIX", object()):
            return
        host = address[0] if isinstance(address, tuple) and address else address
        if not self._is_loopback_host(host):
            self._deny(host)

    def install(self) -> None:
        if self._installed:
            return

        guard = self

        def guarded_getaddrinfo(host: Any, *args: Any, **kwargs: Any):
            if not guard._is_loopback_host(host):
                guard._deny(host)
            return guard._original_getaddrinfo(host, *args, **kwargs)

        def guarded_gethostbyname(host: Any):
            if not guard._is_loopback_host(host):
                guard._deny(host)
            return guard._original_gethostbyname(host)

        def guarded_gethostbyname_ex(host: Any):
            if not guard._is_loopback_host(host):
                guard._deny(host)
            return guard._original_gethostbyname_ex(host)

        def guarded_connect(sock: socket.socket, address: Any):
            guard._check_address(sock.family, address)
            return guard._original_connect(sock, address)

        def guarded_connect_ex(sock: socket.socket, address: Any):
            guard._check_address(sock.family, address)
            return guard._original_connect_ex(sock, address)

        def guarded_sendto(sock: socket.socket, data: Any, *args: Any):
            if not args:
                raise TypeError("sendto expected a destination address")
            guard._check_address(sock.family, args[-1])
            return guard._original_sendto(sock, data, *args)

        socket.getaddrinfo = guarded_getaddrinfo
        socket.gethostbyname = guarded_gethostbyname
        socket.gethostbyname_ex = guarded_gethostbyname_ex
        socket.socket.connect = guarded_connect
        socket.socket.connect_ex = guarded_connect_ex
        socket.socket.sendto = guarded_sendto
        self._guarded_getaddrinfo = guarded_getaddrinfo
        self._guarded_gethostbyname = guarded_gethostbyname
        self._guarded_gethostbyname_ex = guarded_gethostbyname_ex
        self._guarded_connect = guarded_connect
        self._guarded_connect_ex = guarded_connect_ex
        self._guarded_sendto = guarded_sendto
        self._installed = True

    def uninstall(self) -> None:
        if not self._installed:
            return
        if socket.getaddrinfo is self._guarded_getaddrinfo:
            socket.getaddrinfo = self._original_getaddrinfo
        if socket.gethostbyname is self._guarded_gethostbyname:
            socket.gethostbyname = self._original_gethostbyname
        if socket.gethostbyname_ex is self._guarded_gethostbyname_ex:
            socket.gethostbyname_ex = self._original_gethostbyname_ex
        if socket.socket.connect is self._guarded_connect:
            socket.socket.connect = self._original_connect
        if socket.socket.connect_ex is self._guarded_connect_ex:
            socket.socket.connect_ex = self._original_connect_ex
        if socket.socket.sendto is self._guarded_sendto:
            socket.socket.sendto = self._original_sendto
        self._installed = False

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            blocked_attempts = self._blocked_attempts
        return {
            "installed": self._installed,
            "policy": "loopback_only",
            "blocked_attempts": blocked_attempts,
        }
