from __future__ import annotations

import argparse
import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode, urlparse, urlunparse

import httpx
import websockets


@dataclass(slots=True)
class ScenarioResult:
    name: str
    durations_ms: list[float] = field(default_factory=list)
    ok: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def add(self, duration_ms: float, *, ok: bool, error: str | None = None) -> None:
        self.durations_ms.append(duration_ms)
        if ok:
            self.ok += 1
        else:
            self.failed += 1
            if error and len(self.errors) < 5:
                self.errors.append(error)

    def summary(self) -> dict[str, Any]:
        values = sorted(self.durations_ms)
        return {
            "name": self.name,
            "ok": self.ok,
            "failed": self.failed,
            "count": len(values),
            "p50_ms": _percentile(values, 50),
            "p95_ms": _percentile(values, 95),
            "p99_ms": _percentile(values, 99),
            "max_ms": round(values[-1], 2) if values else 0.0,
            "errors": self.errors,
        }


def _percentile(values: list[float], pct: int) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return round(values[0], 2)
    index = min(len(values) - 1, max(0, int(round((pct / 100) * (len(values) - 1)))))
    return round(values[index], 2)


def _bars(count: int) -> list[dict[str, Any]]:
    base = 1_700_000_000
    return [
        {
            "time": base + i * 60,
            "open": 100 + i * 0.1,
            "high": 101 + i * 0.1,
            "low": 99 + i * 0.1,
            "close": 100.5 + i * 0.1,
            "volume": 10 + i,
        }
        for i in range(count)
    ]


