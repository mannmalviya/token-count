// `token-count` CLI entrypoint.
//
// Thin wiring layer only — it parses command-line flags and hands off to
// the pure-ish functions in init.ts / hook.ts / stats.ts. Those are the ones
// with tests. Keep this file small so there's nothing to unit-test here.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { runInit } from "./init.js";
import { runHook } from "./hook.js";
import { runStats } from "./stats.js";
import { backfillFromClaudeProjects, type GroupBy } from "@token-count/core";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const program = new Command();
  program
    .name("token-count")
    .description("Local-first Claude Code token usage tracker.")
    .version("0.0.0");

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------
  program
    .command("init")
    .description("Install the Stop hook into Claude Code's settings, and backfill existing transcripts.")
    .option("--project", "Write to .claude/settings.json in cwd instead of the global ~/.claude/settings.json")
    .option("--no-backfill", "Skip importing token usage from existing Claude transcripts")
    .action((opts: { project?: boolean; backfill?: boolean }) => {
      // Build the absolute command Claude Code should invoke. We resolve any
      // symlinks (pnpm link creates one) so the settings file contains the
      // real path to this binary.
      const binPath = fs.realpathSync(process.argv[1] ?? "");
      const hookCommand = `${binPath} hook`;

      const result = runInit({
        scope: opts.project ? "project" : "global",
        homeDir: os.homedir(),
        cwd: process.cwd(),
        hookCommand,
      });

      if (result.wasAlreadyInstalled) {
        console.log(`token-count hook already installed in ${result.settingsPath}`);
      } else {
        console.log(`Installed token-count Stop hook -> ${result.settingsPath}`);
      }
      console.log(`Data directory: ${path.join(process.env.TOKEN_COUNT_DIR ?? path.join(os.homedir(), ".token-count"))}`);

      // By default, also import every assistant turn already in
      // ~/.claude/projects/*/*.jsonl. Dedupe-by-turn_uuid means re-running
      // is safe. --no-backfill skips this for users who only want fresh data.
      if (opts.backfill !== false) {
        const projectsDir = path.join(os.homedir(), ".claude", "projects");
        const bf = backfillFromClaudeProjects({ projectsDir });
        console.log(
          `Backfill: scanned ${bf.sessionsScanned} sessions, added ${bf.appended} records (${bf.skipped} already recorded), ${bf.promptsAppended} new prompts (${bf.promptsSkipped} already recorded).`,
        );
      }
    });

  // -------------------------------------------------------------------------
  // hook (invoked by Claude Code — reads a JSON payload on stdin)
  // -------------------------------------------------------------------------
  program
    .command("hook")
    .description("Stop-hook handler. Reads JSON from stdin, appends a record to usage.jsonl.")
    .action(async () => {
      // CRITICAL: we must always exit 0. Any failure here would surface as a
      // hook error to the user mid-session. Wrap the whole thing in try/catch.
      try {
        const raw = await readStdin();
        if (raw.trim().length === 0) {
          // No payload — nothing to do. Stop hooks sometimes fire without one
          // during shutdown; just no-op.
          return;
        }
        const payload = JSON.parse(raw);
        if (!payload?.session_id || !payload?.transcript_path) {
          // Payload shape isn't what we expect; log and continue.
          console.error("token-count hook: missing session_id or transcript_path");
          return;
        }
        runHook({
          session_id: payload.session_id,
          transcript_path: payload.transcript_path,
        });
      } catch (err) {
        // Last-resort safety net. We deliberately don't re-throw — Claude
        // Code should never see a non-zero exit from us.
        console.error("token-count hook: unexpected error", err);
      }
    });

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------
  program
    .command("stats")
    .description("Print a summary of recorded token usage.")
    .option("--by <dim>", "Group by: day, model, or project", "day")
    .option("--since <iso>", "Include only records on/after this ISO date")
    .option("--until <iso>", "Include only records before this ISO date")
    .option("--cost", "Include an estimated USD cost column (rates from core/pricing.ts)")
    .action((opts: { by?: string; since?: string; until?: string; cost?: boolean }) => {
      const by = opts.by as GroupBy;
      if (!["day", "model", "project"].includes(by)) {
        console.error(`--by must be one of: day, model, project (got "${opts.by}")`);
        process.exit(1);
      }
      const { output } = runStats({
        by,
        since: opts.since ? new Date(opts.since) : undefined,
        until: opts.until ? new Date(opts.until) : undefined,
        cost: opts.cost,
      });
      process.stdout.write(output);
    });

  // -------------------------------------------------------------------------
  // backfill — import history from ~/.claude/projects/ on demand.
  // Safe to re-run; dedupes against existing records by turn_uuid.
  // -------------------------------------------------------------------------
  program
    .command("backfill")
    .description("Import all assistant turns from existing Claude Code transcripts.")
    .action(() => {
      const projectsDir = path.join(os.homedir(), ".claude", "projects");
      const bf = backfillFromClaudeProjects({ projectsDir });
      console.log(
        `Scanned ${bf.sessionsScanned} sessions, added ${bf.appended} records (${bf.skipped} already recorded), ${bf.promptsAppended} new prompts (${bf.promptsSkipped} already recorded).`,
      );
    });

  await program.parseAsync(process.argv);
}

// ---------------------------------------------------------------------------
// Utility: read all of stdin as a string.
// ---------------------------------------------------------------------------

// Claude Code's hook contract pipes a small JSON payload on stdin. Node's
// stdin is a stream; we just collect it chunk by chunk.
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    // If nothing is piped in, we'll just see `end` immediately. That's fine.
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
