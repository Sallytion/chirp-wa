import { existsSync } from 'node:fs';
import { rename, writeFile, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { Store } from './store.js';
import { privateDir } from './util.js';

// The marker makes an interrupted account switch finish before another login.
export async function finishAccountReset(store: Store, dir: string): Promise<string | undefined> {
  const root = resolve(dir);
  const marker = join(root, 'account-reset.json');
  if (!existsSync(marker)) return;
  const { folder } = JSON.parse(await readFile(marker, 'utf8')) as { folder: string };
  if (!/^account-backup-[\w-]+$/.test(folder)) throw new Error('Invalid account backup folder.');
  const archive = join(root, folder);
  if (dirname(archive) !== root || !existsSync(join(archive, 'history.sqlite')))
    throw new Error('Account backup is missing. Cannot start a new account.');
  for (const child of ['auth', 'media']) {
    const source = join(root, child);
    if (existsSync(source)) await rename(source, join(archive, child));
  }
  store.clearAccount();
  await unlink(marker);
  return archive;
}

export async function archiveAccount(
  store: Store,
  dir: string,
  unlinkDevice?: () => Promise<void>,
): Promise<string> {
  const pending = await finishAccountReset(store, dir);
  if (pending) return pending;
  const folder = `account-backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const archive = privateDir(join(resolve(dir), folder));
  // A failed backup never invalidates a working login or clears local history.
  await store.archive(join(archive, 'history.sqlite'));
  if (unlinkDevice) await unlinkDevice();
  await writeFile(join(resolve(dir), 'account-reset.json'), JSON.stringify({ folder }), {
    mode: 0o600,
  });
  return (await finishAccountReset(store, dir))!;
}
