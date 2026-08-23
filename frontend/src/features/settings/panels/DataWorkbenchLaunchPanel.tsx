import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";

export interface DataWorkbenchLaunchPanelProps {
  onOpen(): void;
}

export default function DataWorkbenchLaunchPanel({ onOpen }: DataWorkbenchLaunchPanelProps) {
  useLocale();
  return (
    <section className="st-group">
      <div className="st-tool-card">
        <div className="st-tool-header">
          <span className="st-tool-icon">🧭</span>
          <div>
            <div className="st-tool-name">{t("settings.workbench.name")} <span className="st-badge st-badge-db">{t("settings.workbench.badge")}</span></div>
            <div className="st-tool-desc">{t("settings.workbench.desc")}</div>
          </div>
        </div>
        <div className="st-actions-row">
          <button className="st-btn st-btn-accent" onClick={onOpen} type="button">{t("settings.workbench.open")}</button>
        </div>
      </div>
    </section>
  );
}
