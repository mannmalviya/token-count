// `token-count init` — one-time setup.
//
// Two jobs:
//   1. Create `~/.token-count/` (handled via core.tokenCountDir() + mkdir).
//   2. Write a Stop hook entry into Claude Code's settings.json so every
//      assistant turn triggers `token-count hook`.
//
// We keep this function pure of `process.argv`, `os.homedir()`, and
// `process.cwd()` by taking them as parameters — tests inject fake dirs so
// they never touch the user's real settings.

import fs from "node:fs";
import path from "node:path";
import { tokenCountDir } from "@token-count/core";

export type InitScope = "global" | "project";

export interface InitOptions {
  /**
   * "global" writes to `<homeDir>/.claude/settings.json` (applies to every
   * Claude Code session). "project" writes to `<cwd>/.claude/settings.json`.
   */
  scope: InitScope;
  homeDir: string;
  cwd: string;
  /**
   * The full shell command Claude Code should invoke on Stop. We pass this
   * in rather than computing it here so tests are deterministic.
   * Typically: `/absolute/path/to/token-count.js hook`.
   */
  hookCommand: string;
}

export interface InitResult {
  settingsPath: string;
  wasAlreadyInstalled: boolean;
}

/** Claude Code settings schema — we only care about the hooks subtree. */
interface ClaudeSettings {
  hooks?: {
    [event: string]: HookMatcher[] | undefined;
  };
  // Allow any other top-level keys (permissions, env, etc.) to pass through.
  [key: string]: unknown;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

interface HookEntry {
  type: string;
  command?: string;
  [key: string]: unknown;
}

/**
 * Install (or confirm installed) the Stop hook, and ensure the token-count
 * data dir exists.
 */
export function runInit(opts: InitOptions): InitResult {
  // 1. Ensure the data dir exists. tokenCountDir() respects TOKEN_COUNT_DIR
  //    so tests don't need to touch the real home.
  fs.mkdirSync(tokenCountDir(), { recursive: true });

  // 2. Resolve the Claude settings path based on scope.
  const settingsPath = resolveSettingsPath(opts);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  // 3. Read current settings (if any). A missing file => empty object.
  const existing: ClaudeSettings = readJsonOrEmpty(settingsPath);

  // 4. Check whether our hook command is already registered under Stop.
  //    Idempotency: never add a duplicate entry.
  const stopHooks = existing.hooks?.Stop ?? [];
  const alreadyInstalled = stopHooks.some((matcher) =>
    matcher.hooks.some((h) => h.type === "command" && h.command === opts.hookCommand),
  );
  if (alreadyInstalled) {
    return { settingsPath, wasAlreadyInstalled: true };
  }

  // 5. Merge in our new hook. We append rather than replace so we play nicely
  //    with other tools that may also register Stop hooks.
  const updated: ClaudeSettings = {
    ...existing,
    hooks: {
      ...(existing.hooks ?? {}),
      Stop: [
        ...stopHooks,
        {
          matcher: "",
          hooks: [{ type: "command", command: opts.hookCommand }],
        },
      ],
    },
  };

  // 6. Pretty-print so the file stays human-readable if users inspect it.
  fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { settingsPath, wasAlreadyInstalled: false };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function resolveSettingsPath(opts: InitOptions): string {
  const base = opts.scope === "global" ? opts.homeDir : opts.cwd;
  return path.join(base, ".claude", "settings.json");
}

function readJsonOrEmpty(p: string): ClaudeSettings {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ClaudeSettings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // If the file exists but is malformed, don't clobber it — let the user
    // see the error and fix it themselves. This is a rare case worth
    // failing loudly.
    throw err;
  }
}
