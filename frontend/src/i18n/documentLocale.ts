import { subscribeLocale } from "./locale.js";
import { t, type MessageKey } from "./t.js";

export interface DocumentLocaleKeys {
  titleKey: MessageKey;
  descriptionKey: MessageKey;
}

const CSS_COPY = [
  { property: "--i18n-swap-here", key: "css.swapHere" },
  { property: "--i18n-workspace-loading", key: "css.workspaceLoading" },
  { property: "--i18n-synced", key: "css.synced" },
  { property: "--i18n-managing", key: "css.managing" },
  { property: "--i18n-expand", key: "css.expand" },
  { property: "--i18n-collapse", key: "css.collapse" },
] as const satisfies readonly { property: string; key: MessageKey }[];

function applyCssCopy(): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const item of CSS_COPY) {
    style.setProperty(item.property, JSON.stringify(t(item.key)));
  }
}

function applyDocumentCopy(keys: DocumentLocaleKeys): void {
  if (typeof document === "undefined") return;
  document.title = t(keys.titleKey);
  const meta = document.querySelector("meta[name=\"description\"]");
  if (meta) meta.setAttribute("content", t(keys.descriptionKey));
  applyCssCopy();
}

export function bindDocumentLocale(keys: DocumentLocaleKeys): () => void {
  applyDocumentCopy(keys);
  return subscribeLocale(() => applyDocumentCopy(keys));
}
