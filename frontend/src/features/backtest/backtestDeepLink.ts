export function backtestRunIdFromSearch(search: string): string | null {
  const runId = new URLSearchParams(search).get("run")?.trim() ?? "";
  return /^bt_[a-zA-Z0-9_-]{8,128}$/.test(runId) ? runId : null;
}

export function backtestCompareRunIdFromSearch(search: string): string | null {
  const runId = new URLSearchParams(search).get("compare")?.trim() ?? "";
  return /^bt_[a-zA-Z0-9_-]{8,128}$/.test(runId) ? runId : null;
}

export type BacktestResearchEntry =
  | { kind: "home" }
  | { kind: "context"; contextId: string }
  | { kind: "run"; runId: string }
  | { kind: "study"; studyId: string }
  | { kind: "invalid"; message: string };

const CONTEXT_ID = /^brc_[a-zA-Z0-9_-]{8,128}$/;
const STUDY_ID = /^st_[a-zA-Z0-9_-]{8,128}$/;

export function parseBacktestResearchEntry(search: string): BacktestResearchEntry {
  const params = new URLSearchParams(search);
  const candidates: Array<["context" | "run" | "study", string]> = [
    ["context", params.get("context")?.trim() ?? ""],
    ["run", params.get("run")?.trim() ?? ""],
    ["study", params.get("study")?.trim() ?? ""],
  ].filter((entry) => entry[1] !== "") as Array<["context" | "run" | "study", string]>;
  if (candidates.length === 0) return { kind: "home" };
  if (candidates.length !== 1) {
    return { kind: "invalid", message: "Only one research context, Run, or Study ID is allowed." };
  }
  const [kind, id] = candidates[0]!;
  if (kind === "context") {
    return CONTEXT_ID.test(id)
      ? { kind: "context", contextId: id }
      : { kind: "invalid", message: "The research context ID is invalid." };
  }
  if (kind === "run") {
    return /^bt_[a-zA-Z0-9_-]{8,128}$/.test(id)
      ? { kind: "run", runId: id }
      : { kind: "invalid", message: "The BacktestRun ID is invalid." };
  }
  return STUDY_ID.test(id)
    ? { kind: "study", studyId: id }
    : { kind: "invalid", message: "The BacktestStudy ID is invalid." };
}
