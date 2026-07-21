import React from "react";
import type { ReplayCapabilityModel } from "../replayCapabilityModel.js";


export interface ReplayCapabilitySurfaceProps {
  readonly capabilities: ReplayCapabilityModel;
}

function ReplayCapabilitySurface({ capabilities }: ReplayCapabilitySurfaceProps) {
  return (
    <section className="replay-capability-surface" aria-label="回放历史能力" data-replay-panel="capabilities">
      <header><strong>历史能力</strong><small>不支持的数据不会显示为 0 或沿用 live 精度。</small></header>
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
