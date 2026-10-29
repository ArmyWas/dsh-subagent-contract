# Dependency baseline maintenance, 2026-10-29

## Why the independent Cordis update is not accepted

[PR #16](https://github.com/ArmyWas/dsh-subagent-contract/pull/16) selects
Cordis 4.0.5 while the reviewed session/catalog 0.1.5-rc.3 graph requires the
exact Cordis 4.0.2 peer. All three root CI environments fail during `npm ci`
with `ERESOLVE`, before verifier tests start. The two experimental SDK smoke
jobs use a separate graph; their success cannot validate the root update.

The root Cordis/session/catalog tuple remains 4.0.2 / 0.1.5-rc.3 / 0.1.5-rc.3.
The SDK client and subprocess remain pinned to 0.1.2-alpha.2. No force install,
legacy peer resolution, overrides, or major Harness migration is introduced.

## Routine version updates versus security updates

The three direct root runtime packages receive exact-name Dependabot
`ignore.update-types` rules for routine patch/minor/major version PRs. Their
evidence baseline must be reviewed together rather than independently bumped.
Development dependency and GitHub Actions updates retain their existing policy.

This does not use bare ignores or `ignore.versions`. GitHub documents that
[update-types does not filter security updates](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/controlling-dependencies-updated).
Repository vulnerability alerts and security-update settings remain enabled.
An eventual security update can still require a coordinated manual bundle
upgrade; this configuration does not guarantee that every security PR installs.

The policy regression recognizes only this repository's bounded YAML shape.
It is not a general YAML parser or proof that GitHub has applied the policy.
The configuration must be merged onto the default branch to govern future runs.

## Fresh advisory scan and narrow lock refresh

A fresh npm scan found newer advisories before the GitHub alert list reflected
them. Selected transitive packages were updated within their existing incoming
ranges; direct runtime pins were not changed. No package nodes were added or
removed in either graph.

| Graph | Package | Previous | Selected |
| --- | --- | --- | --- |
| Root, development | fast-uri | 3.1.8 | 3.1.9 |
| Root, production | zod | 4.6.5 | 4.6.7 |
| SDK experiment | @hono/node-server | 2.1.1 | 2.1.5 |
| SDK experiment | body-parser | 2.3.0 | 2.4.0 |
| SDK experiment | fast-uri | 3.1.8 | 3.1.9 |
| SDK experiment | qs | 6.16.0 | 6.17.1 |
| SDK experiment | undici | 8.11.2 | 8.12.3 |
| SDK experiment | zod | 4.5.4 | 4.6.7 |

MCP 1.32.1 permits the selected Node server via `^1.19.9 || ^2.0.5`; its Hono
peer remains satisfied by Hono 4.13.13. Express 5.2.1 permits body-parser 2.4.0;
the latter's updated qs, content-type, and iconv-lite requirements are met.
The web-fetch package permits Undici through `^8.10.0`. Other changed packages
likewise remain within the recorded incoming ranges.

## Verification and boundary

On Windows with Node.js 24.14.1 / npm 11.11.0, clean frozen-lock installs,
65 root tests, 38 guarded SDK tests, and keyless SDK initialization passed.
Both full npm audits report zero known vulnerabilities at verification time.
Root packaging checks passed. Installed security floors are metadata guards,
not proof of exploit prevention or every downstream deployment's configuration.

The SDK smoke uses a placeholder credential, a fresh temporary home, and the
existing test-only Node networking guard. No real key, prompt or model request
was used. HTTP server routes, an exploit matrix, and the paid four-scenario
subagent matrix were not exercised by this maintenance pass. Existing live
matrix evidence remains historical; the experiment is still source-only and
not ready for npm publication. The earlier
[SDK review](SDK_SECURITY_REVIEW_2026-10-22.md) records additional boundaries,
including the separate npm optional-tree diagnostic.
