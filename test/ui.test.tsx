import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { render, cleanup } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { Store } from '../src/store.js';
import { DemoClient, DEMO_JID, DEMO_CHANNEL_JID } from '../src/demo.js';
import { imagePreview } from '../src/media.js';
import { command } from '../src/commands.js';
import { qrText } from '../src/ui/layout.js';
import QRCode from 'qrcode';
import stringWidth from 'string-width';
import { readClipboard } from '../src/clipboard.js';

const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.ok(predicate(), 'Timed out waiting for UI state');
}
const settings = { autoRead: false, notifications: false, theme: 'dark' as const };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-ui-'));
  const store = new Store(':memory:');
  const client = new DemoClient(store, dir);
  await client.connect();
  return {
    dir,
    store,
    client,
    close: async () => {
      cleanup();
      await client.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('full-screen TUI switches chats, sends, replies, searches, shows actions and previews media', async () => {
  const f = await fixture();
  try {
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    assert.match(ui.lastFrame()!, /CHIRP/);
    assert.match(ui.lastFrame()!, /Maya Shah/);
    assert.match(ui.lastFrame()!, /Ctrl\+G/);
    ui.stdin.write('A test from the composer 🌅');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.equal(f.store.search('A test from the composer')[0]?.fromMe, true);
    ui.stdin.write('\x1br');
    await delay();
    assert.match(ui.lastFrame()!, /Replying to/);
    ui.stdin.write('\x1b');
    await delay();
    ui.stdin.write('\x1ba');
    await delay();
    assert.match(ui.lastFrame()!, /Actions/);
    assert.match(ui.lastFrame()!, /React to selected/);
    ui.stdin.write('\x1b');
    await delay();
    ui.stdin.write('\x0b');
    await delay();
    assert.match(ui.lastFrame()!, /Switch chat/);
    ui.stdin.write('Mom');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.match(ui.lastFrame()!, /dinner at 8/);
    ui.stdin.write('\x0b');
    await delay();
    ui.stdin.write('Maya');
    await delay();
    ui.stdin.write('\r');
    await delay();
    ui.stdin.write('\x06');
    await delay();
    ui.stdin.write('inspiration');
    await delay();
    assert.match(ui.lastFrame()!, /inspiration/);
    ui.stdin.write('\r');
    await delay();
    ui.stdin.write('\x1bp');
    await waitFor(() => /IMAGE/.test(ui.lastFrame() || '') && /▀/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /O open externally/);
    assert.ok(f.store.draft(DEMO_JID) === '');
  } finally {
    await f.close();
  }
});

test('cached history navigation and drafts survive chat switches', async () => {
  const f = await fixture();
  try {
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    ui.stdin.write('Keep this draft');
    await delay();
    ui.stdin.write('\x0b');
    await delay();
    ui.stdin.write('Mom');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.equal(f.store.draft(DEMO_JID), 'Keep this draft');
    ui.stdin.write('\x0b');
    await delay();
    ui.stdin.write('Maya');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.match(ui.lastFrame()!, /Keep this draft/);
    ui.stdin.write('\x1b[5~');
    await delay();
    assert.match(ui.lastFrame()!, /browsing history/);
  } finally {
    await f.close();
  }
});

test('typing reuses history while incoming edits and receipts immediately refresh the transcript', async () => {
  const f = await fixture();
  let reads = 0;
  const history = f.store.history.bind(f.store);
  f.store.history = (...args) => {
    reads++;
    return history(...args);
  };
  try {
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    const initialReads = reads;
    for (const char of 'typing a draft') {
      ui.stdin.write(char);
      await delay(25);
    }
    await delay();
    assert.equal(reads, initialReads, 'Editor renders must not reload history');
    const last = history(DEMO_JID).at(-1)!;
    f.store.patch(last.raw.key, { text: 'Incoming edit is visible', edited: true, status: 'read' });
    await delay();
    assert.ok(reads > initialReads);
    assert.match(ui.lastFrame()!, /Incoming edit is visible/);
    assert.match(ui.lastFrame()!, /typing a draft/);
  } finally {
    await f.close();
  }
});

test('sync activity stays visible through sending, dialogs, page switches, and completion', async () => {
  const f = await fixture();
  try {
    f.client.state = {
      ...f.client.state,
      historyProgress: 42,
      sync: { chats: 'syncing', contacts: 'syncing' },
    };
    const ui = render(<App {...f} profile="test" demo settings={settings} />);
    await waitFor(() => /Syncing chats & contacts… · 42%/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /Maya Shah/);
    assert.match(ui.lastFrame()!, /Syncing chats & contacts… · 42%/);
    ui.stdin.write('Sending while syncing');
    await waitFor(() => /Sending while syncing/.test(ui.lastFrame() || ''));
    ui.stdin.write('\r');
    await waitFor(() => /Message sent/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /Message sent/);
    assert.match(ui.lastFrame()!, /Syncing chats & contacts/);
    ui.stdin.write('\x1ba');
    await waitFor(() => /Actions/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /Actions/);
    assert.match(ui.lastFrame()!, /Syncing chats & contacts/);
    ui.stdin.write('\x1b');
    await waitFor(() => !/Actions/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x1b2');
    await waitFor(() => /CHANNELS/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /CHANNELS/);
    assert.match(ui.lastFrame()!, /Syncing chats & contacts/);
    f.client.state = { ...f.client.state, sync: { chats: 'synced', contacts: 'synced' } };
    ui.rerender(<App {...f} profile="test" demo settings={settings} />);
    await waitFor(() => /Sync complete/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /Sync complete/);
    assert.doesNotMatch(ui.lastFrame()!, /Syncing chats & contacts/);
  } finally {
    await f.close();
  }
});

test('portable Control shortcuts paste, preview, caption and send images; preserve attachment drafts; and delete words', async () => {
  const f = await fixture();
  try {
    const file = await f.client.download(f.store.message({ remoteJid: DEMO_JID, id: 'photo' })!);
    const clipboard = async () => ({
      type: 'image' as const,
      path: file,
      width: 240,
      height: 120,
      bytes: 100,
    });
    const ui = render(
      <App
        {...f}
        profile="test"
        demo
        clipboard={clipboard}
        settings={settings}
        initialJid={DEMO_JID}
      />,
    );
    await delay();
    const before = f.store.count(DEMO_JID);
    ui.stdin.write('\x16');
    await delay();
    assert.match(ui.lastFrame()!, /Clipboard image · 240×120/);
    assert.equal(f.store.count(DEMO_JID), before);
    ui.stdin.write('\x10');
    await waitFor(
      () =>
        /Clipboard image · 240 × 120/.test(ui.lastFrame() || '') && /▀/.test(ui.lastFrame() || ''),
    );
    ui.stdin.write('\x1b');
    await delay();
    assert.match(ui.lastFrame()!, /Enter send/);
    ui.stdin.write('\x0b');
    await delay();
    ui.stdin.write('Mom');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.doesNotMatch(ui.lastFrame()!, /Clipboard image · 240×120/);
    ui.stdin.write('\x0b');
    await delay();
    ui.stdin.write('Maya');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.match(ui.lastFrame()!, /Clipboard image · 240×120/);
    ui.stdin.write('Caption extra');
    await waitFor(() => f.store.draft(DEMO_JID) === 'Caption extra');
    ui.stdin.write('\x1b[127;5u');
    await waitFor(() => f.store.draft(DEMO_JID) === 'Caption ');
    assert.equal(f.store.draft(DEMO_JID), 'Caption ');
    ui.stdin.write('more');
    await waitFor(() => f.store.draft(DEMO_JID) === 'Caption more');
    ui.stdin.write('\x17');
    await waitFor(() => f.store.draft(DEMO_JID) === 'Caption ');
    assert.equal(f.store.draft(DEMO_JID), 'Caption ');
    ui.stdin.write('words');
    await waitFor(() => f.store.draft(DEMO_JID) === 'Caption words');
    ui.stdin.write('\x1b\x7f');
    await waitFor(() => f.store.draft(DEMO_JID) === 'Caption ');
    assert.equal(f.store.draft(DEMO_JID), 'Caption ');
    ui.stdin.write('\r');
    await delay();
    assert.match(ui.lastFrame()!, /Image sent/);
    assert.doesNotMatch(ui.lastFrame()!, /Clipboard image · 240×120/);
    assert.equal(f.store.history(DEMO_JID).at(-1)?.kind, 'image');
    assert.equal(f.store.history(DEMO_JID).at(-1)?.text, 'Caption ');
    ui.stdin.write('\x0e');
    await delay();
    assert.match(ui.lastFrame()!, /CHANNELS/);
    ui.stdin.write('\x0e');
    await delay();
    ui.stdin.write('\x07');
    await delay();
    assert.match(ui.lastFrame()!, /Actions/);
    assert.match(ui.lastFrame()!, /Paste from clipboard/);
    ui.stdin.write('\x1b');
    await delay();
    ui.stdin.write('\x16');
    await delay();
    ui.stdin.write('\x1b');
    await delay();
    assert.doesNotMatch(ui.lastFrame()!, /Clipboard image · 240×120/);
  } finally {
    await f.close();
  }
});

test('Indic sidebar previews cannot create an extra row, and compact terminals keep the last message and composer visible', async () => {
  const f = await fixture();
  try {
    f.store.ingest({
      key: { remoteJid: DEMO_JID, id: 'hindi' },
      messageTimestamp: Math.floor(Date.now() / 1000) + 60,
      message: { conversation: 'अब से कचौरी उपलब्ध है।' },
    });
    f.client.state = {
      ...f.client.state,
      sync: { chats: 'syncing', contacts: 'syncing' },
      historyProgress: 42,
    };
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    assert.equal(ui.lastFrame()!.split('\n').length, 36);
    assert.ok(
      ui
        .lastFrame()!
        .split('\n')
        .every((line) => stringWidth(line) <= 100),
    );
    Object.defineProperty(ui.stdout, 'columns', { value: 40 });
    Object.defineProperty(ui.stdout, 'rows', { value: 18 });
    ui.stdout.emit('resize');
    await delay();
    assert.equal(ui.lastFrame()!.split('\n').length, 18);
    assert.ok(
      ui
        .lastFrame()!
        .split('\n')
        .every((line) => stringWidth(line) <= 40),
    );
    assert.match(ui.lastFrame()!, /कचौरी/);
    assert.match(ui.lastFrame()!, /Message…/);
  } finally {
    await f.close();
  }
});

test('composer accepts terminal Backspace and keeps forward Delete separate', async () => {
  const f = await fixture();
  try {
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    ui.stdin.write('abcd');
    await waitFor(() => f.store.draft(DEMO_JID) === 'abcd');
    ui.stdin.write('\x7f');
    await waitFor(() => f.store.draft(DEMO_JID) === 'abc');
    assert.equal(f.store.draft(DEMO_JID), 'abc');
    ui.stdin.write('\x08');
    await waitFor(() => f.store.draft(DEMO_JID) === 'ab');
    assert.equal(f.store.draft(DEMO_JID), 'ab');
    ui.stdin.write('\x1b[D');
    await waitFor(() => /a▌b/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x1b[3~');
    await waitFor(() => f.store.draft(DEMO_JID) === 'a');
    assert.equal(f.store.draft(DEMO_JID), 'a');
    ui.stdin.write('\x7f');
    await waitFor(() => f.store.draft(DEMO_JID) === '');
    assert.equal(f.store.draft(DEMO_JID), '');
    ui.stdin.write('👍🏽');
    await waitFor(() => f.store.draft(DEMO_JID) === '👍🏽');
    ui.stdin.write('\x7f');
    await waitFor(() => f.store.draft(DEMO_JID) === '');
    assert.equal(f.store.draft(DEMO_JID), '');
    ui.stdin.write('abc\x7f\x7f');
    await waitFor(() => f.store.draft(DEMO_JID) === 'a');
    assert.equal(f.store.draft(DEMO_JID), 'a');
    ui.stdin.write('\x7f');
    await waitFor(() => f.store.draft(DEMO_JID) === '');
    ui.stdin.write('\x0b');
    await waitFor(() => /Switch chat/.test(ui.lastFrame() || ''));
    ui.stdin.write('Mayax');
    await waitFor(() => /⌕ Mayax▌/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x7f');
    await waitFor(() => /⌕ Maya▌/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /⌕ Maya▌/);
    ui.stdin.write('\x1b[3~');
    await delay();
    assert.match(ui.lastFrame()!, /⌕ Maya▌/);
  } finally {
    await f.close();
  }
});

test('emoji picker selects with arrows, inserts without sending, and dismisses with Escape', async () => {
  const f = await fixture();
  try {
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    const count = f.store.count(DEMO_JID);
    ui.stdin.write('Hello :smile');
    await waitFor(() => /Emoji ·/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /Emoji ·/);
    assert.match(ui.lastFrame()!, /:smile:/);
    ui.stdin.write('\r');
    await waitFor(() => f.store.draft(DEMO_JID) === 'Hello 😄');
    assert.equal(f.store.draft(DEMO_JID), 'Hello 😄');
    assert.equal(f.store.count(DEMO_JID), count);
    assert.doesNotMatch(ui.lastFrame()!, /Emoji ·/);
    ui.stdin.write('\r');
    await waitFor(() => !!f.store.search('Hello 😄')[0]);
    assert.equal(f.store.search('Hello 😄')[0]?.fromMe, true);
    ui.stdin.write(':smile');
    await waitFor(() => /Emoji ·/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x1b[B');
    await waitFor(() => /2\/8/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /2\/8/);
    ui.stdin.write('\t');
    await waitFor(() => f.store.draft(DEMO_JID) === '😃');
    assert.equal(f.store.draft(DEMO_JID), '😃');
    ui.stdin.write('\x7f');
    await waitFor(() => f.store.draft(DEMO_JID) === '');
    assert.equal(f.store.draft(DEMO_JID), '');
    ui.stdin.write(':smile');
    await waitFor(() => /Emoji ·/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x1b');
    await waitFor(() => !/Emoji ·/.test(ui.lastFrame() || ''));
    assert.doesNotMatch(ui.lastFrame()!, /Emoji ·/);
    assert.equal(f.store.draft(DEMO_JID), ':smile');
    ui.stdin.write('y');
    await waitFor(() => /Emoji ·/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /Emoji ·/);
    ui.stdin.write('\x1b');
    await waitFor(() => !/Emoji ·/.test(ui.lastFrame() || ''));
    ui.stdin.write('\r');
    await waitFor(() => !!f.store.search(':smiley')[0]);
    assert.equal(f.store.search(':smiley')[0]?.fromMe, true);
  } finally {
    await f.close();
  }
});

test('both login methods are available interactively; terminal QR is rendered', async () => {
  const f = await fixture();
  try {
    let phone = '';
    f.client.requestPairing = async (value) => {
      phone = value;
      f.client.state = { ...f.client.state, pairingCode: '12345678' };
    };
    f.client.state = { connection: 'qr', notice: 'Scan QR', presence: {}, qr: 'login-test' };
    const ui = render(<App {...f} profile="test" settings={settings} />);
    await delay();
    assert.match(ui.lastFrame()!, /QR code \(default\)/);
    assert.match(ui.lastFrame()!, /Pair with phone number/);
    assert.match(ui.lastFrame()!, /[▀▄█]/);
    ui.stdin.write('p');
    await delay();
    assert.match(ui.lastFrame()!, /include country code/);
    ui.stdin.write('+919876543210');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.equal(phone, '+919876543210');
    assert.match(ui.lastFrame()!, /1234-5678/);
  } finally {
    await f.close();
  }
});

test('logout is accessible on both pages, cancellation is harmless, and confirmation clears previous chat context', async () => {
  const f = await fixture();
  try {
    const ui = render(<App {...f} profile="test" settings={settings} initialJid={DEMO_JID} />);
    await delay();
    ui.stdin.write('Previous account draft');
    await delay();
    ui.stdin.write('\x1bl');
    await delay();
    assert.match(ui.lastFrame()!, /Log out \/ link another account/);
    ui.stdin.write('\r');
    await delay();
    assert.equal(f.client.state.connection, 'open');
    assert.equal(f.store.draft(DEMO_JID), 'Previous account draft');
    ui.stdin.write('\x1b2');
    await delay();
    ui.stdin.write('\x1ba');
    await delay();
    ui.stdin.write('\x1b[B'.repeat(13));
    await delay();
    assert.match(ui.lastFrame()!, /Log out \/ link another account/);
    ui.stdin.write('\r');
    await delay();
    assert.match(ui.lastFrame()!, /archive history, contacts, drafts/);
    ui.stdin.write('\x1b[B');
    await delay();
    ui.stdin.write('\r');
    await delay();
    assert.equal(f.client.state.connection, 'logged-out');
    assert.equal(f.store.stats().messages, 0);
    assert.match(ui.lastFrame()!, /Link WhatsApp/);
    assert.doesNotMatch(ui.lastFrame()!, /Previous account draft|Design Dispatch|Maya Shah/);
    assert.equal(f.store.draft(DEMO_JID), '');
    ui.unmount();
    assert.equal(f.store.draft(DEMO_JID), '');
  } finally {
    await f.close();
  }
});

test('preview dimensions are bounded; view-once media and confirmation commands are protected', async () => {
  const f = await fixture();
  try {
    const photo = f.store.message({ remoteJid: DEMO_JID, id: 'photo' })!;
    const preview = await imagePreview(await f.client.download(photo), 30, 10);
    assert.ok(preview.split('\n').length <= 10);
    assert.equal(qrText(QRCode.create('hello').modules).split('\n')[0].trim(), '');
    const ctx = { ...f, jid: DEMO_JID, selected: photo, visible: [photo], settings };
    await assert.rejects(command('/delete', ctx), /confirm/);
    await assert.rejects(command('/logout', ctx), /confirm/);
    const result = await command('/receipts off', ctx);
    assert.equal(result.settings?.autoRead, false);
  } finally {
    await f.close();
  }
});

test('accepted QR shows finishing login and rejected sessions offer relinking with Q', async () => {
  const f = await fixture();
  const empty = new Store(':memory:');
  try {
    f.client.state = {
      connection: 'reconnecting',
      linked: true,
      notice: 'QR accepted · reconnecting',
      presence: {},
    };
    let relinked = false;
    f.client.useQr = () => {
      relinked = true;
    };
    const ui = render(<App {...f} store={empty} profile="test" settings={settings} />);
    await delay();
    assert.match(ui.lastFrame()!, /Finishing WhatsApp login/);
    assert.doesNotMatch(ui.lastFrame()!, /Preparing your QR code/);
    assert.doesNotMatch(ui.lastFrame()!, /Pair with phone number/);
    f.client.state = { ...f.client.state, connection: 'logged-out' };
    ui.rerender(<App {...f} store={empty} profile="test" settings={settings} />);
    await delay();
    assert.match(ui.lastFrame()!, /Relink with a fresh QR/);
    ui.stdin.write('q');
    await delay();
    assert.equal(relinked, true);
  } finally {
    await f.close();
    empty.close();
  }
});

test('Chats and Channels pages isolate lists, retain drafts, and preview channel attachments', async () => {
  const f = await fixture();
  try {
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    assert.match(ui.lastFrame()!, /Chats/);
    assert.match(ui.lastFrame()!, /Channels/);
    assert.doesNotMatch(ui.lastFrame()!, /Design Dispatch/);
    ui.stdin.write('Keep this chat draft');
    await delay();
    ui.stdin.write('\x1b2');
    await delay();
    assert.match(ui.lastFrame()!, /CHANNELS/);
    assert.match(ui.lastFrame()!, /Design Dispatch/);
    assert.match(ui.lastFrame()!, /read-only/);
    assert.doesNotMatch(ui.lastFrame()!, /Maya Shah/);
    assert.equal(f.store.draft(DEMO_JID), 'Keep this chat draft');
    ui.stdin.write('attempt to send');
    await delay();
    assert.equal(f.store.draft(DEMO_CHANNEL_JID), '');
    ui.stdin.write('\x0b');
    await delay();
    assert.match(ui.lastFrame()!, /Switch channel/);
    assert.doesNotMatch(ui.lastFrame()!, /Maya Shah/);
    ui.stdin.write('\x1b');
    await delay();
    ui.stdin.write('\x1bp');
    await waitFor(() => /IMAGE/.test(ui.lastFrame() || '') && /▀/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x1b');
    await delay();
    ui.stdin.write('\x1b1');
    await delay();
    assert.match(ui.lastFrame()!, /Maya Shah/);
    assert.match(ui.lastFrame()!, /Keep this chat draft/);
    assert.doesNotMatch(ui.lastFrame()!, /Design Dispatch/);
    ui.stdin.write('\x1ba');
    await delay();
    assert.match(ui.lastFrame()!, /Sync WhatsApp contact names/);
  } finally {
    await f.close();
  }
});
