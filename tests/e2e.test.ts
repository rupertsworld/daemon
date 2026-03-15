import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { Daemon } from "../src/index.ts";

const exec = promisify(execFile);

async function isProcessRunning(name: string, args: string): Promise<boolean> {
  try {
    if (platform() === "darwin") {
      const { stdout } = await exec("pgrep", ["-f", `${name} ${args}`]);
      return stdout.trim().length > 0;
    }
    const { stdout } = await exec("pgrep", ["-f", `${name} ${args}`]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

const currentPlatform = platform();
const SERVICE_NAME = "com.rupertsworld.daemon-e2e-test";

describe("e2e: macOS (launchd)", { skip: currentPlatform !== "darwin" }, () => {
  test("install, status running, uninstall, status gone", async () => {
    const daemon = new Daemon({
      name: SERVICE_NAME,
      description: "daemon e2e test",
      command: "/bin/sleep",
      args: ["86400"],
    });

    try {
      await daemon.install();

      const afterInstall = await daemon.status();
      assert.equal(afterInstall.installed, true, "should be installed after install");
      assert.equal(afterInstall.running, true, "should be running after install");

      const processAlive = await isProcessRunning("/bin/sleep", "86400");
      assert.equal(processAlive, true, "sleep process should actually be running on the system");
    } finally {
      await daemon.uninstall();
    }

    const afterUninstall = await daemon.status();
    assert.equal(afterUninstall.installed, false, "should not be installed after uninstall");
    assert.equal(afterUninstall.running, false, "should not be running after uninstall");

    const processGone = await isProcessRunning("/bin/sleep", "86400");
    assert.equal(processGone, false, "sleep process should no longer be running after uninstall");
  });

  test("install is idempotent", async () => {
    const daemon = new Daemon({
      name: SERVICE_NAME,
      description: "daemon e2e test",
      command: "/bin/sleep",
      args: ["86400"],
    });

    try {
      await daemon.install();
      await daemon.install();

      const status = await daemon.status();
      assert.equal(status.installed, true);
      assert.equal(status.running, true);
    } finally {
      await daemon.uninstall();
    }
  });

  test("uninstall is safe when not installed", async () => {
    const daemon = new Daemon({
      name: SERVICE_NAME,
      description: "daemon e2e test",
      command: "/bin/sleep",
      args: ["86400"],
    });

    await daemon.uninstall();

    const status = await daemon.status();
    assert.equal(status.installed, false);
    assert.equal(status.running, false);
  });

  test("install with env vars", async () => {
    const daemon = new Daemon({
      name: SERVICE_NAME,
      description: "daemon e2e test with env",
      command: "/bin/sleep",
      args: ["86400"],
      env: { TEST_VAR: "hello" },
    });

    try {
      await daemon.install();

      const status = await daemon.status();
      assert.equal(status.installed, true);
      assert.equal(status.running, true);
    } finally {
      await daemon.uninstall();
    }
  });
});

describe("e2e: Linux (systemd)", { skip: currentPlatform !== "linux" }, () => {
  test("install, status running, uninstall, status gone", async () => {
    const daemon = new Daemon({
      name: SERVICE_NAME,
      description: "daemon e2e test",
      command: "/bin/sleep",
      args: ["86400"],
    });

    try {
      await daemon.install();

      await new Promise((r) => setTimeout(r, 1000));

      const afterInstall = await daemon.status();
      assert.equal(afterInstall.installed, true, "should be installed after install");
      assert.equal(afterInstall.running, true, "should be running after install");

      const processAlive = await isProcessRunning("/bin/sleep", "86400");
      assert.equal(processAlive, true, "sleep process should actually be running on the system");
    } finally {
      await daemon.uninstall();
    }

    await new Promise((r) => setTimeout(r, 500));

    const afterUninstall = await daemon.status();
    assert.equal(afterUninstall.installed, false, "should not be installed after uninstall");
    assert.equal(afterUninstall.running, false, "should not be running after uninstall");

    const processGone = await isProcessRunning("/bin/sleep", "86400");
    assert.equal(processGone, false, "sleep process should no longer be running after uninstall");
  });

  test("install is idempotent", async () => {
    const daemon = new Daemon({
      name: SERVICE_NAME,
      description: "daemon e2e test",
      command: "/bin/sleep",
      args: ["86400"],
    });

    try {
      await daemon.install();
      await daemon.install();

      await new Promise((r) => setTimeout(r, 1000));

      const status = await daemon.status();
      assert.equal(status.installed, true);
      assert.equal(status.running, true);
    } finally {
      await daemon.uninstall();
    }
  });

  test("uninstall is safe when not installed", async () => {
    const daemon = new Daemon({
      name: SERVICE_NAME,
      description: "daemon e2e test",
      command: "/bin/sleep",
      args: ["86400"],
    });

    await daemon.uninstall();

    const status = await daemon.status();
    assert.equal(status.installed, false);
    assert.equal(status.running, false);
  });
});
