# Changelog

All notable changes to **Claude Usage** will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [4.0.0] - 2026-05-17

### Changed
- **Dashboard fully revamped** — replaced the single-scroll page with a tabbed SPA (Overview / Projects / Sessions / Models):
  - **Overview** — hero cards with split integer/decimal cost display; Today's Token Breakdown section (Input, Output, Cache Read, Cache Write); Usage Windows & Quota cards with window labels; compact By Model cards with SVG donut ring charts; All-Time Token Breakdown
  - **Projects tab** — searchable, client-side sortable table (Cost / Tokens / Sessions / Name) with per-project colour-coded dots and share-of-spend bars
  - **Sessions tab** — filterable by model pill and text search; colour-coded project dots consistent with the Projects tab
  - **Models tab** — three summary cards (Total Spend, Total Tokens, Requests) plus full-width detail cards with donut rings
- **Color system aligned with claude-deck** — dashboard now uses VS Code theme variables (`--vscode-editor-background`, `--vscode-editor-foreground`, etc.) so it adapts to light/dark themes; accent updated to `#d97757`
- **TODAY hero card highlighted** — distinct border and tinted background using `--accent-line` / `--accent-bg`; all other hero card values are white
- **Today's Token Breakdown added** — new section in the Overview tab showing today's per-type token counts alongside the existing all-time breakdown
- **Sparkline charts removed** — hero cards show clean cost values without decorative line graphs
- **Startup loading indicator** — status bar shows an animated `$(sync~spin) Claude...` spinner on launch instead of stale cached values; live data replaces it once the first scan completes

### Added
- **`todayTokenBreakdown`** — per-type token counts scoped to today, surfaced in the new Today's Tokens section
- **`last7DayCosts`** — rolling 7-day daily cost array (used internally for future sparkline support)
- **`prevWeekCost` / `prevMonthCost`** — previous-period costs for week-over-week and month-over-month comparisons

---

## [3.0.0] - 2026-05-15

### Fixed
- **Duplicate message counting (~1.73× overcount)** — Claude Code appends the same final assistant message to the JSONL multiple times under different outer UUIDs. Added deduplication by `message.id` so each API response is counted exactly once, cutting inflated token and cost totals roughly in half.
- **Wrong cache write tier pricing (~45% undercount)** — the JSONL `usage.cache_creation` object exposes two write tiers: `ephemeral_5m_input_tokens` (1.25× base) and `ephemeral_1h_input_tokens` (2.0× base). Claude Code uses 1-hour caching by default, so virtually all cache writes were hitting the 1h tier. The old code read only the flat `cache_creation_input_tokens` total and priced everything at the cheaper 5m rate. Both tiers are now read and priced independently.
- **`formatCost` showing `$0.50¢`** — sub-cent amounts were rendered with both a `$` prefix and a `¢` suffix. Now correctly rendered as `0.50¢`.
- **`timeUntil` day boundary off-by-one** — `h > 24` changed to `h >= 24` so exactly 24 hours shows `1d 0h` instead of `24h 0m`.
- **Status bar tooltip showed all-time tokens under "Today" heading** — input/output token breakdown is now clearly separated into an "All Time" section.
- **`resetRefreshTimer` not cleared on deactivate** — dangling timeout after extension disable is now cleaned up in `deactivate()`.

### Changed
- **Pricing table updated to current Anthropic rates:**
  - Claude Opus 4.5 / 4.6 / 4.7 repriced to $5 / $25 per MTok (was $15 / $75)
  - Claude Haiku 4.5 repriced to $1 / $5 per MTok (was $0.80 / $4)
  - Added explicit entries for `claude-opus-4-5/4-6/4-7` before the generic `claude-opus-4` prefix to fix prefix-match ordering bug
  - Added `claude-haiku-3-5` entry for new-style Haiku 3.5 model IDs
  - Added 1h cache write price column to all models in the pricing table
- **Status bar color** — item is now colored by quota urgency: purple (normal), amber (≥ 70%), red (≥ 90%)
- **Status bar tooltip redesigned** — clean line-by-line format with `---` dividers before Quota and Streak sections; shows today's message count and streak days
- **Dashboard header** — replaced 📊 emoji with the actual `icon.png` extension icon via `webview.asWebviewUri`

