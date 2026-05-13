# Plan: log file routing for plist and systemd renderers (TV-183 part 1)

## Overview

Today the daemon package doesn't configure where the service's stdout/stderr go. On macOS that means Apple System Log only (Console.app to read). On Linux it means the systemd journal. Neither is friendly for users debugging `tv serve --persist` — they want a log file they can `tail -f`.

Add two optional `DaemonOptions` fields, `stdoutPath` and `stderrPath`, and pass them through to the renderers as launchd's `StandardOutPath` / `StandardErrorPath` and systemd's `StandardOutput=append:` / `StandardError=append:`. Independent — either can be set without the other. Caller pre-creates the parent directory; this package doesn't `mkdir` user-specified paths.

Part 2 of TV-183 (TV server diagnostic logging that consumes these options) lives in the `television` repo and is out of scope here.

## Log paths

### `DaemonOptions` additions

```ts
stdoutPath?: string;
stderrPath?: string;
```

Both optional. Empty strings are rejected (treat as not-set instead of writing an empty path). Both flow through the existing `validateXmlString` (rejects XML-forbidden control chars) on macOS; both flow through a new `validateSystemdPath` (rejects newlines and NUL) on Linux. No absolute-path enforcement — callers decide.

### Plist

When `stdoutPath` is set, emit between `ProcessType` and the optional `EnvironmentVariables` block:

```xml
<key>StandardOutPath</key>
<string>${xmlEscape(stdoutPath)}</string>
```

Same shape for `StandardErrorPath`. Either, both, or neither — order is `StandardOutPath` before `StandardErrorPath` when both present.

### Systemd

When `stdoutPath` is set, append to the `[Service]` section:

```
StandardOutput=append:${stdoutPath}
```

Same for `StandardError=append:`. `append:` (not `file:`) so logs survive restarts — the whole point of routing them to a file. Paths are emitted literally — systemd directives take a literal path; the quoting rules are only for `Environment=`. Reject newlines and NUL in the path with a thrown `Error` (no representation in the unit-file syntax).

### Class wiring

Store `stdoutPath` / `stderrPath` on `Daemon`, pass them to the renderers. No directory creation.

### Tests

Plist:
- `stdoutPath` only → plist contains `StandardOutPath` but not `StandardErrorPath`.
- `stderrPath` only → mirror.
- Both → both keys present, `StandardOutPath` before `StandardErrorPath`.
- Path containing `&` → XML-escaped to `&amp;`.
- Path containing `\x00` → throws.
- Neither option (default) → neither key present.

Systemd:
- `stdoutPath` only → unit contains `StandardOutput=append:/…` only.
- `stderrPath` only → mirror.
- Both → both directives present.
- Path containing newline → throws.
- Path containing NUL → throws.
- Neither option → neither directive present.

## README

Add two rows to the options table:

| `stdoutPath` | `string` | no | Absolute path for the daemon's stdout log file. Caller must pre-create the parent directory. |
| `stderrPath` | `string` | no | Absolute path for the daemon's stderr log file. Caller must pre-create the parent directory. |

Add a short paragraph under the options table noting that on Linux the logs are appended (`append:`) and on macOS `launchd` truncates — same as it does for any `StandardOutPath`.

## Out of scope

- TV-183 part 2: TV server diagnostic logging that consumes `stdoutPath` / `stderrPath`. Lives in the `television` repo.
- Auto-creating log directories.
- Log rotation or size caps.
- Windows support.
