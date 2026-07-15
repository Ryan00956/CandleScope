import { createDrawingWorkerProcessor } from "./drawingWorkerProcessor.js";
import type { DrawingWorkerResponse } from "./drawingWorkerProtocol.js";

interface DrawingDedicatedWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: DrawingWorkerResponse, transferables: Transferable[]): void;
}

const workerScope = globalThis as unknown as DrawingDedicatedWorkerScope;
const processor = createDrawingWorkerProcessor({
  postMessage: (message, transferables) => workerScope.postMessage(message, transferables),
});

workerScope.onmessage = (event): void => {
  void processor.handleMessage(event.data);
};
