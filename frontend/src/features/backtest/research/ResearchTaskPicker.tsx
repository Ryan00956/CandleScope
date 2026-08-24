import { t, type MessageKey } from "../../../i18n/index.js";
import type { BacktestResearchTask } from "./backtestResearchTypes.js";

const TASKS: ReadonlyArray<{
  id: BacktestResearchTask;
  number: string;
  title: MessageKey;
  detail: MessageKey;
}> = [
  { id: "PRECISE_EXECUTION", number: "01", title: "research.task.precise.title", detail: "research.task.precise.detail" },
  { id: "PARAMETER_ROBUSTNESS", number: "02", title: "research.task.robust.title", detail: "research.task.robust.detail" },
  { id: "PYTHON_MODEL", number: "03", title: "research.task.python.title", detail: "research.task.python.detail" },
  { id: "MULTI_MARKET", number: "04", title: "research.task.multi.title", detail: "research.task.multi.detail" },
  { id: "REPLAY_REVIEW", number: "05", title: "research.task.replay.title", detail: "research.task.replay.detail" },
];

export default function ResearchTaskPicker({
  onSelect,
  returnHref,
}: {
  onSelect(task: BacktestResearchTask): void;
  returnHref: string;
}) {
  return (
    <main className="research-task-home" data-testid="research-task-home">
      <section className="research-task-hero">
        <div>
          <span>{t("research.kicker")}</span>
          <h1>{t("research.title")}</h1>
          <p>{t("research.subtitle")}</p>
        </div>
        <a href={returnHref}>{t("research.return")}</a>
      </section>
      <section className="research-task-grid" aria-label={t("research.task.home")}>
        {TASKS.map((task) => (
          <button
            key={task.id}
            type="button"
            data-research-task={task.id}
            onClick={() => onSelect(task.id)}
          >
            <span className="research-task-number">{task.number}</span>
            <strong>{t(task.title)}</strong>
            <p>{t(task.detail)}</p>
            <small>{t("research.task.open")}</small>
          </button>
        ))}
      </section>
      <footer className="research-task-foot">
        <span>{t("research.status.authority")}</span>
        <span>{t("research.status.isolated")}</span>
      </footer>
    </main>
  );
}
