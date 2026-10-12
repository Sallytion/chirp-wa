// Diagnose an existing paired session without sending messages or read receipts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { Store } from '../src/store.js';
import { WhatsAppClient } from '../src/client.js';
import { profileDir } from '../src/util.js';

const dir = profileDir(undefined, process.argv[2] || 'default');
const credentials = join(dir, 'auth', 'creds.json');
if (!existsSync(credentials) || !JSON.parse(readFileSync(credentials, 'utf8')).me?.id) {
  throw new Error('No paired session. Start chirp and scan the QR first.');
}
const release = await lockfile.lock(dir, { realpath: false, stale: 30_000 });
const store = new Store(join(dir, 'history.sqlite'));
const client = new WhatsAppClient(store, dir);
let unsubscribe = () => {};
let timeout: NodeJS.Timeout | undefined;
let stable: NodeJS.Timeout | undefined;
try {
  const connected = new Promise<void>((resolve, reject) => {
    let previous = '';
    unsubscribe = client.subscribe(() => {
      const state = client.state;
      if (state.connection !== previous) {
        console.log(`${state.connection}: ${state.notice}`);
        previous = state.connection;
      }
      if (state.connection === 'open' && !stable) stable = setTimeout(resolve, 5000);
      if (state.connection === 'reconnecting' || state.connection === 'logged-out')
        reject(new Error(state.notice));
    });
    timeout = setTimeout(
      () => reject(new Error(`Session did not open within 30 seconds: ${client.state.notice}`)),
      30_000,
    );
  });
  await client.connect();
  await connected;
  console.log(
    `PASS: Linked WhatsApp session stayed connected for 5 seconds. Cached messages: ${store.stats().messages}. No messages or read receipts sent.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  clearTimeout(stable);
  unsubscribe();
  await client.stop();
  store.close();
  await release();
}