### Added
- **`todayMessages`** — count of API messages sent today, shown in the status bar tooltip
- **`streakDays`** — consecutive calendar days with any Claude Code usage, shown in the status bar tooltip
- **Separate `cacheWrite5mTokens` / `cacheWrite1hTokens` fields** on `UsageRecord` for accurate per-tier cost calculation

---

## [2.1.0] - 2026-04-17

### Fixed
- **Weekly quota preserved on session reset** - when the 5-hour window resets and a fresh quota fetch returns without a `7d-utilization` header, the previous weekly utilization is now carried forward instead of being zeroed out

### Changed
- **Faster quota updates** - quota now refreshes ~1 second after each Claude Code API response (triggered by JSONL file writes), down from a fixed 5-minute poll. The 5-minute interval remains as a fallback when Claude Code is idle.

---

## [2.0.0] - 2026-04-10

### Changed
- Status bar now shows 5h session time remaining alongside quota percentage: `$(graph) $3.70  5h:46% $(clock)1h23m  7d:6%`

### Fixed
- **Instant load on startup** - last known usage and quota are cached in `globalState` and restored immediately when VS Code opens, so the status bar is never blank while waiting for network/disk
- **Stale quota after reset** - if a quota window's reset time already passed while VS Code was closed, utilization is shown as 0% on restore rather than the old cached value

---

## [1.0.2] - 2026-04-03

### Changed
- README images updated to absolute GitHub raw URLs so they render correctly on the VS Code Marketplace page
- Added dashboard screenshot to README

---

## [1.0.1] - 2026-04-03

### Fixed
- **Quota auto-reset** - extension now schedules a refresh exactly 2 seconds after each quota window resets, so the UI clears itself immediately instead of waiting up to 5 minutes
- **429 handling** - when the API returns 429 with no rate-limit headers, quota is correctly marked as "Limit reached" with a red bar rather than silently showing `< 0.1%`
- **Bar overflow** - quota progress bar is now capped at 100% width; over-limit state shows "Limit reached" label in red
- **Status bar over-limit** - status bar now shows `5h:maxed` instead of a percentage above 100%

---

## [1.0.0] - 2026-04-03

### Added
- Professional marketplace icon featuring Claude AI sparkle mark
- Full README with feature documentation, pricing reference, and privacy policy

### Fixed
- **Accurate cost calculation** - intermediate streaming messages (`stop_reason: null`) were being counted alongside final messages, inflating costs by ~1.5–2×. Only final messages are now counted.
- **Sub-1% quota display** - quota utilisation values below 1% were rounded to "0% used". They now display with one decimal place (e.g. "0.3% used") or "< 0.1%" for very small values.

### Changed
- Status bar now shows live session and weekly quota percentages instead of token count: `$(graph) $3.70  5h:46%  7d:6%`
- Status bar icon changed from `$(hubot)` to `$(graph)`
- Hover tooltip reformatted as aligned Markdown tables with quota reset times

---

## [0.1.0] - 2026-04-03

### Added
- **Status bar item** - shows today's cost and live quota at a glance; click to open the dashboard
- **Dashboard webview** - full-screen panel with:
  - Hero cards: all-time, today, this week, this month spend
  - Live quota cards: current session (5 h) and weekly utilisation pulled directly from Anthropic API response headers - no manual configuration required
  - Token breakdown: input, output, cache read, cache write with percentage bars
  - Projects table sorted by cost
  - Per-model breakdown cards
  - Recent sessions list with relative timestamps
- **Auto-refresh** - file-system watcher on `~/.claude/projects/**/*.jsonl` triggers a refresh within 500 ms of any new Claude Code activity
- **Quota polling** - quota data is re-fetched from the Anthropic API every 5 minutes using the OAuth token stored in `~/.claude/.credentials.json`
- **Zero configuration** - reads Claude Code's own credential and project files; nothing to set up
- Cross-platform support: Linux, macOS, Windows (including WSL)
