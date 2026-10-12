import { fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import type { WAVersion } from '@whiskeysockets/baileys';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// WhatsApp can reject an older bundled browser revision during new-device linking.
// Fetch protocol metadata, never executable code. Fall back to Baileys defaults.
export async function protocolVersion(dir: string): Promise<WAVersion | undefined> {
  const path = join(dir, 'protocol-version.json');
  let cached: { version: WAVersion; fetchedAt: number } | undefined;
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (
      Array.isArray(value.version) &&
      value.version.length === 3 &&
      value.version.every((n: unknown) => Number.isSafeInteger(n) && Number(n) > 0)
    )
      cached = value;
    if (cached && Date.now() - cached.fetchedAt < 6 * 60 * 60 * 1000) return cached.version;
  } catch {}
  const current = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5000) });
  if (current.isLatest) {
    await writeFile(path, JSON.stringify({ version: current.version, fetchedAt: Date.now() }), {
      mode: 0o600,
    }).catch(() => {});
    return current.version;
  }
  return cached?.version;
}
