type SharedDrawingDocumentEventListener = (event: Event) => void;

interface ListenerRegistration {
  readonly listener: SharedDrawingDocumentEventListener;
}

interface SharedDocumentEventHub {
  readonly documentRef: Document;
  readonly eventType: string;
  readonly nativeListener: EventListener;
  readonly registrations: Set<ListenerRegistration>;
}

const documentEventHubs = new WeakMap<Document, Map<string, SharedDocumentEventHub>>();

function reportListenerError(error: unknown): void {
  const reporter = (globalThis as typeof globalThis & {
    reportError?: (caught: unknown) => void;
  }).reportError;
  if (typeof reporter === "function") reporter(error);
  else console.error("Shared drawing document event listener failed", error);
}

function getOrCreateDocumentHub(
  documentRef: Document,
  eventType: string,
): SharedDocumentEventHub {
  let byEventType = documentEventHubs.get(documentRef);
  if (!byEventType) {
    byEventType = new Map();
    documentEventHubs.set(documentRef, byEventType);
  }
  const existing = byEventType.get(eventType);
  if (existing) return existing;
  const registrations = new Set<ListenerRegistration>();
  const hub: SharedDocumentEventHub = {
    documentRef,
    eventType,
    registrations,
    nativeListener: (event) => {
      // Snapshot registration order, matching separate same-target DOM
      // listeners even if one host unmounts another while dispatching.
      for (const registration of [...registrations]) {
        try {
          registration.listener(event);
        } catch (error) {
          // Native EventTarget dispatch reports one listener failure and keeps
          // delivering to the remaining listeners. Preserve that isolation.
          reportListenerError(error);
        }
      }
    },
  };
  byEventType.set(eventType, hub);
  documentRef.addEventListener(eventType, hub.nativeListener, true);
  return hub;
}

/** Share one capture listener per document event type across drawing panes. */
export function subscribeSharedDrawingDocumentEvent(
  documentRef: Document,
  eventType: string,
  listener: SharedDrawingDocumentEventListener,
): () => void {
  const hub = getOrCreateDocumentHub(documentRef, eventType);
  const registration = Object.freeze({ listener });
  hub.registrations.add(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    hub.registrations.delete(registration);
    if (hub.registrations.size > 0) return;
    documentRef.removeEventListener(eventType, hub.nativeListener, true);
    const byEventType = documentEventHubs.get(documentRef);
    byEventType?.delete(eventType);
    if (byEventType?.size === 0) documentEventHubs.delete(documentRef);
  };
}
