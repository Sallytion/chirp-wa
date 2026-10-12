import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import type { WAMessage } from '@whiskeysockets/baileys';
import { proto } from '@whiskeysockets/baileys';
import { safeText, tokens, jidFor, profileDir } from '../src/util.js';
import { normalize } from '../src/messages.js';
import { transcript } from '../src/ui/layout.js';

const jid = '919876543210@s.whatsapp.net';
const raw = (id: string, time = 100, fromMe = false): WAMessage => ({
  key: { remoteJid: jid, id, fromMe },
  messageTimestamp: time,
  pushName: 'Maya',
  message: { conversation: `hello ${id}` },
  status: 2,
});

test('cached inbox counts stay correct across writes, rollback, account reset, and archive changes', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.stats(), { chats: 0, messages: 0 });
    assert.equal(store.sectionCount('chats'), 0);
    store.ingest(raw('first'));
    assert.deepEqual(store.stats(), { chats: 1, messages: 1 });
    assert.equal(store.sectionCount('chats'), 1);
    assert.throws(() =>
      store.transaction(() => {
        store.ingest(raw('rollback'));
        assert.equal(store.stats().messages, 2);
        throw new Error('rollback');
      }),
    );
    assert.equal(store.stats().messages, 1);
    assert.equal(store.count(jid), 1);
    store.upsertChat({ jid, archived: true });
    assert.equal(store.sectionCount('chats'), 0);
    store.upsertChat({ jid, archived: false });
    assert.equal(store.sectionCount('chats'), 1);
    store.clearAccount();
    assert.deepEqual(store.stats(), { chats: 0, messages: 0 });
    assert.equal(store.sectionCount('chats'), 0);
  } finally {
    store.close();
  }
});

test('history persists, paginates chronologically and deduplicates notifications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-test-'));
  const path = join(dir, 'history.sqlite');
  let store = new Store(path);
  try {
    store.transaction(() => {
      for (let i = 0; i < 105; i++) store.ingest(raw(`m${i}`, i + 1));
    });
    assert.equal(store.count(jid), 105);
    assert.deepEqual(
      store.history(jid, 3).map((m) => m.timestamp),
      [103, 104, 105],
    );
    assert.deepEqual(
      store.history(jid, 3, 3).map((m) => m.timestamp),
      [100, 101, 102],
    );
    store.ingest(raw('fresh', 200), true);
    store.ingest(raw('fresh', 200), true);
    assert.equal(store.chat(jid)?.unread, 1);
    store.saveDraft(jid, 'Draft 🌅');
    store.close();
    store = new Store(path);
    assert.equal(store.count(jid), 106);
    assert.equal(store.draft(jid), 'Draft 🌅');
    assert.equal(store.search('hello fresh', jid)[0]?.id, 'fresh');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipts advance monotonically; one group reader does not imply everybody read', () => {
  const store = new Store(':memory:');
  try {
    const m = raw('out', 100, true);
    store.ingest(m);
    store.receipt(m.key, jid, { read: 105 });
    store.patch(m.key, { status: 'delivered' });
    assert.equal(store.message(m.key)?.status, 'read');
    const group = {
      ...raw('group', 100, true),
      key: { remoteJid: '123@g.us', id: 'group', fromMe: true },
    };
    store.ingest(group);
    store.receipt(group.key, jid, { read: 105 });
    assert.equal(store.message(group.key)?.status, 'sent');
    assert.equal(store.message(group.key)?.receipts[jid].read, 105);
  } finally {
    store.close();
  }
});

test('read receipts only mark supplied messages and preserve server unread count', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 10; i++) store.ingest(raw(`m${i}`, i), true);
    store.readLocal(jid, store.history(jid, 2));
    assert.equal(store.chat(jid)?.unread, 8);
    assert.equal(store.message(raw('m0').key)?.localRead, false);
    assert.equal(store.message(raw('m9').key)?.localRead, true);
    store.readLocal(jid, store.history(jid, 2));
    assert.equal(store.chat(jid)?.unread, 8);
  } finally {
    store.close();
  }
});

