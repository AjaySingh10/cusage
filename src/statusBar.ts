import * as vscode from 'vscode';
import { UsageSummary, formatCost, formatTokenCount } from './aggregator';
import { QuotaData } from './quota';

const C_PURPLE = '#7c6af7';
const C_AMBER  = '#fbbf24';
const C_RED    = '#f87171';

function urgencyColor(quota: QuotaData | null): string {
  if (!quota) return C_PURPLE;
  const max = Math.max(quota.fiveHourUtilization, quota.sevenDayUtilization);
  if (max >= 0.9) return C_RED;
  if (max >= 0.7) return C_AMBER;
  return C_PURPLE;
}

export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'clusage.openPanel';
    this.item.color   = C_PURPLE;
    this.item.text    = '$(sync~spin) Claude...';
    this.item.tooltip = 'Claude Usage - loading…';
    this.item.show();
  }

  update(summary: UsageSummary, quota: QuotaData | null): void {
    // No calls made today — show spinner until first request this session
    if (summary.todayTokens === 0) {
      this.item.color   = C_PURPLE;
      this.item.text    = '$(sync~spin) Waiting for Claude...';
      this.item.tooltip = 'No Claude Code usage today yet';
      return;
    }

    const cost = formatCost(summary.todayCost);

    const fmtPct = (v: number) =>
      v > 1      ? 'maxed' :
      v < 0.0005 ? '0%' :
      v < 0.001  ? '<0.1%' :
      v < 0.1    ? `${(v * 100).toFixed(1)}%` :
                   `${Math.round(v * 100)}%`;

    this.item.color = urgencyColor(quota);

    if (quota) {
      const reset = timeUntil(quota.fiveHourResetAt);
      this.item.text = `$(graph) ${cost}  5h:${fmtPct(quota.fiveHourUtilization)} $(clock)${reset}  7d:${fmtPct(quota.sevenDayUtilization)}`;
    } else {
      // Quota fetch failed (no creds, offline, transient API error) but we
      // still have real usage data — show cost-only instead of stalling on
      // the spinner forever.
      this.item.color = C_PURPLE;
      this.item.text  = `$(graph) ${cost}`;
    }

    this.item.tooltip = buildTooltip(summary, quota);
  }

  dispose(): void {
    this.item.dispose();
  }
}

function buildTooltip(summary: UsageSummary, quota: QuotaData | null): vscode.MarkdownString {
  const fmtDelta = (current: number, ref: number): string => {
    if (ref === 0) return '-';
    const pct = ((current - ref) / ref) * 100;
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
  };

  const fmtPct = (v: number) =>
    v > 1     ? '**Maxed**' :
    v < 0.001 ? '0%' :
    v < 0.1   ? `${(v * 100).toFixed(1)}%` :
                `${Math.round(v * 100)}%`;

  const lines: string[] = [
    `**Today's Usage (API Cost)**`,
    ``,
    `💰 Cost: **${formatCost(summary.todayCost)}**`,
    `🔢 Tokens: ${formatTokenCount(summary.todayTokens)}`,
    `💬 Messages: ${summary.todayMessages}`,
  ];

  if (quota) {
    lines.push(
      ``,
      `---`,
      `⚡ **Quota**`,
      `· Session (5h): **${fmtPct(quota.fiveHourUtilization)}** - resets in ${timeUntil(quota.fiveHourResetAt)}`,
      `· Weekly  (7d): **${fmtPct(quota.sevenDayUtilization)}** - resets in ${timeUntil(quota.sevenDayResetAt)}`,
    );
  }

  lines.push(
    ``,
    `---`,
    `🔥 Streak: ${summary.streakDays} day${summary.streakDays !== 1 ? 's' : ''}`,
    ``,
    `---`,
    `All Time: **${formatCost(summary.allTimeCost)}**`,
    ``,
    `*Click to open dashboard*`,
  );

  const md = new vscode.MarkdownString(lines.join('\n\n'));
  md.isTrusted = true;
  return md;
}

function timeUntil(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
