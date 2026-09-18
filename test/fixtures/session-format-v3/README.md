# Session format v3 fixtures

These deterministic, redacted JSONL files use the released physical v3 shape
accepted by `@deepseek-ai/dsh-session-format-catalog@0.1.5-rc.2` with strict
recovery and current validation. They contain no production prompts, model
output, credentials, or machine-specific workspace paths.

The checked-in header uses the `__FIXTURE_CWD__` template token. The test
loader replaces it with the fixture directory's absolute path on the current
host before strict recovery. The official session validator uses the host
platform's `node:path.isAbsolute`, so a Windows drive-qualified path is not an
absolute path on Linux.

`seeded.jsonl` contains inherited end-seed markers at sequences 0 and 2. The
last marker wins, so the recovered inherited cut is 2: sequences 0 and 1 are
inherited, while the final marker itself belongs to the session's own suffix.

`source-ranges.jsonl` records the physical range form `[[0, 1]]`; recovery must
expand it to the logical sequence list `[0, 1]`.
