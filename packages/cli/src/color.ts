// Tiny ANSI color helper for the CLI.
//
// Keeps the Claude-orange accent used in the VSCode dashboard consistent in
// the terminal too. No `chalk` dependency — we emit raw truecolor escapes,
// which every modern terminal (iTerm2, Alacritty, Windows Terminal, VSCode
// integrated terminal, gnome-terminal, kitty, wezterm) supports.
//
// Colors are suppressed unless stdout is a TTY. This follows standard CLI
// convention so piping / redirecting produces clean text, and tests (which
// capture stdout non-TTY) don't see escape codes. `NO_COLOR` (de-facto
// standard, see no-color.org) disables colors unconditionally;
// `FORCE_COLOR` turns them back on when the TTY check would fail (useful
// for CI logs that support ANSI).

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
// 24-bit color escape for #D97757 — the Claude Code terracotta. Same
// literal RGB as --tc-accent in the VSCode webviews.
const ACCENT = "\x1b[38;2;217;119;87m";

function shouldColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  // process.stdout.isTTY is undefined when stdout is piped/captured, true
  // only when attached to an interactive terminal.
  return Boolean(process.stdout.isTTY);
}

// Cache the decision at module load. `runStats` calls these helpers many
// times per invocation; recomputing env lookups would be wasteful.
const enabled = shouldColor();

export function accent(s: string): string {
  return enabled ? `${ACCENT}${s}${RESET}` : s;
}

export function accentBold(s: string): string {
  return enabled ? `${BOLD}${ACCENT}${s}${RESET}` : s;
}

export function dim(s: string): string {
  return enabled ? `${DIM}${s}${RESET}` : s;
}

export function bold(s: string): string {
  return enabled ? `${BOLD}${s}${RESET}` : s;
}
