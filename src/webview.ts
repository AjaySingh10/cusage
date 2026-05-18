import * as vscode from 'vscode';
import { UsageSummary, formatCost, formatTokenCount } from './aggregator';
import { QuotaData } from './quota';

let currentPanel: vscode.WebviewPanel | undefined;
let extensionUri: vscode.Uri | undefined;

export function showDashboard(context: vscode.ExtensionContext, summary: UsageSummary, quota: QuotaData | null): void {
  extensionUri = context.extensionUri;
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    currentPanel.webview.html = getHtml(currentPanel.webview, summary, quota);
    return;
  }
  currentPanel = vscode.window.createWebviewPanel(
    'clusage.dashboard', 'Claude Usage', vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] }
  );
  currentPanel.webview.html = getHtml(currentPanel.webview, summary, quota);
  currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
}

export function refreshDashboard(summary: UsageSummary, quota: QuotaData | null): void {
  if (currentPanel?.visible) {
    currentPanel.webview.html = getHtml(currentPanel.webview, summary, quota);
  }
}

function relativeTime(date: Date): string {
  const d = Date.now() - date.getTime();
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const dy = Math.floor(h / 24);
  if (dy < 30) return `${dy}d ago`;
  return date.toLocaleDateString();
}

function modelShortName(model: string): string {
  const s = model.replace(/^claude-/, '').replace(/-(\d)/, ' $1');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function pct(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 100);
}

const PROJECT_PALETTE = ['#f87171','#fb923c','#fbbf24','#4ade80','#34d399','#5eead4','#60a5fa','#a78bfa','#f472b6','#e879f9'];
function projectColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length];
}

function donutSvg(share: number, color: string): string {
  const r = 22, circ = 2 * Math.PI * r;
  const dash = share > 0 ? Math.max((share / 100) * circ, 3) : 0;
  return `<svg width="54" height="54" viewBox="0 0 54 54">
    <circle cx="27" cy="27" r="${r}" fill="none" stroke="#2a2a35" stroke-width="5"/>
    <circle cx="27" cy="27" r="${r}" fill="none" stroke="${color}" stroke-width="5"
      stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
      transform="rotate(-90 27 27)" stroke-linecap="round"/>
    <text x="27" y="31" text-anchor="middle" font-size="10" font-weight="700" fill="${color}">${Math.round(share)}%</text>
  </svg>`;
}

function changeBadge(current: number, prev: number): string {
  if (prev <= 0) return '';
  const p = ((current - prev) / prev) * 100;
  return p >= 0
    ? `<span class="badge-up">↑${Math.round(p)}%</span>`
    : `<span class="badge-dn">↓${Math.abs(Math.round(p))}%</span>`;
}

function heroVal(n: number): string {
  if (n < 0.01) return n === 0 ? '$0<span class="hero-dec">.00</span>' : `${(n * 100).toFixed(2)}¢`;
  const s = n.toFixed(2);
  const dot = s.indexOf('.');
  return `$${s.slice(0, dot)}<span class="hero-dec">${s.slice(dot)}</span>`;
}

function timeUntil(date: Date): string {
  const diff = date.getTime() - Date.now();
  if (diff <= 0) return 'soon';
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) { const d = Math.floor(h / 24); return `in ${d}d ${h % 24}h`; }
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const MODEL_COLORS = ['#f97316', '#7c6af7', '#5eead4', '#4ade80', '#f472b6', '#60a5fa', '#fbbf24'];

