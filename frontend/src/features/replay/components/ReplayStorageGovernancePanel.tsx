import { useState } from "react";

import { t } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type {
  ReplayStorageCategoryName,
  ReplayStorageGcProtocol,
  ReplayStorageObjectCategory,
  ReplayStorageObjectItem,
} from "../replayStorageModel.js";
import type { TrainingHubRuntime } from "../useTrainingHub.js";


const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

const CATEGORY_NAMES = [
  "segments",
  "historical_books",
  "account_history",
  "review_evidence",
] as const satisfies readonly ReplayStorageCategoryName[];

function categoryLabel(name: ReplayStorageCategoryName): string {
  switch (name) {
    case "segments":
      return t("replay.storage.segments");
    case "historical_books":
      return t("replay.storage.books");
    case "account_history":
      return t("replay.storage.accountHistory");
    case "review_evidence":
      return t("replay.storage.reviewEvidence");
  }
}

const GC_CATEGORIES = [
  "segments",
  "historical_books",
  "account_history",
] as const;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < MIB) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < GIB) return `${(value / MIB).toFixed(1)} MiB`;
  return `${(value / GIB).toFixed(2)} GiB`;
}

function identityLabel(item: ReplayStorageObjectItem): string {
  return [
    item.identity.exchange,
    item.identity.market_type,
    item.identity.symbol,
    item.identity.base_interval,
  ].filter((value): value is string => typeof value === "string").join(" · ");
}

