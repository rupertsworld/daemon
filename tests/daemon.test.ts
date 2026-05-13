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
    name?: string;
    platform?: NodeJS.Platform;
    homeDir?: string;
    exec?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
    args?: string[];
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
    name: overrides.name ?? "com.example.test",
    description: "Test daemon",
    command: "/usr/local/bin/test-daemon",
    args: overrides.args ?? ["--serve"],
    env: overrides.env,
    platform: overrides.platform ?? "darwin",
    homeDir: overrides.homeDir ?? tmpdir(),
    exec,
  });

  return { daemon, calls };
}

const safeSystemdEnvValueCases = [
  { label: "underscore", slug: "underscore", value: "a_b" },
  { label: "dot", slug: "dot", value: "a.b" },
  { label: "slash", slug: "slash", value: "a/b" },
  { label: "colon", slug: "colon", value: "a:b" },
  { label: "at sign", slug: "at-sign", value: "a@b" },
  { label: "comma", slug: "comma", value: "a,b" },
  { label: "equals sign", slug: "equals-sign", value: "a=b" },
  { label: "plus sign", slug: "plus-sign", value: "a+b" },
  { label: "hyphen", slug: "hyphen", value: "a-b" },
];

const quotedSystemdEnvValueCases = [
  { label: "dollar sign", slug: "dollar-sign", value: "a$b" },
  { label: "backtick", slug: "backtick", value: "a`b" },
  { label: "semicolon", slug: "semicolon", value: "a;b" },
  { label: "hash", slug: "hash", value: "a#b" },
  { label: "asterisk", slug: "asterisk", value: "a*b" },
  { label: "question mark", slug: "question-mark", value: "a?b" },
  { label: "opening parenthesis", slug: "open-paren", value: "a(b" },
  { label: "closing parenthesis", slug: "close-paren", value: "a)b" },
];

const allowedXmlWhitespaceCases = [
  { label: "tab", slug: "tab", value: "line1\tline2" },
  { label: "newline", slug: "newline", value: "line1\nline2" },
  { label: "carriage return", slug: "carriage-return", value: "line1\rline2" },
];

const forbiddenXmlControlCharCases = [
  { label: "\\x00", slug: "x00", value: "\u0000" },
  { label: "\\x08", slug: "x08", value: "\u0008" },
  { label: "\\x0B", slug: "x0b", value: "\u000B" },
  { label: "\\x0C", slug: "x0c", value: "\u000C" },
  { label: "\\x0E", slug: "x0e", value: "\u000E" },
  { label: "\\x1F", slug: "x1f", value: "\u001F" },
];

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

