# Changelog

All notable changes to this project will be documented here.

## 0.1.0-preview.1 — Unreleased

- Add seven durable subagent contracts spanning lineage, descriptors,
  admission, foreground results, continuation, settlement, and report
  provenance.
- Read complete bundled-benchmark runs in the `dsh-eval` 0.3.0 artifact shape
  without importing private modules.
- Decode plain JSONL and concatenated multi-frame Zstandard session logs.
- Support the tested descriptor v2 builds and descriptor v3 from
  the local `0.1.2-alpha.1` source revision and the real persistent
  `0.1.2-alpha.2` SDK matrix, with incompatible-version exit code 2.
- Add a fixed benchmark initializer, JSON Schema report, deterministic fixtures,
  and real-trace evidence notes.
- Add a separate persistent SDK runner experiment that exercises all four fixed
  scenarios without the stock headless process truncating background children.
- Treat open activity as inconclusive evidence, redact raw trial errors and
  descriptions, and bound trace count, path type, compressed size, and
  decompressed output.
- Require explicit foreground/background intent and reject unsupported or extra
  fixed-matrix children instead of inferring a passing mode from descriptors.
- Harden the persistent SDK experiment with child-id lifecycle pairing,
  least-privilege per-scenario tool surfaces, scrubbed environment inheritance,
  bounded requests/notifications/traces, no-overwrite artifacts, offline
  acceptance checks, and transparent bounded retries.
