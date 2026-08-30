# Research evidence

## Product question

Can a release test prove that a DeepSeek Harness subagent's durable parent/child
record is correct, rather than merely prove that the parent returned plausible
text?

## Duplicate check

Two existing projects already cover the broad evaluation space:

- [`dsh-eval`](https://github.com/hccccc01333/dsh-eval) runs YAML benchmarks,
  isolates Harness homes, records all `tracePaths`, folds metrics, and reports or
  compares runs.
- [`dsh-eval-harness`](https://github.com/BiBoyang/dsh-eval-harness) runs plugin
  regression cases and reads plain or multi-frame Zstandard session logs.

The official runtime also owns an in-process invariant for pairing
`subagent/start` and `subagent/end`. This project does not copy any of those
responsibilities. The observed gap is a post-process, cross-session contract
over the durable headers, descriptors, parent tool results, continuation
messages, reports, and settlement notices.

## Real-product probes

The implementation was checked against three independent trace sets on Windows.
These first probes were captured from real Harness sessions and then verified
offline; they were not all produced by the current bundled four-case runner.

| Harness line | Descriptor | Scenarios | Result |
| --- | --- | --- | --- |
| `0.1.0-rc.7` | v2 | foreground one-shot; continuable background settlement | 2/2 passed |
| npm `0.1.1-rc.2` | v2 | foreground one-shot; continuable background settlement | 2/2 passed |
| local source `0.1.2-alpha.1` (`caec78de20`) | v3 | foreground one-shot; continuable background settlement | 2/2 passed |

The prompts forced fixed output tokens and unique child descriptions. Each run
used an isolated `DSH_HOME`. The verifier then read the actual concatenated
Zstandard logs rather than a normalized export.

One implementation bug was found by this process: real `assistant/message`
events store content below `data.message.content`, while user messages store it
directly below `data.content`. The parser now handles both shapes and has a
regression test.

## Full live-matrix finding

On 2026-08-31 a repaired source checkout of `dsh-eval` ran the complete bundled
matrix against Harness `0.1.0-rc.7`:

- `foreground-success` and `two-admissions` were exercised and passed.
- `continuable-fifo` and `continuable-report` ended inconclusive, with no
  behavior violation claimed.
- The cause was the runner boundary: `dsh-eval` spawns the one-shot `headless`
  profile and harvests logs as soon as the root process exits. The root becomes
  idle and exits while a background child still has an open turn, so the child
  trace is a valid JSONL prefix but not terminal evidence.
- The run also exposed that permission `defaultPreset: workspace-write` pins
  `approval: ask`; a non-interactive evaluator needs its own explicit
  `workspace-write + never` preset.

The verifier now emits `RUN_TRACE_UNSETTLED` and suppresses terminal-dependent
false failures for this evidence shape. This is a runner compatibility gap,
not evidence of a Harness subagent defect.

## Persistent SDK matrix

The next experiment replaced the one-shot process boundary with the official
SDK profile and `@deepseek-ai/dsh-sdk-client@0.1.2-alpha.2`. It subscribed to
root and descendant notifications, kept each isolated runtime alive through
all child activation epochs, and shut down only after the fixed scenario's
durable completion boundary.

The current hardened Windows run returned exit `0`. Every case passed on its
first attempt; all 11 persisted request headers used the enforced 4,096-token
cap, and the derived interval from the earliest persisted session creation to
artifact write was 49.533 seconds:

| Case | Durable completion evidence | Verdict |
| --- | --- | --- |
| `foreground-success` | one child start/end, root idle afterwards | exercised, pass |
| `two-admissions` | two child start/end pairs from one root case | exercised, pass |
| `continuable-fifo` | three activation epochs, 2 sends, 3 settlements | exercised, pass |
| `continuable-report` | one report relay, one settlement, child end, later root idle | exercised, pass |

Overall: 4 verified, 4 passed, 0 failed, 0 inconclusive, 0 violations, 0
compatibility errors. During runner hardening, two discarded runs exposed model
non-compliance rather than Harness contract failures: a FIFO child used the
scoped `report` tool instead of an ordinary reply, and a report parent attempted
an unnecessary follow-up or duplicate launch. This led to per-scenario tool
restriction and fail-closed retry policy: only an exclusive
`S00_SCENARIO_NOT_EXERCISED` may retry, while a contract or infrastructure
failure stops immediately. The evidence run itself required no retry. The checked-in
[`../evidence/alpha2-sdk-summary.json`](../evidence/alpha2-sdk-summary.json)
contains only structural counts; raw session ids, trace paths, prompts, model
responses, and credentials remain local. It records the local artifact hash,
the nine-log content-set hash, Node/Windows versions, the exact executed runner,
lifecycle observer, retry policy, lockfile, and three permission/tool overlays.
The artifact also binds itself to those source and dependency hashes, records
the public endpoint route mode, and records the 4,096-token cap. These are transparent
maintainer attestations, not a third-party signature. The reproducible runner source is in
[`../experiments/sdk-runner`](../experiments/sdk-runner/README.md).

The checked-in structure can be regenerated without printing prompts, model
responses, ids, or paths:

```sh
node scripts/generate-evidence.mjs path/to/run.json path/to/executed-runner.mjs
```

The same audit found that the published `dsh-eval@0.3.0` tarball omits runtime
JavaScript modules imported by `lib/index.js`. The package therefore cannot be
used from a clean install until upstream republishes a corrected artifact.

## Evidence boundary

- The real probes establish v2/v3 parsing, lineage, foreground output identity,
  background id identity, and settlement provenance on the tested builds.
- FIFO follow-up and explicit report contracts have both deterministic offline
  fixtures and one complete persistent alpha.2 live run. More runs and a clean
  Windows/Linux install matrix are still required before using them as a hard
  release gate.
- Model compliance with a benchmark prompt is probabilistic. A failed run can
  mean Harness violated a contract or the parent model did not execute the
  fixed scenario. Reports therefore preserve per-case diagnostics and the
  project starts as a Canary, not an unquestioned release gate.
- Structured contract diagnostics omit credential values, prompt bodies, model
  responses, tool arguments, raw trial errors, and subagent descriptions.
  CLI-level read failures may still surface operating-system paths; review them
  before sharing outside the test environment.
