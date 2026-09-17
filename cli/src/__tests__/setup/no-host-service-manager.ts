import { promisify } from "node:util";
import { vi } from "vitest";

// CLI tests must never drive the real host service manager. launchd and
// systemd user domains are keyed by uid, not by HOME, and os.homedir() ignores
// a reassigned process.env, so a temp HOME does not sandbox them: an
// un-injected `launchctl bootout`/`disable` plus the plist removal takes down
// the developer's live Paperclip service. Tests must inject a CommandRunner or
// a fake detectServiceManager instead; anything that slips through fails here.
const HOST_SERVICE_BINARIES = new Set(["launchctl", "systemctl", "loginctl"]);
const HOST_SERVICE_SHELL_PATTERN = /(^|[\s;&|/(])(launchctl|systemctl|loginctl)(\s|$)/;

function refuse(target: string): never {
  throw new Error(
    `Refusing to run host service manager command in tests: ${target}. Inject a CommandRunner or detectServiceManager fake.`,
  );
}

function assertFileAllowed(file: unknown): void {
  if (typeof file !== "string") return;
  const binary = file.split("/").pop() ?? file;
  if (HOST_SERVICE_BINARIES.has(binary)) refuse(file);
}

function assertShellAllowed(command: unknown): void {
  if (typeof command === "string" && HOST_SERVICE_SHELL_PATTERN.test(command)) refuse(command);
}

type AnyFunction = (...args: any[]) => any;

function guard<T extends AnyFunction>(original: T, check: (target: unknown) => void): T {
  const wrapped = function (this: unknown, target: unknown, ...rest: unknown[]) {
    check(target);
    return original.call(this, target, ...rest);
  } as unknown as T;
  const custom = (original as { [promisify.custom]?: AnyFunction })[promisify.custom];
  if (custom) {
    Object.defineProperty(wrapped, promisify.custom, {
      value: (target: unknown, ...rest: unknown[]) => {
        check(target);
        return custom(target, ...rest);
      },
    });
  }
  return wrapped;
}

async function guardedChildProcess(importOriginal: () => Promise<typeof import("node:child_process")>) {
  const original = await importOriginal();
  const guarded = {
    ...original,
    execFile: guard(original.execFile, assertFileAllowed),
    execFileSync: guard(original.execFileSync, assertFileAllowed),
    spawn: guard(original.spawn, assertFileAllowed),
    spawnSync: guard(original.spawnSync, assertFileAllowed),
    exec: guard(original.exec, assertShellAllowed),
    execSync: guard(original.execSync, assertShellAllowed),
  };
  return { ...guarded, default: guarded };
}

vi.mock("node:child_process", guardedChildProcess);
vi.mock("child_process", guardedChildProcess);
