import React from "react";
import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type { ReplayCapabilityModel } from "../replayCapabilityModel.js";


export interface ReplayCapabilitySurfaceProps {
  readonly capabilities: ReplayCapabilityModel;
}

function ReplayCapabilitySurface({ capabilities }: ReplayCapabilitySurfaceProps) {
  useLocale();
  return (
    <section className="replay-capability-surface" aria-label={t("replay.capability.aria")} data-replay-panel="capabilities">
      <header><strong>{t("replay.capability.title")}</strong><small>{t("replay.capability.hint")}</small></header>
      <div className="replay-capability-grid">
        {Object.entries(capabilities).map(([id, capability]) => (
          <article key={id} data-replay-capability={id} data-capability-state={capability.state}>
            <span>{capability.label}</span>
            <strong>{capability.value}</strong>
            <code>{capability.state}</code>
            <small>{capability.detail}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

export default React.memo(ReplayCapabilitySurface);