test('LID mapping merges chats without losing messages or receipt state', () => {
  const store = new Store(':memory:');
  try {
    store.ingest({ ...raw('lid'), key: { remoteJid: '999@lid', id: 'lid', fromMe: false } }, true);
    store.contacts([{ id: jid, name: 'Known Maya', lid: '999@lid', phoneNumber: jid }]);
    assert.equal(store.resolve('999@lid'), jid);
    assert.equal(store.count(jid), 1);
    assert.equal(store.message({ remoteJid: '999@lid', id: 'lid', fromMe: false })?.jid, jid);
    assert.equal(store.chats().length, 1);
    assert.equal(store.name(jid), 'Known Maya');
  } finally {
    store.close();
  }
});

test('edit/revoke protocol events and reaction removals update the original', () => {
  const store = new Store(':memory:');
  try {
    const m = raw('original', 1, true);
    store.ingest(m);
    store.ingest({
      key: { remoteJid: jid, id: 'edit', fromMe: true },
      message: {
        protocolMessage: {
          key: m.key,
          type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
          editedMessage: { conversation: 'replacement' },
        },
      },
    });
    assert.equal(store.message(m.key)?.text, 'replacement');
    assert.equal(store.message(m.key)?.edited, true);
    store.reaction(m.key, 'You', '💚');
    store.reaction(m.key, 'You', '');
    assert.deepEqual(store.message(m.key)?.reactions, {});
    store.ingest({
      key: { remoteJid: jid, id: 'revoke', fromMe: true },
      message: { protocolMessage: { key: m.key, type: proto.Message.ProtocolMessage.Type.REVOKE } },
    });
    assert.equal(store.message(m.key)?.deleted, true);
  } finally {
    store.close();
  }
});

test('binary media fields survive storage and failed transactions roll back', () => {
  const store = new Store(':memory:');
  try {
    store.ingest({
      key: { remoteJid: jid, id: 'image' },
      message: { imageMessage: { mediaKey: Buffer.from([1, 2, 3]), mimetype: 'image/jpeg' } },
    });
    assert.deepEqual(
      Buffer.from(
        store.message({ remoteJid: jid, id: 'image' })!.raw.message!.imageMessage!.mediaKey!,
      ),
      Buffer.from([1, 2, 3]),
    );
    assert.throws(() =>
      store.transaction(() => {
        store.ingest(raw('rolled-back'));
        throw new Error('fail');
      }),
    );
    assert.equal(store.message(raw('rolled-back').key), undefined);
  } finally {
    store.close();
  }
});

test('poll vote deltas preserve other voters and allow vote removal', () => {
  const store = new Store(':memory:');
  try {
    const key = { remoteJid: jid, id: 'poll', fromMe: true };
    store.ingest({
      key,
      message: {
        pollCreationMessageV3: {
          name: 'Dinner?',
          options: [{ optionName: 'Pizza' }, { optionName: 'Pasta' }],
        },
      },
    });
    const vote = (user: string, selections: Uint8Array[]) => ({
      pollUpdateMessageKey: { remoteJid: jid, participant: user, fromMe: false, id: user },
      vote: { selectedOptions: selections },
    });
    store.updateRaw(key, { pollUpdates: [vote('first@s.whatsapp.net', [Buffer.from('pizza')])] });
    store.updateRaw(key, { pollUpdates: [vote('second@s.whatsapp.net', [Buffer.from('pasta')])] });
    assert.equal(store.message(key)?.raw.pollUpdates?.length, 2);
    store.updateRaw(key, { pollUpdates: [vote('first@s.whatsapp.net', [])] });
    assert.equal(store.message(key)?.raw.pollUpdates?.length, 1);
  } finally {
    store.close();
  }
});

