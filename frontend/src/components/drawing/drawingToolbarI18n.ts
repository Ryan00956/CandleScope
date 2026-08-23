import { hasMessage, t, type MessageKey } from "../../i18n/index.js";
import type { ToolbarVariant } from "./drawingToolbarDefinitions.js";

function variantKey(id: string, suffix = ""): MessageKey {
  return `drawing.variant.${id}${suffix}` as MessageKey;
}

export function drawingVariantLabel(variant: Pick<ToolbarVariant, "id" | "label">): string {
  const key = variantKey(variant.id);
  return hasMessage(key) ? t(key) : variant.label;
}

export function drawingVariantDescription(
  variant: Pick<ToolbarVariant, "id" | "description">,
): string | undefined {
  if (!variant.description) return undefined;
  const key = variantKey(variant.id, ".description");
  return hasMessage(key) ? t(key) : variant.description;
}
