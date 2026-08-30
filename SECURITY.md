# Security policy

## Supported versions

Only the latest published minor version is supported with security fixes.

## Reporting a vulnerability

Please use GitHub's private security advisory flow for this repository. Do not
open a public issue containing credentials, private prompts, session logs, or
workspace paths.

The verifier is read-only with respect to Harness profiles and session logs.
Its `init` command creates one benchmark file using exclusive-create semantics
and refuses to overwrite an existing file.

Run artifacts are trusted-local inputs: ordinary relative and absolute paths
are read with the invoking user's permissions. Remote/device-style paths and
oversized trace sets are rejected, but do not verify an artifact from an
untrusted party in a privileged account. The SDK experiment stores raw prompts
and model output under its gitignored `runs/` directory; review and redact any
material before sharing it.
