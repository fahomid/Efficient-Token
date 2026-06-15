# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities.

Report privately via GitHub's [Report a vulnerability](https://github.com/fahomid/Efficient-Token/security/advisories/new)
(Security → Advisories), or by email to **fahomid2012@gmail.com** with the
subject `efficient-token security`.

Include the version, your platform, reproduction steps, and the impact. You'll
get an acknowledgement within a few days, and a fix or mitigation timeline once
the report is triaged.

## Supported versions

This is pre-1.0 software; security fixes land on the latest released minor
version. Pin a version and watch releases for updates.

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |

## Security model

efficient-token is local-first and runs on the developer's machine over stdio.
It is designed so an MCP host, and the model behind it, cannot use the server to
reach outside the workspace:

- **Filesystem sandbox.** Every path is resolved through a sandbox confined to the
  workspace root (`EFFICIENT_TOKEN_ROOT`, defaulting to the working directory).
  Path traversal (`..`) is rejected, and on Windows so are NTFS alternate data
  streams (a `:` in the final segment). Both reads and writes also `realpath`-check
  the target so a symlinked path component cannot escape the root.
- **Size guards.** Reads are capped at `EFFICIENT_TOKEN_MAX_FILE_BYTES`
  (default 2 MB) to bound memory.
- **Atomic writes.** All writes go to a temp file and are renamed into place, so a
  crash never leaves a half-written file.
- **No arbitrary command execution.** The runner tools (`code_check`,
  `check_locate`, `test_run`) only invoke scripts already defined in the project's
  `package.json`. They are allowlisted, not a shell. The `test_run` filter is
  charset-restricted to exclude shell metacharacters.
- **No network egress.** The free tier makes no outbound network calls. The future
  premium entitlement layer will exchange only a signed license token, never user
  code, and is inert until built.
- **stdout is the protocol stream.** The server never writes diagnostics to
  stdout; all logs go to stderr.

## Operator guidance

- Set `EFFICIENT_TOKEN_ROOT` explicitly to the project you intend to expose, so
  the sandbox root is unambiguous.
- The mutating tools declare `destructiveHint`. Configure your MCP host to gate or
  confirm them if you want a human in the loop for writes.