function StorageObjectRows({
  category,
  protocol,
  runtime,
}: {
  readonly category: ReplayStorageObjectCategory;
  readonly protocol: ReplayStorageGcProtocol;
  readonly runtime: TrainingHubRuntime;
}) {
  useLocale();
  if (category.items.length === 0) return <p>{t("replay.storage.empty")}</p>;
  return (
    <div className="replay-storage-object-list">
      {category.items.map((item) => (
        <article key={item.object_id} data-storage-object={item.object_id}>
          <header>
            <strong>{identityLabel(item)}</strong>
            <span data-storage-health={item.health}>{item.health}</span>
          </header>
          <dl>
            <div><dt>{t("replay.storage.objects")}</dt><dd><code>{item.object_id}</code></dd></div>
            <div><dt>{t("replay.storage.size")}</dt><dd>{formatBytes(item.byte_size)}</dd></div>
            <div><dt>{t("replay.storage.refs")}</dt><dd>{item.active_ref_count}</dd></div>
            <div><dt>{t("replay.storage.recover")}</dt><dd>{item.recoverability}</dd></div>
          </dl>
          <p>
            {item.protection_reasons.length === 0
              ? t("replay.storage.noProtect")
              : t("replay.storage.protect", { reasons: item.protection_reasons.join(" · ") })}
          </p>
          {item.health !== "READY" && item.rehydration_available && (
            <button
              type="button"
              disabled={runtime.operation !== null}
              onClick={() => void runtime.actions.rehydrateStorageObject(
                protocol,
                item.object_id,
              )}
            >
              {t("replay.storage.rehydrate")}
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export default function ReplayStorageGovernancePanel({
  runtime,
}: {
  readonly runtime: TrainingHubRuntime;
}) {
  useLocale();
  const [gcCategory, setGcCategory] = useState<(typeof GC_CATEGORIES)[number]>(
    "segments",
  );
  const [targetMiB, setTargetMiB] = useState(256);
  const [maxObjects, setMaxObjects] = useState(100);
  if (!runtime.storageOpen) return null;
  const inventory = runtime.storageInventory;
  const selected = inventory?.categories[gcCategory] ?? null;
  const busy = runtime.operation?.startsWith("storage-") ?? false;
  const targetBytes = Number.isSafeInteger(targetMiB) && targetMiB > 0
    ? targetMiB * MIB
    : 0;
  const validRequest = Number.isSafeInteger(targetBytes)
    && targetBytes >= 1
    && targetBytes <= 1_000_000_000_000
    && Number.isSafeInteger(maxObjects)
    && maxObjects >= 1
    && maxObjects <= 10_000;

  return (
    <section
      className="replay-storage-governance"
      aria-label={t("replay.storage.aria")}
      data-replay-storage-phase={runtime.operation ?? "ready"}
    >
      <header className="replay-storage-heading">
        <div>
          <span className="training-hub-kicker">{t("replay.kicker.gc")}</span>
          <h2>{t("replay.storage.title")}</h2>
          <p>{t("replay.storage.hint")}</p>
        </div>
        <div>
          <button type="button" disabled={busy} onClick={() => void runtime.actions.refreshStorage()}>
            {t("replay.storage.refresh")}
          </button>
          <button type="button" onClick={runtime.actions.closeStorage}>{t("replay.hub.close")}</button>
        </div>
      </header>

      {inventory === null ? (
        <div className="training-hub-empty">
          <div className="replay-loading-spinner" />
          {t("replay.storage.loading")}
        </div>
      ) : (
        <>
          <section
            className="replay-storage-decision"
            data-release-decision={inventory.decision.state}
          >
            <strong>{t("replay.storage.decision", { state: inventory.decision.state })}</strong>
            <span>{t("replay.storage.defaultFlags", { value: inventory.decision.default_flags_enabled ? "ON" : "OFF" })}</span>
            <p>{inventory.decision.reason_codes.join(" · ")}</p>
          </section>

          <section className="replay-storage-alerts" aria-label={t("replay.storage.alerts")}>
            {inventory.alerts.map((alert) => (
              <p
                key={`${alert.category}:${alert.code}`}
                data-alert-severity={alert.severity}
              >
                <strong>{alert.severity} · {alert.code}</strong>
                <span>{alert.message}</span>
              </p>
            ))}
          </section>

          <div className="replay-storage-category-grid">
            {CATEGORY_NAMES.map((name) => {
              const category = inventory.categories[name];
              return (
                <article key={name} data-storage-category={name}>
                  <header>
                    <h3>{categoryLabel(name)}</h3>
                    <strong>{(category.summary.pressure_bps / 100).toFixed(1)}%</strong>
                  </header>
                  <p>
                    {formatBytes(category.summary.local_bytes)} / {formatBytes(category.summary.max_bytes)}
                  </p>
                  <dl>
                    <div><dt>{t("replay.storage.objects")}</dt><dd>{category.summary.object_count}</dd></div>
                    <div><dt>{t("replay.storage.ready")}</dt><dd>{category.summary.ready_count}</dd></div>
                    <div><dt>{t("replay.storage.evicted")}</dt><dd>{category.summary.evicted_count}</dd></div>
                    <div><dt>{t("replay.storage.isolated")}</dt><dd>{category.summary.quarantined_count}</dd></div>
                    <div><dt>{t("replay.storage.protected")}</dt><dd>{category.summary.pinned_count}</dd></div>
                  </dl>
                  {name === "review_evidence" ? (
                    <>
                      <p>{t("replay.storage.archivePinned")}</p>
                      <div className="replay-storage-object-list">
                        {inventory.categories.review_evidence.items.map((item) => (
                          <article key={item.run_id} data-review-storage-run={item.run_id}>
                            <strong>{item.run_id} · {item.run_state}</strong>
                            <span>
                              {t("replay.storage.anchorBytes", { used: formatBytes(item.anchor_bytes), limit: formatBytes(item.anchor_limit_bytes) })}
                            </span>
                            <span>
                              {t("replay.storage.artifactBytes", { used: formatBytes(item.artifact_bytes), limit: formatBytes(item.artifact_limit_bytes) })}
                            </span>
                            <span>{item.protection_reasons.join(" · ")}</span>
                          </article>
                        ))}
                      </div>
                    </>
                  ) : (
                    <StorageObjectRows
                      category={category as ReplayStorageObjectCategory}
                      protocol={
                        (category as ReplayStorageObjectCategory).gc_protocol
                      }
                      runtime={runtime}
                    />
                  )}
                </article>
              );
            })}
          </div>

          <section className="replay-storage-gc" aria-label={t("replay.storage.gc")}>
            <header>
              <h3>{t("replay.storage.gcTitle")}</h3>
              <p>{t("replay.storage.gcHint")}</p>
            </header>
            <div className="replay-storage-gc-form">
              <label>
                {t("replay.storage.category")}
                <select
                  value={gcCategory}
                  disabled={busy}
                  onChange={(event) => setGcCategory(
                    event.target.value as (typeof GC_CATEGORIES)[number],
                  )}
                >
                  {GC_CATEGORIES.map((name) => (
                    <option key={name} value={name}>{categoryLabel(name)}</option>
                  ))}
                </select>
              </label>
              <label>
                {t("replay.storage.targetMib")}
                <input
                  type="number"
                  min={1}
                  max={953_674}
                  value={targetMiB}
                  disabled={busy}
                  onChange={(event) => setTargetMiB(Number(event.target.value))}
                />
              </label>
              <label>
                {t("replay.storage.maxObjects")}
                <input
                  type="number"
                  min={1}
                  max={10_000}
                  value={maxObjects}
                  disabled={busy}
                  onChange={(event) => setMaxObjects(Number(event.target.value))}
                />
              </label>
              <button
                type="button"
                disabled={busy || selected === null || !validRequest}
                onClick={() => {
                  if (selected === null) return;
                  void runtime.actions.planStorageGc(
                    selected.gc_protocol,
                    targetBytes,
                    maxObjects,
                  );
                }}
              >
                {runtime.operation === "storage-plan" ? t("replay.storage.planning") : t("replay.storage.plan")}
              </button>
            </div>

            {runtime.storagePlan !== null && (
              <div
                className="replay-storage-plan"
                data-storage-plan-hash={runtime.storagePlan.plan_hash}
              >
                <p>
                  <strong>{t("replay.storage.planLabel")}</strong> <code>{runtime.storagePlan.plan_hash}</code>
                </p>
                <p>
                  {t("replay.storage.candidatesPlan", {
                    count: runtime.storagePlan.candidates.length,
                    bytes: formatBytes(runtime.storagePlan.estimated_reclaim_bytes),
                    protected: runtime.storagePlan.protected.length,
                  })}
                </p>
                <ul>
                  {runtime.storagePlan.candidates.map((item) => (
                    <li key={item.object_id}>
                      {item.object_id} · {formatBytes(item.byte_size)}
                    </li>
                  ))}
                  {runtime.storagePlan.protected.map((item) => (
                    <li key={`protected:${item.object_id}`}>
                      {t("replay.storage.keep", {
                        id: item.object_id,
                        reasons: item.protection_reasons.join(" / "),
                      })}
                    </li>
                  ))}
                </ul>
                <label className="replay-storage-confirm">
                  <input
                    type="checkbox"
                    checked={runtime.storagePlanConfirmed}
                    disabled={busy}
                    onChange={(event) => runtime.actions.confirmStoragePlan(
                      event.target.checked,
                    )}
                  />
                  {t("replay.storage.confirmHash")}
                </label>
                <button
                  type="button"
                  disabled={busy
                    || !runtime.storagePlanConfirmed
                    || runtime.storagePlan.candidates.length === 0}
                  onClick={() => void runtime.actions.runStorageGc()}
                >
                  {runtime.operation === "storage-run" ? t("replay.storage.running") : t("replay.storage.run")}
                </button>
              </div>
            )}

            {runtime.storageResult !== null && (
              <p className="replay-storage-result" role="status">
                {t("replay.storage.reclaimed", {
                  bytes: formatBytes(runtime.storageResult.reclaimed_bytes),
                  reclaimed: runtime.storageResult.reclaimed.length,
                  skipped: runtime.storageResult.skipped.length,
                })}
              </p>
            )}
          </section>

          <section className="replay-storage-support" aria-label={t("replay.storage.support")}>
            <h3>{t("replay.storage.supportTitle")}</h3>
            <div>
              {inventory.support_matrix.map((support) => (
                <article key={support.mode} data-storage-support={support.mode}>
                  <header>
                    <strong>{support.mode}</strong>
                    <span>{support.production_readiness}</span>
                  </header>
                  <p>{support.source_contract}</p>
                  <p>{support.declared_scope}</p>
                  <p>{support.fidelity}</p>
                  <p>{t("replay.storage.queueExact")}</p>
                  <p>{t("replay.storage.identities", { count: support.observed_identities.length })}</p>
                  <p>{support.reason_codes.join(" · ")}</p>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </section>
  );
}
