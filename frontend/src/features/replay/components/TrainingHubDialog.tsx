import { useEffect, useState } from "react";
import { t, type MessageKey } from "../../../i18n/index.js";
import { useLocale } from "../../../i18n/useLocale.js";
import type { TrainingRunDraft } from "../trainingHubModel.js";
import {
  formatUtcReplayStartInput,
  parseUtcReplayStartInput,
} from "../trainingHubModel.js";
import {
  REPLAY_POLICY_MUTATIONS,
  type ReplayPolicyMutation,
} from "../replayIntegrityModel.js";
import type {
  ReplayV2SourceKind,
  TrainingRunCard,
  TrainingRunCompatibility,
} from "../replayV2Types.js";
import type { TrainingHubRuntime } from "../useTrainingHub.js";
import {
  formatTrainingEquity,
  trainingCompatibilityLabel,
  trainingIntegrityLabel,
  trainingRunStateLabel,
  trainingSourceKindLabel,
  trainingTimeDisclosureLabel,
} from "../trainingHubLabels.js";
import ReplayStorageGovernancePanel from "./ReplayStorageGovernancePanel.js";

const CREATE_SECTIONS: Array<readonly [string, string, MessageKey]> = [
  ["training-hub-create-start", "1", "replay.hub.sectionStart"],
  ["training-hub-create-rules", "2", "replay.hub.sectionRules"],
  ["training-hub-create-advanced", "3", "replay.hub.sectionAdvanced"],
];

export interface TrainingHubDialogProps {
  readonly runtime: TrainingHubRuntime;
  readonly presentation?: "page" | "modal";
  readonly onRequestClose?: () => void;
  readonly launchLabel?: string;
}

function patchDraft(
  runtime: TrainingHubRuntime,
  patch: Partial<TrainingRunDraft>,
): void {
  if (runtime.draft === null) return;
  runtime.actions.setDraft({ ...runtime.draft, ...patch });
}

function trainingRunStatusMessage(card: TrainingRunCard): string {
  if (card.state !== "ENDED") return card.status.message;
  return card.resume_action === "UNAVAILABLE"
    ? t("replay.hub.endedUnavailable")
    : t("replay.hub.endedReviewable");
}

function trainingRunPrimaryActionLabel(card: TrainingRunCard): string {
  if (card.state === "AWAITING_MARKET") return t("replay.hub.selectMarket");
  return card.state === "ENDED" ? t("replay.hub.openReview") : t("replay.hub.continue");
}

