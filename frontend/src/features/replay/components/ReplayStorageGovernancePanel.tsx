import { useState } from "react";

import type {
  ReplayStorageCategoryName,
  ReplayStorageGcProtocol,
  ReplayStorageObjectCategory,
  ReplayStorageObjectItem,
} from "../replayStorageModel.js";
import type { TrainingHubRuntime } from "../useTrainingHub.js";


const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

const CATEGORY_LABELS: Readonly<Record<ReplayStorageCategoryName, string>> = {
  segments: "BAR / AGG segments",
  historical_books: "历史 BOOK",
  account_history: "Exact account history",
  review_evidence: "Review / Fork 证据",
};

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
  if (category.items.length === 0) return <p>当前没有已登记对象。</p>;
  return (
    <div className="replay-storage-object-list">
      {category.items.map((item) => (
        <article key={item.object_id} data-storage-object={item.object_id}>
          <header>
            <strong>{identityLabel(item)}</strong>
            <span data-storage-health={item.health}>{item.health}</span>
          </header>
          <dl>
            <div><dt>对象</dt><dd><code>{item.object_id}</code></dd></div>
            <div><dt>占用</dt><dd>{formatBytes(item.byte_size)}</dd></div>
            <div><dt>引用</dt><dd>{item.active_ref_count}</dd></div>
            <div><dt>恢复</dt><dd>{item.recoverability}</dd></div>
          </dl>
          <p>
            {item.protection_reasons.length === 0
              ? "当前无保护理由；仍须先生成 dry-run。"
              : `保护：${item.protection_reasons.join(" · ")}`}
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
              按 checksum 重新水化
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
      aria-label="Replay 存储管理"
      data-replay-storage-phase={runtime.operation ?? "ready"}
    >
      <header className="replay-storage-heading">
        <div>
          <span className="training-hub-kicker">DRY-RUN FIRST · HASH-BOUND GC</span>
          <h2>存储管理</h2>
          <p>路径、真实时间范围和 checksum 不进入此页面；Review/Fork 证据不提供 GC。</p>
        </div>
        <div>
          <button type="button" disabled={busy} onClick={() => void runtime.actions.refreshStorage()}>
            刷新库存
          </button>
          <button type="button" onClick={runtime.actions.closeStorage}>关闭</button>
        </div>
      </header>

      {inventory === null ? (
        <div className="training-hub-empty">
          <div className="replay-loading-spinner" />
          正在按需读取脱敏库存…
        </div>
      ) : (
        <>
          <section
            className="replay-storage-decision"
            data-release-decision={inventory.decision.state}
          >
            <strong>生产决策：{inventory.decision.state}</strong>
            <span>默认开关：{inventory.decision.default_flags_enabled ? "ON" : "OFF"}</span>
            <p>{inventory.decision.reason_codes.join(" · ")}</p>
          </section>

          <section className="replay-storage-alerts" aria-label="存储告警">
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
            {(Object.keys(CATEGORY_LABELS) as ReplayStorageCategoryName[]).map((name) => {
              const category = inventory.categories[name];
              return (
                <article key={name} data-storage-category={name}>
                  <header>
                    <h3>{CATEGORY_LABELS[name]}</h3>
                    <strong>{(category.summary.pressure_bps / 100).toFixed(1)}%</strong>
                  </header>
                  <p>
                    {formatBytes(category.summary.local_bytes)} / {formatBytes(category.summary.max_bytes)}
                  </p>
                  <dl>
                    <div><dt>对象</dt><dd>{category.summary.object_count}</dd></div>
                    <div><dt>READY</dt><dd>{category.summary.ready_count}</dd></div>
                    <div><dt>EVICTED</dt><dd>{category.summary.evicted_count}</dd></div>
                    <div><dt>隔离</dt><dd>{category.summary.quarantined_count}</dd></div>
                    <div><dt>受保护</dt><dd>{category.summary.pinned_count}</dd></div>
                  </dl>
                  {name === "review_evidence" ? (
                    <>
                      <p>Run archive evidence 永久受保护；本阶段没有删除入口。</p>
                      <div className="replay-storage-object-list">
                        {inventory.categories.review_evidence.items.map((item) => (
                          <article key={item.run_id} data-review-storage-run={item.run_id}>
                            <strong>{item.run_id} · {item.run_state}</strong>
                            <span>
                              anchor {formatBytes(item.anchor_bytes)} / {formatBytes(item.anchor_limit_bytes)}
                            </span>
                            <span>
                              artifact {formatBytes(item.artifact_bytes)} / {formatBytes(item.artifact_limit_bytes)}
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

          <section className="replay-storage-gc" aria-label="存储 GC 预演">
            <header>
              <h3>GC 预演与执行</h3>
              <p>每个类别单独执行；任何库存、pin 或 generation 漂移都会使旧 plan hash 失效。</p>
            </header>
            <div className="replay-storage-gc-form">
              <label>
                类别
                <select
                  value={gcCategory}
                  disabled={busy}
                  onChange={(event) => setGcCategory(
                    event.target.value as (typeof GC_CATEGORIES)[number],
                  )}
                >
                  {GC_CATEGORIES.map((name) => (
                    <option key={name} value={name}>{CATEGORY_LABELS[name]}</option>
                  ))}
                </select>
              </label>
              <label>
                目标回收 MiB
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
                最多对象
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
                {runtime.operation === "storage-plan" ? "正在预演…" : "生成 dry-run"}
              </button>
            </div>

            {runtime.storagePlan !== null && (
              <div
                className="replay-storage-plan"
                data-storage-plan-hash={runtime.storagePlan.plan_hash}
              >
                <p>
                  <strong>计划</strong> <code>{runtime.storagePlan.plan_hash}</code>
                </p>
                <p>
                  候选 {runtime.storagePlan.candidates.length} 个，预计回收{" "}
                  {formatBytes(runtime.storagePlan.estimated_reclaim_bytes)}；
                  protected {runtime.storagePlan.protected.length} 个。
                </p>
                <ul>
                  {runtime.storagePlan.candidates.map((item) => (
                    <li key={item.object_id}>
                      {item.object_id} · {formatBytes(item.byte_size)}
                    </li>
                  ))}
                  {runtime.storagePlan.protected.map((item) => (
                    <li key={`protected:${item.object_id}`}>
                      {item.object_id} · 不删除 · {item.protection_reasons.join(" / ")}
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
                  我已核对上述 exact plan hash；执行前服务端仍须重新计算并完全匹配。
                </label>
                <button
                  type="button"
                  disabled={busy
                    || !runtime.storagePlanConfirmed
                    || runtime.storagePlan.candidates.length === 0}
                  onClick={() => void runtime.actions.runStorageGc()}
                >
                  {runtime.operation === "storage-run" ? "正在执行…" : "执行此计划"}
                </button>
              </div>
            )}

            {runtime.storageResult !== null && (
              <p className="replay-storage-result" role="status">
                已回收 {formatBytes(runtime.storageResult.reclaimed_bytes)}；
                reclaimed {runtime.storageResult.reclaimed.length}，
                skipped {runtime.storageResult.skipped.length}。
              </p>
            )}
          </section>

          <section className="replay-storage-support" aria-label="真实来源支持清单">
            <h3>真实来源与 fidelity</h3>
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
                  <p>queue exact：否</p>
                  <p>已观察 identity：{support.observed_identities.length}</p>
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
