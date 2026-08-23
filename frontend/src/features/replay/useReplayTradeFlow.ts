import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";

import {
  addReplayTradeFlowDecimals,
  type ReplayTradeFlowState,
  type ReplayTradeFlowTapeItem,
} from "./replayTradeFlow.js";
import { defaultReplayV2Api } from "./replayV2Api.js";

export interface ReplayTradeFlowRuntime {
  readonly state: ReplayTradeFlowState;
  readonly tape: readonly ReplayTradeFlowTapeItem[];
  readonly cvd: string;
  readonly pageDelta: string;
  readonly fidelity: string;
  readonly error: string | null;
}

export function useReplayTradeFlow({
  runId,
  trackId,
  sourceKind,
  revealedSequence,
}: {
  readonly runId: string | null;
  readonly trackId: string | null;
  readonly sourceKind: string | null;
  readonly revealedSequence: number;
}): ReplayTradeFlowRuntime {
  const [view, setView] = useState<ReplayTradeFlowRuntime & { readonly key: string }>({
    key: "unavailable",
    state: "LOADING", tape: [], cvd: "0", pageDelta: "0", fidelity: "--", error: null,
  });
  const cursorRef = useRef<{
    key: string;
    sequence: number;
    epoch: string;
    cvd: string;
    tape: readonly ReplayTradeFlowTapeItem[];
  } | null>(null);
  const key = runId !== null && trackId !== null ? `${runId}:${trackId}` : "unavailable";

  useEffect(() => {
    if (sourceKind !== "agg_trade" || runId === null || trackId === null) {
      cursorRef.current = null;
      return;
    }
    const abort = new AbortController();
    const current = cursorRef.current;
    const incrementalCursor = current?.key === key
      && current.sequence <= revealedSequence
      && revealedSequence - current.sequence <= 200
      ? current
      : null;
    const afterSequence = incrementalCursor?.sequence;
    void defaultReplayV2Api.tradeFlowRun(
      runId,
      {
        trackId,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        limit: 200,
      },
      abort.signal,
    ).then((page) => {
      if (incrementalCursor !== null && page.continuity.after_sequence !== incrementalCursor.sequence) {
        throw new Error("REPLAY_TRADE_FLOW_RESYNC_REQUIRED");
      }
      if (incrementalCursor !== null && page.continuity.data_epoch !== incrementalCursor.epoch) {
        throw new Error("REPLAY_TRADE_FLOW_DATA_EPOCH_CHANGED");
      }
      const nextTape = [
        ...(incrementalCursor?.tape ?? []),
        ...page.tape,
      ].slice(-200);
      const nextCvd = nextTape.reduce(
        (sum, item) => addReplayTradeFlowDecimals(sum, item.cvd_delta),
        "0",
      );
      cursorRef.current = {
        key,
        sequence: page.next_cursor.source_sequence,
        epoch: page.next_cursor.data_epoch,
        cvd: nextCvd,
        tape: nextTape,
      };
      setView({
        key,
        state: "CONTIGUOUS",
        tape: nextTape,
        cvd: nextCvd,
        pageDelta: page.page_flow.delta,
        fidelity: page.fidelity,
        error: null,
      });
    }).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      cursorRef.current = null;
      setView({
        key,
        state: "DEGRADED",
        tape: [],
        cvd: "0",
        pageDelta: "0",
        fidelity: "CLEARED_FAIL_CLOSED",
        error: cause instanceof Error ? cause.message : t("replay.dock.flowFail"),
      });
    });
    return () => abort.abort();
  }, [key, revealedSequence, runId, sourceKind, trackId]);

  if (sourceKind !== "agg_trade" || runId === null || trackId === null) {
    return {
      state: "UNSUPPORTED_SOURCE_MODE",
      tape: [],
      cvd: "0",
      pageDelta: "0",
      fidelity: "BAR_HAS_NO_AGGREGATE_TRADE_TAPE",
      error: null,
    };
  }
  if (view.key !== key) {
    return {
      state: "LOADING",
      tape: [],
      cvd: "0",
      pageDelta: "0",
      fidelity: "--",
      error: null,
    };
  }
  return view;
}