export interface TrainingRunDeleteConfirmationProps {
  readonly card: TrainingRunCard;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function TrainingRunDeleteConfirmation({
  card,
  busy,
  onCancel,
  onConfirm,
}: TrainingRunDeleteConfirmationProps) {
  useLocale();
  return (
    <div className="replay-modal-backdrop" role="presentation">
      <section
        className="replay-end-dialog training-hub-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="training-hub-delete-title"
        aria-describedby="training-hub-delete-description"
      >
        <h2 id="training-hub-delete-title">{t("replay.hub.deleteTitle")}</h2>
        <p id="training-hub-delete-description">
          {t("replay.hub.deleteDesc")}
        </p>
        <strong>{card.name}</strong>
        <div className="replay-dialog-actions">
          <button type="button" autoFocus onClick={onCancel}>{t("replay.hub.cancel")}</button>
          <button type="button" disabled={busy} onClick={onConfirm}>
            {t("replay.hub.deleteConfirm")}
          </button>
        </div>
      </section>
    </div>
  );
}

function TrainingRunCreatePanel({ runtime }: TrainingHubDialogProps) {
  useLocale();
  const { draft, evaluation } = runtime;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string>("training-hub-create-start");
  useEffect(() => {
    if (!runtime.createOpen || draft === null || evaluation === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (visible?.target.id) setActiveSection(visible.target.id);
    }, { rootMargin: "-20% 0px -60% 0px", threshold: [0.15, 0.4, 0.7] });
    for (const [id] of CREATE_SECTIONS) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [draft, evaluation, runtime.createOpen]);
  if (!runtime.createOpen) return null;
  if (draft === null || evaluation === null) {
    return (
      <div className="training-hub-create-overlay" role="presentation">
        <section
          className="training-hub-create training-hub-create-loading"
          role="dialog"
          aria-modal="true"
          aria-label={t("replay.hub.createAria")}
        >
          <div className="replay-loading-spinner" />
          <p>{t("replay.hub.createLoading")}</p>
          <button type="button" onClick={runtime.actions.closeCreate}>{t("replay.hub.cancel")}</button>
        </section>
      </div>
    );
  }
  const busy = runtime.operation === "create"
    || runtime.operation === "plan"
    || runtime.operation === "create-context";
  const busyLabel = runtime.operation === "create"
    ? t("replay.hub.creating")
    : runtime.operation === "create-context"
      ? t("replay.hub.validatingCatalog")
      : t("replay.hub.validatingData");
  const toggleMutation = (mutation: ReplayPolicyMutation, checked: boolean) => {
    const next = checked
      ? [...draft.allowedMutations, mutation]
      : draft.allowedMutations.filter((item) => item !== mutation);
    patchDraft(runtime, { allowedMutations: [...new Set(next)] });
  };
  const scrollToSection = (sectionId: string) => {
    if (sectionId === "training-hub-create-advanced") setAdvancedOpen(true);
    setActiveSection(sectionId);
    requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  };
  return (
    <div className="training-hub-create-overlay" role="presentation">
      <section
        className="training-hub-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="training-hub-create-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) runtime.actions.closeCreate();
        }}
      >
        <header className="training-hub-create-top">
          <div>
            <span className="training-hub-kicker">{t("replay.hub.createKicker")}</span>
            <h2 id="training-hub-create-title">{t("replay.hub.createTitle")}</h2>
            <p>{t("replay.hub.createIntro")}</p>
            <nav className="training-hub-create-steps" aria-label={t("replay.hub.createSteps")}>
              {CREATE_SECTIONS.map(([id, number, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={activeSection === id}
                  onClick={() => scrollToSection(id)}
                >
                  <em>{number}</em>{t(label)}
                </button>
              ))}
            </nav>
          </div>
          <button type="button" autoFocus onClick={runtime.actions.closeCreate} disabled={busy}>{t("replay.hub.close")}</button>
        </header>

        <div className="training-hub-create-body">
          <div className="training-hub-create-main">
            <section className="training-hub-form-section" id="training-hub-create-start">
              <header>
                <div><h3>{t("replay.hub.sectionStart")}</h3><p>{t("replay.hub.startHint")}</p></div>
                <span>01</span>
              </header>
              <div className="training-hub-section-body">
                <label className="training-hub-field training-hub-field-wide">
                  <span>{t("replay.hub.archiveName")}</span>
                  <input
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) => patchDraft(runtime, { name: event.target.value })}
                  />
                </label>
                <div className="training-hub-field">
                  <span>{t("replay.hub.sourceKind")}</span>
                  <div className="training-hub-choice-grid" role="group" aria-label={t("replay.hub.sourceKind")}>
                    <button
                      type="button"
                      aria-pressed={draft.sourceKind === "BAR"}
                      disabled={busy}
                      onClick={() => patchDraft(runtime, {
                        sourceKind: "BAR",
                        requestedStartMs: null,
                        randomRangeStartMs: null,
                        randomRangeEndMs: null,
                      })}
                    >
                      <small>BAR</small><strong>{t("replay.source.bar")}</strong><span>{t("replay.hub.barHint")}</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={draft.sourceKind === "AGG_TRADE"}
                      disabled={busy || !runtime.capabilities?.sources.agg_trade.enabled}
                      onClick={() => patchDraft(runtime, {
                        sourceKind: "AGG_TRADE",
                        requestedStartMs: null,
                        randomRangeStartMs: null,
                        randomRangeEndMs: null,
                      })}
                    >
                      <small>AGG_TRADE</small><strong>{t("replay.source.agg")}</strong><span>{t("replay.hub.aggHint")}</span>
                    </button>
                  </div>
                </div>
                <div className="training-hub-field">
                  <span>{t("replay.hub.startMode")}</span>
                  <div className="training-hub-choice-grid" role="group" aria-label={t("replay.hub.startMode")}>
                    <button
                      type="button"
                      aria-pressed={draft.startMode === "RANDOM"}
                      disabled={busy}
                      onClick={() => patchDraft(runtime, {
                        startMode: "RANDOM",
                        requestedStartMs: null,
                      })}
                    >
                      <small>RANDOM</small><strong>{t("replay.hub.randomWindow")}</strong><span>{t("replay.hub.randomHint")}</span>
                    </button>
                    <button
                      type="button"
                      aria-pressed={draft.startMode === "MANUAL"}
                      disabled={busy}
                      onClick={() => patchDraft(runtime, {
                        startMode: "MANUAL",
                        randomRangeStartMs: null,
                        randomRangeEndMs: null,
                      })}
                    >
                      <small>MANUAL</small><strong>{t("replay.hub.manualUtc")}</strong><span>{t("replay.hub.manualHint")}</span>
                    </button>
                  </div>
                </div>
                <div className="training-hub-field-grid">
                  {draft.startMode === "MANUAL" ? (
                    <>
                      <label className="training-hub-field">
                        <span>{t("replay.hub.startUtc")}</span>
                        <input
                          data-training-field="requested-start-utc"
                          type="datetime-local"
                          step={60}
                          value={formatUtcReplayStartInput(draft.requestedStartMs)}
                          onChange={(event) => patchDraft(runtime, {
                            requestedStartMs: parseUtcReplayStartInput(event.target.value),
                          })}
                        />
                      </label>
                      <p className="training-hub-field-warning" role="note">
                        {t("replay.hub.manualWarning")}
                      </p>
                    </>
                  ) : (
                    <>
                      <label className="training-hub-field">
                        <span>{t("replay.hub.randomStart")}</span>
                        <input
                          type="datetime-local"
                          step={60}
                          value={formatUtcReplayStartInput(draft.randomRangeStartMs)}
                          onChange={(event) => patchDraft(runtime, {
                            randomRangeStartMs: parseUtcReplayStartInput(event.target.value),
                          })}
                        />
                      </label>
                      <label className="training-hub-field">
                        <span>{t("replay.hub.randomEnd")}</span>
                        <input
                          type="datetime-local"
                          step={60}
                          value={formatUtcReplayStartInput(draft.randomRangeEndMs)}
                          onChange={(event) => patchDraft(runtime, {
                            randomRangeEndMs: parseUtcReplayStartInput(event.target.value),
                          })}
                        />
                      </label>
                    </>
                  )}
                </div>
                <p className="training-hub-field-note" role="note">
                  {t("replay.hub.t0Note")}
                </p>
                {runtime.catalog !== null && (
                  <p className="training-hub-field-note training-hub-field-note-ok" role="status">
                    {t("replay.hub.catalogReady", { count: runtime.catalog.entries.length })}
                  </p>
                )}
              </div>
            </section>

            <section className="training-hub-form-section" id="training-hub-create-rules">
              <header>
                <div><h3>{t("replay.hub.sectionRules")}</h3><p>{t("replay.hub.rulesHint")}</p></div>
                <span>02</span>
              </header>
              <div className="training-hub-section-body">
                <div className="training-hub-field">
                  <span>{t("replay.hub.integrityMode")}</span>
                  <div className="training-hub-choice-grid training-hub-choice-grid-three" role="group" aria-label={t("replay.hub.integrityMode")}>
                    {([
                      ["CHALLENGE", "replay.hub.challenge", "replay.hub.challengeHint"],
                      ["PRACTICE", "replay.hub.practice", "replay.hub.practiceHint"],
                      ["SANDBOX", "replay.hub.sandbox", "replay.hub.sandboxHint"],
                    ] as const).map(([integrityMode, labelKey, descriptionKey]) => (
                      <button
                        key={integrityMode}
                        type="button"
                        aria-pressed={draft.integrityMode === integrityMode}
                        disabled={busy}
                        onClick={() => patchDraft(runtime, {
                          integrityMode,
                          fundingMode: integrityMode === "SANDBOX" || draft.fundingMode !== "SANDBOX_FIXED"
                            ? draft.fundingMode
                            : "OFF",
                          allowedMutations: integrityMode === "CHALLENGE"
                            ? []
                            : integrityMode === "SANDBOX"
                              ? REPLAY_POLICY_MUTATIONS
                              : ["deposit", "withdraw"],
                        })}
                      >
                        <small>{integrityMode}</small><strong>{t(labelKey)}</strong><span>{t(descriptionKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <label className="training-hub-field training-hub-field-half">
                  <span>{t("replay.hub.timeDisclosure")}</span>
                  <select
                    data-training-field="time-disclosure-policy"
                    value={draft.timeDisclosurePolicy}
                    onChange={(event) => patchDraft(runtime, {
                      timeDisclosurePolicy: event.target.value as TrainingRunDraft["timeDisclosurePolicy"],
                    })}
                  >
                    <option value="NONE">{t("replay.hub.disclosureNone")}</option>
                    <option value="HIDE_YEAR">{t("replay.hub.disclosureYear")}</option>
                    <option value="HIDE_MONTH">{t("replay.hub.disclosureMonth")}</option>
                    <option value="HIDE_DAY">{t("replay.hub.disclosureDay")}</option>
                    <option value="HIDE_HOUR">{t("replay.hub.disclosureHour")}</option>
                    <option value="HIDE_MINUTE">{t("replay.hub.disclosureMinute")}</option>
                    <option value="HIDE_ALL">{t("replay.hub.disclosureAll")}</option>
                  </select>
                </label>
                <fieldset className="training-hub-mutation-policy" disabled={draft.integrityMode !== "PRACTICE" || busy}>
                  <legend>{t("replay.hub.practiceWhitelist")}</legend>
                  <div>
                    {REPLAY_POLICY_MUTATIONS.map((mutation) => (
                      <label key={mutation}>
                        <input
                          type="checkbox"
                          checked={draft.allowedMutations.includes(mutation)}
                          onChange={(event) => toggleMutation(mutation, event.target.checked)}
                        />
                        {mutation}
                      </label>
                    ))}
                  </div>
                  <p>{t("replay.hub.practiceNote")}</p>
                </fieldset>
                <div className="training-hub-field-grid training-hub-field-grid-three">
                  <label className="training-hub-field">
                    <span>{t("replay.hub.initialEquity")}</span>
                    <input inputMode="decimal" value={draft.initialEquity} onChange={(event) => patchDraft(runtime, { initialEquity: event.target.value })} />
                  </label>
                  <label className="training-hub-field">
                    <span>{t("replay.hub.maxLeverage")}</span>
                    <input inputMode="decimal" value={draft.maxLeverage} onChange={(event) => patchDraft(runtime, { maxLeverage: event.target.value })} />
                  </label>
                  <label className="training-hub-field">
                    <span>{t("replay.hub.marginMode")}</span>
                    <select value={draft.marginMode} onChange={(event) => patchDraft(runtime, { marginMode: event.target.value as TrainingRunDraft["marginMode"] })}>
                      <option value="CROSS">{t("replay.hub.cross")}</option>
                      <option value="ISOLATED">{t("replay.hub.isolated")}</option>
                    </select>
                  </label>
                </div>
                <label className="training-hub-field">
                  <span>{t("replay.hub.positionMode")}</span>
                  <select
                    value={draft.positionMode}
                    onChange={(event) => {
                      const positionMode = event.target.value as TrainingRunDraft["positionMode"];
                      patchDraft(runtime, {
                        positionMode,
                        ...(positionMode === "HEDGE" ? {
                          accountDataMode: "DETERMINISTIC_SIMULATION",
                          fundingMode: "OFF",
                        } : draft.accountDataMode === "DETERMINISTIC_SIMULATION" ? {
                          accountDataMode: "APPROX_PROXY",
                          fundingMode: draft.fundingMode === "HISTORICAL_EXACT" ? "OFF" : draft.fundingMode,
                        } : {}),
                      });
                    }}
                  >
                    <option value="ONE_WAY">{t("replay.hub.oneWay")}</option>
                    <option value="HEDGE">{t("replay.hub.hedge")}</option>
                  </select>
                  <small>{t("replay.hub.hedgeNote")}</small>
                </label>
                <div className="training-hub-capability-boundary" aria-label={t("replay.hub.marketInRun")}>
                  <h3>{t("replay.hub.marketInRun")}</h3>
                  <p>{t("replay.hub.marketInRunDesc")}</p>
                  <p>{t("replay.hub.hedgeBind")}</p>
                </div>
              </div>
            </section>

            <details
              className="training-hub-advanced"
              id="training-hub-create-advanced"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>{t("replay.hub.advancedSummary")}</summary>
            <section className="training-hub-form-section" id="training-hub-create-history">
              <header>
                <div><h3>{t("replay.hub.historyWindow")}</h3><p>{t("replay.hub.historyHint")}</p></div>
                <span>03</span>
              </header>
              <div className="training-hub-section-body">
                <div className="training-hub-field-grid training-hub-field-grid-three">
                  <label className="training-hub-field">
                    <span>{t("replay.hub.warmupBars")}</span>
                    <input
                      type="number"
                      min={1}
                      value={draft.indicatorWarmupBars}
                      onChange={(event) => patchDraft(runtime, {
                        indicatorWarmupBars: Number(event.target.value),
                      })}
                    />
                    <small>{t("replay.hub.warmupHint")}</small>
                  </label>
                  <label className="training-hub-field">
                    <span>{t("replay.hub.forwardCache")}</span>
                    <input
                      data-training-field="forward-cache-ms"
                      type="number"
                      min={1}
                      value={draft.forwardCacheMs}
                      onChange={(event) => patchDraft(runtime, { forwardCacheMs: Number(event.target.value) })}
                    />
                  </label>
                  <label className="training-hub-field">
                    <span>{t("replay.hub.visibleHistory")}</span>
                    <select
                      value={draft.visibleHistoryMode}
                      onChange={(event) => {
                        const mode = event.target.value as TrainingRunDraft["visibleHistoryMode"];
                        patchDraft(runtime, {
                          visibleHistoryMode: mode,
                          visibleHistoryLookbackMs: mode === "ALL_AVAILABLE"
                            ? null
                            : draft.visibleHistoryLookbackMs ?? draft.indicatorWarmupBars * 60 * 1_000,
                        });
                      }}
                    >
                      <option value="ALL_AVAILABLE">{t("replay.hub.allAvailable")}</option>
                      <option value="DURATION">{t("replay.hub.fixedDuration")}</option>
                    </select>
                  </label>
                </div>
                {draft.visibleHistoryMode === "ALL_AVAILABLE" ? (
                  <p className="training-hub-field-note">
                    {t("replay.hub.pageLikeLive")}
                  </p>
                ) : (
                  <label className="training-hub-field training-hub-field-half">
                    <span>{t("replay.hub.visibleMs")}</span>
                    <input
                      type="number"
                      min={60_000}
                      step={60_000}
                      value={draft.visibleHistoryLookbackMs ?? ""}
                      onChange={(event) => patchDraft(runtime, {
                        visibleHistoryLookbackMs: Number(event.target.value),
                      })}
                    />
                    <small>{t("replay.hub.visibleMsHint")}</small>
                  </label>
                )}
              </div>
            </section>

            <section className="training-hub-form-section" id="training-hub-create-account">
              <header>
                <div><h3>{t("replay.hub.accountExec")}</h3><p>{t("replay.hub.accountExecHint")}</p></div>
                <span>04</span>
              </header>
              <div className="training-hub-section-body">
                <div className="training-hub-field-grid">
                  <label className="training-hub-field">
                    <span>{t("replay.hub.accountData")}</span>
                    <select
                      value={draft.accountDataMode}
                      onChange={(event) => {
                        const accountDataMode = event.target.value as TrainingRunDraft["accountDataMode"];
                        patchDraft(runtime, {
                          accountDataMode,
                          fundingMode: accountDataMode === "HISTORICAL_EXACT"
                            ? draft.fundingMode === "SANDBOX_FIXED" ? "OFF" : draft.fundingMode
                            : draft.fundingMode === "HISTORICAL_EXACT" ? "OFF" : draft.fundingMode,
                        });
                      }}
                    >
                      {draft.positionMode === "HEDGE" ? (
                        <option value="DETERMINISTIC_SIMULATION">{t("replay.hub.accountData.deterministicSimulation")}</option>
                      ) : (
                        <>
                          <option value="APPROX_PROXY">{t("replay.hub.accountData.approxProxy")}</option>
                          <option value="HISTORICAL_EXACT">{t("replay.hub.accountData.historicalExact")}</option>
                        </>
                      )}
                    </select>
                    <small>{t("replay.hub.hedgeAccountHint")}</small>
                  </label>
                  <label className="training-hub-field">
                    <span>{t("replay.hub.fundingMode")}</span>
                    <select value={draft.fundingMode} onChange={(event) => patchDraft(runtime, { fundingMode: event.target.value as TrainingRunDraft["fundingMode"] })}>
                      <option value="OFF">{t("replay.hub.modeOff")}</option>
                      {draft.integrityMode === "SANDBOX" && <option value="SANDBOX_FIXED">{t("replay.hub.fundingMode.sandboxFixed")}</option>}
                      {(draft.accountDataMode === "HISTORICAL_EXACT" || draft.accountDataMode === "DETERMINISTIC_SIMULATION") && (
                        <option value="HISTORICAL_EXACT">{t("replay.hub.fundingMode.historicalExact")}</option>
                      )}
                    </select>
                  </label>
                  <label className="training-hub-field">
                    <span>{t("replay.hub.bookMode")}</span>
                    <select value={draft.bookMode} onChange={(event) => patchDraft(runtime, { bookMode: event.target.value as TrainingRunDraft["bookMode"] })}>
                      <option value="OFF">{t("replay.hub.bookMode.off")}</option>
                      <option value="BOOK_ASSISTED_REQUIRED">{t("replay.hub.bookMode.assistedRequired")}</option>
                    </select>
                    <small>{t("replay.hub.bookHint")}</small>
                  </label>
                  {draft.fundingMode === "SANDBOX_FIXED" && (
                    <>
                      <label className="training-hub-field">
                        <span>{t("replay.hub.fixedFunding")}</span>
                        <input inputMode="decimal" value={draft.fixedFundingRate} onChange={(event) => patchDraft(runtime, { fixedFundingRate: event.target.value })} />
                      </label>
                      <label className="training-hub-field">
                        <span>{t("replay.hub.fundingInterval")}</span>
                        <input type="number" min={60_000} max={30 * 86_400_000} value={draft.fundingIntervalMs} onChange={(event) => patchDraft(runtime, { fundingIntervalMs: Number(event.target.value) })} />
                      </label>
                    </>
                  )}
                  <label className="training-hub-field">
                    <span>{t("replay.hub.makerTakerBps")}</span>
                    <span className="training-hub-inline-inputs">
                      <input inputMode="decimal" value={draft.makerFeeBps} aria-label={t("replay.integrity.makerBps")} onChange={(event) => patchDraft(runtime, { makerFeeBps: event.target.value })} />
                      <input inputMode="decimal" value={draft.takerFeeBps} aria-label={t("replay.integrity.takerBps")} onChange={(event) => patchDraft(runtime, { takerFeeBps: event.target.value })} />
                    </span>
                  </label>
                  <label className="training-hub-field">
                    <span>{t("replay.hub.slippage")}</span>
                    <input inputMode="decimal" value={draft.marketSlippageBps} onChange={(event) => patchDraft(runtime, { marketSlippageBps: event.target.value })} />
                  </label>
                </div>
              </div>
            </section>
            </details>
          </div>

          <aside className="training-hub-create-side">
            <div className="training-hub-create-side-scroll">
              <section className="training-hub-summary-card">
                <h3>{t("replay.hub.summary")}</h3>
                <strong>{draft.name || t("replay.hub.unnamed")}</strong>
                <dl>
                  <div><dt>{t("replay.hub.sourceKind")}</dt><dd>{trainingSourceKindLabel(draft.sourceKind)}</dd></div>
                  <div><dt>{t("replay.hub.start")}</dt><dd>{draft.startMode === "RANDOM" ? t("replay.hub.randomStartMode") : t("replay.hub.manualStartMode")}</dd></div>
                  <div><dt>{t("replay.hub.integrity")}</dt><dd>{trainingIntegrityLabel(draft.integrityMode)}</dd></div>
                  <div><dt>{t("replay.hub.timeDisclosure")}</dt><dd>{trainingTimeDisclosureLabel(draft.timeDisclosurePolicy)}</dd></div>
                  <div><dt>{t("replay.hub.equityLeverage")}</dt><dd>{draft.initialEquity} · {draft.maxLeverage}×</dd></div>
                  <div><dt>{t("replay.hub.posMargin")}</dt><dd>{draft.positionMode === "HEDGE" ? t("replay.hub.hedgeShort") : t("replay.hub.oneWayShort")} · {draft.marginMode === "ISOLATED" ? t("replay.hub.isolatedShort") : t("replay.hub.crossShort")}</dd></div>
                  <div><dt>{t("replay.hub.symbol")}</dt><dd>{t("replay.hub.pickAfterRun")}</dd></div>
                </dl>
              </section>
              <section className="training-hub-summary-card">
                <h3>{t("replay.hub.boundary")}</h3>
                <dl>
                  <div><dt>{t("replay.hub.accountHistory")}</dt><dd>{evaluation.unsupported.account_history}</dd></div>
                  <div><dt>{t("replay.hub.funding")}</dt><dd>{evaluation.unsupported.funding}</dd></div>
                  <div><dt>{t("replay.hub.book")}</dt><dd>{evaluation.unsupported.historical_l2}</dd></div>
                  <div><dt>{t("replay.hub.ruleChanges")}</dt><dd>{evaluation.unsupported.rule_changes}</dd></div>
                  <div><dt>{t("replay.hub.isolatedMargin")}</dt><dd>{evaluation.unsupported.isolated_margin}</dd></div>
                </dl>
              </section>
              {evaluation.errors.length > 0 && (
                <div className="replay-error-summary" role="alert">
                  {evaluation.errors.map((message) => <span key={message}>{message}</span>)}
                </div>
              )}
            </div>
            <div className="training-hub-create-actions">
              <button
                className="replay-primary-action"
                type="button"
                disabled={!evaluation.canSubmit || busy}
                onClick={() => void runtime.actions.createRun(draft)}
              >
                {busy ? busyLabel : t("replay.hub.submit")}
              </button>
              <button type="button" onClick={runtime.actions.closeCreate} disabled={busy}>{t("replay.hub.cancel")}</button>
              <p>{t("replay.hub.submitNote")}</p>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

export default function TrainingHubDialog({
  runtime,
  presentation = "page",
  onRequestClose,
  launchLabel,
}: TrainingHubDialogProps) {
  useLocale();
  const busy = runtime.operation !== null;
  const modal = presentation === "modal";
  const [deleteCandidate, setDeleteCandidate] = useState<TrainingRunCard | null>(
    null,
  );
  const loadedRunCount = runtime.items.length;
  const resumableRunCount = runtime.items.filter((card) => (
    card.resume_action !== "UNAVAILABLE" && card.state !== "ENDED"
  )).length;
  const activeRunCount = runtime.items.filter((card) => (
    card.state === "PLAYING" || card.state === "ADVANCING"
  )).length;
  const completedRunCount = runtime.items.filter((card) => card.state === "ENDED").length;
  return (
    <main
      className={`training-hub-page ${modal ? "training-hub-modal-surface" : ""}`}
      role="dialog"
      aria-modal={modal}
      aria-labelledby="training-hub-title"
      data-training-hub-phase={runtime.phase}
      data-training-hub-presentation={presentation}
    >
      <section className="training-hub-shell">
        <header className="training-hub-heading">
          <div className="training-hub-brand">
            <div className="training-hub-brand-mark" aria-hidden="true">R2</div>
            <div>
              <span className="training-hub-kicker">{t("replay.hub.kicker")}</span>
              <h1 id="training-hub-title">{t("replay.hub.title")}</h1>
              <p>
                {launchLabel ?? t("replay.hub.subtitle")}
              </p>
            </div>
          </div>
          <div className="training-hub-heading-actions">
            <button type="button" onClick={() => void runtime.actions.openStorage()} disabled={busy}>
              {t("replay.hub.storage")}
            </button>
            {modal ? (
              <button type="button" onClick={onRequestClose}>{t("replay.hub.close")}</button>
            ) : (
              <a href="/" target="_blank" rel="noopener noreferrer">{t("replay.hub.live")}</a>
            )}
            <button type="button" onClick={runtime.actions.refresh} disabled={busy}>{t("replay.hub.refresh")}</button>
            <button className="training-hub-primary-button" type="button" onClick={() => void runtime.actions.openCreate()} disabled={busy}>
              {t("replay.hub.new")}
            </button>
          </div>
        </header>

        <section className="training-hub-stats" aria-label={t("replay.hub.overview")}>
          <article data-tone="violet"><span>{t("replay.hub.statsAll")}</span><strong>{loadedRunCount}</strong><small>{t("replay.hub.statsAllHint")}</small></article>
          <article data-tone="amber"><span>{t("replay.hub.statsResume")}</span><strong>{resumableRunCount}</strong><small>{t("replay.hub.statsResumeHint")}</small></article>
          <article data-tone="green"><span>{t("replay.hub.statsActive")}</span><strong>{activeRunCount}</strong><small>{t("replay.hub.statsActiveHint")}</small></article>
          <article data-tone="cyan"><span>{t("replay.hub.statsEnded")}</span><strong>{completedRunCount}</strong><small>{t("replay.hub.statsEndedHint")}</small></article>
        </section>

        <div className="training-hub-toolbar">
          <div className="training-hub-filters" aria-label={t("replay.hub.filterStatus")}>
            <div className="training-hub-filter-chips" role="group" aria-label={t("replay.hub.filterStatus")}>
              {([
                [null, "replay.hub.all"],
                ["AWAITING_MARKET", "replay.state.awaiting"],
                ["PAUSED", "replay.hub.pausedChip"],
                ["PLAYING", "replay.state.playing"],
                ["ENDED", "replay.state.ended"],
              ] as const).map(([state, labelKey]) => (
                <button
                  key={labelKey}
                  type="button"
                  aria-pressed={runtime.filters.state === state}
                  onClick={() => runtime.actions.setFilters({ ...runtime.filters, state })}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
            <label>
              {t("replay.hub.filterSource")}
              <select
                value={runtime.filters.sourceKind ?? ""}
                onChange={(event) => runtime.actions.setFilters({
                  ...runtime.filters,
                  sourceKind: event.target.value === "" ? null : event.target.value as ReplayV2SourceKind,
                })}
              >
                <option value="">{t("replay.hub.all")}</option>
                <option value="BAR">{t("replay.source.bar")}</option>
                <option value="AGG_TRADE">{t("replay.source.agg")}</option>
              </select>
            </label>
            <label>
              {t("replay.hub.filterCompat")}
              <select
                value={runtime.filters.compatibility ?? ""}
                onChange={(event) => runtime.actions.setFilters({
                  ...runtime.filters,
                  compatibility: event.target.value === ""
                    ? null
                    : event.target.value as TrainingRunCompatibility,
                })}
              >
                <option value="">{t("replay.hub.all")}</option>
                <option value="READY">{t("replay.compat.ready")}</option>
                <option value="UNAVAILABLE">{t("replay.compat.blocked")}</option>
              </select>
            </label>
          </div>
          <span className="training-hub-toolbar-meta">
            {t("replay.hub.loaded", { count: loadedRunCount })}{runtime.nextCursor !== null ? t("replay.hub.hasNext") : t("replay.hub.endOfList")}
          </span>
        </div>

        {runtime.error !== null && (
          <div className="replay-error-summary" role="alert">
            <strong>{runtime.error.code}</strong>
            <span>{runtime.error.message}</span>
            {runtime.error.code === "CATALOG_EPOCH_MISMATCH" && (
              <button type="button" onClick={() => void runtime.actions.openCreate()}>
                {t("replay.hub.revalidate")}
              </button>
            )}
          </div>
        )}

        {runtime.phase === "LOADING" && runtime.items.length === 0 ? (
          <div className="training-hub-empty"><div className="replay-loading-spinner" />{t("replay.hub.loading")}</div>
        ) : runtime.items.length === 0 ? (
          <div className="training-hub-empty">
            <div className="training-hub-empty-mark" aria-hidden="true">R2</div>
            <strong>{t("replay.hub.emptyTitle")}</strong>
            <span>{t("replay.hub.emptyHint")}</span>
            <button type="button" onClick={() => void runtime.actions.openCreate()} disabled={busy}>{t("replay.hub.emptyCreate")}</button>
          </div>
        ) : (
          <div className="training-hub-card-grid" aria-label={t("replay.hub.list")}>
            {runtime.items.map((card) => (
              <article className="training-hub-card" data-state={card.state} key={card.run_id}>
                <header className="training-hub-card-head">
                  <div>
                    <span>{t("replay.hub.cardKicker", { mode: trainingIntegrityLabel(card.integrity_mode) })}</span>
                    <h2>{card.name}</h2>
                  </div>
                  <strong className="training-hub-state-badge" data-run-state={card.state}>{trainingRunStateLabel(card.state)}</strong>
                </header>
                <div className="training-hub-card-hero">
                  {card.state === "AWAITING_MARKET" || card.last_symbol === null ? (
                    <>
                      <span>{t("replay.hub.currentSymbol")}</span>
                      <strong>{t("replay.hub.noSymbol")}</strong>
                    </>
                  ) : (
                    <>
                      <span>{t("replay.hub.equity")}</span>
                      <strong>
                        {card.equity_status === "CURRENT" && card.equity !== null
                          ? formatTrainingEquity(card.equity)
                          : card.equity_status}
                        {card.equity_status === "CURRENT" && <small>{card.settlement_asset}</small>}
                      </strong>
                    </>
                  )}
                </div>
                <dl className="training-hub-card-meta">
                  <div><dt>{t("replay.hub.accountSymbol")}</dt><dd>{card.last_symbol ?? t("replay.hub.unselected")}{card.subscribed_track_count > 0 ? t("replay.hub.activeTracks", { count: card.subscribed_track_count }) : ""}</dd></div>
                  <div><dt>{t("replay.hub.sourceKind")}</dt><dd>{trainingSourceKindLabel(card.source_kind)}</dd></div>
                  <div><dt>{t("replay.hub.progress")}</dt><dd>#{card.progress.source_sequence}</dd></div>
                  <div><dt>{t("replay.hub.timeDisclosure")}</dt><dd>{trainingTimeDisclosureLabel(card.time_disclosure_policy)}</dd></div>
                  <div><dt>{t("replay.hub.compat")}</dt><dd>{trainingCompatibilityLabel(card.compatibility)}</dd></div>
                  <div><dt>{t("replay.hub.integrity")}</dt><dd>{trainingIntegrityLabel(card.integrity_mode)}</dd></div>
                </dl>
                <p className="training-hub-card-message">{trainingRunStatusMessage(card)}</p>
                <footer className="training-hub-card-actions">
                  <button
                    className="training-hub-primary-button"
                    type="button"
                    disabled={busy || card.resume_action === "UNAVAILABLE"}
                    onClick={() => runtime.actions.continueRun(card)}
                  >
                    {trainingRunPrimaryActionLabel(card)}
                  </button>
                  <button
                    className="training-hub-delete-action"
                    type="button"
                    disabled={busy}
                    onClick={() => setDeleteCandidate(card)}
                  >
                    {t("replay.hub.delete")}
                  </button>
                </footer>
              </article>
            ))}
          </div>
        )}
        {runtime.nextCursor !== null && (
          <div className="training-hub-load-more-wrap">
            <button
              className="training-hub-load-more"
              type="button"
              disabled={busy}
              onClick={runtime.actions.loadNext}
            >
              {t("replay.hub.loadMore")}
            </button>
          </div>
        )}
        <TrainingRunCreatePanel runtime={runtime} />
        <ReplayStorageGovernancePanel runtime={runtime} />
      </section>
      {deleteCandidate !== null && (
        <TrainingRunDeleteConfirmation
          card={deleteCandidate}
          busy={busy}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={() => {
            const runId = deleteCandidate.run_id;
            setDeleteCandidate(null);
            void runtime.actions.deleteRun(runId);
          }}
        />
      )}
    </main>
  );
}
