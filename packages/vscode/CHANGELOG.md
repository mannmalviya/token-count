# Changelog

## 0.1.0 — 2026-04-28

Initial public release.

- Live "today's tokens" status bar item; click to open the dashboard.
- Optional second status bar item with a rich hover tooltip (today / 7-day / all-time totals, message counts, top model). Toggle via `tokenCount.rightStatusBar.enabled`.
- Activity-bar sidebar with customizable stat cards (today tokens/messages, current project tokens/messages, plus a `+` to pin 7-day / all-time / sessions / msgs-per-day / top-model tiles).
- Dashboard webview: summary cards, time-series chart with heatmap / bars / line modes, tokens-vs-messages metric toggle, model and project filters, sortable per-model and per-project tables, project breakdown donut.
- Local-timezone day bucketing by default; toggle off via `tokenCount.useLocalTimezone` to match `token-count stats --utc`.
