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
  stdoutPath?: string;
  stderrPath?: string;
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

const invalidXmlCharPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const safeSystemdEnvValuePattern = /^[A-Za-z0-9_./:@,=+-]*$/;

type RenderOptions = {
  programArgs: string[];
  env?: Record<string, string>;
  stdoutPath?: string;
  stderrPath?: string;
};

type RenderPlistOptions = RenderOptions & {
  name: string;
};

type RenderUnitOptions = RenderOptions & {
  description: string;
};

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validateXmlString(s: string): void {
  if (invalidXmlCharPattern.test(s)) {
    throw new Error("string contains characters that are not allowed in XML 1.0");
  }
}

function validateEnvKey(k: string): void {
  if (!envKeyPattern.test(k)) {
    throw new Error(`invalid environment variable key: ${k}`);
  }
}

function formatSystemdEnvValue(v: string): string {
  if (v.includes("\0") || v.includes("\n")) {
    throw new Error("systemd environment values cannot contain NUL or newline characters");
  }

  if (safeSystemdEnvValuePattern.test(v)) return v;

  return `"${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function validateSystemdPath(path: string): void {
  if (path === "") {
    throw new Error("log paths cannot be empty");
  }

  if (path.includes("\0") || path.includes("\n")) {
    throw new Error("systemd log paths cannot contain NUL or newline characters");
  }
}

function renderPlist({
  name,
  programArgs,
  env,
  stdoutPath,
  stderrPath,
}: RenderPlistOptions): string {
  validateXmlString(name);

  const entries = programArgs
    .map((arg) => {
      validateXmlString(arg);
      return `    <string>${xmlEscape(arg)}</string>`;
    })
    .join("\n");

  let envBlock = "";
  if (env && Object.keys(env).length > 0) {
    const envEntries = Object.entries(env)
      .map(([k, v]) => {
        validateXmlString(k);
        validateEnvKey(k);
        validateXmlString(v);
        return `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`;
      })
      .join("\n");
    envBlock = `\n  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>`;
  }

  let logPathBlock = "";
  if (stdoutPath !== undefined) {
    if (stdoutPath === "") {
      throw new Error("log paths cannot be empty");
    }
    validateXmlString(stdoutPath);
    logPathBlock += `\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(stdoutPath)}</string>`;
  }

  if (stderrPath !== undefined) {
    if (stderrPath === "") {
      throw new Error("log paths cannot be empty");
    }
    validateXmlString(stderrPath);
    logPathBlock += `\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(stderrPath)}</string>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(name)}</string>
  <key>ProgramArguments</key>
  <array>
${entries}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>${logPathBlock}${envBlock}
</dict>
</plist>
`;
}

function quoteSystemdArg(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
  return `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderUnit({
  description,
  programArgs,
  env,
  stdoutPath,
  stderrPath,
}: RenderUnitOptions): string {
  const execStart = programArgs.map(quoteSystemdArg).join(" ");
  const envLines = env
    ? Object.entries(env)
        .map(([k, v]) => {
          validateEnvKey(k);
          return `Environment=${k}=${formatSystemdEnvValue(v)}`;
        })
        .join("\n")
    : "";
  let logPathLines = "";
  if (stdoutPath !== undefined) {
    validateSystemdPath(stdoutPath);
    logPathLines += `StandardOutput=append:${stdoutPath}\n`;
  }

  if (stderrPath !== undefined) {
    validateSystemdPath(stderrPath);
    logPathLines += `StandardError=append:${stderrPath}\n`;
  }

  return `[Unit]
Description=${description}

[Service]
Type=simple
ExecStart=${execStart}
${envLines ? envLines + "\n" : ""}${logPathLines}Restart=always
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
  private readonly stdoutPath: string | undefined;
  private readonly stderrPath: string | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly home: string;
  private readonly exec: ExecFn;

  constructor(options: DaemonOptions) {
    this.name = options.name;
    this.description = options.description;
    this.programArgs = [options.command, ...options.args];
    this.env = options.env;
    this.stdoutPath = options.stdoutPath;
    this.stderrPath = options.stderrPath;
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
      await writeFile(
        path,
        renderPlist({
          name: this.name,
          programArgs: this.programArgs,
          env: this.env,
          stdoutPath: this.stdoutPath,
          stderrPath: this.stderrPath,
        }),
        "utf8",
      );
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
      await writeFile(
        path,
        renderUnit({
          description: this.description,
          programArgs: this.programArgs,
          env: this.env,
          stdoutPath: this.stdoutPath,
          stderrPath: this.stderrPath,
        }),
        "utf8",
      );
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