def _ws_url(base_url: str, path: str, params: dict[str, Any] | None = None) -> str:
    parsed = urlparse(base_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    query = urlencode(params or {})
    return urlunparse((scheme, parsed.netloc, path, "", query, ""))


async def _run_http_scenario(
    client: httpx.AsyncClient,
    name: str,
    *,
    method: str,
    path: str,
    concurrency: int,
    requests: int,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> ScenarioResult:
    result = ScenarioResult(name)
    semaphore = asyncio.Semaphore(concurrency)

    async def _one() -> None:
        async with semaphore:
            start = time.perf_counter()
            try:
                response = await client.request(
                    method,
                    path,
                    params=params,
                    json=json_body,
                )
                elapsed = (time.perf_counter() - start) * 1000
                result.add(
                    elapsed,
                    ok=response.status_code < 500,
                    error=None if response.status_code < 500 else response.text[:200],
                )
            except Exception as exc:
                elapsed = (time.perf_counter() - start) * 1000
                result.add(elapsed, ok=False, error=repr(exc))

    await asyncio.gather(*(_one() for _ in range(requests)))
    return result


async def _run_ws_probe(base_url: str, symbol: str, interval: str) -> list[dict[str, Any]]:
    probes: list[dict[str, Any]] = []

    async def _probe(name: str, url: str, first_message: dict[str, Any] | str | None) -> None:
        start = time.perf_counter()
        try:
            async with websockets.connect(url, open_timeout=5, close_timeout=2) as ws:
                if first_message is not None:
                    if isinstance(first_message, str):
                        await ws.send(first_message)
                    else:
                        await ws.send(json.dumps(first_message))
                messages = []
                for _ in range(2):
                    try:
                        messages.append(await asyncio.wait_for(ws.recv(), timeout=5))
                    except asyncio.TimeoutError:
                        break
                probes.append({
                    "name": name,
                    "ok": True,
                    "duration_ms": round((time.perf_counter() - start) * 1000, 2),
                    "messages": messages,
                })
        except Exception as exc:
            probes.append({
                "name": name,
                "ok": False,
                "duration_ms": round((time.perf_counter() - start) * 1000, 2),
                "error": repr(exc),
            })

    await asyncio.gather(
        _probe(
            "klines_multi_ws",
            _ws_url(base_url, "/api/v1/stream/klines_multi", {"symbol": symbol}),
            {"action": "subscribe", "intervals": [interval]},
        ),
        _probe(
            "indicator_ws",
            _ws_url(base_url, "/api/v1/stream/indicators"),
            {
                "action": "subscribe",
                "clientId": "bench-ma",
                "symbol": symbol,
                "interval": interval,
                "name": "MA",
                "params": {"period": 20},
                "historyLimit": 120,
            },
        ),
    )
    return probes


async def _fetch_json(client: httpx.AsyncClient, path: str) -> dict[str, Any]:
    try:
        response = await client.get(path)
        return response.json()
    except Exception as exc:
        return {"error": repr(exc)}


def _compact_diagnostics(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "executors": payload.get("executors"),
        "runtime": payload.get("runtime"),
        "backfill": {
            "ready_chunks": payload.get("ready_chunks"),
            "running_chunks": payload.get("running_chunks"),
            "next_drain_in_ms": payload.get("next_drain_in_ms"),
            "rate_limited_skips": payload.get("rate_limited_skips"),
        },
    }


async def run(args: argparse.Namespace) -> dict[str, Any]:
    bars = _bars(args.bars)
    now_ms = int(time.time() * 1000)
    start_ms = now_ms - (args.range_bars + 5) * 60_000
    end_ms = now_ms - 60_000

    async with httpx.AsyncClient(base_url=args.base_url, timeout=args.timeout) as client:
        health = await _fetch_json(client, "/health")
        before_debug = await _fetch_json(client, "/debug/snapshot")
        before_indicators = await _fetch_json(client, "/api/v1/indicators/diagnostics")

        scenarios = await asyncio.gather(
            _run_http_scenario(
                client,
                "klines_latest",
                method="GET",
                path="/api/v1/klines/latest",
                concurrency=args.klines_concurrency,
                requests=args.klines_requests,
                params={"symbol": args.symbol, "interval": args.interval, "limit": 2},
            ),
            _run_http_scenario(
                client,
                "builtin_indicator_compute",
                method="POST",
                path="/api/v1/indicators/compute",
                concurrency=args.indicator_concurrency,
                requests=args.indicator_requests,
                json_body={
                    "mode": "builtin",
                    "name": "MA",
                    "symbol": args.symbol,
                    "interval": args.interval,
                    "params": {"period": 20},
                    "ohlcv": bars,
                },
            ),
            _run_http_scenario(
                client,
                "pyne_compute",
                method="POST",
                path="/api/v1/indicators/compute",
                concurrency=args.pyne_concurrency,
                requests=args.pyne_requests,
                json_body={
                    "mode": "script",
                    "symbol": args.symbol,
                    "interval": args.interval,
                    "securityMode": "safe",
                    "script": "plot(close, title='Close')",
                    "ohlcv": bars,
                },
            ),
            _run_http_scenario(
                client,
                "visible_range_repair",
                method="GET",
                path="/api/v1/klines/range",
                concurrency=args.range_concurrency,
                requests=args.range_requests,
                params={
                    "symbol": args.symbol,
                    "interval": args.interval,
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "repair": "async",
                    "strict": "true",
                },
            ),
        )

        ws = await _run_ws_probe(args.base_url, args.symbol, args.interval)
        after_debug = await _fetch_json(client, "/debug/snapshot")
        after_indicators = await _fetch_json(client, "/api/v1/indicators/diagnostics")

    return {
        "base_url": args.base_url,
        "symbol": args.symbol,
        "interval": args.interval,
        "health": health,
        "scenarios": [item.summary() for item in scenarios],
        "websockets": ws,
        "diagnostics": {
            "before_debug": _compact_diagnostics(before_debug),
            "after_debug": _compact_diagnostics(after_debug),
            "before_indicators": {"executors": before_indicators.get("executors")},
            "after_indicators": {"executors": after_indicators.get("executors")},
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run CandleScope concurrency benchmarks.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--interval", default="1m")
    parser.add_argument("--bars", type=int, default=5000)
    parser.add_argument("--range-bars", type=int, default=300)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--klines-concurrency", type=int, default=10)
    parser.add_argument("--klines-requests", type=int, default=50)
    parser.add_argument("--indicator-concurrency", type=int, default=10)
    parser.add_argument("--indicator-requests", type=int, default=30)
    parser.add_argument("--pyne-concurrency", type=int, default=3)
    parser.add_argument("--pyne-requests", type=int, default=9)
    parser.add_argument("--range-concurrency", type=int, default=2)
    parser.add_argument("--range-requests", type=int, default=4)
    return parser.parse_args()


def main() -> None:
    report = asyncio.run(run(parse_args()))
    print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
