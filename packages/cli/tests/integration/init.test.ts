// Tests for `token-count init`.
//
// `init` does two things:
//   1. Creates `~/.token-count/` (where usage.jsonl will live).
//   2. Merges a Stop hook entry into `~/.claude/settings.json` (or the
//      project-scoped `.claude/settings.json` with --project).
//
// Requirements:
//   - Idempotent — running twice is a no-op (same file contents).
//   - Preserves any existing hooks (Stop, PreToolUse, etc.) in the settings.
//   - Never clobbers other top-level keys in settings.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/init.js";

const HOOK_CMD = "/abs/path/to/bin/token-count.js hook";

describe("runInit", () => {
  let fakeHome: string;
  let fakeCwd: string;
  let tokenCountDir: string;
  const originalEnv = process.env.TOKEN_COUNT_DIR;

  beforeEach(() => {
    // Isolate: a fake HOME (for ~/.claude/settings.json), a fake project cwd
    // (for .claude/settings.json with --project), and a redirected token-count
    // data dir.
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tc-init-home-"));
    fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "tc-init-cwd-"));
    tokenCountDir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-init-dir-"));
    process.env.TOKEN_COUNT_DIR = tokenCountDir;
  });
  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(fakeCwd, { recursive: true, force: true });
    fs.rmSync(tokenCountDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.TOKEN_COUNT_DIR;
    else process.env.TOKEN_COUNT_DIR = originalEnv;
  });

  // Helper: read & parse the settings file the init wrote.
  function readSettings(p: string): any {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  it("global scope: creates ~/.claude/settings.json with a Stop hook", () => {
    const result = runInit({
      scope: "global",
      homeDir: fakeHome,
      cwd: fakeCwd,
      hookCommand: HOOK_CMD,
    });
    const expectedPath = path.join(fakeHome, ".claude", "settings.json");
    expect(result.settingsPath).toBe(expectedPath);
    expect(result.wasAlreadyInstalled).toBe(false);
    expect(fs.existsSync(expectedPath)).toBe(true);

    const cfg = readSettings(expectedPath);
    expect(cfg.hooks.Stop).toHaveLength(1);
    expect(cfg.hooks.Stop[0].hooks[0]).toMatchObject({
      type: "command",
      command: HOOK_CMD,
    });
  });

  it("project scope: writes to .claude/settings.json in cwd", () => {
    const result = runInit({
      scope: "project",
      homeDir: fakeHome,
      cwd: fakeCwd,
      hookCommand: HOOK_CMD,
    });
    expect(result.settingsPath).toBe(path.join(fakeCwd, ".claude", "settings.json"));
    expect(fs.existsSync(result.settingsPath)).toBe(true);
  });

  it("creates the token-count data dir", () => {
    runInit({
      scope: "global",
      homeDir: fakeHome,
      cwd: fakeCwd,
      hookCommand: HOOK_CMD,
    });
    expect(fs.existsSync(tokenCountDir)).toBe(true);
  });

  it("is idempotent — running twice leaves only one hook entry", () => {
    runInit({ scope: "global", homeDir: fakeHome, cwd: fakeCwd, hookCommand: HOOK_CMD });
    const second = runInit({
      scope: "global",
      homeDir: fakeHome,
      cwd: fakeCwd,
      hookCommand: HOOK_CMD,
    });
    expect(second.wasAlreadyInstalled).toBe(true);
    const cfg = readSettings(second.settingsPath);
    expect(cfg.hooks.Stop).toHaveLength(1);
  });

  it("preserves existing Stop hooks from other tools", () => {
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "/some/other/tool.sh" }],
            },
          ],
        },
      }),
    );

    runInit({ scope: "global", homeDir: fakeHome, cwd: fakeCwd, hookCommand: HOOK_CMD });

    const cfg = readSettings(settingsPath);
    // Two entries: the pre-existing one and ours.
    expect(cfg.hooks.Stop).toHaveLength(2);
    const commands = cfg.hooks.Stop.flatMap((s: any) =>
      s.hooks.map((h: any) => h.command),
    );
    expect(commands).toContain("/some/other/tool.sh");
    expect(commands).toContain(HOOK_CMD);
  });

  it("preserves unrelated top-level keys and other hook types", () => {
    const settingsPath = path.join(fakeHome, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] },
          ],
        },
      }),
    );

    runInit({ scope: "global", homeDir: fakeHome, cwd: fakeCwd, hookCommand: HOOK_CMD });

    const cfg = readSettings(settingsPath);
    expect(cfg.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(cfg.hooks.PreToolUse).toBeDefined();
    expect(cfg.hooks.Stop).toHaveLength(1);
  });
});
