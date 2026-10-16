import React from 'react';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { render, cleanup } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { Store } from '../src/store.js';
import { DemoClient, DEMO_JID } from '../src/demo.js';
import { mentionsOf } from '../src/messages.js';

const delay = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.ok(predicate(), 'Timed out waiting for UI state');
}
const settings = { autoRead: false, notifications: false, theme: 'dark' as const };
const GROUP = '120363000000000001@g.us';
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-features-'));
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
async function openChat(ui: ReturnType<typeof render>, name: string) {
  ui.stdin.write('\x0b');
  await waitFor(() => /Switch chat/.test(ui.lastFrame() || ''));
  ui.stdin.write(name);
  await delay();
  ui.stdin.write('\r');
  await delay();
}

test('the newest of local and connection notices is shown', async () => {
  const f = await fixture();
  try {
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    ui.stdin.write('Hello there');
    await delay();
    ui.stdin.write('\r');
    await waitFor(() => /Message sent/.test(ui.lastFrame() || ''));
    await f.client.history();
    await waitFor(() => /Demo history is already cached/.test(ui.lastFrame() || ''));
    ui.stdin.write('/receipts on');
    await delay();
    ui.stdin.write('\r');
    await waitFor(() => /receipts on/.test(ui.lastFrame() || ''));
  } finally {
    await f.close();
  }
});

test('automatic read receipts pause while the terminal is unfocused', async () => {
  const f = await fixture();
  try {
    const unread = () => !f.store.message({ remoteJid: DEMO_JID, id: 'e' })!.localRead;
    assert.ok(unread());
    const ui = render(
      <App
        {...f}
        profile="test"
        demo
        settings={{ ...settings, autoRead: true }}
        initialJid={DEMO_JID}
      />,
    );
    await delay(50);
    ui.stdin.write('\x1b[O');
    await delay(800);
    assert.ok(unread(), 'nothing is marked read while unfocused');
    assert.equal(f.store.draft(DEMO_JID), '', 'focus reports are not typed into the composer');
    ui.stdin.write('\x1b[I');
    await waitFor(() => !unread());
  } finally {
    await f.close();
  }
});

test('typing indicators follow the preference while presence is still watched', async () => {
  const f = await fixture();
  try {
    const typing: boolean[] = [];
    const watched: string[] = [];
    f.client.typing = async (_jid: string, active: boolean) => {
      typing.push(active);
    };
    f.client.watchPresence = async (jid: string) => {
      watched.push(jid);
    };
    const ui = render(
      <App
        {...f}
        profile="test"
        demo
        settings={{ ...settings, typing: false }}
        initialJid={DEMO_JID}
      />,
    );
    await delay();
    ui.stdin.write('typing quietly');
    await delay(600);
    assert.deepEqual(typing, []);
    ui.stdin.write('\x15');
    await openChat(ui, 'Mom');
    assert.deepEqual(watched, ['919000000001@s.whatsapp.net']);
    assert.deepEqual(typing, []);
    ui.stdin.write('/typing on');
    await delay();
    ui.stdin.write('\r');
    await waitFor(() => /typing on/.test(ui.lastFrame() || ''));
    ui.stdin.write('hello');
    await waitFor(() => typing.includes(true));
  } finally {
    await f.close();
  }
});

test('group chats show quoted replies, poll tallies, mute markers and @ mention completion', async () => {
  const f = await fixture();
  try {
    f.store.upsertChat({ jid: '919000000001@s.whatsapp.net', muted: -1 });
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    assert.match(ui.lastFrame()!, /⊘ Mom/);
    await openChat(ui, 'Design');
    const frame = ui.lastFrame()!;
    assert.match(frame, /↳ Maya Shah: The terminal layout looks clean/);
    assert.match(frame, /1\. Tuesday · 0/);
    assert.match(frame, /2\. Thursday · 1/);
    ui.stdin.write('@ar');
    await waitFor(() => /Mention ·/.test(ui.lastFrame() || ''));
    assert.match(ui.lastFrame()!, /Arjun Mehta · 919000000002/);
    ui.stdin.write('\t');
    await waitFor(() => f.store.draft(GROUP) === '@919000000002 ');
    ui.stdin.write('please review');
    await delay();
    ui.stdin.write('\r');
    await waitFor(() => !!f.store.search('please review')[0]);
    const sent = f.store.search('please review')[0];
    assert.deepEqual(mentionsOf(sent.raw), ['919000000002@s.whatsapp.net']);
    await waitFor(() => /@Arjun Mehta please review/.test(ui.lastFrame() || ''));
  } finally {
    await f.close();
  }
});

