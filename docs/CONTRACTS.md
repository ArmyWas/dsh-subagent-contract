# Contract specification: `dsh-subagent/v0.1`

This document is normative for report codes in version 0.1.

## Input model

The verifier reads the multi-session run-artifact shape observed in `dsh-eval`
0.3.0 and emitted by the persistent SDK experiment. The v0.1 support contract requires
a complete run of the exact bundled four-case benchmark. Every case must be
present, every trial must be `status: completed`, and every trial must carry a
non-empty, complete `tracePaths` array. `completed` only means traces were
harvested; it does not imply a zero process exit code, absence of timeout, or a
correct task result. A missing case, an error trial, or an incomplete/truncated
trace makes the verdict inconclusive (exit `2`). Imported, partial, and ad-hoc
run artifacts are outside this supported-verdict boundary.

Run artifacts are treated as trusted local inputs, not as a network-fetch
format. The loader refuses UNC/device-style paths, more than 16 trace paths per
trial, an individual trace above 64 MiB, or a trial above 128 MiB. Zstandard
output is also bounded. Relative and ordinary absolute local paths remain
allowed because real runners persist them in `tracePaths`.

Each trace is decoded independently. Graph relationships come from the session
header, never from `tracePaths` order. The verifier analyzes
`events.slice(header.seedLength ?? 0)` as the session's own suffix.

## Fixed scenario coverage

Before applying behavior contracts, the bundled cases must prove that the model
actually exercised their requested scenario:

- `foreground-success`: one successful foreground admission with the fixed
  description;
- `two-admissions`: two distinct successful foreground admissions in one model
  step, using the two fixed descriptions;
- `continuable-fifo`: one background child, three residency boundaries, and the
  fixed `FIRST` then `SECOND` continuation sequence;
- `continuable-report`: one background child and exactly one successful report
  carrying the fixed token.

Failure to exercise a fixed scenario is `S00_SCENARIO_NOT_EXERCISED`, a
compatibility/inconclusive result rather than evidence of a Harness behavior
violation.

## C01 — Lineage graph

- Every session id is unique inside one trial.
- Exactly one session is not marked `origin: subagent`.
- Every subagent child names a present `parentSession`.
- `child.delegationDepth = parent.delegationDepth + 1`.
- Following parent links cannot form a cycle.

## C02 — Own descriptor

- Every subagent child's own suffix contains exactly one
  `subagent/descriptor`.
- The descriptor appears before the child's first own `request/header`.
- Descriptor v2 and v3 are validated as separate closed record shapes.
- A continuable descriptor has a non-empty label.
- An unknown descriptor version is compatibility drift, not a behavioral
  failure.

## C03 — Admission cardinality

- Every parent `subagent` tool call has exactly one result with the same call id.
- A non-error launch result with a unique description maps to exactly one direct
  child whose durable label matches that description.
- A background error result maps to no child: the admission was rejected.
- A foreground error result may have no child (rejected before admission) or
  one matching child (admitted, then failed). The latter is not a ghost child
  and is evaluated by C04.
- More than one matching child is always invalid, and every direct child must be
  accounted for by one launch regardless of the launch result's error bit.

The bundled benchmark uses unique descriptions so correlation is deterministic.

## C04 — Foreground outcome

For calls explicitly carrying `run_in_background: false`, once exactly one
matching child exists:

- `turn/end.reason.kind: completed` plus a non-error parent result requires the
  rendered parent result to equal the child's final assistant text.
- `completed` plus an error parent result is inconclusive: the durable record
  cannot distinguish a post-completion transport/finalization error from a
  corrupted outcome, so v0.1 does not label it a behavior violation.
- Any other terminal reason requires an error result.
- If the child persisted partial assistant text, the error result contains it.
- A persisted foreground child with no own `turn/end` is a terminal-record
  violation unless the trace is syntactically truncated or ends with an open
  turn/step. Open activity is incomplete evidence, so terminal-dependent checks
  are reported as compatibility/inconclusive instead of a behavior failure.

A foreground error is therefore allowed to have a child. C03 establishes
admission cardinality; C04 evaluates the admitted child's terminal outcome.

## C05 — Continuation identity and FIFO

For calls explicitly carrying `run_in_background: true`:

- The matched child descriptor is `mode: continuable`.
- The immediate tool result names that same durable child id.
- Every successful `send_message` for that id becomes a child `user/message`
  whose source is `{ kind: coordinator, form: relay, senderSessionId: parent }`.
- Coordinator messages equal the accepted send order.
- Follow-ups increase the number of turns in the same child rather than creating
  a replacement session.

## C06 — Settlement provenance

Every observed `subagent-settled` message resolves to a direct child whose own
descriptor is `mode: continuable`. The source is `form: notice`, carries a
non-empty summary, uses the child's id as `senderSessionId`, and does not repeat
the same message id.

The runtime settles one residency epoch, not necessarily one turn: queued
follow-ups can produce multiple `turn/end` records before one notice. Therefore
the general contract deliberately does not compare notice count with turn
count, nor does it impose an order relative to `report`. The fixed
`continuable-fifo` and `continuable-report` cases alone add scenario-specific
boundary counts and ordering because their prompts explicitly require the
parent to wait at those boundaries.

## C07 — Report provenance

Every child `report` tool call has exactly one tool result. A successful result
has one direct-parent `subagent-report` user message with `form: relay`, the
child's id as sender, and content preserving the reported output. An error
result may have no relay (failure before delivery) or one relay (delivery
succeeded but a later hook/finalization step failed); the latter is not a
duplicate report. Every observed report relay must resolve to a direct
continuable child and one report call. A report relay is never counted as a
settlement notice.

The general contract does not require a report/settlement ordering. Only the
fixed `continuable-report` case requires its one explicit report relay to be
followed by the requested later settlement boundary.

## Stable exit semantics

- `0`: no violations or compatibility errors.
- `1`: at least one behavior violation and no compatibility error.
- `2`: at least one compatibility error; the report may also list observed
  violations, but must not be treated as a complete verdict.
