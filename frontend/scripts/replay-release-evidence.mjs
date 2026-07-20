import { spawnSync } from "node:child_process";

const RELEASE_EVIDENCE_SCHEMA_VERSION = "replay-release-evidence.v1";
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEAD_COMMAND = Object.freeze(["rev-parse", "--verify", "HEAD^{commit}"]);
const STATUS_COMMAND = Object.freeze([
  "status",
  "--porcelain=v1",
  "--untracked-files=all",
  "--ignore-submodules=none",
]);

function runGit(repositoryRoot, args) {
  const completed = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (completed.error) {
    throw new Error(`Unable to inspect Git release evidence: ${completed.error.message}`);
  }
  if (completed.status !== 0) {
    const detail = String(completed.stderr || completed.stdout || "").trim();
    throw new Error(`Unable to inspect Git release evidence${detail ? `: ${detail}` : ""}`);
  }
  return String(completed.stdout || "");
}

export function captureReplayReleaseEvidence(repositoryRoot, options = {}) {
  const executeGit = options.runGit ?? runGit;
  const now = options.now ?? (() => new Date());
  const gitHead = executeGit(repositoryRoot, HEAD_COMMAND).trim();
  if (!FULL_GIT_OBJECT_ID.test(gitHead)) {
    throw new Error("Replay release evidence requires a full Git HEAD object id");
  }

  const dirtyStatus = executeGit(repositoryRoot, STATUS_COMMAND).trim();
  if (dirtyStatus) {
    throw new Error(`Replay release evidence requires a clean Git worktree:\n${dirtyStatus}`);
  }
  const verifiedHead = executeGit(repositoryRoot, HEAD_COMMAND).trim();
  if (verifiedHead !== gitHead) {
    throw new Error("Replay release evidence HEAD changed while verifying worktree cleanliness");
  }

  const recordedAt = now();
  if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) {
    throw new Error("Replay release evidence requires a valid recording time");
  }
  return Object.freeze({
    recorded_at: recordedAt.toISOString(),
    evidence: Object.freeze({
      schema_version: RELEASE_EVIDENCE_SCHEMA_VERSION,
      git_head: gitHead.toLowerCase(),
      git_dirty: false,
    }),
  });
}