test("install: linux includes env vars in systemd unit when provided", async () => {
  const home = await makeTempHome("daemon-linux-env");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { PATH: "/home/user/.nvm/versions/node/v22/bin:/usr/bin", NODE_ENV: "production" },
    });

    await daemon.install();

    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitFile, "utf8");

    assert.ok(unit.includes("Environment=PATH=/home/user/.nvm/versions/node/v22/bin:/usr/bin"));
    assert.ok(unit.includes("Environment=NODE_ENV=production"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux omits env lines when no env vars provided", async () => {
  const home = await makeTempHome("daemon-linux-no-env");

  try {
    const { daemon } = makeDaemon({ platform: "linux", homeDir: home });

    await daemon.install();

    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitFile, "utf8");

    assert.ok(!unit.includes("Environment="));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux quotes env values containing spaces", async () => {
  const home = await makeTempHome("daemon-linux-env-space");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { KEY: "a b" },
    });

    await daemon.install();

    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitFile, "utf8");

    assert.ok(unit.includes('Environment=KEY="a b"'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('install: linux quotes env values containing " and escapes them', async () => {
  const home = await makeTempHome("daemon-linux-env-quote");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { KEY: 'a"b' },
    });

    await daemon.install();

    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitFile, "utf8");

    assert.ok(unit.includes('Environment=KEY="a\\"b"'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux quotes env values containing backslashes and escapes them", async () => {
  const home = await makeTempHome("daemon-linux-env-backslash");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { KEY: "a\\b" },
    });

    await daemon.install();

    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitFile, "utf8");

    assert.ok(unit.includes('Environment=KEY="a\\\\b"'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const { label, slug, value } of safeSystemdEnvValueCases) {
  test(`install: linux keeps safe env values with ${label} unquoted`, async () => {
    const home = await makeTempHome(`daemon-linux-env-safe-${slug}`);

    try {
      const { daemon } = makeDaemon({
        platform: "linux",
        homeDir: home,
        env: { KEY: value },
      });

      await daemon.install();

      const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
      const unit = await readFile(unitFile, "utf8");

      assert.ok(unit.includes(`Environment=KEY=${value}`));
      assert.ok(!unit.includes(`Environment=KEY="${value}"`));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

for (const { label, slug, value } of quotedSystemdEnvValueCases) {
  test(`install: linux quotes env values containing ${label}`, async () => {
    const home = await makeTempHome(`daemon-linux-env-quoted-${slug}`);

    try {
      const { daemon } = makeDaemon({
        platform: "linux",
        homeDir: home,
        env: { KEY: value },
      });

      await daemon.install();

      const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
      const unit = await readFile(unitFile, "utf8");

      assert.ok(unit.includes(`Environment=KEY="${value}"`));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("install: linux rejects env values containing newlines", async () => {
  const home = await makeTempHome("daemon-linux-env-newline");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { KEY: "a\nb" },
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux rejects env values containing NUL", async () => {
  const home = await makeTempHome("daemon-linux-env-nul");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { KEY: "a\u0000b" },
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux rejects env keys starting with digits", async () => {
  const home = await makeTempHome("daemon-linux-invalid-env-key");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { "1BAD": "value" },
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux rejects env keys containing =", async () => {
  const home = await makeTempHome("daemon-linux-invalid-env-key-equals");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { "BAD=KEY": "value" },
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux rejects env keys containing spaces", async () => {
  const home = await makeTempHome("daemon-linux-invalid-env-key-space");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { "BAD KEY": "value" },
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux quotes UTF-8 env values and preserves them verbatim", async () => {
  const home = await makeTempHome("daemon-linux-env-utf8");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { KEY: "café résumé" },
    });

    await daemon.install();

    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitFile, "utf8");

    assert.ok(unit.includes('Environment=KEY="café résumé"'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: linux renders empty env values successfully", async () => {
  const home = await makeTempHome("daemon-linux-env-empty");

  try {
    const { daemon } = makeDaemon({
      platform: "linux",
      homeDir: home,
      env: { KEY: "" },
    });

    await daemon.install();

    const unitFile = join(home, ".config", "systemd", "user", "com.example.test.service");
    const unit = await readFile(unitFile, "utf8");

    assert.ok(unit.includes("Environment=KEY="));
    assert.ok(!unit.includes('Environment=KEY=""'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

test("install: macOS escapes XML-special characters in plist labels", async () => {
  const home = await makeTempHome("daemon-darwin-label-xml-escape");
  const name = "com.example.a&b<c>d";

  try {
    const { daemon } = makeDaemon({
      name,
      platform: "darwin",
      homeDir: home,
    });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", `${name}.plist`);
    const plist = await readFile(plistPath, "utf8");

    assert.ok(plist.includes("<string>com.example.a&amp;b&lt;c&gt;d</string>"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS rejects plist labels containing forbidden XML control characters", async () => {
  const home = await makeTempHome("daemon-darwin-label-invalid-xml-control");

  try {
    const { daemon } = makeDaemon({
      name: "com.example.bad\u0000name",
      platform: "darwin",
      homeDir: home,
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS escapes XML-special characters in env values", async () => {
  const home = await makeTempHome("daemon-darwin-env-xml-escape");

  try {
    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      env: { URL: "a&b<c>d" },
    });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.ok(plist.includes("<key>URL</key>"));
    assert.ok(plist.includes("<string>a&amp;b&lt;c&gt;d</string>"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const { label, slug, value } of allowedXmlWhitespaceCases) {
  test(`install: macOS allows XML whitespace control ${label} in env values`, async () => {
    const home = await makeTempHome(`daemon-darwin-env-xml-whitespace-${slug}`);

    try {
      const { daemon } = makeDaemon({
        platform: "darwin",
        homeDir: home,
        env: { KEY: value },
      });

      await daemon.install();

      const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
      const plist = await readFile(plistPath, "utf8");

      assert.ok(plist.includes(`<string>${value}</string>`));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("install: macOS rejects invalid env keys containing &", async () => {
  const home = await makeTempHome("daemon-darwin-invalid-env-key");

  try {
    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      env: { "BAD&KEY": "value" },
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS escapes XML-special characters in program args", async () => {
  const home = await makeTempHome("daemon-darwin-arg-xml-escape");

  try {
    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      args: ["--config=<prod>"],
    });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.ok(plist.includes("<string>--config=&lt;prod&gt;</string>"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS rejects XML-forbidden control characters in program args", async () => {
  const home = await makeTempHome("daemon-darwin-arg-invalid-xml-control");

  try {
    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      args: ["--bad=\u0001"],
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS rejects XML-forbidden control characters in env values", async () => {
  const home = await makeTempHome("daemon-darwin-invalid-xml-control");

  try {
    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      env: { BAD: "\u0001" },
    });

    await assert.rejects(daemon.install());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const { label, slug, value } of forbiddenXmlControlCharCases) {
  test(`install: macOS rejects XML-forbidden control character boundary ${label} in env values`, async () => {
    const home = await makeTempHome(`daemon-darwin-invalid-xml-boundary-${slug}`);

    try {
      const { daemon } = makeDaemon({
        platform: "darwin",
        homeDir: home,
        env: { BAD: value },
      });

      await assert.rejects(daemon.install());
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("install: macOS plist always includes ProcessType Background", async () => {
  const home = await makeTempHome("daemon-darwin-process-type");

  try {
    const { daemon } = makeDaemon({ platform: "darwin", homeDir: home });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.ok(plist.includes("<key>ProcessType</key>"));
    assert.ok(plist.includes("<string>Background</string>"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install: macOS renders empty env values successfully", async () => {
  const home = await makeTempHome("daemon-darwin-env-empty");

  try {
    const { daemon } = makeDaemon({
      platform: "darwin",
      homeDir: home,
      env: { KEY: "" },
    });

    await daemon.install();

    const plistPath = join(home, "Library", "LaunchAgents", "com.example.test.plist");
    const plist = await readFile(plistPath, "utf8");

    assert.ok(plist.includes("<key>KEY</key>"));
    assert.ok(plist.includes("<string></string>"));
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
