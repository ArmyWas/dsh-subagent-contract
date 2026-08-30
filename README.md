# dsh-subagent-contract

Deterministic, post-run contract checks for DeepSeek Harness subagents.

This is an independent community project. It is not maintained, endorsed, or
supported by DeepSeek.

The verifier consumes the public run-artifact shape introduced by `dsh-eval`,
reopens its parent and child logs, preserves their individual headers, and
checks relationships that disappear when traces are merged into aggregate
metrics. It does not copy the evaluation framework.

> **Development preview:** the verifier and deterministic fixtures work. A
> bounded persistent SDK experiment has also completed the real four-case matrix
> 4/4 on `0.1.2-alpha.2`, with every case passing on its first attempt. The
> repository is not ready for npm publication: the runner remains an
> experimental source-only path, and it still needs repeated stability data
> plus a full live Linux matrix. The published `dsh-eval@0.3.0` path remains independently broken: its
> tarball omits runtime modules, and its one-shot headless process exits before
> background lifecycle cases settle.

[中文说明](README.zh-CN.md)

## Why this exists

A parent can appear to finish correctly while the durable multi-agent record is
wrong: a child can have the wrong parent or depth, a rejected launch can leave a
ghost session, a follow-up can land in a replacement conversation, or a runtime
settlement notice can be attributed to the wrong child. Text scoring and merged
tool counts do not prove those properties.

This verifier turns those failures into stable diagnostics and exit codes that
can be used in release canaries and minimal reproductions.

## Current development check

Prerequisite: Node.js 22.19+ or 24+.

```sh
npm install
npm test
npm run check
npm run pack:check
```

Maintainers with a run artifact produced from a repaired source checkout can
exercise the offline CLI directly. No model call happens during verification:

```sh
node bin/dsh-subagent-contract.js verify artifacts/subagent-run.json
node bin/dsh-subagent-contract.js verify artifacts/subagent-run.json --format json
```

After the upstream runner is republished, the intended command is
`dsh --profile eval run ...`; `dsh eval run ...` is not a valid current Harness
launcher alias. Republishing alone will not make the two background cases
reliable: their runtime must stay alive through child settlement.

The current persistent proof lives in
[`experiments/sdk-runner`](experiments/sdk-runner/README.md). It pins the
pre-release SDK client, runs the exact four fixed cases in isolated homes, and
produces the same multi-session artifact shape for this verifier. It is an
experiment, not yet the supported installation path.

The runner records a structural summary of every attempt. It allows up to three
isolated attempts only when the offline verifier reports the single, explicit
`S00_SCENARIO_NOT_EXERCISED` model-compliance gap. A lifecycle, permission,
trace, token-budget, cleanup, compatibility, or contract failure stops the run
immediately and cannot be washed green by a later retry. The checked-in Windows
evidence needed one attempt for every case; retries were not used.

`dsh-eval` gives every trial an isolated `DSH_HOME`. Provider credentials must
therefore come from the launching process environment. A key saved only in an
everyday Web profile is not inherited by those trial homes. Never put
credentials in a benchmark file or committed artifact. The experiment removes
an inherited `DEEPSEEK_BASE_URL`, pins the public DeepSeek endpoint, and checks
that every persisted root and child request stays at or below 4,096 output
tokens.

The offline verifier itself is cross-platform. The current upstream runner
also has unresolved Windows `.cmd` launch ergonomics, so this README does not
publish an unverified shell-wrapper workaround.

Live runs make real model requests. The four cases can take several minutes and
incur provider charges. Their isolated homes and raw session logs are retained
for evidence, contain prompts/model output, and are not automatically deleted.
Generated `tracePaths` are absolute, so artifacts are not portable across
machines without relocating the referenced logs.

For future CI output, the verifier's stable form is:

```sh
npx dsh-subagent-contract verify artifacts/subagent-run.json --format json
```

## The seven v0.1 contracts

| ID | Contract | What it proves |
| --- | --- | --- |
| `C01` | Lineage graph | One root, unique session ids, resolvable parents, monotone depth, no cycles. |
| `C02` | Own descriptor | Exactly one descriptor in each child's own suffix, before its first request; descriptor v2 and v3 are validated explicitly. |
| `C03` | Admission cardinality | Every parent launch has one result. Foreground errors may occur before or after a child is created; background errors represent rejected admission. No child is unaccounted for. |
| `C04` | Foreground outcome | Completed + success preserves the child's final output; non-completed errors preserve partial output. Completed + error is reported as inconclusive. |
| `C05` | Continuation identity and FIFO | A background id resolves to the same durable continuable child and accepted `send_message` calls arrive in order with direct-parent provenance. |
| `C06` | Settlement provenance | Every runtime notice resolves to the correct direct continuable child; fixed canary cases also verify their requested settlement boundaries. |
| `C07` | Report provenance | A child's explicit `report` relay remains distinct from settlement; ordering between them is required only by the fixed report case. |

