import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import { ChartErrorBoundary } from "./app/AppProviders.js";
import ReplayApp from "./features/replay/ReplayApp.js";
import { replayEntryFromWindow } from "./features/replay/replayEntry.js";
import "./index.css";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Replay document root is missing");

createRoot(root).render(
  <StrictMode>
    <ChartErrorBoundary>
      <ReplayApp entry={replayEntryFromWindow()} />
    </ChartErrorBoundary>
  </StrictMode>,
);