test('terminal escapes, SQL wildcard searches, quoted Windows paths and profile traversal', () => {
  assert.equal(safeText('\x1b[31mred\x1b[0m\x1b]52;c;secret\x07'), 'red');
  assert.deepEqual(tokens('/attach "C:\\My Files\\photo.jpg" "hello world"'), [
    '/attach',
    'C:\\My Files\\photo.jpg',
    'hello world',
  ]);
  assert.throws(() => tokens('/attach "bad'));
  assert.throws(() => profileDir(undefined, '../outside'));
  assert.equal(jidFor('+91 98765 43210'), jid);
  assert.throws(() => jidFor('not-a-number'));
  const store = new Store(':memory:');
  try {
    store.ingest(raw('100%'));
    store.ingest(raw('100x'));
    assert.equal(store.search('100%').length, 1);
  } finally {
    store.close();
  }
});

test('chats and groups stay together while channels, directory searches, and global searches stay separate', () => {
  const store = new Store(':memory:');
  try {
    for (const id of [jid, '123@g.us', '123@newsletter', '456@newsletter', '789@broadcast']) {
      store.upsertChat({ jid: id, name: 'Shared name', archived: id === '456@newsletter' });
      store.ingest(
        { key: { remoteJid: id, id: 'update' }, message: { conversation: 'Shared search text' } },
        true,
      );
    }
    store.contacts([{ id: '123@newsletter', name: 'Channel title' }]);
    assert.deepEqual(new Set(store.chats().map((c) => c.jid)), new Set([jid, '123@g.us']));
    assert.deepEqual(
      store.chats('', 'all', 'channels').map((c) => c.jid),
      ['123@newsletter'],
    );
    assert.equal(store.chats('', 'archived', 'channels')[0].jid, '456@newsletter');
    assert.ok(
      store
        .directory()
        .every((c) => !c.jid.endsWith('@newsletter') && !c.jid.endsWith('@broadcast')),
    );
    assert.ok(store.directory('', 'channels').every((c) => c.jid.endsWith('@newsletter')));
    assert.equal(store.search('Shared search text').length, 2);
    assert.equal(store.search('Shared search text', undefined, 'channels').length, 2);
    assert.equal(store.search('Shared search text', '123@newsletter').length, 1);
    assert.equal(store.sectionCount('channels'), 1);
  } finally {
    store.close();
  }
});

test('saved contact names survive profile updates, LID mapping, and device IDs', () => {
  const store = new Store(':memory:');
  try {
    store.contacts([{ id: '999@lid', name: 'Saved Maya' }]);
    store.saveDraft('999@lid', 'Keep my draft');
    store.alias('999@lid', jid);
    store.ingest({ ...raw('new'), pushName: 'Public profile' });
    store.contacts([
      { id: jid, notify: 'New profile' },
      { id: jid, verifiedName: 'Business name' },
    ]);
    assert.equal(store.name(jid), 'Saved Maya');
    assert.equal(store.name('999@lid'), 'Saved Maya');
    assert.equal(store.contactName('919876543210:7@s.whatsapp.net'), 'Saved Maya');
    assert.equal(store.chat(jid)?.name, 'Saved Maya');
    assert.equal(store.draft(jid), 'Keep my draft');
    assert.equal(store.senderName(store.message(raw('new').key)!), 'Saved Maya');
    store.contacts([{ id: jid, name: 'Renamed contact' }]);
    assert.equal(store.name(jid), 'Renamed contact');
    store.contacts([
      { id: '123@s.whatsapp.net', notify: 'A profile' },
      { id: '123@s.whatsapp.net', verifiedName: 'Verified business' },
    ]);
    store.contacts([{ id: '123@s.whatsapp.net', notify: 'Another profile' }]);
    assert.equal(store.name('123@s.whatsapp.net'), 'Verified business');
    store.ingest({
      key: { remoteJid: '456@s.whatsapp.net', id: 'own', fromMe: true },
      pushName: 'My own name',
      message: { conversation: 'Outgoing' },
    });
    assert.equal(store.name('456@s.whatsapp.net'), '456');
    store.upsertChat({ jid: '123@g.us', name: 'Original group' });
    store.contacts([{ id: '123@g.us', name: 'Original group' }]);
    store.upsertChat({ jid: '123@g.us', name: 'Renamed group' });
    assert.equal(store.name('123@g.us'), 'Renamed group');
  } finally {
    store.close();
  }
});

