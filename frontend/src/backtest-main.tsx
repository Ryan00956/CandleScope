import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import BacktestApp from "./features/backtest/BacktestApp.js";
import "./index.css";
import "./features/backtest/backtest.css";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Backtest document root is missing");

createRoot(root).render(
  <StrictMode>
    <BacktestApp />
  </StrictMode>,
);
