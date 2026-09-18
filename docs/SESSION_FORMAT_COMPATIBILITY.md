# Session format compatibility

Local implementation reviewed on 2026-09-17 and revalidated on 2026-09-18. No release or current-version
four-case model compatibility claim is implied by this parser change.

## Decision

| Approach | Benefit | Cost / boundary |
| --- | --- | --- |
| Send every version through the official catalog | One full physical-format recovery path | Existing v0 fixtures use one-based sequences and minimal logical events. Converting them requires event-schema, provenance and migration work beyond renumbering. It would change the historical regression oracle. |
| Preserve historical v0 and use an explicit strict v3 adapter (chosen) | Fixes the observed v3 failure while preserving existing verdict regressions; reuses official current event semantics | Two clearly bounded readers, and new runtime dependencies. The legacy reader is not a full official v0 migration codec. |

Version dispatch happens before recovery. Header v3 always uses
`sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`.
Recovery failure is an error, never a reason to retry with the v0 parser.
Header versions 1, 2 and unknown values are rejected. Descriptor v2/v3 handling
is independent of session-header versions and is unchanged.

`current` validation is intentional: the pinned catalog's `transformed` mode
does not validate current-version event relationships. Probes found it could
accept an unknown required event or a `turn/end` referencing the wrong turn.

## Inheritance and provenance

- A physical v3 header requires boolean `isSeeded`. The catalog rejects seeded
  streams without an inherited marker and unseeded streams with one.
- The last `session/end-seed` with `data.inherited === true` determines
  `inheritedEventCount`. Its sequence is the cut; the marker itself is in
  `events.slice(inheritedEventCount)`. Earlier inherited markers remain in the
  prefix. Later ordinary restore markers (`data: {}`) do not move the cut.
- The pinned catalog accepts explicit non-true `data.inherited` values despite
  the declared `inherited?: true` type. The adapter explicitly rejects these.
- Physical `sourceEventSeqs` may contain individual indices and inclusive
  `[start, end]` ranges. The catalog expands these to logical indices and
  validates ordering, duplicates, earlier-event references and surface history.
- The original physical header is retained for lineage and inspection. Both
  readers expose normalized `inheritedEventCount` and `ownEvents`.

## Bounds, truncation and privacy

The existing per-file 64 MiB input and 128 MiB decoded limits remain. Before
catalog decoding, v3 rows must have dense zero-based sequences; source indices
must be safe nonnegative integers referring to earlier rows. The cumulative
expanded provenance budget is 1,048,576 entries per session. This is an entry
limit, not a claim about total JavaScript heap bytes. Oversized valid logs are
also refused rather than risking unbounded range allocation.

Concatenated Zstandard frames remain supported. A torn last frame or a final
JSON row cut at unexpected EOF is incomplete evidence and cannot yield a full
contract pass. A newline-terminated invalid row, or a syntax error before EOF,
is rejected. Complete but semantically invalid v3 rows are also rejected.

Upstream errors can quote event types, field names and private values. The v3
adapter emits a fixed validation/safety error without the original cause;
JSON syntax errors expose only the source path and line number. Operating
system paths remain local diagnostic information and should be reviewed before
sharing. No prompt, model response, credential, profile or source log is changed.

## Dependencies

Direct versions are exact: catalog and session `0.1.5-rc.2`, cordis `4.0.2`.
The catalog requires peer `@deepseek-ai/dsh-session@^0.1.5-rc.2` and
`@deepseek-ai/cordis@^4.0.2`; these peers are declared explicitly. On the audit
date the catalog's `latest` was `0.1.3-alpha.2`, while `next` was `0.1.5-rc.2`.
Installing `latest` would not reproduce this implementation.
The original audit also observed `alpha` as `0.1.6-alpha.1`. A subsequent check
at 2026-09-17T15:04:14Z found that tag updated to `0.1.6-alpha.2`; the earlier
value remains the historical snapshot from the initial check.

The catalog alone is 6,802 bytes packed / 17,192 bytes unpacked. The reviewed
production graph contains 19 packages, with 7,798,621 logical on-disk bytes
(about 7.44 MiB), including installation metadata and executable shims.
Most of that size is Zod. These are logical file sizes, not allocated disk
blocks, process memory, or this verifier's own tarball size.

An isolated install and clean `npm ci --omit=dev --ignore-scripts` succeeded;
none of the audited production packages declares an install lifecycle hook.
The repository lockfile fixes the reviewed transitive graph for `npm ci`.
Some upstream transitive requirements use carets: downstream consumers of an
npm tarball do not inherit this lockfile's full resolution guarantee. Recheck
fresh consumer installs and version tags before any authorized release.

## Evidence scope

- Deterministic v3 fixtures cover unseeded, seeded and compressed provenance
  shapes; old v0 fixtures and four-case verdict regressions are retained.
- A recorded real headless session from a `dsh@0.1.5-rc.1` installation restores
  25 events with header v3, `isSeeded: false`, and inherited count zero. Its
  installed persistence/session packages resolve to `0.1.5-rc.2`.
- A second real headless code-review task on the pinned `dsh@0.1.5-rc.2`
  installation restores all 207 events with `isSeeded: false`, inherited count
  zero and `incomplete: false`. It includes 32 model steps, 48 paired tool calls
  and results, and a final `turn/end` reason of `max-tokens`. The review task
  did not complete: complete persisted evidence does not mean a successful
  task. Compressed log SHA-256:
  `6316cc8def97fa00445cf3ca49ffc7cfb1d4bd86ddebc70bca16db053afefaba`.
  This is a maintainer attestation; the raw private log is not distributed.
- A separate no-model probe uses official SessionStore fork and JSONL
  persistence `0.1.5-rc.2`. Its parent / child / resumed grandchild logs have
  2 / 4 / 8 events and inherited counts 0 / 2 / 4, across three Zstandard frames
  each. This is actual runtime-written inheritance evidence under controlled
  inputs, not a paid subagent run or an independent user field report.
- Real raw logs remain in the local experiment directory. Checked-in fixtures
  contain synthetic values. Parsing proof does not establish current Harness
  behavior across the paid four-case matrix, UI correctness, or Linux support.
