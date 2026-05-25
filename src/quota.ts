import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface QuotaData {
  fiveHourUtilization: number;   // 0.0 – 1.0  (>1.0 means over limit)
  fiveHourResetAt: Date;
  sevenDayUtilization: number;
  sevenDayResetAt: Date;
  overallStatus: 'allowed' | 'blocked' | 'unknown';
  headersPresent: boolean;       // false = 429 with no headers, utilization inferred
  sevenDayHeaderPresent: boolean; // false = 7d-utilization header was absent in response
  fetchedAt: Date;
}

function readToken(): string | null {
  const home = os.homedir();
  // Candidate paths in priority order — covers Linux, WSL, macOS
  const candidates = [
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, 'Library', 'Application Support', 'Claude', '.credentials.json'),
    path.join(home, '.config', 'claude', '.credentials.json'),
  ];

  for (const credPath of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      // Try every known field name for the OAuth access token
      const token =
        raw?.claudeAiOauth?.accessToken ??
        raw?.oauthAccount?.accessToken ??
        raw?.oauth?.accessToken ??
        raw?.accessToken ??
        null;
      if (token) return token;
    } catch {
      // file missing or unreadable — try next candidate
    }
  }
  return null;
}

export async function fetchQuota(): Promise<QuotaData | null> {
  const token = readToken();
  if (!token) return null;

  return new Promise(resolve => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          // OAuth tokens go through `authorization: Bearer`. Sending the same
          // token in `x-api-key` causes the API to reject with 401
          // "invalid x-api-key" — it validates that header as an API key, not
          // an OAuth token, so the combo must not be sent together.
          'authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-client-platform': 'claude_cli',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      res => {
        const h = res.headers as Record<string, string>;
        res.resume();

        const parse5hReset = h['anthropic-ratelimit-unified-5h-reset'];
        const parse7dReset = h['anthropic-ratelimit-unified-7d-reset'];
        const headersPresent = Boolean(parse5hReset || h['anthropic-ratelimit-unified-5h-utilization']);
        const sevenDayHeaderPresent = Boolean(parse7dReset || h['anthropic-ratelimit-unified-7d-utilization']);

        const fiveHourResetAt  = parse5hReset
          ? new Date(parseInt(parse5hReset, 10) * 1000)
          : new Date(Date.now() + 5 * 3600_000);
        const sevenDayResetAt = parse7dReset
          ? new Date(parseInt(parse7dReset, 10) * 1000)
          : new Date(Date.now() + 7 * 86400_000);

        // Any non-2xx without rate-limit headers is an auth / server failure,
        // not a usable quota signal. Returning zeros here would mislead users
        // into thinking they had full quota remaining. The single exception is
        // 429-with-no-headers, which legitimately means "quota exhausted".
        if (!headersPresent && res.statusCode !== 429 &&
            (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300)) {
          resolve(null);
          return;
        }

        // 429 with no headers = quota exhausted / hard rate-limited
        if (res.statusCode === 429 && !headersPresent) {
          resolve({
            fiveHourUtilization: 1.0,
            fiveHourResetAt,
            sevenDayUtilization: 1.0,
            sevenDayResetAt,
            overallStatus: 'blocked',
            headersPresent: false,
            sevenDayHeaderPresent: false,
            fetchedAt: new Date(),
          });
          return;
        }

        const fiveHourUtilization = parseFloat(h['anthropic-ratelimit-unified-5h-utilization'] ?? '0') || 0;
        const sevenDayUtilization = sevenDayHeaderPresent
          ? parseFloat(h['anthropic-ratelimit-unified-7d-utilization']!) || 0
          : 0;
        const status = h['anthropic-ratelimit-unified-status'];

        resolve({
          fiveHourUtilization,
          fiveHourResetAt,
          sevenDayUtilization,
          sevenDayResetAt,
          overallStatus: status === 'blocked' ? 'blocked' : status === 'allowed' ? 'allowed' : 'unknown',
          headersPresent,
          sevenDayHeaderPresent,
          fetchedAt: new Date(),
        });
      }
    );

    req.on('error', () => resolve(null));
    req.setTimeout(10_000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}
