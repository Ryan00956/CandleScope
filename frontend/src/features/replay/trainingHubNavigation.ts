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
  if (!new Set(["PAUSED", "ENDED", "ERROR"]).has(result.state)
    || !result.checkpointed
    || !result.released) {
    throw new Error("服务端未确认可持久化状态、checkpoint 与运行时释放；不会离开训练页");
  }
  navigate("/replay.html");
  return result;
}
