# Contributing

Issues and focused pull requests are welcome.

Before proposing a new contract, show that it is both:

1. observable in durable DeepSeek Harness session logs after the process exits;
2. not already enforced by `dsh-eval`, `dsh-eval-harness`, or an official
   in-process invariant.

Every diagnostic change must include a deterministic, redacted fixture. Never
commit credentials, full user prompts, private workspace paths, or unredacted
session logs.

Run the local gates before opening a pull request:

```sh
npm run check
npm run pack:check
```

Keep output codes backward-compatible within a contract version. A semantic
change to a contract requires a new contract version rather than silently
changing `dsh-subagent/v0.1`.
