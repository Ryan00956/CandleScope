import { t } from "../../../i18n/index.js";
import ResearchMarketChart from "./ResearchMarketChart.js";
import ResearchTaskPicker from "./ResearchTaskPicker.js";
import { useBacktestResearchRuntime } from "./useBacktestResearchRuntime.js";

function ResearchStatus({
  error,
  onRetry,
}: {
  error?: string | null;
  onRetry(): void;
}) {
  return (
    <main className="research-status-page" data-state={error ? "error" : "loading"}>
      <section>
        <span>{t("research.kicker")}</span>
        <h1>{error ? t("research.errorTitle") : t("research.loading")}</h1>
        {error && <p>{error}</p>}
        {error && <button type="button" onClick={onRetry}>{t("research.retry")}</button>}
        <a href="/">{t("research.live")}</a>
      </section>
    </main>
  );
}

export default function BacktestResearchApp({
  search,
}: {
  search?: string;
} = {}) {
  const runtime = useBacktestResearchRuntime(search === undefined ? {} : { search });
  if (runtime.view.phase !== "READY") {
    return <ResearchStatus error={runtime.view.phase === "ERROR" ? runtime.view.error : null} onRetry={runtime.actions.refresh} />;
  }
  if (runtime.view.selectedTask === null) {
    return (
      <ResearchTaskPicker
        returnHref={runtime.view.returnHref}
        onSelect={runtime.actions.selectTask}
      />
    );
  }
  const workspaceKey = runtime.view.activeRun?.run_id
    ?? runtime.view.launchContext?.context_id
    ?? runtime.view.activeStudy?.study_id
    ?? "research-home";
  return <ResearchMarketChart key={workspaceKey} runtime={runtime} />;
}
