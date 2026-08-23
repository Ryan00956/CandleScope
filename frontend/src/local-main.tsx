import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import LocalApp from "./features/local-data/LocalApp.js";
import { readPersistedLocale } from "./features/settings/chartAppearanceSettings.js";
import { bindDocumentLocale, hydrateLocale } from "./i18n/index.js";
import "./index.css";

hydrateLocale(readPersistedLocale());
bindDocumentLocale({
  titleKey: "local.documentTitle",
  descriptionKey: "local.documentDescription",
});

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Local document root is missing");

createRoot(root).render(
  <StrictMode>
    <LocalApp />
  </StrictMode>,
);
