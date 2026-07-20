const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ReplayEntry =
  | { readonly kind: "configure" }
  | { readonly kind: "session"; readonly sessionId: string }
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
  const unknown = [...params.keys()].filter((key) => key !== "session");
  const sessions = params.getAll("session");
  if (unknown.length > 0 || sessions.length > 1) {
    return {
      kind: "error",
      code: "REPLAY_ENTRY_INVALID",
      message: "Replay URL query parameters are invalid.",
    };
  }
  if (sessions.length === 0) return { kind: "configure" };
  const sessionId = sessions[0] ?? "";
  if (!SESSION_ID.test(sessionId)) {
    return {
      kind: "error",
      code: "REPLAY_ENTRY_INVALID",
      message: "Replay session id is invalid.",
    };
  }
  return { kind: "session", sessionId };
}

export function replayEntryFromWindow(target: Pick<Window, "location"> = window): ReplayEntry {
  return resolveReplayEntry(target.location);
}
