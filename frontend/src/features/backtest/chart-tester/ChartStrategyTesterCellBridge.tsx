import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import type { ChartSession } from "../../chart-session/chartSessionTypes.js";
import type { ChartStrategyAttachmentRecord } from "../../chart-workspace/chartWorkspaceTypes.js";
import { ChartStrategyTesterRuntimeFactory } from "./ChartStrategyTesterRuntime.js";
import {
  getChartStrategyDraftStore,
  strategyDraftContentRevision,
} from "./chartStrategyTesterDrafts.js";
import type {
  ChartStrategyRunRequest,
  ChartStrategyTesterEntryState,
} from "./chartStrategyTesterUiModel.js";
import ChartStrategyTesterPanel from "./ChartStrategyTesterPanel.js";
import "./chartStrategyTester.css";

const runtimeFactory = new ChartStrategyTesterRuntimeFactory(true);

export interface ChartStrategyTesterCellBridgeProps {
  workspaceId: string;
  cellId: string;
  session: ChartSession;
  attachment: ChartStrategyAttachmentRecord | null;
  active: boolean;
  panelOpen: boolean;
  bottomPanelHost: HTMLElement | null;
  onAttachmentChange(attachment: ChartStrategyAttachmentRecord | null): void;
  onEntryStateChange(state: ChartStrategyTesterEntryState): void;
  onClosePanel(): void;
}

export default function ChartStrategyTesterCellBridge({
  workspaceId,
  cellId,
  session,
  attachment,
  active,
  panelOpen,
  bottomPanelHost,
  onAttachmentChange,
  onEntryStateChange,
  onClosePanel,
}: ChartStrategyTesterCellBridgeProps) {
  const draftStore = useMemo(() => getChartStrategyDraftStore(), []);
  const [loadedDraftRevision, setLoadedDraftRevision] = useState<{
    draftId: string;
    revision: number | null;
  } | null>(null);
  const activeDraftId = attachment?.strategyDraftId ?? null;
  const draftContentRevision = activeDraftId !== null
    && loadedDraftRevision?.draftId === activeDraftId
    ? loadedDraftRevision.revision
    : null;
  useEffect(() => {
    runtimeFactory.activate({
      workspaceId,
      cellId,
      attachment,
      session,
      draftContentRevision,
      editorOpen: active && panelOpen,
    });
  }, [active, attachment, cellId, draftContentRevision, panelOpen, session, workspaceId]);

  useEffect(() => {
    const draftId = attachment?.strategyDraftId;
    if (!draftId) return undefined;
    let cancelled = false;
    void draftStore.load(draftId).then((view) => {
      if (cancelled) return;
      setLoadedDraftRevision({
        draftId,
        revision: view.record ? strategyDraftContentRevision(view.record.source) : null,
      });
    });
    const unsubscribe = draftStore.subscribe((id, view) => {
      if (id === draftId) {
        setLoadedDraftRevision({
          draftId,
          revision: view.record ? strategyDraftContentRevision(view.record.source) : null,
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [attachment?.strategyDraftId, draftStore]);

  useEffect(() => () => {
    runtimeFactory.release(workspaceId, cellId);
  }, [cellId, workspaceId]);

  const handleRunRequest = useCallback((_request: ChartStrategyRunRequest) => {
    void _request;
    const runtime = runtimeFactory.get(workspaceId, cellId);
    if (!runtime) return;
    const token = runtime.beginRequest("RESOLVING");
    runtime.dispatch({ type: "REQUEST_STATUS", token, status: "READY" });
  }, [cellId, workspaceId]);

  if (!active || !panelOpen || !bottomPanelHost) return null;
  return createPortal(
    <ChartStrategyTesterPanel
      cellScope={`${workspaceId}\u0000${cellId}`}
      session={session}
      attachment={attachment}
      draftStore={draftStore}
      onAttachmentChange={onAttachmentChange}
      onEntryStateChange={onEntryStateChange}
      onRunRequest={handleRunRequest}
      onClose={onClosePanel}
    />,
    bottomPanelHost,
  );
}