function getHtml(webview: vscode.Webview, summary: UsageSummary, quota: QuotaData | null): string {
  const iconUri = extensionUri
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'icon.png'))
    : '';

  const { tokenBreakdown, todayTokenBreakdown, byProject, byModel, recentSessions,
    prevWeekCost, prevMonthCost } = summary;


  const totalToday = todayTokenBreakdown.input + todayTokenBreakdown.output + todayTokenBreakdown.cacheRead + todayTokenBreakdown.cacheWrite;
  const totalAllTime = tokenBreakdown.input + tokenBreakdown.output + tokenBreakdown.cacheRead + tokenBreakdown.cacheWrite;
  const totalModelCost = byModel.reduce((s, m) => s + m.costUSD, 0);
  const totalModelTokens = byModel.reduce((s, m) => s + m.totalTokens, 0);
  const totalRequests = byModel.reduce((s, m) => s + m.requestCount, 0);
  const avgCostPerReq = totalRequests > 0 ? totalModelCost / totalRequests : 0;

  // Quota percentages
  const fivePct = quota ? Math.min(quota.fiveHourUtilization * 100, 100) : 0;
  const sevenPct = quota ? Math.min(quota.sevenDayUtilization * 100, 100) : 0;
  const fiveClass = fivePct >= 90 ? 'danger' : fivePct >= 70 ? 'warn' : 'ok';
  const sevenClass = sevenPct >= 90 ? 'danger' : sevenPct >= 70 ? 'warn' : 'ok';

  function fmtPct(p: number, cls: string): string {
    if (p > 100) return `<span class="quota-pct danger">Limit reached</span>`;
    if (p < 0.05) return `<span class="quota-pct ${cls}">&lt; 0.1% used</span>`;
    if (p < 10) return `<span class="quota-pct ${cls}">${p.toFixed(1)}% used</span>`;
    return `<span class="quota-pct ${cls}">${Math.round(p)}% used</span>`;
  }

  function tokenGrid(bd: typeof tokenBreakdown, total: number, label: string): string {
    const items = [
      { label: 'Input',       val: bd.input,      color: '#7c6af7' },
      { label: 'Output',      val: bd.output,     color: '#4ade80' },
      { label: 'Cache read',  val: bd.cacheRead,  color: '#5eead4' },
      { label: 'Cache write', val: bd.cacheWrite, color: '#fbbf24' },
    ];
    return items.map((item, i) => {
      const p = pct(item.val, total);
      return `<div class="token-card" style="animation-delay:${60 + i * 30}ms">
        <div class="token-header">
          <span class="tdot" style="background:${item.color}"></span>
          <span class="token-lbl">${item.label}</span>
          <span class="token-pct-lbl">${p}% of ${label}</span>
        </div>
        <div class="token-val">${formatTokenCount(item.val)}</div>
        <div class="tbar"><div class="tbar-fill" style="width:${p}%;background:${item.color}"></div></div>
      </div>`;
    }).join('');
  }

  function modelCards(fullWidth: boolean): string {
    return byModel.map((m, i) => {
      const share = pct(m.costUSD, totalModelCost);
      const color = MODEL_COLORS[i % MODEL_COLORS.length];
      const shortId = m.model.replace('claude-', '');
      const costStr = m.costUSD.toFixed(2);
      const dot = costStr.indexOf('.');
      const costHtml = `$${costStr.slice(0, dot)}<span class="model-cost-dec">${costStr.slice(dot)}</span>`;
      return `
      <div class="model-card${fullWidth ? ' model-card-full' : ''}" style="animation-delay:${i * 60}ms">
        <div class="model-card-left">
          <div class="model-card-header">
            <span class="model-card-name">${escHtml(modelShortName(m.model))}</span>
            <span class="tag">${escHtml(shortId)}</span>
          </div>
          <div class="model-card-cost">${costHtml}</div>
          <div class="muted" style="font-size:11px;margin-top:2px">${formatTokenCount(m.totalTokens)} tok · ${m.requestCount.toLocaleString()} req</div>
          <div class="model-bar-track"><div class="model-bar-fill" style="width:${share}%;background:${color}"></div></div>
        </div>
        <div class="model-card-right">${donutSvg(share, color)}</div>
      </div>`;
    }).join('');
  }

  // JSON for JS sort/filter
  const projectsJson = JSON.stringify(byProject.slice(0, 30).map(p => ({
    color: projectColor(p.displayName),
    name: p.displayName,
    sessions: p.sessionCount,
    tokens: p.totalTokens,
    tokensFmt: formatTokenCount(p.totalTokens),
    cost: p.costUSD,
    costFmt: formatCost(p.costUSD),
  })));

  const sessionsJson = JSON.stringify(recentSessions.map(s => ({
    color: projectColor(s.displayName),
    project: s.displayName,
    model: modelShortName(s.model),
    cost: s.costUSD,
    costFmt: formatCost(s.costUSD),
    tokens: s.totalTokens,
    tokensFmt: formatTokenCount(s.totalTokens),
    time: relativeTime(s.timestamp),
  })));

  const allModels = [...new Set(recentSessions.map(s => modelShortName(s.model)))];
  const modelPills = ['All', ...allModels].map((m, i) =>
    `<button class="pill${i === 0 ? ' active' : ''}" data-model="${escHtml(m)}" onclick="filterSessions(this)">${escHtml(m)}</button>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Usage</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg:           var(--vscode-editor-background, #1e1e1e);
  --bg-1:         var(--vscode-sideBar-background, #252526);
  --bg-2:         var(--vscode-list-hoverBackground, #2d2d30);
  --line:         var(--vscode-panel-border, #333335);
  --fg:           var(--vscode-editor-foreground, #e8e8ea);
  --fg-mute:      var(--vscode-descriptionForeground, #a1a1a6);
  --fg-dim:       #6e6e74;
  --fg-faint:     #4a4a50;
  --accent:       #d97757;
  --accent-hi:    #e08e72;
  --accent-bg:    rgba(217,119,87,.12);
  --accent-line:  rgba(217,119,87,.28);
  --ok:           #4ade80;
  --err:          #f87171;
  --warn:         #fbbf24;
  --global:       #74a8e8;
  --global-bg:    rgba(116,168,232,.10);
  --global-ln:    rgba(116,168,232,.28);
  --project:      #b89bf0;
  --project-bg:   rgba(184,155,240,.10);
  --project-ln:   rgba(184,155,240,.28);
  --sans:         var(--vscode-font-family, -apple-system, 'Segoe UI', system-ui, sans-serif);
  --mono:         var(--vscode-editor-font-family, ui-monospace, 'SF Mono', Menlo, monospace);
  --r-sm:         4px;
  --r:            6px;
  --r-lg:         10px;
  /* aliases used throughout this file */
  --surface:      var(--bg-1);
  --surface2:     var(--bg-2);
  --border:       var(--line);
  --text:         var(--fg);
  --muted:        var(--fg-mute);
  --accent2:      #5eead4;
  --green:        var(--ok);
  --amber:        var(--warn);
  --rose:         var(--err);
  --blue:         var(--global);
  --orange:       var(--accent);
  --radius:       var(--r-lg);
  --radius-sm:    var(--r);
}
body { background: var(--bg); color: var(--fg); font-family: var(--sans); font-size: 13px; line-height: 1.5; min-height: 100vh; -webkit-font-smoothing: antialiased; }

/* ── Top bar ── */
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
.topbar-left { display: flex; align-items: center; gap: 10px; }
.topbar-icon { width: 26px; height: 26px; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
.topbar-icon img { width: 100%; height: 100%; display: block; }
.topbar-title { font-size: 14px; font-weight: 600; }
.topbar-path { font-size: 11px; color: var(--muted); }
.topbar-right { display: flex; align-items: center; gap: 14px; }
.live-badge { display: flex; align-items: center; gap: 5px; background: rgba(74,222,128,.12); border: 1px solid rgba(74,222,128,.3); border-radius: 12px; padding: 2px 9px; font-size: 11px; color: var(--green); }
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
.updated { font-size: 11px; color: var(--muted); }

/* ── Tabs ── */
.tabs { display: flex; padding: 0 20px; background: var(--surface); border-bottom: 1px solid var(--border); gap: 2px; }
.tab-btn { display: flex; align-items: center; gap: 6px; padding: 10px 14px; font-size: 12px; font-weight: 500; color: var(--muted); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; transition: color 0.15s; margin-bottom: -1px; white-space: nowrap; }
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--fg); border-bottom-color: var(--accent); }
.tab-count { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 1px 6px; font-size: 10px; color: var(--muted); }

/* ── Panels ── */
.panel { padding: 20px; }
.panel.hidden { display: none; }

/* ── Section headers ── */
.sec-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.sec-title { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; }
.sec-meta { font-size: 11px; color: var(--muted); }
.section { margin-bottom: 24px; }

/* ── Hero cards ── */
.hero-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
.hero-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; position: relative; overflow: hidden; animation: fadeUp 0.3s ease both; }
.hero-card.today { border-color: var(--accent-line); background: var(--accent-bg); }
.hero-label { font-size: 11px; color: var(--fg-mute); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; margin-bottom: 6px; }
.hero-card.today .hero-label { color: var(--accent); }
.hero-value { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; line-height: 1; color: var(--fg); }
.hero-card.today .hero-value { color: var(--accent); }
.hero-dec { font-size: 16px; font-weight: 600; opacity: 0.55; }
.hero-sub { font-size: 11px; color: var(--fg-dim); margin-top: 7px; }
.hero-badge { position: absolute; bottom: 13px; right: 14px; font-size: 11px; font-weight: 600; }
.badge-up { color: var(--ok);  background: rgba(74,222,128,.15); border-radius: var(--r-sm); padding: 2px 6px; }
.badge-dn { color: var(--err); background: rgba(248,113,113,.15); border-radius: var(--r-sm); padding: 2px 6px; }

/* ── Token breakdown ── */
.token-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.token-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; animation: fadeUp 0.3s ease both; }
.token-header { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; }
.tdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.token-lbl { font-size: 11px; color: var(--muted); flex: 1; }
.token-pct-lbl { font-size: 10px; color: var(--muted); }
.token-val { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
.tbar { height: 3px; background: var(--border); border-radius: 2px; margin-top: 10px; overflow: hidden; }
.tbar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }

/* ── Quota ── */
.quota-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.quota-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 18px; animation: fadeUp 0.3s ease both; }
.quota-card-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.quota-label { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.quota-win-label { font-size: 10px; color: var(--muted); letter-spacing: 0.05em; }
.quota-cost { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
.quota-tokens { font-size: 11px; color: var(--muted); margin-bottom: 10px; }
.q-track { height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; margin-bottom: 7px; }
.q-fill { height: 100%; border-radius: 3px; transition: width 0.6s ease; }
.q-fill.ok     { background: linear-gradient(90deg, var(--accent), var(--accent2)); }
.q-fill.warn   { background: linear-gradient(90deg, var(--amber), #f59e0b); }
.q-fill.danger { background: linear-gradient(90deg, var(--rose), #ef4444); }
.quota-footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); }
.quota-pct.ok     { color: var(--accent2); font-weight: 600; }
.quota-pct.warn   { color: var(--amber); font-weight: 600; }
.quota-pct.danger { color: var(--rose); font-weight: 600; }

/* ── Model cards ── */
.model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.model-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; display: flex; align-items: center; gap: 12px; animation: fadeUp 0.3s ease both; }
.model-card-full { grid-column: 1 / -1; }
.model-card-left { flex: 1; min-width: 0; }
.model-card-right { flex-shrink: 0; }
.model-card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 2px; }
.model-card-name { font-size: 15px; font-weight: 600; }
.model-card-cost { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; margin-top: 4px; }
.model-cost-dec { font-size: 14px; opacity: 0.65; }
.model-bar-track { height: 3px; background: var(--border); border-radius: 2px; margin-top: 12px; overflow: hidden; }
.model-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s ease; }

/* ── Tags ── */
.tag { background: var(--surface2); border: 1px solid var(--border); padding: 1px 6px; border-radius: 4px; font-size: 10px; color: var(--muted); white-space: nowrap; }

/* ── Projects tab ── */
.tab-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.search-input { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12px; color: var(--text); outline: none; width: 220px; }
.search-input::placeholder { color: var(--muted); }
.search-input:focus { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-bg); }
.sort-btn { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 5px 10px; font-size: 11px; color: var(--muted); cursor: pointer; transition: all 0.15s; }
.sort-btn:hover { color: var(--text); border-color: var(--muted); }
.sort-btn.active { color: var(--fg); background: var(--bg-2); border-color: var(--accent-line); }
.table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.proj-table { width: 100%; border-collapse: collapse; }
.proj-table thead tr { background: var(--surface2); border-bottom: 1px solid var(--border); }
.proj-table th { padding: 8px 14px; font-size: 10px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; text-align: left; }
.proj-table th.right, .proj-table td.right { text-align: right; }
.proj-table td { padding: 10px 14px; font-size: 12px; border-bottom: 1px solid var(--border); }
.proj-table tr:last-child td { border-bottom: none; }
.proj-table tr:hover td { background: var(--surface2); }
.proj-name-cell { display: flex; align-items: center; gap: 8px; }
.proj-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.proj-name-text { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }
.cost-cell { color: var(--green); font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
.share-bar-bg { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; width: 140px; }
.share-bar-fill { height: 100%; background: linear-gradient(90deg, var(--orange), #fb923c); border-radius: 2px; }
.muted { color: var(--muted); }

/* ── Sessions tab ── */
.sessions-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.session-row { display: flex; align-items: center; padding: 11px 16px; border-bottom: 1px solid var(--border); gap: 10px; transition: background 0.15s; }
.session-row:last-child { border-bottom: none; }
.session-row:hover { background: var(--surface2); }
.sess-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.sess-name { font-weight: 500; font-size: 12px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sess-right { display: flex; align-items: center; gap: 16px; flex-shrink: 0; font-size: 12px; }
.sess-cost { color: var(--green); font-weight: 600; font-variant-numeric: tabular-nums; }
.sess-tokens { color: var(--muted); font-size: 11px; text-align: right; line-height: 1.3; }
.sess-time { color: var(--muted); font-size: 11px; min-width: 55px; text-align: right; }
.model-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.pill { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 3px 10px; font-size: 11px; color: var(--muted); cursor: pointer; transition: all 0.15s; }
.pill:hover { color: var(--text); }
.pill.active { background: var(--accent-bg); border-color: var(--accent-line); color: var(--accent); }

/* ── Models tab summary ── */
.model-summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
.model-summary-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; animation: fadeUp 0.3s ease both; }
.model-summary-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
.model-summary-value { font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1; }
.model-summary-sub { font-size: 11px; color: var(--muted); margin-top: 5px; }
.model-detail-list { display: flex; flex-direction: column; gap: 10px; }

/* ── Animations ── */
@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
</style>
</head>
<body>

<!-- Top bar -->
<div class="topbar">
  <div class="topbar-left">
    ${iconUri ? `<div class="topbar-icon"><img src="${iconUri}" alt=""/></div>` : ''}
    <div>
      <div class="topbar-title">Claude Usage</div>
      <div class="topbar-path">~/.claude/projects</div>
    </div>
  </div>
  <div class="topbar-right">
    <div class="live-badge"><span class="live-dot"></span>live</div>
    <span class="updated">Updated ${new Date(summary.lastUpdated).toLocaleTimeString()}</span>
  </div>
</div>

<!-- Tabs -->
<nav class="tabs">
  <button class="tab-btn active" data-tab="overview"  onclick="switchTab('overview')">⊞ Overview</button>
  <button class="tab-btn"        data-tab="projects"  onclick="switchTab('projects')">☰ Projects <span class="tab-count">${byProject.length}</span></button>
  <button class="tab-btn"        data-tab="sessions"  onclick="switchTab('sessions')">◷ Sessions <span class="tab-count">${recentSessions.length}</span></button>
  <button class="tab-btn"        data-tab="models"    onclick="switchTab('models')">▣ Models <span class="tab-count">${byModel.length}</span></button>
</nav>

<!-- ═══ OVERVIEW ═══ -->
<div id="tab-overview" class="panel">

  <div class="hero-grid">
    <div class="hero-card" style="animation-delay:0ms">
      <div class="hero-label">All Time</div>
      <div class="hero-value">${heroVal(summary.allTimeCost)}</div>
      <div class="hero-sub">${formatTokenCount(summary.allTimeTokens)} tokens</div>
    </div>
    <div class="hero-card today" style="animation-delay:50ms">
      <div class="hero-label">Today</div>
      <div class="hero-value">${heroVal(summary.todayCost)}</div>
      <div class="hero-sub">${formatTokenCount(summary.todayTokens)} tokens</div>
    </div>
    <div class="hero-card" style="animation-delay:100ms">
      <div class="hero-label">This Week</div>
      <div class="hero-value">${heroVal(summary.weekCost)}</div>
      <div class="hero-sub">7-day window</div>
    </div>
    <div class="hero-card" style="animation-delay:150ms">
      <div class="hero-label">This Month</div>
      <div class="hero-value">${heroVal(summary.monthCost)}</div>
      <div class="hero-sub">Calendar month</div>
    </div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-title">Today's Tokens</span>
      <span class="sec-meta">total ${formatTokenCount(totalToday)}</span>
    </div>
    <div class="token-grid">${tokenGrid(todayTokenBreakdown, totalToday, 'today')}</div>
  </div>

  <div class="section">
    <div class="sec-header"><span class="sec-title">Usage Windows &amp; Quota</span></div>
    <div class="quota-grid">
      <div class="quota-card" style="animation-delay:0ms">
        <div class="quota-card-header">
          <span class="quota-label">Current Session</span>
          <span class="quota-win-label">5H WINDOW</span>
        </div>
        <div class="quota-cost">${formatCost(summary.lastFiveHours.cost)}</div>
        <div class="quota-tokens">${formatTokenCount(summary.lastFiveHours.tokens)} tokens</div>
        ${quota ? `<div class="q-track"><div class="q-fill ${fiveClass}" style="width:${fivePct}%"></div></div>
        <div class="quota-footer"><span>${timeUntil(quota.fiveHourResetAt)}</span>${fmtPct(fivePct, fiveClass)}</div>` : ''}
      </div>
      <div class="quota-card" style="animation-delay:60ms">
        <div class="quota-card-header">
          <span class="quota-label">Weekly</span>
          <span class="quota-win-label">7D WINDOW</span>
        </div>
        <div class="quota-cost">${formatCost(summary.lastWeek.cost)}</div>
        <div class="quota-tokens">${formatTokenCount(summary.lastWeek.tokens)} tokens</div>
        ${quota ? `<div class="q-track"><div class="q-fill ${sevenClass}" style="width:${sevenPct}%"></div></div>
        <div class="quota-footer"><span>${timeUntil(quota.sevenDayResetAt)}</span>${fmtPct(sevenPct, sevenClass)}</div>` : ''}
      </div>
      <div class="quota-card" style="animation-delay:120ms">
        <div class="quota-card-header">
          <span class="quota-label">Last Hour</span>
          <span class="quota-win-label">60M WINDOW</span>
        </div>
        <div class="quota-cost">${formatCost(summary.lastHour.cost)}</div>
        <div class="quota-tokens">${formatTokenCount(summary.lastHour.tokens)} tokens</div>
      </div>
    </div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-title">By Model</span>
      <span class="sec-meta">${formatCost(totalModelCost)} total · ${formatTokenCount(totalModelTokens)} tokens</span>
    </div>
    <div class="model-grid">${modelCards(false)}</div>
  </div>

  <div class="section">
    <div class="sec-header">
      <span class="sec-title">All-Time Tokens</span>
      <span class="sec-meta">total ${formatTokenCount(totalAllTime)}</span>
    </div>
    <div class="token-grid">${tokenGrid(tokenBreakdown, totalAllTime, 'total')}</div>
  </div>

</div>

<!-- ═══ PROJECTS ═══ -->
<div id="tab-projects" class="panel hidden">
  <div class="sec-header" style="margin-bottom:14px">
    <span class="sec-title">Projects</span>
    <span class="sec-meta">${byProject.length} active</span>
  </div>
  <div class="tab-controls">
    <input class="search-input" id="proj-search" placeholder="Filter projects…" oninput="renderProjects()"/>
    <button class="sort-btn active" id="sort-cost"     onclick="sortProjects('cost')">↓ Cost</button>
    <button class="sort-btn"        id="sort-tokens"   onclick="sortProjects('tokens')">↓ Tokens</button>
    <button class="sort-btn"        id="sort-sessions" onclick="sortProjects('sessions')">↓ Sessions</button>
    <button class="sort-btn"        id="sort-name"     onclick="sortProjects('name')">↓ Name</button>
  </div>
  <div class="table-wrap">
    <table class="proj-table">
      <thead><tr>
        <th>Project</th>
        <th class="right">Sessions</th>
        <th class="right">Tokens</th>
        <th class="right">Cost</th>
        <th>Share of Spend</th>
      </tr></thead>
      <tbody id="proj-tbody"></tbody>
    </table>
  </div>
</div>

<!-- ═══ SESSIONS ═══ -->
<div id="tab-sessions" class="panel hidden">
  <div class="sec-header" style="margin-bottom:14px">
    <span class="sec-title">Recent Sessions</span>
    <span class="sec-meta">${recentSessions.length} sessions</span>
  </div>
  <div class="tab-controls">
    <input class="search-input" id="sess-search" placeholder="Filter sessions…" oninput="renderSessions()"/>
    <div class="model-pills">${modelPills}</div>
  </div>
  <div class="sessions-wrap" id="sessions-list"></div>
</div>

<!-- ═══ MODELS ═══ -->
<div id="tab-models" class="panel hidden">
  <div class="sec-header" style="margin-bottom:14px">
    <span class="sec-title">By Model</span>
    <span class="sec-meta">${byModel.length} model${byModel.length !== 1 ? 's' : ''} · ${totalRequests.toLocaleString()} requests</span>
  </div>
  <div class="model-summary-grid">
    <div class="model-summary-card" style="animation-delay:0ms">
      <div class="model-summary-label">Total Spend</div>
      <div class="model-summary-value" style="color:var(--orange)">${heroVal(totalModelCost)}</div>
      <div class="model-summary-sub">${byModel.length} model${byModel.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="model-summary-card" style="animation-delay:60ms">
      <div class="model-summary-label">Total Tokens</div>
      <div class="model-summary-value" style="color:var(--accent2)">${formatTokenCount(totalModelTokens)}</div>
      <div class="model-summary-sub">input + output + cache</div>
    </div>
    <div class="model-summary-card" style="animation-delay:120ms">
      <div class="model-summary-label">Requests</div>
      <div class="model-summary-value" style="color:var(--accent)">${totalRequests.toLocaleString()}</div>
      <div class="model-summary-sub">avg ${formatCost(avgCostPerReq)} per req</div>
    </div>
  </div>
  <div class="sec-header" style="margin-bottom:10px"><span class="sec-title">Detail</span></div>
  <div class="model-detail-list">${modelCards(true)}</div>
</div>

<script>
const PROJECTS = ${projectsJson};
const SESSIONS = ${sessionsJson};
let sortKey = 'cost', sortDir = -1, sessModel = 'All';

function switchTab(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.remove('hidden');
  document.querySelector('[data-tab="' + name + '"]').classList.add('active');
}

function sortProjects(key) {
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sort-' + key).classList.add('active');
  if (sortKey === key) { sortDir *= -1; } else { sortKey = key; sortDir = key === 'name' ? 1 : -1; }
  renderProjects();
}

function renderProjects() {
  const q = (document.getElementById('proj-search').value || '').toLowerCase();
  let rows = PROJECTS.filter(p => p.name.toLowerCase().includes(q));
  rows.sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (sortKey === 'name') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    return va < vb ? -sortDir : va > vb ? sortDir : 0;
  });
  const maxCost = rows.reduce((m, r) => Math.max(m, r.cost), 0.001);
  document.getElementById('proj-tbody').innerHTML = rows.map(p => {
    const w = Math.round((p.cost / maxCost) * 100);
    return '<tr>' +
      '<td><div class="proj-name-cell"><span class="proj-dot" style="background:' + p.color + '"></span>' +
      '<span class="proj-name-text">' + esc(p.name) + '</span></div></td>' +
      '<td class="right muted">' + p.sessions + '</td>' +
      '<td class="right muted">' + p.tokensFmt + '</td>' +
      '<td class="cost-cell">' + p.costFmt + '</td>' +
      '<td><div class="share-bar-bg"><div class="share-bar-fill" style="width:' + w + '%"></div></div></td>' +
      '</tr>';
  }).join('');
}

function filterSessions(btn) {
  if (btn) {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    sessModel = btn.dataset.model;
  }
  renderSessions();
}

function renderSessions() {
  const q = (document.getElementById('sess-search') ? document.getElementById('sess-search').value : '').toLowerCase();
  const rows = SESSIONS.filter(s =>
    (sessModel === 'All' || s.model === sessModel) && (!q || s.project.toLowerCase().includes(q))
  );
  document.getElementById('sessions-list').innerHTML = rows.length
    ? rows.map(s =>
        '<div class="session-row">' +
        '<span class="sess-dot" style="background:' + s.color + '"></span>' +
        '<span class="sess-name">' + esc(s.project) + '</span>' +
        '<span class="tag">' + esc(s.model) + '</span>' +
        '<div class="sess-right">' +
        '<span class="sess-cost">' + s.costFmt + '</span>' +
        '<span class="sess-tokens">' + s.tokensFmt + '<br>tok</span>' +
        '<span class="sess-time">' + s.time + '</span>' +
        '</div></div>'
      ).join('')
    : '<div class="muted" style="padding:24px;text-align:center">No sessions match</div>';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

renderProjects();
renderSessions();
</script>
</body>
</html>`;
}
