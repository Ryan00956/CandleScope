export type DrawingDocumentAuthorityMode = "document" | "legacy";

function configuredDrawingDocumentAuthority(): unknown {
  // Vite only replaces direct import.meta.env property access in production.
  try {
    return import.meta.env.VITE_DRAWING_DOCUMENT_AUTHORITY;
  } catch {
    return undefined;
  }
}

/**
 * Document authority is the Phase 2 default. The exact `legacy` value is the
 * emergency rollback path; both modes retain the SavedDrawing[] wire format.
 */
export function resolveDrawingDocumentAuthorityMode(
  configured: unknown = configuredDrawingDocumentAuthority(),
): DrawingDocumentAuthorityMode {
  return configured === "legacy" ? "legacy" : "document";
}
