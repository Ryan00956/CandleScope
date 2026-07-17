import type {
  DrawingExportLease,
  DrawingExportPrepareOptions,
} from "../drawingInteractionController.js";

export interface DrawingExportReadyApi {
  prepareExport(options?: DrawingExportPrepareOptions): Promise<DrawingExportLease>;
}

export interface DrawingExportReadinessDependencies {
  readonly drawingKey: string;
  readonly drawingToolActive: boolean;
  readonly engineLoadError: Error | null;
  readonly getApi: () => DrawingExportReadyApi | null;
  readonly hasPresenceHint: () => boolean;
  readonly probePresence: () => Promise<boolean>;
  readonly supportsDrawingFeatures: boolean;
}

/** Only an authoritative missing result may bypass the drawing export barrier. */
export async function prepareDrawingExportFailClosed(
  dependencies: DrawingExportReadinessDependencies,
  options?: DrawingExportPrepareOptions,
): Promise<DrawingExportLease | null> {
  const readyApi = dependencies.getApi();
  if (readyApi) return readyApi.prepareExport(options);
  if (!dependencies.supportsDrawingFeatures || !dependencies.drawingKey) return null;

  const present = dependencies.hasPresenceHint() || await dependencies.probePresence();
  const loadedApi = dependencies.getApi();
  if (loadedApi) return loadedApi.prepareExport(options);
  if (!present && !dependencies.drawingToolActive) return null;
  if (dependencies.engineLoadError) {
    throw new Error("绘图引擎加载失败，已停止导出以避免遗漏绘图。", {
      cause: dependencies.engineLoadError,
    });
  }
  throw new Error("绘图引擎仍在加载，已停止导出以避免遗漏绘图，请稍后重试。 ");
}
