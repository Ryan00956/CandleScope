"""Small complete runtime used by documentation and contract tests."""

from __future__ import annotations

import re

from ..constants import (
    FEATURE_BATCH_EXECUTION_V1,
    FEATURE_RENDER_LINE_SERIES_V1,
    FEATURE_SOURCE_ANALYSIS_V1,
)
from ..models import (
    AnalyzeRequest,
    AnalyzeResult,
    Diagnostic,
    ExecuteBatchRequest,
    ExecuteBatchResult,
    LanguageDescriptor,
    LinePoint,
    LineSeries,
    RenderOutput,
    RuntimeDescriptor,
)
from ..runtime import BaseRuntimePlugin
from ..server import serve_runtime


_PLOT_CLOSE = re.compile(r"^\s*plot\s*\(\s*close\s*\)\s*;?\s*$")


def _unsupported_source() -> Diagnostic:
    return Diagnostic(
        code="HELLO_UNSUPPORTED_SOURCE",
        severity="error",
        message="Hello Runtime only supports plot(close).",
        hint="Replace the source with: plot(close)",
    )


class HelloRuntime(BaseRuntimePlugin):
    def describe(self) -> RuntimeDescriptor:
        return RuntimeDescriptor(
            id="hello-runtime",
            name="Hello Runtime",
            version="0.2.0",
            package="candlescope-plugin-sdk",
            languages=(
                LanguageDescriptor(
                    id="hello",
                    name="Hello Script",
                    extensions=(".hello",),
                ),
            ),
            features=(
                FEATURE_SOURCE_ANALYSIS_V1,
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
            required_host_features=(
                FEATURE_BATCH_EXECUTION_V1,
                FEATURE_RENDER_LINE_SERIES_V1,
            ),
            meta={"example": True},
        )

    def analyze(self, request: AnalyzeRequest) -> AnalyzeResult:
        if _PLOT_CLOSE.fullmatch(request.source):
            return AnalyzeResult(ok=True, executable=True)
        return AnalyzeResult(
            ok=False,
            executable=False,
            diagnostics=(_unsupported_source(),),
        )

    def execute_batch(self, request: ExecuteBatchRequest) -> ExecuteBatchResult:
        analysis = self.analyze(
            AnalyzeRequest(
                source=request.source,
                context=request.context,
                options=request.options,
            )
        )
        if not analysis.executable:
            return ExecuteBatchResult(
                ok=False,
                diagnostics=analysis.diagnostics,
            )
        points = tuple(LinePoint(bar.time, bar.close) for bar in request.bars)
        return ExecuteBatchResult(
            ok=True,
            output=RenderOutput(
                series=(
                    LineSeries(
                        id="close",
                        title="Close",
                        points=points,
                        pane="main",
                        scale="right",
                        style={"color": "#22c55e", "lineWidth": 2},
                    ),
                ),
                meta={"runtime": "hello-runtime"},
            ),
        )


def main() -> int:
    return serve_runtime(HelloRuntime())


if __name__ == "__main__":
    raise SystemExit(main())
