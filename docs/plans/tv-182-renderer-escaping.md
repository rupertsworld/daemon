# Plan: fix env var escaping in plist and systemd renderers (TV-182)

## Overview

`@rupertsworld/daemon` renders launchd plist XML and systemd unit files by raw string interpolation. When env keys or values contain XML-special characters (`&`, `<`, `>`) the generated plist is malformed and `launchctl load` fails silently. When systemd `Environment=` values contain spaces (or other characters needing quoting), systemd silently mis-parses the line. Both bugs are dormant today because no caller passes env vars, but TV-39 is about to start piping user shell env into these renderers, where `&` in URLs, spaces in colour vars, and similar are routine.

This change makes both renderers escape correctly, validates inputs that can't be represented (control characters, invalid env keys, newlines in systemd values), and adds `ProcessType: Background` to the plist so macOS schedules the service appropriately.

Bumps `0.1.1` → `0.2.0` — escape behaviour is observable in any consumer fixture.

## Escaping and ProcessType

### Helpers (new, internal)

- `xmlEscape(s: string): string` — replaces `&`, `<`, `>` with the corresponding XML entities. Used for every interpolation inside plist text content (the only place we put user data; we never write to XML attributes).
- `validateXmlString(s: string): void` — throws on any character in `\x00-\x08`, `\x0B`, `\x0C`, `\x0E-\x1F`. These are forbidden in XML 1.0 and cannot be escaped; a plist containing them will not parse. Tab, LF, CR are allowed.
- `validateEnvKey(k: string): void` — throws unless `k` matches `/^[A-Za-z_][A-Za-z0-9_]*$/` (POSIX env var name). Applied on both platforms so invalid keys fail the same way regardless of OS.
- `formatSystemdEnvValue(v: string): string` — throws on NUL or newline (systemd has no representation for either). Returns `v` unquoted if it matches the liberal safe charset `/^[A-Za-z0-9_./:@,=+-]*$/`. Otherwise returns a double-quoted string with `\` and `"` backslash-escaped — the canonical `systemd.exec(5)` form. UTF-8, spaces, `$`, backticks, `;`, `#` all survive the quoting.

Inputs that can't be represented (control chars, bad keys, newlines) throw rather than silently dropping. Callers are TV code we control; loud failure is correct.

### `renderPlist` changes

- Run `validateXmlString` on `name`, every `ProgramArguments` element, and every env key/value before rendering.
- Run `validateEnvKey` on every env key.
- Pass `name`, each program-arg, and each env key/value through `xmlEscape` at the interpolation site.
- Always emit `<key>ProcessType</key><string>Background</string>` between `KeepAlive` and the optional `EnvironmentVariables` block. No option, no opt-out — correct for every consumer.

### `renderUnit` changes

- Run `validateEnvKey` on every env key.
- Replace the existing `Environment=${k}=${v}` interpolation with `Environment=${k}=${formatSystemdEnvValue(v)}`.
- Existing `quoteSystemdArg` (used for `ExecStart`) is unchanged — it already handles its narrower job.

### Version and changelog

- `package.json` → `"version": "0.2.0"`.

### Tests (additions to `tests/daemon.test.ts`)

Plist:
- env value containing `&`, `<`, `>` round-trips with entities (`&amp;`, `&lt;`, `&gt;`).
- env key containing `&` — throws (invalid key catches it first).
- program-arg containing `<` is escaped.
- env value containing `\x01` — throws.
- plist always contains `<key>ProcessType</key>` and `<string>Background</string>`.

Systemd:
- env value containing a space → quoted (`Environment=KEY="a b"`).
- env value containing `"` → quoted and `"` escaped to `\"`.
- env value containing `\` → quoted and `\` escaped to `\\`.
- env value of plain `production` → unquoted (preserves existing assertion in the env test).
- env value containing `\n` — throws.
- env key starting with a digit — throws.

## Out of scope

- TV-39 (capturing shell env upstream) — this PR only fixes the renderer it will feed.
- TV-183 (log file routing via `StandardOutPath` / `StandardErrorPath`) — separate plan.
- Windows support.
