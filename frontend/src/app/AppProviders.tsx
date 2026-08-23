import React from "react";
import type { ErrorInfo, PropsWithChildren, ReactNode } from "react";
import { t } from "../i18n/index.js";

export type ChartErrorBoundaryProps = PropsWithChildren;

interface ChartErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ChartErrorBoundary extends React.Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ChartErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", height: "100%", gap: 16,
          color: "#94a3b8", padding: 32,
        }}>
          <div style={{ fontSize: 48 }}>!</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "#e2e8f0" }}>
            {t("shell.chartErrorTitle")}
          </div>
          <div style={{ fontSize: 13, maxWidth: 400, textAlign: "center" }}>
            {t("shell.chartErrorDetail")}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: "8px 24px", background: "#3b82f6", color: "#fff",
              border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600,
            }}
          >
            {t("shell.retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function AppProviders({ children }: PropsWithChildren): ReactNode {
  return children;
}
