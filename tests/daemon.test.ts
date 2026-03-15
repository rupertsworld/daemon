import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, UnsupportedPlatformError } from "../src/index.ts";

type ExecCall = { command: string; args: string[] };

async function makeTempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

function makeDaemon(
  overrides: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
    env?: Record<string, string>;
  } = {},
): { daemon: Daemon; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec =
    overrides.exec ??
    (async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    });

  const daemon = new Daemon({
    name: "com.example.test",
    description: "Test daemon",
    command: "/usr/local/bin/test-daemon",
    args: ["--serve"],
    env: overrides.env,
    platform: overrides.platform ?? "darwin",
    homeDir: overrides.homeDir ?? tmpdir(),
    exec,
  });

  return { daemon, calls };
}

test("install: macOS writes launchd plist and loads the service", async () => {
  const home = await makeTempHome("daemon-darwin-install");

  try {
    const { daemon, calls } = makeDaemon({ platform: "darwin", homeDir: home });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.ok(plist.includes("<string>/usr/local/bin/test-daemon</string>"));
    assert.ok(plist.includes("<string>--serve</string>"));
    assert.ok(
      calls.some(
        ({ command, args }) =>
          command === "launchctl" && args[0] === "load" && args[1] === "-w" && args[2] === plistPath,
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS reinstall unloads before reloading (idempotent)", async () => {
  const home = await makeTempHome("daemon-darwin-reinstall");

  try {
    const plistFile = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistFile, "<plist />", "utf8");

    const { daemon, calls } = makeDaemon({ platform: "darwin", homeDir: home });

    await daemon.install();

    assert.equal(calls[0].command, "launchctl");
    assert.deepEqual(calls[0].args, ["unload", "-w", plistFile]);
    assert.equal(calls[1].command, "launchctl");
    assert.deepEqual(calls[1].args, ["load", "-w", plistFile]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux writes systemd unit and enables the service", async () => {
  const home = await makeTempHome("daemon-linux-install");

  try {
    const { daemon, calls } = makeDaemon({ platform: "linux", homeDir: home });

    await daemon.install();

    const unitPath = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitPath, "utf8");

    assert.ok(unit.includes("ExecStart=/usr/local/bin/test-daemon --serve"));
    assert.ok(unit.includes("Description=Test daemon"));
    assert.ok(
      calls.some(
        ({ command, args }) =>
          command === "systemctl" && args.join(" ") === "--user enable --now com.example.test.service",
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux reinstall disables before re-enabling (idempotent)", async () => {
  const home = await makeTempHome("daemon-linux-reinstall");

  try {
    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitFile, "[Unit]\nDescription=old\n", "utf8");

    const { daemon, calls } = makeDaemon({ platform: "linux", homeDir: home });

    await daemon.install();

    assert.deepEqual(calls[0], {
      command: "systemctl",
      args: ["--user", "disable", "--now", "com.example.test.service"],
    });
    assert.deepEqual(calls[1], { command: "systemctl", args: ["--user", "daemon-reload"] });
    assert.deepEqual(calls[2], {
      command: "systemctl",
      args: ["--user", "enable", "--now", "com.example.test.service"],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstall: linux removes the systemd unit and disables the service", async () => {
  const home = await makeTempHome("daemon-linux-uninstall");

  try {
    const unitPath = join(home, ".config", "systemd", "user", "com.example.test.service");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath, "[Unit]\nDescription=old\n", "utf8");

    const { daemon, calls } = makeDaemon({ platform: "linux", homeDir: home });

    await daemon.uninstall();

    assert.equal(existsSync(unitPath), false);
    assert.ok(
      calls.some(
        ({ command, args }) =>
          command === "systemctl" &&
          args.join(" ") === "--user disable --now com.example.test.service",
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstall: macOS removes plist and unloads the service", async () => {
  const home = await makeTempHome("daemon-darwin-uninstall");

  try {
    const plistFile = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistFile, "<plist />", "utf8");

    const { daemon, calls } = makeDaemon({ platform: "darwin", homeDir: home });

    await daemon.uninstall();

    assert.equal(existsSync(plistFile), false);
    assert.ok(
      calls.some(
        ({ command, args }) =>
          command === "launchctl" && args[0] === "unload" && args[1] === "-w",
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstall: macOS is safe when not installed", async () => {
  const home = await makeTempHome("daemon-darwin-uninstall-noop");

  try {
    const { daemon } = makeDaemon({ platform: "darwin", homeDir: home });
    await daemon.uninstall();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstall: linux is safe when not installed", async () => {
  const home = await makeTempHome("daemon-linux-uninstall-noop");

  try {
    const { daemon } = makeDaemon({ platform: "linux", homeDir: home });
    await daemon.uninstall();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status: macOS reports installed and running for active service", async () => {
  const home = await makeTempHome("daemon-darwin-status-running");

  try {
    const plistFile = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistFile, "<plist />", "utf8");

    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      exec: async () => ({ stdout: "", stderr: "" }),
    });

    assert.deepEqual(await daemon.status(), { installed: true, running: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status: macOS reports not installed when no plist exists", async () => {
  const home = await makeTempHome("daemon-darwin-status-missing");

  try {
    const { daemon } = makeDaemon({ platform: "darwin", homeDir: home });

    assert.deepEqual(await daemon.status(), { installed: false, running: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status: macOS reports installed but not running when launchctl fails", async () => {
  const home = await makeTempHome("daemon-darwin-status-stopped");

  try {
    const plistFile = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistFile, "<plist />", "utf8");

    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      exec: async () => {
        throw new Error("not found");
      },
    });

    assert.deepEqual(await daemon.status(), { installed: true, running: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status: linux reports installed and running for active service", async () => {
  const home = await makeTempHome("daemon-linux-status-running");

  try {
    const unitPath = join(home, ".config", "systemd", "user", "com.example.test.service");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath, "[Unit]\n", "utf8");

    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      exec: async () => ({ stdout: "active\n", stderr: "" }),
    });

    assert.deepEqual(await daemon.status(), { installed: true, running: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status: linux reports installed but not running for inactive service", async () => {
  const home = await makeTempHome("daemon-linux-status-inactive");

  try {
    const unitPath = join(home, ".config", "systemd", "user", "com.example.test.service");
    await mkdir(join(home, ".config", "systemd", "user"), { recursive: true });
    await writeFile(unitPath, "[Unit]\n", "utf8");

    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      exec: async () => {
        throw new Error("inactive");
      },
    });

    assert.deepEqual(await daemon.status(), { installed: true, running: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: unsupported platform throws UnsupportedPlatformError", async () => {
  const { daemon } = makeDaemon({ platform: "win32" });

  await assert.rejects(daemon.install(), (err) => err instanceof UnsupportedPlatformError);
});

test("uninstall: unsupported platform throws UnsupportedPlatformError", async () => {
  const { daemon } = makeDaemon({ platform: "win32" });

  await assert.rejects(daemon.uninstall(), (err) => err instanceof UnsupportedPlatformError);
});

test("status: unsupported platform throws UnsupportedPlatformError", async () => {
  const { daemon } = makeDaemon({ platform: "win32" });

  await assert.rejects(daemon.status(), (err) => err instanceof UnsupportedPlatformError);
});

test("install: macOS includes env vars in plist when provided", async () => {
  const home = await makeTempHome("daemon-darwin-env");

  try {
    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      env: { PATH: "/usr/local/bin", NODE_ENV: "production" },
    });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.ok(plist.includes("<key>EnvironmentVariables</key>"));
    assert.ok(plist.includes("<key>PATH</key>"));
    assert.ok(plist.includes("<string>/usr/local/bin</string>"));
    assert.ok(plist.includes("<key>NODE_ENV</key>"));
    assert.ok(plist.includes("<string>production</string>"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS omits env block when no env vars provided", async () => {
  const home = await makeTempHome("daemon-darwin-no-env");

  try {
    const { daemon } = makeDaemon({ platform: "darwin", homeDir: home });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.ok(!plist.includes("<key>EnvironmentVariables</key>"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
