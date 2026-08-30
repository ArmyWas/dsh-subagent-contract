# Persistent SDK runner experiment

This experiment exists because the stock one-shot `headless` profile exits when
the root agent first becomes idle. That can truncate durable evidence while a
background child is still running. The SDK profile keeps the Harness runtime
alive and streams root/child lifecycle notifications until each fixed scenario
reaches its actual completion boundary.

It is intentionally separate from the published verifier package. The runner
is pinned to `@deepseek-ai/dsh-sdk-client@0.1.2-alpha.2` while the protocol is
pre-release, and has been exercised on Windows only. Do not treat it as a
general benchmark runner.

The runtime inherits a scrubbed process environment plus only the required
DeepSeek key. It explicitly removes inherited custom endpoint routing, pins the
public DeepSeek endpoint, and enforces a 4,096-token output cap in both live
notifications and every persisted root/child request header. Telemetry, shell,
filesystem, web, workflow, and unrelated agent tools are disabled. Recursion is
capped at one child level, and each scenario exposes only the subagent control
surface it needs. Requests, notifications, trace counts, trace bytes, and total
case time are bounded.

## Run the four fixed cases

Provide the selected DeepSeek adapter credential through the process
environment. Never put a key in this directory, a benchmark, or a run artifact.

```sh
cd experiments/sdk-runner
npm ci
node run-matrix.mjs alpha2-sdk.run.json
node ../../bin/dsh-subagent-contract.js verify alpha2-sdk.run.json
```

The output path is created with no-overwrite semantics. Choose a fresh name or
omit it to write inside a unique `runs/` directory.
An operating-system kill or machine shutdown can still prevent the final JSON
from being written; the unique run home retains any logs that reached disk.

`DSH_CONTRACT_MODEL` can override the default `deepseek-v4-pro` model. Each run
creates a new timestamped `runs/` tree and never deletes an existing Harness
home. The generated JSON contains absolute `tracePaths`; the underlying session
logs contain prompts and model output. Both are gitignored and should remain
local unless explicitly redacted.

Because following an orchestration prompt is probabilistic, an exclusive
`S00_SCENARIO_NOT_EXERCISED` result may make up to three isolated attempts. A
structural summary of every attempt is recorded in the artifact. Lifecycle,
permission, trace, token-budget, cleanup, compatibility, and contract failures
stop immediately and cannot be replaced by a later pass. This can make real
provider calls and incur charges for more than four turns.

Expected alpha.2 result from the current 2026-08-31 Windows probe: all four
cases exercised and passed on attempt 1, with no violation or compatibility
error. All 11 persisted request headers used the 4,096-token cap. The checked-in
evidence is a structure-only summary; raw sessions are not committed.
