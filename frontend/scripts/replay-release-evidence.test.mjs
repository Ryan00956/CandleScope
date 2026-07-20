import assert from "node:assert/strict";
import test from "node:test";

import { captureReplayReleaseEvidence } from "./replay-release-evidence.mjs";

const GIT_HEAD = "73091c9b172ad6ba119ee3e18810a20d16b12a34";

function gitResponses(responses, calls = []) {
  return (repositoryRoot, args) => {
    calls.push({ repositoryRoot, args });
    const key = args.join(" ");
    const response = responses[key];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`Unexpected Git command: ${key}`);
    return response;
  };
}

test("release evidence binds a clean worktree to a full Git HEAD and UTC timestamp", () => {
  const calls = [];
  const result = captureReplayReleaseEvidence("H:\\program\\CandleScope-kline-replay", {
    now: () => new Date("2026-07-20T03:04:05.678Z"),
    runGit: gitResponses({
      "rev-parse --verify HEAD^{commit}": `${GIT_HEAD}\n`,
      "status --porcelain=v1 --untracked-files=all --ignore-submodules=none": "",
    }, calls),
  });

  assert.deepEqual(result, {
    recorded_at: "2026-07-20T03:04:05.678Z",
    evidence: {
      schema_version: "replay-release-evidence.v1",
      git_head: GIT_HEAD,
      git_dirty: false,
    },
  });
  assert.deepEqual(calls, [
    {
      repositoryRoot: "H:\\program\\CandleScope-kline-replay",
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
    },
    {
      repositoryRoot: "H:\\program\\CandleScope-kline-replay",
      args: ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
    },
    {
      repositoryRoot: "H:\\program\\CandleScope-kline-replay",
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
    },
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.evidence));
});

test("release evidence rejects a dirty worktree with actionable status", () => {
  assert.throws(
    () => captureReplayReleaseEvidence("repository", {
      runGit: gitResponses({
        "rev-parse --verify HEAD^{commit}": GIT_HEAD,
        "status --porcelain=v1 --untracked-files=all --ignore-submodules=none": " M frontend/src/example.ts\n?? local.txt\n",
      }),
    }),
    /requires a clean Git worktree:[\s\S]*frontend\/src\/example\.ts[\s\S]*local\.txt/,
  );
});

test("release evidence rejects missing or abbreviated Git identity", () => {
  assert.throws(
    () => captureReplayReleaseEvidence("repository", {
      runGit: gitResponses({ "rev-parse --verify HEAD^{commit}": "73091c9" }),
    }),
    /requires a full Git HEAD object id/,
  );
  assert.throws(
    () => captureReplayReleaseEvidence("repository", {
      runGit: gitResponses({ "rev-parse --verify HEAD^{commit}": `${GIT_HEAD}a` }),
    }),
    /requires a full Git HEAD object id/,
  );
  assert.throws(
    () => captureReplayReleaseEvidence("repository", {
      runGit: gitResponses({
        "rev-parse --verify HEAD^{commit}": new Error("git unavailable"),
      }),
    }),
    /git unavailable/,
  );
});

test("release evidence rejects an invalid recording clock", () => {
  assert.throws(
    () => captureReplayReleaseEvidence("repository", {
      now: () => new Date(Number.NaN),
      runGit: gitResponses({
        "rev-parse --verify HEAD^{commit}": GIT_HEAD,
        "status --porcelain=v1 --untracked-files=all --ignore-submodules=none": "",
      }),
    }),
    /requires a valid recording time/,
  );
});

test("release evidence rejects HEAD movement during clean-status verification", () => {
  let headReadCount = 0;
  assert.throws(
    () => captureReplayReleaseEvidence("repository", {
      runGit: (_repositoryRoot, args) => {
        if (args[0] === "status") return "";
        headReadCount += 1;
        return headReadCount === 1 ? GIT_HEAD : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
    }),
    /HEAD changed while verifying worktree cleanliness/,
  );
});
