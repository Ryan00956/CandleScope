import { t } from "../../../i18n/index.js";

export default function BacktestResearchDisabled() {
  return (
    <main className="research-status-page" data-state="disabled">
      <section>
        <span>{t("research.kicker")}</span>
        <h1>{t("research.disabled.title")}</h1>
        <p>{t("research.disabled.detail")}</p>
        <a href="/">{t("research.live")}</a>
      </section>
    </main>
  );
}
