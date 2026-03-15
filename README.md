# @rupertsworld/daemon

Install, uninstall, and check background daemons on macOS (launchd) and Linux (systemd).

## Supported platforms

- **macOS** — LaunchAgents via `launchctl`
- **Linux** — systemd user units via `systemctl --user`

Other platforms throw a clear error.

## Install

```bash
npm install @rupertsworld/daemon
```

## Usage

```typescript
import { Daemon } from "@rupertsworld/daemon";

const daemon = new Daemon({
  name: "com.example.myapp",
  description: "My background service",
  command: "/usr/local/bin/myapp",
  args: ["--serve"],
  env: { NODE_ENV: "production" }, // optional
});

// Register and start the daemon
await daemon.install();

// Check if it's running
const { installed, running } = await daemon.status();

// Stop and remove the daemon
await daemon.uninstall();
```

## API

### `new Daemon(options)`

| Option        | Type                       | Required | Description                          |
| ------------- | -------------------------- | -------- | ------------------------------------ |
| `name`        | `string`                   | yes      | Service identifier                   |
| `description` | `string`                   | yes      | Human-readable description           |
| `command`     | `string`                   | yes      | Absolute path to the executable      |
| `args`        | `string[]`                 | yes      | Arguments passed to the command      |
| `env`         | `Record<string, string>`   | no       | Environment variables for the daemon |

### `daemon.install(): Promise<void>`

Writes the platform service file and registers it. Idempotent — if the service is already installed, it unloads/disables first, then re-registers.

### `daemon.uninstall(): Promise<void>`

Stops the service and removes the service file. Safe to call when the service is not installed.

### `daemon.status(): Promise<{ installed: boolean; running: boolean }>`

Returns whether the service file exists and whether the daemon process is currently running.
