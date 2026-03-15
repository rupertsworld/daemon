import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type ExecResult = { stdout: string; stderr: string };
type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

export type DaemonOptions = {
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  exec?: ExecFn;
};

export type DaemonStatus = {
  installed: boolean;
  running: boolean;
};

function plistPath(home: string, name: string): string {
  return join(home, "Library", "LaunchAgents", `${name}.plist`);
}

function unitPath(home: string, name: string): string {
  return join(home, ".config", "systemd", "user", `${name}.service`);
}

function renderPlist(
  name: string,
  programArgs: string[],
  env?: Record<string, string>,
): string {
  const entries = programArgs
    .map((arg) => `    <string>${arg}</string>`)
    .join("\n");

  let envBlock = "";
  if (env && Object.keys(env).length > 0) {
    const envEntries = Object.entries(env)
      .map(([k, v]) => `    <key>${k}</key>\n    <string>${v}</string>`)
      .join("\n");
    envBlock = `\n  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${name}</string>
  <key>ProgramArguments</key>
  <array>
${entries}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>${envBlock}
</dict>
</plist>
`;
}

function quoteSystemdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
  return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderUnit(description: string, programArgs: string[]): string {
  const execStart = programArgs.map(quoteSystemdArg).join(" ");
  return `[Unit]
Description=${description}

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function defaultExec(command: string, args: string[]): Promise<ExecResult> {
  const result = await execFileAsync(command, args);
  return { stdout: result.stdout, stderr: result.stderr };
}

export class UnsupportedPlatformError extends Error {
  constructor() {
    super("not supported on this platform");
    this.name = "UnsupportedPlatformError";
  }
}

export class Daemon {
  private readonly name: string;
  private readonly description: string;
  private readonly programArgs: string[];
  private readonly env: Record<string, string> | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly exec: ExecFn;

  constructor(options: DaemonOptions) {
    this.name = options.name;
    this.description = options.description;
    this.programArgs = [options.command, ...options.args];
    this.env = options.env;
    this.platform = options.platform ?? process.platform;
    this.home = options.homeDir ?? homedir();
    this.exec = options.exec ?? defaultExec;
  }

  async install(): Promise<void> {
    if (this.platform === "darwin") {
      const path = plistPath(this.home, this.name);
      if (existsSync(path)) {
        await this.exec("launchctl", ["unload", "-w", path]).catch(() => undefined);
      }
      await mkdir(join(this.home, "Library", "LaunchAgents"), { recursive: true });
      await writeFile(path, renderPlist(this.name, this.programArgs, this.env), "utf8");
      await this.exec("launchctl", ["load", "-w", path]);
      return;
    }

    if (this.platform === "linux") {
      const path = unitPath(this.home, this.name);
      if (existsSync(path)) {
        await this.exec("systemctl", ["--user", "disable", "--now", `${this.name}.service`]).catch(
          () => undefined,
        );
      }
      await mkdir(join(this.home, ".config", "systemd", "user"), { recursive: true });
      await writeFile(path, renderUnit(this.description, this.programArgs), "utf8");
      await this.exec("systemctl", ["--user", "daemon-reload"]);
      await this.exec("systemctl", ["--user", "enable", "--now", `${this.name}.service`]);
      return;
    }

    throw new UnsupportedPlatformError();
  }

  async uninstall(): Promise<void> {
    if (this.platform === "darwin") {
      const path = plistPath(this.home, this.name);
      if (existsSync(path)) {
        await this.exec("launchctl", ["unload", "-w", path]).catch(() => undefined);
        await rm(path, { force: true });
      }
      return;
    }

    if (this.platform === "linux") {
      const path = unitPath(this.home, this.name);
      await this.exec("systemctl", ["--user", "disable", "--now", `${this.name}.service`]).catch(
        () => undefined,
      );
      await rm(path, { force: true });
      await this.exec("systemctl", ["--user", "daemon-reload"]);
      return;
    }

    throw new UnsupportedPlatformError();
  }

  async status(): Promise<DaemonStatus> {
    if (this.platform === "darwin") {
      const path = plistPath(this.home, this.name);
      if (!existsSync(path)) return { installed: false, running: false };
      try {
        await this.exec("launchctl", ["list", this.name]);
        return { installed: true, running: true };
      } catch {
        return { installed: true, running: false };
      }
    }

    if (this.platform === "linux") {
      const path = unitPath(this.home, this.name);
      if (!existsSync(path)) return { installed: false, running: false };
      try {
        const result = await this.exec("systemctl", [
          "--user",
          "is-active",
          `${this.name}.service`,
        ]);
        const active = result.stdout.trim() === "" || result.stdout.trim() === "active";
        return { installed: true, running: active };
      } catch {
        return { installed: true, running: false };
      }
    }

    throw new UnsupportedPlatformError();
  }
}