test('legacy database upgrade recovers aliased contact names and incoming sender names without relinking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-migration-'));
  const path = join(dir, 'history.sqlite');
  let store = new Store(path);
  try {
    store.alias('999@lid', jid);
    store.db
      .prepare('INSERT INTO contacts(jid,name,name_rank) VALUES(?,?,?)')
      .run('999@lid', 'Legacy saved name', 3);
    store.ingest({
      key: { remoteJid: '123@g.us', participant: '456@s.whatsapp.net', id: 'group' },
      pushName: 'Recovered sender',
      message: { conversation: 'Keep this message' },
    });
    store.db.prepare('DELETE FROM contacts WHERE jid=?').run('456@s.whatsapp.net');
    const legacy = normalize({
      key: { remoteJid: '777@lid', remoteJidAlt: '888@s.whatsapp.net', id: 'legacy-alias' },
      pushName: 'Legacy alternate',
      message: { conversation: 'Merge during old contact migration' },
    })!;
    store.db
      .prepare('INSERT INTO messages(jid,id,from_me,timestamp,text,data) VALUES(?,?,?,?,?,?)')
      .run(legacy.jid, legacy.id, 0, legacy.timestamp, legacy.text, JSON.stringify(legacy));
    store.upsertChat({ jid: legacy.jid });
    store.db.exec(
      'DROP INDEX messages_visible_history; ALTER TABLE messages DROP COLUMN visible; ALTER TABLE contacts DROP COLUMN name_rank; PRAGMA user_version=1',
    );
    store.close();
    store = new Store(path);
    assert.equal(store.name(jid), 'Legacy saved name');
    assert.equal(store.contactName('456@s.whatsapp.net'), 'Recovered sender');
    assert.equal(store.count('123@g.us'), 1);
    assert.equal(store.name('123@g.us'), '123');
    assert.equal(store.resolve('777@lid'), '888@s.whatsapp.net');
    assert.equal(store.count('888@s.whatsapp.net'), 1);
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 4);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('background security events cannot crowd the inbox or trigger unread messages, search, or receipts', () => {
  const store = new Store(':memory:');
  const stub = proto.WebMessageInfo.StubType;
  const group = '123@g.us';
  const phantom = '456@lid';
  try {
    store.ingest(raw('actual', 10), true);
    for (const [id, target, type] of [
      ['identity', jid, stub.E2E_IDENTITY_CHANGED],
      ['encryption', phantom, stub.E2E_ENCRYPTED],
      ['device', group, stub.E2E_DEVICE_CHANGED],
      ['cached-enum', phantom, 'E2E_IDENTITY_CHANGED'],
    ] as const) {
      const event = {
        key: { remoteJid: target, id, fromMe: true },
        messageTimestamp: 1000,
        messageStubType: type,
        messageStubParameters: ['987@lid'],
      } as WAMessage;
      assert.equal(store.ingest(event, true), false);
      assert.equal(store.message(event.key), undefined);
      store.upsertWAChat({ id: target, conversationTimestamp: 1000 });
    }
    assert.deepEqual(
      store.chats().map((c) => c.jid),
      [jid],
    );
    assert.equal(store.sectionCount('chats'), 1);
    assert.equal(store.chat(jid)?.preview, 'hello actual');
    assert.equal(store.chat(jid)?.timestamp, 10);
    assert.equal(store.chat(jid)?.unread, 1);
    assert.equal(store.count(jid), 1);
    assert.equal(store.search('WhatsApp event').length, 0);
    assert.equal(store.stats().messages, 1);
    assert.equal(
      Number(store.db.prepare('SELECT count(*) AS n FROM messages WHERE visible=0').get()?.n),
      4,
    );
    const event = {
      key: { remoteJid: group, id: 'join', fromMe: true },
      messageTimestamp: 2000,
      messageStubType: stub.GROUP_PARTICIPANT_ADD,
    };
    store.ingest(event, true);
    const notice = store.message(event.key)!;
    assert.equal(notice.kind, 'system');
    assert.equal(notice.localRead, true);
    assert.equal(store.chat(group)?.unread, 0);
    const rendered = transcript([notice], 80)
      .map((l) => l.text)
      .join('\n');
    assert.match(rendered, /Participant added/);
    assert.doesNotMatch(rendered, /You|✓|WhatsApp event/);
    // A real text payload remains visible even when accompanied by a stub flag.
    store.ingest({ ...raw('real-payload', 3000), messageStubType: stub.E2E_IDENTITY_CHANGED });
    assert.equal(store.count(jid), 2);
  } finally {
    store.close();
  }
});

