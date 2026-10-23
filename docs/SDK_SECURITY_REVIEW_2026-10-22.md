# SDK runner dependency-security review

## Scope

This maintenance review combines Subagent Contract PRs #11, #12, #13, and #14
against main revision `c42f9be03820c4fa09579abbe056ff3b21a71ccf`. They update only
the separate experimental runner's dependency lock. No verifier behavior,
contract version, provider endpoint, live profile, or user session is changed.
This is not an npm release or a new real-model contract-matrix result.

| Dependency | Before | Reviewed installation |
| --- | --- | --- |
| `proxy-addr` | 2.0.7 | 2.0.8 |
| `compression` | 1.8.1 | 1.8.2 |
| `hono` | 4.13.5 | 4.13.13 |
| `@modelcontextprotocol/sdk` | 1.30.0 | 1.32.1 |
| `ip-address` | 10.7.0 | 10.7.4 |
| `sharp` | 0.35.4 | 0.35.5 |

A fresh advisory scan after the four bot updates still reported `ip-address`
and `sharp`. The latter two compatible patch updates were therefore added;
sharp's platform binaries and libvips packages move together. All six versions
remain within their existing parent constraints. No dependency override or new
direct production dependency is introduced.

## Reachability and authorization boundary

The runner constructs `HarnessClient` with the `sdk` profile in an isolated
home/workspace. The pinned client's transport is `JsonRpcLineTransport` over
its child's stdin/stdout. The repository's runner does not create an HTTP MCP
server, a shared MCP task store, or a bearer-authentication endpoint.

The installed graph also contains optional capabilities such as the Harness
MCP HTTP client, web host, and image decoder. Installing those modules does not
prove that their vulnerable routes were reached in a contract trial. Conversely,
this review is not a reachability guarantee for custom profiles or deployments.
The dependency updates remove the reviewed vulnerable version ranges without
claiming that this project was attacked.

In particular, the MCP SDK's bearer fix introduces an optional
`expectedResource` setting. An HTTP-server integrator must also return the
token audience as `AuthInfo.resource` from its verifier. Updating the package
alone is not sufficient. No artificial audience value was inserted into this
stdio-only runner. Its regression tests exercise the upstream middleware in
memory with synthetic tokens, including the still-permissive unconfigured
case; they are not a live HTTP-server security certification.

## Reproduction and observed evidence

On Windows with Node.js 24.14.1 and npm 11.11.0, from a clean installation:

1. Root `npm ci --ignore-scripts`, `npm run check`, and `npm run pack:check`
   pass: 60 verifier tests, including prepack validation. The package file list
   continues to exclude the experimental runner.
2. In `experiments/sdk-runner`, `npm ci --ignore-scripts` and `npm run check`
   pass: 32 tests, consisting of the existing 16 plus 16 security regressions.
   The whole runner test suite preloads the Node network guard.
3. Both cross-origin 307/308 responses are refused without invoking the
   destination fetch; a same-origin 307 remains supported. These are injected
   fetch-response fixtures, not traffic to a real external MCP server.
4. Explicit audience checks reject wrong/missing resources and expired tokens,
   accept the correct resource, and demonstrate that the unconfigured SDK
   still accepts a different audience. All tokens are synthetic.
5. The updated native sharp binary renders a 2-by-2 synthetic SVG to PNG.
   This is a compatibility smoke, not an exploit reproduction.
6. `npm run smoke` initializes and shuts down the real pinned SDK runtime with
   a placeholder credential and a child-process network guard. The guard's
   test covers ESM HTTP imports, fetch, TCP, and listeners. No model prompt is
   sent, and no real provider credential is loaded for these checks.
7. The root production audit and full experimental-runner audit report zero
   known advisories at the time of this review. This is a registry snapshot,
   not proof that no vulnerability exists.

The existing CI also runs runner checks and initialization on Windows and
Ubuntu; the exact PR/main workflow results remain the source of truth for
those platforms. No paid matrix, browser UI, custom HTTP MCP server, or
independent user field report is claimed here.

### Known npm installation diagnostic

On Windows x64, npm 11.11.0 leaves the optional `@img/sharp-wasm32` and
`@emnapi/runtime` packages installed after omitting their incompatible
FreeBSD/WebContainer parents. The frozen lock correctly records those nodes
as optional, but full actual-tree `npm ls --all` reports them as extraneous.
That diagnostic is **not green**. The selected native Windows sharp binary,
bounded SVG render, fresh install, selected dependency checks, and advisory
scan pass. The valid cross-platform lock nodes have not been deleted or hidden
with overrides/pruning. This toolchain diagnostic is separate from the six
dependency security updates and is not a claim of a fully clean actual tree.

## Upstream references

- [MCP task-session isolation](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-22jm-h49p-29qw)
- [MCP cross-origin redirect handling](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6prh-2h8m-c8cw)
- [MCP bearer resource checking](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-rvq5-wwqv-78pq)
- [Hono static-path middleware](https://github.com/honojs/hono/security/advisories/GHSA-5r4p-p66f-jhc7)
- [Proxy address trust matching](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
- [Compression cleanup](https://github.com/expressjs/compression/security/advisories/GHSA-vc2v-76pw-4v95)
- [IP address family matching](https://github.com/advisories/GHSA-j6r3-76f7-8jcv)
- [IP address diagnostic bounds](https://github.com/advisories/GHSA-h3mg-xc3c-68pw)
- [IP zone identifier bounds](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)
- [Sharp/libvips advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w)