test('search results load more pages as you scroll', async () => {
  const f = await fixture();
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 120; i++)
        f.store.ingest({
          key: { remoteJid: DEMO_JID, id: `page-${i}`, fromMe: false },
          messageTimestamp: 1_600_000_000 + i,
          message: { conversation: `pagetest item ${i}` },
        });
    });
    const ui = render(<App {...f} profile="test" demo settings={settings} initialJid={DEMO_JID} />);
    await delay();
    ui.stdin.write('\x06');
    await delay();
    ui.stdin.write('pagetest');
    await waitFor(() => /50\+ results/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x1b[B'.repeat(49));
    await waitFor(() => /100\+ results/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x1b[B'.repeat(50));
    await waitFor(() => /120 results/.test(ui.lastFrame() || ''));
  } finally {
    await f.close();
  }
});

test('kitty previews transmit once, draw placeholders and free the image on close', async () => {
  const f = await fixture();
  try {
    const photo = await f.client.download(f.store.message({ remoteJid: DEMO_JID, id: 'photo' })!);
    const clipboard = async () => ({
      type: 'image' as const,
      path: photo,
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
        graphics="kitty"
        settings={settings}
        initialJid={DEMO_JID}
      />,
    );
    await delay();
    ui.stdin.write('\x16');
    await waitFor(() => /Clipboard image · 240×120/.test(ui.lastFrame() || ''));
    ui.stdin.write('\x10');
    await waitFor(() => /\u{10EEEE}/u.test(ui.lastFrame() || ''));
    const transmit = ui.frames.find((frame) => frame.startsWith('\x1b_Ga=T,U=1,f=100'));
    assert.ok(transmit, 'the PNG is transmitted with a virtual placement');
    const id = /i=(\d+)/.exec(transmit!)![1];
    ui.stdin.write('\x1b');
    await waitFor(() => ui.frames.some((frame) => frame === `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`));
    assert.ok(existsSync(photo), 'non-clipboard files are never deleted');
  } finally {
    await f.close();
  }
});

test('pasted clipboard images are deleted after sending or discarding', async () => {
  const f = await fixture();
  try {
    const photo = await f.client.download(f.store.message({ remoteJid: DEMO_JID, id: 'photo' })!);
    mkdirSync(join(f.dir, 'media'), { recursive: true });
    let count = 0;
    const clipboard = async () => {
      const path = join(f.dir, 'media', `clipboard-test-${count++}.png`);
      copyFileSync(photo, path);
      return { type: 'image' as const, path, width: 240, height: 120, bytes: 100 };
    };
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
    ui.stdin.write('\x16');
    await waitFor(() => /Clipboard image/.test(ui.lastFrame() || ''));
    const first = join(f.dir, 'media', 'clipboard-test-0.png');
    assert.ok(existsSync(first));
    ui.stdin.write('\x1b');
    await waitFor(() => !existsSync(first));
    ui.stdin.write('\x16');
    await waitFor(() => /Clipboard image/.test(ui.lastFrame() || ''));
    const second = join(f.dir, 'media', 'clipboard-test-1.png');
    ui.stdin.write('\r');
    await waitFor(() => /Image sent/.test(ui.lastFrame() || ''));
    await waitFor(() => !existsSync(second));
  } finally {
    await f.close();
  }
});
