const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ReplayEntry =
  | { readonly kind: "configure" }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "error"; readonly code: "REPLAY_ROUTE_MISMATCH" | "REPLAY_ENTRY_INVALID"; readonly message: string };

export interface ReplayEntryLocation {
  readonly pathname: string;
  readonly search: string;
}

export function resolveReplayEntry(location: ReplayEntryLocation): ReplayEntry {
  const pathname = String(location.pathname || "");
  if (!/(?:^|\/)replay\.html$/.test(pathname)) {
    return {
      kind: "error",
      code: "REPLAY_ROUTE_MISMATCH",
      message: "This replay document was served from an invalid route. Live fallback is disabled.",
    };
  }

  const params = new URLSearchParams(location.search);
  const unknown = [...params.keys()].filter((key) => key !== "run");
  const runs = params.getAll("run");
  if (unknown.length > 0 || runs.length > 1) {
    return {
      kind: "error",
      code: "REPLAY_ENTRY_INVALID",
      message: "Replay URL query parameters are invalid.",
    };
  }
  if (runs.length === 0) return { kind: "configure" };
  const runId = runs[0] ?? "";
  if (!RUN_ID.test(runId)) {
    return {
      kind: "error",
      code: "REPLAY_ENTRY_INVALID",
      message: "Replay run id is invalid.",
    };
  }
  return { kind: "run", runId };
}

export function replayEntryFromWindow(target: Pick<Window, "location"> = window): ReplayEntry {
  return resolveReplayEntry(target.location);
}
