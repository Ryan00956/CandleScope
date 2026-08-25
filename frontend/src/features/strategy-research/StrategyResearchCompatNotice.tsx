import { useState } from "react";

import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";
import { dismissCompatNotice, isCompatNoticeDismissed } from "./strategyResearchCompat.js";

export function StrategyResearchCompatNotice({ page }: { page: "local" | "backtest" }) {
  useLocale();
  const [dismissed, setDismissed] = useState(() => isCompatNoticeDismissed());
  if (dismissed) return null;
  return (
    <aside
      className="strategy-research-compat-notice"
      role="note"
      data-testid="strategy-research-compat-notice"
      data-compat-page={page}
    >
      <p>{page === "local" ? t("strategy.compat.local") : t("strategy.compat.backtest")}</p>
      <a href="/strategy.html">{t("strategy.compat.canonical")}</a>
      <button
        type="button"
        onClick={() => {
          dismissCompatNotice();
          setDismissed(true);
        }}
      >
        {t("strategy.compat.dismiss")}
      </button>
    </aside>
  );
}
