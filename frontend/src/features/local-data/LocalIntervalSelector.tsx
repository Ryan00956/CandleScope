import { useMemo, useState } from "react";

import {
  getCommonLocalIntervals,
  resolveLocalIntervalSupport,
} from "./localIntervalPolicy.js";
import type { LocalDatasetManifest } from "./localDataTypes.js";


export default function LocalIntervalSelector({
  manifest,
  interval,
  onSelect,
}: {
  manifest: LocalDatasetManifest;
  interval: string;
  onSelect(interval: string): void;
}) {
  const [custom, setCustom] = useState("90m");
  const [feedback, setFeedback] = useState<string | null>(null);
  const common = useMemo(() => {
    const values = getCommonLocalIntervals(manifest);
    const active = resolveLocalIntervalSupport(manifest, interval);
    if (active.supported && !values.includes(active.target)) values.push(active.target);
    return values;
  }, [interval, manifest]);
  const customSupport = useMemo(
    () => resolveLocalIntervalSupport(manifest, custom),
    [custom, manifest],
  );

  return (
    <div className="local-interval-selector" aria-label="本地数据周期">
      <div className="local-interval-buttons" role="toolbar" aria-label="可用周期">
        {common.map((value) => {
          const support = resolveLocalIntervalSupport(manifest, value);
          return (
            <button
              type="button"
              key={value}
              className={support.target === interval ? "active" : ""}
              onClick={() => {
                onSelect(support.target);
                setFeedback(support.message);
              }}
              title={support.message}
            >
              {value}
              {support.derived && <small>{support.factor}×</small>}
            </button>
          );
        })}
      </div>
      <form
        className="local-custom-interval"
        onSubmit={(event) => {
          event.preventDefault();
          if (!customSupport.supported) {
            setFeedback(customSupport.message);
            return;
          }
          onSelect(customSupport.target);
          setFeedback(customSupport.message);
        }}
      >
        <label>
          自定义
          <input
            value={custom}
            onChange={(event) => {
              setCustom(event.target.value);
              setFeedback(null);
            }}
            placeholder="90m"
            aria-label="自定义本地周期"
          />
        </label>
        <button type="submit" disabled={!customSupport.supported}>切换</button>
      </form>
      <span
        className={`local-interval-feedback ${customSupport.supported ? "ok" : "error"}`}
        role={customSupport.supported ? "status" : "alert"}
      >
        {feedback ?? customSupport.message}
      </span>
    </div>
  );
}