The exact invariants and diagnostic codes are documented in
[`docs/CONTRACTS.md`](docs/CONTRACTS.md).

## Compatibility and safety

- The v0.1 support promise is limited to a complete run of the exact bundled
  four-case benchmark (`foreground-success`, `two-admissions`,
  `continuable-fifo`, and `continuable-report`). Every fixed case must be
  present and expose complete `tracePaths`; partial, imported, or ad-hoc
  artifacts cannot receive a full supported verdict.
- Recognizes the public artifact shape observed in `dsh-eval` 0.3.0 without importing its
  private source modules. This does not claim that the broken 0.3.0 npm tarball
  is usable as a runner.
- Reads plain JSONL and DeepSeek Harness's concatenated multi-frame Zstandard
  session logs.
- Supports durable subagent descriptor v2 (the tested rc.7 and npm rc.2 builds)
  and descriptor v3 from both local `0.1.2-alpha.1` source revision
  `caec78de20` and the persistent `0.1.2-alpha.2` SDK matrix tested on
  2026-08-31. Unknown descriptor versions return exit code `2` instead of
  guessing.
- Honors `header.seedLength`, so an inherited fork prefix is not mistaken for
  the child's own descriptor.
- Structured diagnostics omit prompts, assistant messages, tool arguments, raw
  trial errors, and subagent descriptions. CLI-level input/read errors may
  still contain operating-system paths, so review output before sharing it.
- Treat run artifacts as trusted local files. The loader refuses remote/device
  paths and bounds trace count, compressed input, and decompressed output, but
  ordinary absolute local `tracePaths` intentionally retain the invoking
  user's file access.
- Never modifies a Harness profile or session log. `init` only creates the
  requested benchmark file and refuses to overwrite an existing file.

The real trace probes and local verification ran on Windows. The repository
configures CI for Windows Node.js 24 and Linux Node.js 22/24; those jobs must be
observed green after the first GitHub push before any release claim.

The report's `source.kind` is descriptive, not an authenticity guarantee:
`sdk-runner-claim` comes from a self-declared artifact field, while
`dsh-eval-compatible` means only that the artifact has the supported shape.
The separately published evidence hash is also a maintainer attestation, not a
third-party signature.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every verifiable contract passed. |
| `1` | At least one behavioral contract was violated. |
| `2` | The artifact or descriptor version is incompatible, so a reliable verdict is impossible. |

Machine output follows [`schemas/report.schema.json`](schemas/report.schema.json).

## What this project does not do

- The published verifier package does not run Harness cases, manage
  credentials, score final answers, or calculate tokens and cost. The separate
  SDK experiment currently supplies the persistent four-case runner.
- It does not replace the official in-process `subagent/start` / `subagent/end`
  invariant. It checks the durable record after the process has exited.
- It does not introduce another YAML assertion language, retry engine,
  baseline gate, or LLM judge.
- The bundled live benchmark is intentionally a canary: model nondeterminism
  means it should become a blocking release gate only after a team has measured
  its stability on the profiles it uses.

## Evidence

The parser and contracts were tested against deterministic fixtures and real
DeepSeek Harness parent/child traces from rc.7, npm release rc.2, local
`0.1.2-alpha.1`, and the full persistent `0.1.2-alpha.2` SDK matrix. The latter
exercised all four scenarios and returned exit `0`; all 11 persisted request
headers carried the 4,096-token cap, and the interval from the first persisted
session creation to artifact write was 49.533 seconds. Its
redacted structural result and self-attested hashes are
[`evidence/alpha2-sdk-summary.json`](evidence/alpha2-sdk-summary.json).
See
[`docs/RESEARCH_EVIDENCE.md`](docs/RESEARCH_EVIDENCE.md) for the evidence
boundary and reproduction notes.

## Development

```sh
npm test
npm run check
npm run pack:check
```

The package has no runtime dependencies. Contributions should add a redacted,
deterministic fixture for every new diagnostic. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. The multi-frame Zstandard container reader was informed by the MIT-licensed
`dsh-eval-harness` implementation; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
