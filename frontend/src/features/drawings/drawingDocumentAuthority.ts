export type DrawingDocumentAuthorityMode = "document" | "legacy";

function configuredDrawingDocumentAuthority(): unknown {
  const meta = import.meta as { readonly env?: Readonly<Record<string, unknown>> };
  return meta.env?.["VITE_DRAWING_DOCUMENT_AUTHORITY"];
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