test('v3 cached protobuf enum names are repaired without retaining generic notification noise', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-enum-migration-'));
  const path = join(dir, 'history.sqlite');
  let store = new Store(path);
  try {
    store.ingest(raw('keep', 1));
    const event = normalize(
      { key: { remoteJid: '456@lid', id: 'cached' }, messageTimestamp: 100, messageStubType: 38 },
      true,
    )!;
    event.raw.messageStubType = 'E2E_IDENTITY_CHANGED' as any;
    event.text = 'WhatsApp notification';
    store.db
      .prepare('INSERT INTO messages(jid,id,from_me,timestamp,text,data) VALUES(?,?,?,?,?,?)')
      .run(event.jid, event.id, 0, event.timestamp, event.text, JSON.stringify(event));
    store.upsertChat({ jid: event.jid, timestamp: 100, preview: event.text });
    store.db.exec('PRAGMA user_version=3');
    store.close();
    store = new Store(path);
    assert.equal(store.sectionCount('chats'), 1);
    assert.equal(store.count(event.jid), 0);
    assert.equal(store.count(jid), 1);
    assert.equal(store.search('WhatsApp notification').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('existing event noise is hidden reversibly and previews, unread counts, and sorting recover during upgrade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-events-'));
  const path = join(dir, 'history.sqlite');
  let store = new Store(path);
  const phantom = '456@lid';
  try {
    store.ingest(raw('old-message', 10), true);
    store.ingest({
      ...raw('newer-message', 20),
      key: { remoteJid: '123@s.whatsapp.net', id: 'newer-message' },
    });
    for (const target of [jid, phantom]) {
      const event = normalize(
        { key: { remoteJid: target, id: 'noise' }, messageTimestamp: 1000, messageStubType: 38 },
        true,
      )!;
      event.text = 'WhatsApp event 38: 999@lid';
      event.localRead = false;
      store.db
        .prepare('INSERT INTO messages(jid,id,from_me,timestamp,text,data) VALUES(?,?,?,?,?,?)')
        .run(target, event.id, 0, 1000, event.text, JSON.stringify(event));
      store.upsertChat({
        jid: target,
        timestamp: 1000,
        preview: event.text,
        unread: target === jid ? 2 : 1,
      });
    }
    store.saveDraft(jid, 'Preserve draft');
    store.db.exec(
      'DROP INDEX messages_visible_history; ALTER TABLE messages DROP COLUMN visible; PRAGMA user_version=2',
    );
    store.close();
    store = new Store(path);
    assert.deepEqual(
      store.chats().map((c) => c.jid),
      ['123@s.whatsapp.net', jid],
    );
    assert.equal(store.chat(jid)?.timestamp, 10);
    assert.equal(store.chat(jid)?.preview, 'hello old-message');
    assert.equal(store.chat(jid)?.unread, 1);
    assert.equal(store.chat(phantom)?.unread, 0);
    assert.equal(store.count(jid), 1);
    assert.equal(store.draft(jid), 'Preserve draft');
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM messages').get()?.n), 4);
    assert.equal(store.search('WhatsApp event').length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
