// Optional network smoke check: connect an unlinked device and verify QR generation.
// No account is linked and no WhatsApp messages are sent.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { Store } from '../src/store.js';
import { WhatsAppClient } from '../src/client.js';

const dir = mkdtempSync(join(tmpdir(), 'chirp-handshake-'));
const store = new Store(':memory:');
const client = new WhatsAppClient(store, dir);
let unsubscribe = () => {};
let timeout: NodeJS.Timeout | undefined;
try {
  const ready = new Promise<void>((resolve, reject) => {
    unsubscribe = client.subscribe(() => {
      if (client.state.connection === 'reconnecting') console.log(client.state.notice);
      if (client.state.qr) {
        const qr = QRCode.create(client.state.qr).modules;
        console.log(
          `PASS: WhatsApp connection produced a valid ${qr.size}×${qr.size} terminal QR. No account linked or messages sent.`,
        );
        resolve();
      } else if (client.state.connection === 'logged-out') reject(new Error(client.state.notice));
    });
    timeout = setTimeout(
      () => reject(new Error(`No QR after 45 seconds: ${client.state.notice}`)),
      45_000,
    );
  });
  await client.connect();
  await ready;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  unsubscribe();
  await client.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
