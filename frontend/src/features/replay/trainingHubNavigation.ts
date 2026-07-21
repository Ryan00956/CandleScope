import type { TrainingRunReturnResponse } from "./replayV2Types.js";

export interface ReturnToHubApi {
  returnToHub(sessionId: string, signal?: AbortSignal): Promise<TrainingRunReturnResponse>;
}

export async function returnToTrainingHub(
  sessionId: string,
  api: ReturnToHubApi,
  navigate: (url: string) => void = (url) => window.location.assign(url),
  signal?: AbortSignal,
): Promise<TrainingRunReturnResponse> {
  const result = await api.returnToHub(sessionId, signal);
  if (result.state !== "PAUSED" || !result.checkpointed || !result.released) {
    throw new Error("服务端未确认暂停、checkpoint 与运行时释放；不会离开训练页");
  }
  navigate("/replay.html");
  return result;
}
