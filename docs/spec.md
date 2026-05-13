# Renderer spec

Behaviour of the launchd plist and systemd unit renderers in `@rupertsworld/daemon`. Authoritative reference for callers that feed user-supplied data (env vars, command args) into a `Daemon`.

## Input validation

The following are rejected with a thrown `Error` *before* any file is written, on either platform:

- **Env var keys** that don't match `/^[A-Za-z_][A-Za-z0-9_]*$/` (POSIX). Examples that throw: `1BAD`, `BAD=KEY`, `BAD KEY`, `BAD&KEY`.
- **Strings rendered into XML** containing any character in `\x00-\x08`, `\x0B`, `\x0C`, `\x0E-\x1F`. These are forbidden in XML 1.0 and cannot be escaped. Applies to `name`, each program argument, and every env key/value when the target is macOS. Tab (`\x09`), LF (`\x0A`), and CR (`\x0D`) are allowed.
- **Systemd env values** containing NUL (`\x00`) or newline (`\x0A`). systemd has no representation for either.
- **Log paths** (`stdoutPath`, `stderrPath`) that are the empty string, or that contain NUL or newline when the target is Linux. (On macOS, log paths are subject to the same XML control-char rule as any other XML-rendered string.)

Validation is loud by design — TV consumers should rely on this rather than silently producing broken service files.

## launchd plist (macOS)

XML-escapes `&`, `<`, `>` (entities `&amp;`, `&lt;`, `&gt;`) in every interpolation site:

- `<key>Label</key><string>…</string>` — escapes `name`.
- Each `<string>…</string>` inside `<key>ProgramArguments</key>` — escapes each arg.
- Each `<key>…</key>` and `<string>…</string>` inside `<key>EnvironmentVariables</key>` — escapes env keys and values.

`"` and `'` are not escaped — they're legal inside XML element text content (only attribute values would require it, and the renderer never writes user data into attributes).

Always emits:

```xml
<key>ProcessType</key>
<string>Background</string>
```

between `KeepAlive` and the optional `EnvironmentVariables` block. No option; right for every consumer of this package.

When `stdoutPath` and/or `stderrPath` are set on `DaemonOptions`, emits between `ProcessType` and the optional `EnvironmentVariables` block:

```xml
<key>StandardOutPath</key>
<string>${xmlEscape(stdoutPath)}</string>
<key>StandardErrorPath</key>
<string>${xmlEscape(stderrPath)}</string>
```

Either option may be set independently. When both are set, `StandardOutPath` is emitted before `StandardErrorPath`. Caller is responsible for ensuring the parent directory exists; this package does not `mkdir`.

## systemd unit (Linux)

`Environment=KEY=VALUE` lines render the value through this rule:

1. If the value matches `/^[A-Za-z0-9_./:@,=+-]*$/` — emit it bare: `Environment=KEY=value`. Empty values are bare (`Environment=KEY=`).
2. Otherwise emit double-quoted with `\` → `\\` and `"` → `\"`: `Environment=KEY="a b"`, `Environment=KEY="a\"b"`, `Environment=KEY="a\\b"`. UTF-8, spaces, `$`, backticks, `;`, `#`, `*`, `?`, parentheses all survive inside the quoted form.

`ExecStart` arg quoting is handled separately by `quoteSystemdArg` (unchanged from prior versions) and is not part of this spec.

When `stdoutPath` and/or `stderrPath` are set on `DaemonOptions`, emits inside `[Service]`:

```
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}
```

Either may be set independently. `append:` (rather than `file:`) is used so logs survive service restarts. Paths are emitted literally — systemd directives take a literal path; the `Environment=` quoting rules do not apply. Caller is responsible for ensuring the parent directory exists.

## Why these rules

Both renderers previously did raw `${…}` interpolation, which silently produced malformed service files when env vars contained XML-special characters (plist) or whitespace (systemd). Failure modes were silent: `launchctl load` would fail to parse, `systemd` would mis-parse the line and the daemon would start with a different environment than intended.

The escaping rules above are the minimum that makes both formats accept arbitrary user-shell-derived env data without ambiguity. The validation rules cover the characters neither format can represent at all.

## Versioning

Behaviour described here is `@rupertsworld/daemon@0.2.0` and later. Pre-`0.2.0` versions did no escaping or validation.
