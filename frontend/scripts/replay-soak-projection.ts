import {
  replayTradeDeltaEvent,
  replayTradeSessionResponse,
} from '../src/features/replay/__tests__/fixtures'
import {
  parseReplayEvent,
  parseReplaySessionResponse,
} from '../src/features/replay/replayParser'
import { ReplayStore } from '../src/features/replay/replayStore'

// This entry is included only when the release soak sets
// VITE_REPLAY_SOAK_PROJECTION_ENABLED=1. It gives the browser projection gate
// the same optimized production module graph used by the app without exposing
// source-module URLs through Vite's development server.
export const fixtures = {
  replayTradeDeltaEvent,
  replayTradeSessionResponse,
}

export const parser = {
  parseReplayEvent,
  parseReplaySessionResponse,
}

export { ReplayStore }
