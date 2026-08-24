export function backtestRunIdFromSearch(search: string): string | null {
  const runId = new URLSearchParams(search).get("run")?.trim() ?? "";
  return /^bt_[a-zA-Z0-9_-]{8,128}$/.test(runId) ? runId : null;
}

export function backtestCompareRunIdFromSearch(search: string): string | null {
  const runId = new URLSearchParams(search).get("compare")?.trim() ?? "";
  return /^bt_[a-zA-Z0-9_-]{8,128}$/.test(runId) ? runId : null;
}
