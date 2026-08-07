import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { scanAllProjects } from './parser';
import { aggregate, UsageSummary } from './aggregator';
import { StatusBarController } from './statusBar';
import { showDashboard, refreshDashboard } from './webview';
import { fetchQuota, QuotaData } from './quota';

let statusBar: StatusBarController | undefined;
let lastSummary: UsageSummary | undefined;
let lastQuota: QuotaData | null = null;
let extContext: vscode.ExtensionContext | undefined;

function noAnimEnabled(): boolean {
  return vscode.workspace.getConfiguration('clusage').get<boolean>('disableRefreshAnimation', false);
}

async function refreshUsage(): Promise<void> {
  try {
    const records = await scanAllProjects();
    lastSummary = aggregate(records);
    extContext?.globalState.update('lastSummary', lastSummary);
    statusBar?.update(lastSummary, lastQuota);
    refreshDashboard(lastSummary, lastQuota, noAnimEnabled());
  } catch (err) {
    console.error('[clusage] usage refresh error:', err);
  }
}

let resetRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let quotaFetchInFlight = false;

async function refreshQuota(): Promise<void> {
  if (quotaFetchInFlight) return;
  quotaFetchInFlight = true;
  try {
    const newQuota = await fetchQuota();
    // If the 7d header was absent in this response, preserve the previous 7d
    // value so the session reset doesn't wipe the weekly utilization.
    if (newQuota && !newQuota.sevenDayHeaderPresent && lastQuota) {
      const now = Date.now();
      if (lastQuota.sevenDayResetAt.getTime() > now) {
        newQuota.sevenDayUtilization = lastQuota.sevenDayUtilization;
        newQuota.sevenDayResetAt = lastQuota.sevenDayResetAt;
      }
    }
    lastQuota = newQuota;
    if (lastQuota) {
      extContext?.globalState.update('lastQuota', {
        ...lastQuota,
        fiveHourResetAt: lastQuota.fiveHourResetAt.toISOString(),
        sevenDayResetAt: lastQuota.sevenDayResetAt.toISOString(),
      });
    }
    if (lastSummary) {
      statusBar?.update(lastSummary, lastQuota);
      refreshDashboard(lastSummary, lastQuota, noAnimEnabled());
    }

    // Schedule an automatic re-fetch right after whichever reset is soonest,
    // so the UI clears itself the moment the quota window rolls over.
    if (resetRefreshTimer) clearTimeout(resetRefreshTimer);
    if (lastQuota) {
      const now = Date.now();
      const candidates = [
        lastQuota.fiveHourResetAt.getTime(),
        lastQuota.sevenDayResetAt.getTime(),
      ].filter(t => t > now);

      if (candidates.length > 0) {
        const nextReset = Math.min(...candidates);
        const delay = nextReset - now + 2000; // 2 s buffer after the reset
        resetRefreshTimer = setTimeout(() => refreshQuota(), delay);
      }
    }
  } catch (err) {
    console.error('[clusage] quota refresh error:', err);
  } finally {
    quotaFetchInFlight = false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  statusBar = new StatusBarController();
  context.subscriptions.push(statusBar);

  // Restore cached data instantly so the status bar is never blank on load
  const cachedSummary = context.globalState.get<UsageSummary>('lastSummary');
  const cachedQuotaRaw = context.globalState.get<any>('lastQuota');

  // Restore cached data into memory so the dashboard can open immediately,
  // but do NOT push it to the status bar — the spinner stays until the first
  // real scan completes (avoids showing stale zeros on startup).
  if (cachedSummary) {
    lastSummary = cachedSummary;
  }
  if (cachedQuotaRaw) {
    const now = Date.now();
    const fiveHourResetAt = new Date(cachedQuotaRaw.fiveHourResetAt);
    const sevenDayResetAt = new Date(cachedQuotaRaw.sevenDayResetAt);
    lastQuota = {
      ...cachedQuotaRaw,
      fiveHourResetAt,
      sevenDayResetAt,
      fiveHourUtilization: fiveHourResetAt.getTime() <= now ? 0 : cachedQuotaRaw.fiveHourUtilization,
      sevenDayUtilization: sevenDayResetAt.getTime() <= now ? 0 : cachedQuotaRaw.sevenDayUtilization,
      sevenDayHeaderPresent: cachedQuotaRaw.sevenDayHeaderPresent ?? true,
    };
  }
  // Status bar stays on the spinner until refreshUsage() finishes below.

  // Open dashboard command
  const openCmd = vscode.commands.registerCommand('clusage.openPanel', () => {
    if (lastSummary) {
      showDashboard(context, lastSummary, lastQuota, noAnimEnabled());
    } else {
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Loading Claude usage data…' },
        async () => {
          await Promise.all([refreshUsage(), refreshQuota()]);
          if (lastSummary) showDashboard(context, lastSummary, lastQuota, noAnimEnabled());
        }
      );
    }
  });
  context.subscriptions.push(openCmd);

  // Re-apply settings (e.g. showCostInStatusBar, disableRefreshAnimation) as
  // soon as the user changes them, instead of waiting for the next data poll.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (!e.affectsConfiguration('clusage') || !lastSummary) return;
    statusBar?.update(lastSummary, lastQuota);
    refreshDashboard(lastSummary, lastQuota, noAnimEnabled());
  }));

  // Watch for new JSONL data
  const claudeGlob = new vscode.RelativePattern(
    vscode.Uri.file(path.join(os.homedir(), '.claude', 'projects')),
    '**/*.jsonl'
  );
  const watcher = vscode.workspace.createFileSystemWatcher(claudeGlob);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let quotaDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  const debouncedRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => refreshUsage(), 500);
    // Refresh quota ~15 s after the last JSONL write, so the status bar
    // catches up within a turn or two rather than waiting the full poll interval.
    if (quotaDebounceTimer) clearTimeout(quotaDebounceTimer);
    quotaDebounceTimer = setTimeout(() => refreshQuota(), 1_000);
  };
  watcher.onDidChange(debouncedRefresh, null, context.subscriptions);
  watcher.onDidCreate(debouncedRefresh, null, context.subscriptions);
  context.subscriptions.push(watcher);

  // Poll quota every 5 minutes as a fallback when Claude Code is idle
  const quotaInterval = setInterval(() => refreshQuota(), 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(quotaInterval) });

  // Initial load - quota first so the panel shows it immediately
  refreshUsage();
  refreshQuota();
}

export function deactivate(): void {
  if (resetRefreshTimer) clearTimeout(resetRefreshTimer);
  statusBar?.dispose();
}
