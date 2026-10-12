import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type makeWASocket from '@whiskeysockets/baileys';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { WhatsAppClient } from '../src/client.js';
import { Store } from '../src/store.js';
import { archiveAccount, finishAccountReset } from '../src/accounts.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 40));

test('reopening a linked session tracks pending chats, history downloads, contact sync, and disconnection independently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-sync-'));
  const store = new Store(':memory:');
  let config: any;
  let finishQuery!: (value: any) => void;
  const fake: any = {
    ev: new EventEmitter(),
    end: () => {},
    query: () =>
      new Promise((resolve) => {
        finishQuery = resolve;
      }),
    resyncAppState: async () => {},
  };
  const factory = ((options: any) => {
    config = options;
    fake.authState = options.auth;
    return fake;
  }) as typeof makeWASocket;
  const client = new WhatsAppClient(store, dir, undefined, undefined, factory);
  try {
    await client.connect();
    fake.ev.emit('creds.update', { me: { id: '123:1@s.whatsapp.net' }, accountSyncCounter: 1 });
    await tick();
    fake.ev.emit('connection.update', { connection: 'open' });
    assert.equal(client.state.sync?.chats, 'waiting');
    fake.ev.emit('connection.update', { receivedPendingNotifications: true });
    assert.equal(client.state.sync?.chats, 'synced');
    config.shouldSyncHistoryMessage({ syncType: 0 });
    assert.equal(
      client.state.sync?.chats,
      'synced',
      'Synthetic SDK probes must not start a history download',
    );
    config.shouldSyncHistoryMessage({ syncType: 0, directPath: '/test-history' });
    assert.equal(client.state.sync?.chats, 'syncing');
    fake.ev.emit('messaging-history.status', { syncType: 0, status: 'complete', explicit: true });
    assert.equal(client.state.sync?.chats, 'syncing');
    fake.ev.emit('messaging-history.set', { syncType: 0, chats: [], contacts: [], messages: [] });
    assert.equal(client.state.sync?.chats, 'synced');
    const contacts = client.syncContacts();
    assert.equal(client.state.sync?.contacts, 'syncing');
    assert.equal(client.state.sync?.chats, 'synced');
    finishQuery({ tag: 'iq', attrs: {}, content: [{ tag: 'sync', attrs: {}, content: [] }] });
    await contacts;
    assert.equal(client.state.sync?.contacts, 'synced');
    fake.query = async () => {
      throw new Error('Snapshot unavailable');
    };
    await assert.rejects(client.syncContacts(), /Snapshot unavailable/);
    assert.equal(client.state.sync?.contacts, 'error');
    fake.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });
    assert.equal(client.state.sync, undefined);
  } finally {
    await client.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('intentional logout unlinks once, archives account data, and offers a fresh QR without mixing accounts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-logout-'));
  const store = new Store(join(dir, 'history.sqlite'));
  const sockets: any[] = [];
  const configs: any[] = [];
  let logouts = 0;
  const factory = ((config: any) => {
    const socket = {
      ev: new EventEmitter(),
      end: () => {},
      logout: async () => {
        logouts++;
        socket.ev.emit('connection.update', {
          connection: 'close',
          lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
        });
      },
    };
    sockets.push(socket);
    configs.push(config);
    return socket;
  }) as typeof makeWASocket;
  const client = new WhatsAppClient(store, dir, undefined, undefined, factory);
  try {
    await client.connect();
    sockets[0].ev.emit('creds.update', {
      me: { id: '123:1@s.whatsapp.net', name: 'Previous account' },
    });
    sockets[0].ev.emit('connection.update', { connection: 'open' });
    store.ingest({
      key: { remoteJid: '456@s.whatsapp.net', id: 'old' },
      message: { conversation: 'Keep in archive' },
    });
    store.contacts([{ id: '456@s.whatsapp.net', name: 'Old contact' }]);
    store.saveDraft('456@s.whatsapp.net', 'Old draft');
    mkdirSync(join(dir, 'media'));
    writeFileSync(join(dir, 'media', 'photo.jpg'), 'old attachment');
    await client.logout();
    assert.equal(logouts, 1);
    assert.equal(client.state.connection, 'logged-out');
    assert.equal(client.state.linked, false);
    assert.equal(client.state.user, undefined);
    assert.deepEqual(store.stats(), { chats: 0, messages: 0 });
    assert.equal(store.contactName('456@s.whatsapp.net'), undefined);
    assert.equal(store.draft('456@s.whatsapp.net'), '');
    assert.equal(existsSync(join(dir, 'auth')), false);
    assert.equal(existsSync(join(dir, 'media')), false);
    const folder = readdirSync(dir).find((f) => f.startsWith('account-backup-'))!;
    assert.ok(folder);
    const archived = new Store(join(dir, folder, 'history.sqlite'));
    try {
      assert.equal(archived.count('456@s.whatsapp.net'), 1);
      assert.equal(archived.draft('456@s.whatsapp.net'), 'Old draft');
    } finally {
      archived.close();
    }
    assert.equal(readFileSync(join(dir, folder, 'media', 'photo.jpg'), 'utf8'), 'old attachment');
    await client.useQr();
    assert.equal(sockets.length, 2);
    assert.equal(configs[1].auth.creds.me, undefined);
    sockets[1].ev.emit('connection.update', { qr: 'new-account-qr' });
    assert.equal(client.state.qr, 'new-account-qr');
    sockets[0].ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: '456@s.whatsapp.net', id: 'late-old' },
          message: { conversation: 'Old socket' },
        },
      ],
    });
    assert.equal(store.stats().messages, 0);
  } finally {
    await client.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed unlink preserves active data; interrupted local reset resumes before another login', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-account-reset-'));
  const store = new Store(join(dir, 'history.sqlite'));
  try {
    store.ingest({
      key: { remoteJid: '123@s.whatsapp.net', id: 'keep' },
      message: { conversation: 'Archived history' },
    });
    mkdirSync(join(dir, 'auth'));
    writeFileSync(join(dir, 'auth', 'creds.json'), '{}');
    await assert.rejects(
      archiveAccount(store, dir, async () => {
        throw new Error('Unlink failed');
      }),
      /Unlink failed/,
    );
    assert.equal(store.stats().messages, 1);
    assert.equal(existsSync(join(dir, 'auth')), true);
    const folder = readdirSync(dir).find((f) => f.startsWith('account-backup-'))!;
    writeFileSync(join(dir, 'account-reset.json'), JSON.stringify({ folder }));
    await finishAccountReset(store, dir);
    assert.equal(store.stats().messages, 0);
    assert.equal(existsSync(join(dir, 'account-reset.json')), false);
    assert.equal(existsSync(join(dir, folder, 'auth', 'creds.json')), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Baileys adapter handles QR/pairing, history, incoming deduplication, updates and logout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-client-'));
  const store = new Store(':memory:');
  const ev = new EventEmitter();
  const calls: { method: string; args: any[] }[] = [];
  let config: any;
  const fake: any = {
    ev,
    user: { id: '123@s.whatsapp.net', name: 'Test' },
    requestPairingCode: async (phone: string) => {
      calls.push({ method: 'pair', args: [phone] });
      return 'ABCDEFGH';
    },
    readMessages: async (keys: any[]) => {
      calls.push({ method: 'read', args: keys });
    },
    sendMessage: async (...args: any[]) => {
      calls.push({ method: 'send', args });
      return {
        key: { remoteJid: args[0], id: 'sent', fromMe: true },
        message: { conversation: args[1].text },
        status: 2,
      };
    },
    end: () => {},
    logout: async () => {},
    fetchMessageHistory: async (...args: any[]) => {
      calls.push({ method: 'history', args });
    },
  };
  const factory = ((options: any) => {
    config = options;
    return fake;
  }) as typeof makeWASocket;
  const client = new WhatsAppClient(store, dir, undefined, undefined, factory);
  const jid = '919876543210@s.whatsapp.net';
  const key = { remoteJid: jid, id: 'in', fromMe: false };
  try {
    await client.connect();
    assert.equal(config.syncFullHistory, true);
    assert.equal(config.browser[1], 'Chrome');
    assert.equal(config.shouldSyncHistoryMessage({}), true);
    ev.emit('connection.update', { qr: 'terminal-qr' });
    await tick();
    assert.equal(client.state.qr, 'terminal-qr');
    await client.requestPairing('+91 98765 43210');
    assert.equal(client.state.pairingCode, 'ABCDEFGH');
    assert.equal(calls[0].args[0], '919876543210');
    client.useQr();
    assert.equal(client.state.qr, 'terminal-qr');
    assert.equal(client.state.pairingCode, undefined);
    ev.emit('connection.update', { connection: 'open' });
    await tick();
    assert.equal(client.state.connection, 'open');
    ev.emit('messaging-history.set', {
      chats: [{ id: jid, name: 'Maya', unreadCount: 0 }],
      contacts: [],
      messages: [
        {
          key: { ...key, id: 'past' },
          messageTimestamp: 1,
          message: { conversation: 'Past conversation' },
        },
      ],
      progress: 100,
    });
    await tick();
    assert.equal(store.stats().messages, 1);
    assert.equal(client.state.historyProgress, 100);
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key, messageTimestamp: 2, message: { conversation: 'Hello' } }],
    });
    ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key, messageTimestamp: 2, message: { conversation: 'Hello' } }],
    });
    await tick();
    assert.equal(store.chat(jid)?.unread, 1);
    await client.read(jid, store.history(jid, 1));
    assert.equal(calls.find((c) => c.method === 'read')?.args[0].id, 'in');
    assert.equal(store.message(key)?.localRead, true);
    await client.send(jid, 'Quoted reply', store.message(key));
    assert.equal(calls.find((c) => c.method === 'send')?.args[2].quoted.key.id, 'in');
    ev.emit('message-receipt.update', [
      {
        key: { remoteJid: jid, id: 'sent', fromMe: true },
        receipt: { userJid: jid, readTimestamp: 10 },
      },
    ]);
    await tick();
    assert.equal(store.message({ remoteJid: jid, id: 'sent', fromMe: true })?.status, 'read');
    await client.history(jid, store.history(jid, 1, 2)[0]);
    assert.equal(calls.find((c) => c.method === 'history')?.args[0], 50);
    const protectedMessage = { ...store.message(key)!, kind: 'image' as const, viewOnce: true };
    await assert.rejects(client.download(protectedMessage), /View-once/);
    ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });
    await tick();
    assert.equal(client.state.connection, 'logged-out');
    await assert.rejects(client.send(jid, 'No accidental send'), /offline/);
  } finally {
    await client.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paired sessions retain their Chrome identity when restored from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-client-'));
  const store = new Store(':memory:');
  let config: any;
  const fake: any = { ev: new EventEmitter(), end: () => {} };
  const factory = ((options: any) => {
    config = options;
    return fake;
  }) as typeof makeWASocket;
  const first = new WhatsAppClient(store, dir, undefined, undefined, factory);
  let second: WhatsAppClient | undefined;
  try {
    await first.connect();
    assert.equal(config.browser[1], 'Chrome');
    config.auth.creds.me = { id: '123:1@s.whatsapp.net', name: 'Me' };
    fake.ev.emit('creds.update', {});
    await first.stop();
    fake.ev = new EventEmitter();
    second = new WhatsAppClient(store, dir, undefined, undefined, factory);
    await second.connect();
    assert.equal(config.browser[1], 'Chrome');
    assert.equal(second.state.linked, true);
  } finally {
    await first.stop();
    await second?.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('relink archives rejected credentials and keeps cached history and drafts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-relink-'));
  const store = new Store(join(dir, 'history.sqlite'));
  const sockets: any[] = [];
  const configs: any[] = [];
  const factory = ((config: any) => {
    const socket = { ev: new EventEmitter(), end: () => {} };
    sockets.push(socket);
    configs.push(config);
    return socket;
  }) as typeof makeWASocket;
  const client = new WhatsAppClient(store, dir, undefined, undefined, factory);
  try {
    store.ingest({
      key: { remoteJid: '123@s.whatsapp.net', id: 'keep' },
      message: { conversation: 'History to keep' },
    });
    store.saveDraft('123@s.whatsapp.net', 'Saved draft');
    await client.connect();
    sockets[0].ev.emit('creds.update', { me: { id: '123:1@s.whatsapp.net' } });
    sockets[0].ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    });
    await client.useQr();
    const backup = readdirSync(dir).find((name) => name.startsWith('auth-backup-'))!;
    assert.ok(backup);
    assert.equal(
      JSON.parse(readFileSync(join(dir, backup, 'creds.json'), 'utf8')).me.id,
      '123:1@s.whatsapp.net',
    );
    assert.equal(sockets.length, 2);
    assert.equal(configs[1].auth.creds.me, undefined);
    assert.equal(store.stats().messages, 1);
    assert.equal(store.draft('123@s.whatsapp.net'), 'Saved draft');
    assert.equal(client.state.linked, false);
    assert.equal(client.state.connection, 'connecting');
    sockets[0].ev.emit('connection.update', { qr: 'expired-qr' });
    assert.equal(client.state.qr, undefined);
    sockets[1].ev.emit('connection.update', { qr: 'fresh-qr' });
    assert.equal(client.state.qr, 'fresh-qr');
  } finally {
    await client.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('QR scan persists credentials before the mandatory restart, clears expired QR, and reconnects as Chrome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-pairing-'));
  const store = new Store(':memory:');
  const sockets: any[] = [];
  const configs: any[] = [];
  const factory = ((config: any) => {
    const socket = { ev: new EventEmitter(), end: () => {} };
    sockets.push(socket);
    configs.push(config);
    return socket;
  }) as typeof makeWASocket;
  const client = new WhatsAppClient(store, dir, undefined, undefined, factory);
  try {
    await client.connect();
    await assert.rejects(client.requestPairing('+919876543210'), /fresh login QR/);
    const first = sockets[0];
    first.ev.emit('connection.update', { qr: 'old-qr' });
    assert.equal(client.state.qr, 'old-qr');
    first.ev.emit('creds.update', {
      me: { id: '123:1@s.whatsapp.net' },
      account: { details: Buffer.from('test') },
    });
    first.ev.emit('connection.update', { isNewLogin: true, qr: undefined });
    assert.equal(client.state.linked, true);
    assert.equal(client.state.qr, undefined);
    assert.match(client.state.notice, /finishing login/);
    first.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    });
    assert.match(client.state.notice, /QR accepted/);
    client.useQr();
    assert.equal(client.state.connection, 'reconnecting');
    assert.equal(client.state.qr, undefined);
    const deadline = Date.now() + 3000;
    while (sockets.length < 2 && Date.now() < deadline) await tick();
    assert.equal(sockets.length, 2);
    assert.equal(configs[1].auth.creds.me.id, '123:1@s.whatsapp.net');
    assert.equal(configs[0].browser[1], 'Chrome');
    assert.deepEqual(configs[1].browser, configs[0].browser);
    assert.equal(
      configs[1].auth.creds.registered,
      false,
      'QR pairing must not depend on the phone-code registered flag',
    );
    sockets[1].ev.emit('connection.update', { connection: 'open' });
    first.ev.emit('connection.update', { qr: 'stale-socket-qr' });
    assert.equal(client.state.connection, 'open');
    assert.equal(client.state.qr, undefined);
    await assert.rejects(client.requestPairing('+919876543210'), /fresh login QR/);
  } finally {
    await client.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
