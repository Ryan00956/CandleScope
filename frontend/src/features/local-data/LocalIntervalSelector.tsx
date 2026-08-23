import { useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/useLocale.js";

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
  useLocale();
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
    <div className="local-interval-selector" aria-label={t("local.intervalAria")}>
      <div className="local-interval-buttons" role="toolbar" aria-label={t("local.availableIntervals")}>
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
          {t("local.custom")}
          <input
            value={custom}
            onChange={(event) => {
              setCustom(event.target.value);
              setFeedback(null);
            }}
            placeholder="90m"
            aria-label={t("local.customInterval")}
          />
        </label>
        <button type="submit" disabled={!customSupport.supported}>{t("local.switch")}</button>
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
