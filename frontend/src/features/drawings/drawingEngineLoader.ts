import { DRAWING_ENGINE_TOOL_IDS } from "./drawingModel.js";
import { drawingDocumentRepository } from "./persistence/drawingDocumentRepository.js";
import type {
  DrawingDocumentRepository,
} from "./persistence/drawingDocumentRepository.js";
import type { DrawingToolId } from "./drawingTypes.js";

export { DRAWING_ENGINE_TOOL_IDS };

type DrawingEngineHostModule = typeof import("./DrawingEngineHost.js");

let drawingEngineHostPromise: Promise<DrawingEngineHostModule> | null = null;

type DrawingPresenceRepository = Pick<
  DrawingDocumentRepository,
  "probeAndRepairManifest" | "readManifestHint"
>;

export interface DrawingEnginePresencePolicy {
  probe(drawingKey: string): Promise<boolean>;
  shouldLoad(options: Readonly<{
    activeTool: DrawingToolId | null | undefined;
    drawingKey: string;
  }>): boolean;
}

export function createDrawingEnginePresencePolicy(
  repository: DrawingPresenceRepository,
): DrawingEnginePresencePolicy {
  const presenceCache = new Map<string, boolean>();
  const presenceProbes = new Map<string, Promise<boolean>>();

  const shouldLoad: DrawingEnginePresencePolicy["shouldLoad"] = ({ activeTool, drawingKey }) => {
    if (activeTool != null && DRAWING_ENGINE_TOOL_IDS.has(activeTool)) return true;
    const manifest = repository.readManifestHint(drawingKey);
    if (manifest.status === "valid" && manifest.hint.count > 0) return true;
    return presenceCache.get(drawingKey) === true;
  };

  const probe = (drawingKey: string): Promise<boolean> => {
    const inFlight = presenceProbes.get(drawingKey);
    if (inFlight) return inFlight;
    const request = repository.probeAndRepairManifest(drawingKey)
      .then((result) => {
        if (result.status === "invalid" || result.status === "unavailable") {
          presenceCache.delete(drawingKey);
          throw result.error;
        }
        const present = result.status === "found" && result.count > 0;
        if (present) presenceCache.set(drawingKey, true);
        else presenceCache.delete(drawingKey);
        return present;
      });
    presenceProbes.set(drawingKey, request);
    const cleanup = (): void => {
      if (presenceProbes.get(drawingKey) === request) presenceProbes.delete(drawingKey);
    };
    void request.then(cleanup, cleanup);
    return request;
  };

  return Object.freeze({ probe, shouldLoad });
}

const drawingEnginePresencePolicy = createDrawingEnginePresencePolicy(drawingDocumentRepository);

export function loadDrawingEngineHost(): Promise<DrawingEngineHostModule> {
  if (!drawingEngineHostPromise) {
    drawingEngineHostPromise = import("./DrawingEngineHost.js");
  }
  return drawingEngineHostPromise;
}

export function preloadDrawingEngineHost(): void {
  loadDrawingEngineHost().catch(() => {
    drawingEngineHostPromise = null;
  });
}

export function shouldLoadDrawingEngine({
  activeTool,
  drawingKey,
}: {
  activeTool: DrawingToolId | null | undefined;
  drawingKey: string;
}): boolean {
  return drawingEnginePresencePolicy.shouldLoad({ activeTool, drawingKey });
}

/**
 * Controlled async presence check for missing/corrupt manifest hints. The
 * component layer receives only a boolean and never owns IDB/localStorage
 * migration rules.
 */
export function probeDrawingEnginePresence(drawingKey: string): Promise<boolean> {
  return drawingEnginePresencePolicy.probe(drawingKey);
}
