import { t } from "../../i18n/index.js";
import type { TrainingRunReturnResponse } from "./replayV2Types.js";

export interface ReturnToHubApi {
  returnToHub(runId: string, signal?: AbortSignal): Promise<TrainingRunReturnResponse>;
}

export async function returnToTrainingHub(
  runId: string,
  api: ReturnToHubApi,
  navigate: (url: string) => void = (url) => window.location.assign(url),
  signal?: AbortSignal,
): Promise<TrainingRunReturnResponse> {
  const result = await api.returnToHub(runId, signal);
  if (!new Set(["PAUSED", "ENDED", "ERROR"]).has(result.state)
    || !result.checkpointed
    || !result.released) {
    throw new Error(t("replay.hub.returnUnconfirmed"));
  }
  navigate("/replay.html");
  return result;
}
