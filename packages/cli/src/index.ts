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

  // Top-level examples. Commander only lists subcommand *names* in the root
  // --help (their flags live under `<cmd> --help`). Surfacing concrete
  // invocations here so flags like `--cost` and `--by` are discoverable
  // without having to drill into each subcommand first.
  program.addHelpText(
    "after",
    `
Examples:
  $ token-count init                       Install the Stop hook + backfill existing transcripts
  $ token-count init --no-backfill         Install the hook only; skip importing history
  $ token-count backfill                   Re-scan ~/.claude/projects for new records (safe to re-run)
  $ token-count stats                      Per-day totals
  $ token-count stats --by model           Totals grouped by model
  $ token-count stats --by project --cost  Per-project totals with an API-rate USD column
  $ token-count stats --since 2026-04-01   Only records on/after a given ISO date

Environment:
  TOKEN_COUNT_DIR   Override the storage directory (default: ~/.token-count)

See \`token-count <command> --help\` for options specific to each subcommand.`,
  );

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------
  const initCmd = program
    .command("init")
    .description("Install the Stop hook into Claude Code's settings, and backfill existing transcripts.")
    .option(
      "--project",
      "Install into .claude/settings.json in the current directory (project-scoped) instead of ~/.claude/settings.json (global).",
    )
    .option(
      "--no-backfill",
      "Skip the initial import of existing transcripts under ~/.claude/projects. Only new Claude Code sessions will be recorded.",
    );
  initCmd.addHelpText(
    "after",
    `
Examples:
  $ token-count init                Install the global hook and backfill history
  $ token-count init --project      Install only for the current project
  $ token-count init --no-backfill  Install the hook but don't import existing transcripts`,
  );
  initCmd.action((opts: { project?: boolean; backfill?: boolean }) => {
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
  const statsCmd = program
    .command("stats")
    .description("Print a summary of recorded token usage.")
    .option("--by <dim>", "Group rows by one of: day, model, project", "day")
    .option("--since <iso>", "Only include records on/after this ISO date (e.g. 2026-04-01)")
    .option("--until <iso>", "Only include records strictly before this ISO date")
    .option(
      "--cost",
      "Add an 'API rate (USD)' column showing what these tokens would cost at Anthropic's per-token API rates. Claude Code subscriptions are flat-rate, so this is a reference value — not what you actually pay.",
    )
    .option(
      "--utc",
      "Bucket per-day rows at UTC midnight instead of your local-machine midnight. Default is local time so a session you ran at 11pm shows up on the day you actually ran it; pass --utc when you need numbers that match other UTC-anchored views.",
    );
  statsCmd.addHelpText(
    "after",
    `
Examples:
  $ token-count stats                                 Per-day totals (default)
  $ token-count stats --by model                      Totals grouped by model
  $ token-count stats --by project --cost             Per-project totals + API-rate USD
  $ token-count stats --since 2026-04-01 --until 2026-04-15
                                                      Restrict to a date window`,
  );
  statsCmd.action((opts: { by?: string; since?: string; until?: string; cost?: boolean; utc?: boolean }) => {
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
        // Default to local time. `--utc` flips back to UTC bucketing.
        localTime: !opts.utc,
      });
      process.stdout.write(output);
    });

  // -------------------------------------------------------------------------
  // backfill — import history from ~/.claude/projects/ on demand.
  // Safe to re-run; dedupes against existing records by turn_uuid.
  // -------------------------------------------------------------------------
  const backfillCmd = program
    .command("backfill")
    .description("Import all assistant turns from existing Claude Code transcripts under ~/.claude/projects. Safe to re-run — records dedupe by turn UUID.");
  backfillCmd.addHelpText(
    "after",
    `
Examples:
  $ token-count backfill   Scan ~/.claude/projects/*/*.jsonl and append any missing records`,
  );
  backfillCmd.action(() => {
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
