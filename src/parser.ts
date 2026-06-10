import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as os from 'os';

export interface UsageRecord {
  timestamp: Date;
  sessionId: string;
  projectPath: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;   // total: 5m + 1h (for display/aggregation)
  cacheWrite5mTokens: number; // priced at 1.25× base input
  cacheWrite1hTokens: number; // priced at 2.0× base input
  costUSD: number;
}

// Per-million-token prices: [input, output, cacheWrite5m, cacheWrite1h, cacheRead]
// More-specific prefixes MUST come before broader ones (startsWith matching).
const PRICING_TABLE: Array<[string, number, number, number, number, number]> = [
  // Fable 5 - $10 / $50
  ['claude-fable-5',    10,    50,  12.50,  20,   1.00],
  // Opus 4.8 - $5 / $25 (must precede 'claude-opus-4')
  ['claude-opus-4-8',    5,    25,   6.25,  10,   0.50],
  // Opus 4.5 / 4.6 / 4.7 - repriced at $5 / $25 (must precede 'claude-opus-4')
  ['claude-opus-4-5',    5,    25,   6.25,  10,   0.50],
  ['claude-opus-4-6',    5,    25,   6.25,  10,   0.50],
  ['claude-opus-4-7',    5,    25,   6.25,  10,   0.50],
  // Opus 4 (deprecated) and 4.1 - original $15 / $75 tier
  ['claude-opus-4',     15,    75,  18.75,  30,   1.50],
  // Sonnet 4.x - $3 / $15
  ['claude-sonnet-4',    3,    15,   3.75,   6,   0.30],
  // Haiku 4.5 - repriced at $1 / $5 (must precede 'claude-haiku-4')
  ['claude-haiku-4-5',   1,     5,   1.25,   2,   0.10],
  // Generic Haiku 4.x fallback
  ['claude-haiku-4',     1,     5,   1.25,   2,   0.10],
  // Claude 3.x legacy - new-style IDs first (claude-haiku-3-5-*)
  ['claude-haiku-3-5',   0.8,   4,   1.00,  1.60, 0.08],
  ['claude-3-opus',     15,    75,  18.75,  30,   1.50],
  ['claude-3-5-sonnet',  3,    15,   3.75,   6,   0.30],
  ['claude-3-5-haiku',   0.8,   4,   1.00,  1.60, 0.08],
  ['claude-3-sonnet',    3,    15,   3.75,   6,   0.30],
  ['claude-3-haiku',    0.25, 1.25, 0.3125, 0.50, 0.025],
];
const DEFAULT_PRICING: [number, number, number, number, number] = [3, 15, 3.75, 6, 0.30];

function getPricing(model: string): [number, number, number, number, number] {
  for (const [prefix, input, output, cacheWrite5m, cacheWrite1h, cacheRead] of PRICING_TABLE) {
    if (model.startsWith(prefix)) {
      return [input, output, cacheWrite5m, cacheWrite1h, cacheRead];
    }
  }
  return DEFAULT_PRICING;
}

function computeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWrite5mTokens: number,
  cacheWrite1hTokens: number,
  cacheReadTokens: number
): number {
  const [inputPrice, outputPrice, cacheWrite5mPrice, cacheWrite1hPrice, cacheReadPrice] = getPricing(model);
  const M = 1_000_000;
  return (
    (inputTokens        * inputPrice)       / M +
    (outputTokens       * outputPrice)      / M +
    (cacheWrite5mTokens * cacheWrite5mPrice) / M +
    (cacheWrite1hTokens * cacheWrite1hPrice) / M +
    (cacheReadTokens    * cacheReadPrice)   / M
  );
}

async function readJsonlFile(filePath: string, projectPath: string): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  // Claude Code appends the same final assistant message multiple times under different
  // outer UUIDs. Deduplicate by the inner message.id so each API response is counted once.
  const seenMsgIds = new Set<string>();

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant') continue;

      const msg = obj.message;
      if (!msg?.usage) continue;

      // Skip streaming intermediates - stop_reason is null until the final chunk.
      if (msg.stop_reason === null || msg.stop_reason === undefined) continue;

      // Skip duplicates - Claude Code writes the same final message several times.
      const msgId: string = msg.id ?? '';
      if (msgId) {
        if (seenMsgIds.has(msgId)) continue;
        seenMsgIds.add(msgId);
      }

      const usage = msg.usage;
      const inputTokens = usage.input_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? 0;
      const cacheReadTokens = usage.cache_read_input_tokens ?? 0;

      // Split cache writes by tier - 1h writes cost 2× base input, 5m writes cost 1.25×.
      // Claude Code exclusively uses 1h caching; the sub-object is present in all known
      // JSONL versions, but we fall back gracefully when it's absent.
      const cc = usage.cache_creation ?? {};
      const cacheWrite5mTokens: number = cc.ephemeral_5m_input_tokens ?? 0;
      const cacheWrite1hTokens: number = cc.ephemeral_1h_input_tokens ?? (usage.cache_creation_input_tokens ?? 0);
      const cacheWriteTokens = cacheWrite5mTokens + cacheWrite1hTokens;

      if (inputTokens === 0 && outputTokens === 0 && cacheWriteTokens === 0 && cacheReadTokens === 0) {
        continue;
      }

      const projectDir = obj.cwd ?? projectPath;
      const model: string = msg.model ?? 'unknown';

      const costUSD = computeCost(model, inputTokens, outputTokens, cacheWrite5mTokens, cacheWrite1hTokens, cacheReadTokens);

      records.push({
        timestamp: new Date(obj.timestamp ?? Date.now()),
        sessionId: obj.sessionId ?? '',
        projectPath: projectDir,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheWrite5mTokens,
        cacheWrite1hTokens,
        costUSD,
      });
    } catch {
      // Skip malformed lines
    }
  }

  return records;
}

// Recursively collect every *.jsonl under a project directory. Claude Code
// nests subagent transcripts under <sessionId>/subagents/, so a flat readdir
// would miss them.
function collectJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

export async function scanAllProjects(): Promise<UsageRecord[]> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(claudeDir).filter(d =>
      fs.statSync(path.join(claudeDir, d)).isDirectory()
    );
  } catch {
    return [];
  }

  const allRecords: UsageRecord[] = [];

  for (const projectDir of projectDirs) {
    const projectPath = '/' + projectDir.replace(/^-/, '').replace(/-/g, '/');
    const dirPath = path.join(claudeDir, projectDir);

    for (const filePath of collectJsonlFiles(dirPath)) {
      try {
        const records = await readJsonlFile(filePath, projectPath);
        allRecords.push(...records);
      } catch {
        // Skip unreadable files
      }
    }
  }

  return allRecords;
}
