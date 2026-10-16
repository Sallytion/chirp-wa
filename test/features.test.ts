import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type makeWASocket from '@whiskeysockets/baileys';
import { decryptPollVote, proto } from '@whiskeysockets/baileys';
import { Store, muteSeconds } from '../src/store.js';
import { WhatsAppClient } from '../src/client.js';
import { isMuted } from '../src/types.js';
import { isExecutableFile, linksIn, safeText, tokens } from '../src/util.js';
import { normalize, pollTally, quotedOf, vcardText } from '../src/messages.js';
import {
  displayMentions,
  insertMention,
  mentionToken,
  mentionsIn,
  searchParticipants,
} from '../src/mentions.js';
import { clearMediaCache, mediaCacheUsage, openExternally, saveDownload } from '../src/media.js';
import { muteDuration, command } from '../src/commands.js';
import { transcript } from '../src/ui/layout.js';
import { focusEvent } from '../src/ui/input.js';
import { detectGraphics, kittyDelete, kittyPlaceholders, kittyTransmit } from '../src/kitty.js';

const jid = '15550001111@s.whatsapp.net';
const raw = (id: string, text: string, timestamp = 1_700_000_000, remoteJid = jid) => ({
  key: { remoteJid, id, fromMe: false },
  messageTimestamp: timestamp,
  message: { conversation: text },
});

test('slash command arguments keep apostrophes, and quotes still group paths', () => {
  assert.deepEqual(tokens("/search don't"), ['/search', "don't"]);
  assert.deepEqual(tokens("/group subject Mom's party"), ['/group', 'subject', "Mom's", 'party']);
  assert.deepEqual(tokens('/search "it\'s fine"'), ['/search', "it's fine"]);
  assert.deepEqual(tokens("/attach 'C:\\My Files\\a.png'"), ['/attach', 'C:\\My Files\\a.png']);
  assert.throws(() => tokens('/attach "unclosed'));
});

test('untrusted text loses bidi overrides; links and executable attachments are recognised', () => {
  assert.equal(safeText('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(safeText('\u2067abc\u2069'), 'abc');
  assert.deepEqual(
    linksIn('See https://example.com/a), and http://x.test/b. Again https://example.com/a'),
    ['https://example.com/a', 'http://x.test/b'],
  );
  assert.deepEqual(linksIn('javascript:alert(1) ftp://example.com'), []);
  for (const path of ['a.exe', 'B.JS', 'x.ps1', 'run.sh', 'x.hta', 'thing.lnk'])
    assert.ok(isExecutableFile(path), path);
  for (const path of ['a.pdf', 'b.jpg', 'notes.txt', 'archive.zip', 'file.bin'])
    assert.ok(!isExecutableFile(path), path);
});

test('opening attachments externally refuses executables and scripts', async () => {
  const opened: string[] = [];
  await assert.rejects(
    openExternally('/tmp/x.exe', (p) => opened.push(p)),
    /will not open \.exe/,
  );
  await assert.rejects(
    openExternally('/tmp/x.js', (p) => opened.push(p)),
    /will not open/,
  );
  await openExternally('/tmp/x.pdf', (p) => opened.push(p));
  assert.deepEqual(opened, ['/tmp/x.pdf']);
});

test('mute ends normalise to seconds; always is -1 and unmute clears it', () => {
  const now = Date.now();
  assert.equal(muteSeconds(null), 0);
  assert.equal(muteSeconds(-1), -1);
  assert.equal(muteSeconds(now + 3_600_000), Math.floor((now + 3_600_000) / 1000));
  assert.equal(muteSeconds(1_800_000_000), 1_800_000_000);
  assert.ok(isMuted({ muted: -1 }));
  assert.ok(isMuted({ muted: Math.floor(now / 1000) + 60 }));
  assert.ok(!isMuted({ muted: Math.floor(now / 1000) - 60 }));
  assert.ok(!isMuted({ muted: 0 }));
  assert.ok(isMuted({ muted: Number.MAX_SAFE_INTEGER }), 'older Chirp mutes stay muted');
  assert.equal(muteDuration('8h'), 28_800);
  assert.equal(muteDuration('1w'), 604_800);
  assert.equal(muteDuration('always'), -1);
  assert.equal(muteDuration('off'), null);
  assert.throws(() => muteDuration('soon'));

  const store = new Store(':memory:');
  try {
    store.upsertWAChat({ id: jid, muteEndTime: -1 } as any);
    assert.ok(isMuted(store.chat(jid)));
    store.upsertWAChat({ id: jid, name: 'Renamed' } as any);
    assert.ok(isMuted(store.chat(jid)), 'an absent field leaves the mute alone');
    store.upsertWAChat({ id: jid, muteEndTime: null } as any);
    assert.ok(!isMuted(store.chat(jid)), 'an explicit null unmutes');
    store.upsertWAChat({ id: jid, muteEndTime: now + 3_600_000 } as any);
    assert.ok(isMuted(store.chat(jid)));
    store.upsertWAChat({ id: jid, muteEndTime: now - 3_600_000 } as any);
    assert.ok(!isMuted(store.chat(jid)), 'expired mutes no longer silence the chat');
  } finally {
    store.close();
  }
});

test('trigram search matches substrings and Indic text, pages newest first, and tracks edits', () => {
  const store = new Store(':memory:');
  try {
    store.transaction(() => {
      for (let i = 0; i < 120; i++)
        store.ingest(
          raw(`n${String(i).padStart(3, '0')}`, `haystack needle number ${i}`, 1_700_000_000 + i),
        );
      store.ingest(raw('hindi', 'कल मिलते हैं दोस्त', 1_700_001_000));
      store.ingest(raw('other', 'nothing to see', 1_700_001_001, '15550002222@s.whatsapp.net'));
    });
    const first = store.search('needle', jid, 'chats', 50, 0);
    const second = store.search('needle', jid, 'chats', 50, 50);
    const third = store.search('needle', jid, 'chats', 50, 100);
    assert.deepEqual([first.length, second.length, third.length], [50, 50, 20]);
    assert.equal(first[0].id, 'n119');
    assert.equal(new Set([...first, ...second, ...third].map((m) => m.id)).size, 120);
    assert.equal(store.search('eedl').length, 100, 'mid-word substrings match');
    assert.equal(store.search('मिलते')[0]?.id, 'hindi');
    assert.equal(store.search('NEEDLE number 117', jid).length, 1, 'case-insensitive');
    assert.equal(store.search('number 7', jid).length, 11, 'substring semantics like LIKE');
    assert.equal(
      store.search('ne', jid, 'chats', 500).length,
      120,
      'short queries fall back to LIKE',
    );
    assert.equal(store.search('').length, 0);

    store.updateRaw(
      { remoteJid: jid, id: 'hindi', fromMe: false },
      { message: { conversation: 'edited text' } },
      true,
    );
    assert.equal(store.search('मिलते').length, 0, 'edits remove the old text from the index');
    assert.equal(store.search('edited text')[0]?.id, 'hindi');

    store.alias('999@lid', jid);
    assert.equal(store.search('edited text')[0]?.jid, jid);
    store.ingest(raw('lid', 'moved by alias merge', 1_700_002_000, '888@lid'));
    store.alias('888@lid', '15550002222@s.whatsapp.net');
    assert.equal(store.search('moved by alias')[0]?.jid, '15550002222@s.whatsapp.net');
    assert.equal(store.search('moved by alias').length, 1);

    const middle = store.message({ remoteJid: jid, id: 'n060', fromMe: false })!;
    assert.equal(store.newerCount(middle), 60);
    store.patch(middle.raw.key, { starred: true });
    assert.deepEqual(
      store.starred(jid).map((m) => m.id),
      ['n060'],
    );

    store.clearAccount();
    assert.equal(store.search('needle').length, 0);
  } finally {
    store.close();
  }
});

test('upgrading a v4 database builds the search index for existing history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-fts-'));
  const path = join(dir, 'history.sqlite');
  let store = new Store(path);
  try {
    store.ingest(raw('old', 'cached before full-text search'));
    store.db.exec(`DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete;
      DROP TRIGGER messages_fts_update; DROP TABLE messages_fts; PRAGMA user_version=4`);
    store.close();
    store = new Store(path);
    assert.equal(store.search('before full-text')[0]?.id, 'old');
    assert.equal(store.db.prepare('PRAGMA user_version').get()?.user_version, 5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('contact names are recovered from history once per profile, or on demand', () => {
  const store = new Store(':memory:');
  try {
    store.ingest({
      key: { remoteJid: '123@g.us', participant: '456@s.whatsapp.net', id: 'g1' },
      pushName: 'Sender',
      message: { conversation: 'hello' },
    });
    store.db.prepare("DELETE FROM meta WHERE key='contacts_recovered'").run();
    store.db.prepare('DELETE FROM contacts').run();
    assert.equal(store.recoverContactNames(), 1);
    store.db.prepare('DELETE FROM contacts').run();
    assert.equal(store.recoverContactNames(), 0, 'later syncs skip the history scan');
    assert.equal(store.contactName('456@s.whatsapp.net'), undefined);
    assert.equal(store.recoverContactNames(true), 1);
    assert.equal(store.contactName('456@s.whatsapp.net'), 'Sender');
  } finally {
    store.close();
  }
});

test('shared contact cards show names, phones and emails instead of vCard source', () => {
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Shah;Maya;;;',
    'FN:Maya Shah',
    'ORG:Chirp Labs;',
    'item1.TEL;waid=919876543210:+91 98765 43210',
    'item1.X-ABLabel:Mobile',
    'TEL;type=WORK;waid=15550001111:',
    'EMAIL;type=INTERNET:maya@example.com',
    'END:VCARD',
  ].join('\n');
  assert.equal(
    vcardText(undefined, vcard),
    'Maya Shah\nChirp Labs\n☎ +91 98765 43210\n☎ +15550001111\n✉ maya@example.com',
  );
  const message = normalize({
    key: { remoteJid: jid, id: 'card' },
    message: { contactMessage: { displayName: 'Maya', vcard } },
  })!;
  assert.equal(message.kind, 'contact');
  assert.doesNotMatch(message.text, /BEGIN:VCARD/);
  assert.match(message.text, /^Maya\n/);
});

test('poll text shows tallies and your vote; vote packets never become chat messages', () => {
  const store = new Store(':memory:');
  try {
    const key = {
      remoteJid: '123@g.us',
      id: 'poll',
      participant: '456@s.whatsapp.net',
      fromMe: false,
    };
    store.ingest({
      key,
      message: {
        pollCreationMessage: {
          name: 'Dinner?',
          options: [{ optionName: 'Pizza' }, { optionName: 'Pasta' }],
          selectableOptionsCount: 1,
        },
      },
    });
    assert.equal(store.message(key)!.text, 'Dinner?\n1. Pizza\n2. Pasta');
    const hash = (name: string) => createHash('sha256').update(name).digest();
    store.updateRaw(key, {
      pollUpdates: [
        {
          pollUpdateMessageKey: {
            remoteJid: '123@g.us',
            id: 'v1',
            participant: '789@s.whatsapp.net',
          },
          vote: { selectedOptions: [hash('Pasta')] },
          senderTimestampMs: 1,
        },
        {
          pollUpdateMessageKey: { remoteJid: '123@g.us', id: 'v2', fromMe: true },
          vote: { selectedOptions: [hash('Pasta')] },
          senderTimestampMs: 2,
        },
      ],
    });
    const poll = store.message(key)!;
    assert.equal(poll.text, 'Dinner?\n1. Pizza · 0\n2. Pasta · 2 ✓');
    assert.deepEqual(
      pollTally(poll.raw).map((o) => o.voters.length),
      [0, 2],
    );
    assert.equal(
      store.ingest({
        key: { remoteJid: '123@g.us', id: 'vote-packet', participant: '789@s.whatsapp.net' },
        message: { pollUpdateMessage: { pollCreationMessageKey: key, vote: {} } },
      }),
      false,
    );
    assert.equal(store.message({ remoteJid: '123@g.us', id: 'vote-packet' }), undefined);
  } finally {
    store.close();
  }
});

test('replies show the quoted sender and text; mentions render as names', () => {
  const reply = normalize({
    key: { remoteJid: '123@g.us', id: 'reply', participant: '456@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        text: '@15550001111 agreed',
        contextInfo: {
          stanzaId: 'original',
          participant: jid,
          quotedMessage: { conversation: 'Ship it on Thursday' },
          mentionedJid: [jid],
        },
      },
    },
  })!;
  assert.equal(quotedOf(reply)?.text, 'Ship it on Thursday');
  const lines = transcript([reply], 80, {
    senderName: () => 'Arjun',
    quote: (m) => {
      const quoted = quotedOf(m)!;
      return { sender: 'Maya', text: quoted.text };
    },
    text: (m) => displayMentions(m.text, [jid], () => 'Maya'),
  })
    .map((line) => line.text)
    .join('\n');
  assert.match(lines, /↳ Maya: Ship it on Thursday/);
  assert.match(lines, /@Maya agreed/);
  assert.doesNotMatch(lines, /Reply to original/);
});

test('mention completion finds participants and records their JIDs', () => {
  const people = [
    { jid: '919000000002@s.whatsapp.net', name: 'Arjun Mehta' },
    { jid: '12345@lid', name: 'Maya Shah' },
    { jid: '919000000001@s.whatsapp.net', name: 'Mom' },
  ];
  assert.equal(mentionToken('hello @ar', 9)?.query, 'ar');
  assert.equal(mentionToken('email@example', 13), undefined, 'needs a word boundary');
  assert.equal(mentionToken('@ar', 1), undefined, 'only before the cursor at a word end');
  assert.deepEqual(
    searchParticipants(people, 'ma').map((p) => p.name),
    ['Maya Shah'],
  );
  assert.deepEqual(
    searchParticipants(people, '9190').map((p) => p.name),
    ['Arjun Mehta', 'Mom'],
  );
  const token = mentionToken('hi @ar', 6)!;
  const inserted = insertMention('hi @ar', token, people[0]);
  assert.deepEqual(inserted, { value: 'hi @919000000002 ', cursor: 17 });
  assert.deepEqual(mentionsIn(`${inserted.value}and @12345`, people), [
    '919000000002@s.whatsapp.net',
    '12345@lid',
  ]);
  assert.deepEqual(mentionsIn('@9190000000021 is not a match', people), []);
});

test('downloads are written atomically and capped by received bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-download-'));
  try {
    const file = join(dir, 'a.bin');
    await saveDownload(file, Readable.from([Buffer.from('hello '), Buffer.from('world')]));
    assert.equal(readdirSync(dir).join(), 'a.bin');
    const big = join(dir, 'big.bin');
    await assert.rejects(
      saveDownload(big, Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10),
      /limited to 100 MB/,
    );
    const broken = join(dir, 'broken.bin');
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('network reset'));
      },
    });
    await assert.rejects(saveDownload(broken, failing), /network reset/);
    assert.deepEqual(readdirSync(dir), ['a.bin'], 'no partial or temporary files remain');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('media cache reports usage and clears everything except unsent drafts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-cache-'));
  try {
    mkdirSync(join(dir, 'media'));
    writeFileSync(join(dir, 'media', 'a.jpg'), Buffer.alloc(1000));
    writeFileSync(join(dir, 'media', 'b.pdf'), Buffer.alloc(24));
    const draft = join(dir, 'media', 'clipboard-x.png');
    writeFileSync(draft, Buffer.alloc(10));
    assert.deepEqual(await mediaCacheUsage(dir), { files: 3, bytes: 1034 });
    const store = new Store(':memory:');
    const result = await command('/cache clear', {
      store,
      client: {} as any,
      visible: [],
      settings: { autoRead: true, notifications: false, theme: 'dark' },
      dir,
      keep: [draft],
    });
    store.close();
    assert.match(result.notice!, /Cleared 2 cached files/);
    assert.ok(existsSync(draft));
    assert.deepEqual(await mediaCacheUsage(join(dir, 'missing')), { files: 0, bytes: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kitty previews use Unicode placeholders and chunked transmissions', () => {
  const text = kittyPlaceholders(0x123456, 4, 3);
  const lines = text.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(
    lines.every((line) => line.startsWith('\x1b[38;2;18;52;86m') && line.endsWith('\x1b[39m')),
  );
  assert.equal([...lines[0].matchAll(/\u{10EEEE}/gu)].length, 4);
  assert.ok(lines[1].includes('\u{10EEEE}\u030D\u0305'), 'row 1 then column 0 diacritics');
  const transmit = kittyTransmit(7, Buffer.alloc(5000, 1), 4, 3);
  const chunks = transmit.split('\x1b\\').filter(Boolean);
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /^\x1b_Ga=T,U=1,f=100,t=d,i=7,c=4,r=3,q=2,m=1;/);
  assert.match(chunks[1], /^\x1b_Gm=0;/);
  assert.equal(kittyDelete(7), '\x1b_Ga=d,d=I,i=7,q=2\x1b\\');
  assert.equal(detectGraphics({ TERM: 'xterm-kitty' }), 'kitty');
  assert.equal(detectGraphics({ TERM_PROGRAM: 'ghostty' }), 'kitty');
  assert.equal(detectGraphics({ KITTY_WINDOW_ID: '1', TMUX: '/tmp/tmux' }), 'blocks');
  assert.equal(detectGraphics({ TERM: 'xterm-256color' }), 'blocks');
  assert.equal(focusEvent('\x1b[I'), true);
  assert.equal(focusEvent('\x1b[O'), false);
  assert.equal(focusEvent('I'), undefined);
});

function encryptVote(
  secret: Uint8Array,
  pollId: string,
  creator: string,
  voter: string,
  option: string,
) {
  const selectedOptions = [createHash('sha256').update(option).digest()];
  const sign = Buffer.concat([
    Buffer.from(pollId),
    Buffer.from(creator),
    Buffer.from(voter),
    Buffer.from('Poll Vote'),
    Buffer.from([1]),
  ]);
  const key = createHmac('sha256', createHmac('sha256', new Uint8Array(32)).update(secret).digest())
    .update(sign)
    .digest();
  const encIv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, encIv);
  cipher.setAAD(Buffer.from(`${pollId}\u0000${voter}`));
  const payload = proto.Message.PollVoteMessage.encode({ selectedOptions }).finish();
  return {
    encPayload: Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]),
    encIv,
  };
}

test('poll votes are encrypted for WhatsApp and incoming votes are decrypted into tallies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-poll-'));
  const store = new Store(':memory:');
  const relayed: { jid: string; message: any }[] = [];
  const patches: any[] = [];
  const fake: any = {
    ev: new EventEmitter(),
    end: () => {},
    relayMessage: async (to: string, message: any, options: { messageId: string }) => {
      relayed.push({ jid: to, message });
      return options.messageId;
    },
    chatModify: async (patch: any) => patches.push(patch),
    groupMetadata: async (id: string) => ({
      id,
      subject: 'Group',
      addressingMode: 'pn',
      participants: [
        { id: '111@s.whatsapp.net' },
        { id: '333@s.whatsapp.net', notify: 'Notify Name' },
        { id: '444@lid', phoneNumber: '444000@s.whatsapp.net' },
      ],
    }),
  };
  const factory = ((options: any) => {
    fake.authState = options.auth;
    return fake;
  }) as typeof makeWASocket;
  const client = new WhatsAppClient(store, dir, undefined, undefined, factory);
  try {
    await client.connect();
    fake.authState.creds.me = { id: '111:2@s.whatsapp.net', lid: '222:2@lid' };
    fake.ev.emit('connection.update', { connection: 'open' });
    const group = '123@g.us';
    const secret = randomBytes(32);
    const pollKey = {
      remoteJid: group,
      id: 'poll-1',
      participant: '333@s.whatsapp.net',
      fromMe: false,
    };
    store.ingest({
      key: pollKey,
      message: {
        messageContextInfo: { messageSecret: secret },
        pollCreationMessage: {
          name: 'Review day?',
          options: [{ optionName: 'Tuesday' }, { optionName: 'Thursday' }],
          selectableOptionsCount: 1,
        },
      },
    });
    const poll = store.message(pollKey)!;
    await assert.rejects(client.vote(poll, [0, 1]), /one choice/);
    await assert.rejects(client.vote(poll, [5]), /between 1 and 2/);
    await client.vote(poll, [1]);
    const update = relayed[0].message.pollUpdateMessage;
    assert.equal(relayed[0].jid, group);
    assert.equal(update.pollCreationMessageKey.id, 'poll-1');
    const decrypted = decryptPollVote(update.vote, {
      pollCreatorJid: '333@s.whatsapp.net',
      pollMsgId: 'poll-1',
      pollEncKey: secret,
      voterJid: '111@s.whatsapp.net',
    });
    assert.deepEqual(
      Buffer.from(decrypted.selectedOptions![0]),
      createHash('sha256').update('Thursday').digest(),
    );
    assert.match(store.message(pollKey)!.text, /2\. Thursday · 1 ✓/);

    // Votes from a LID-addressed participant decrypt with their LID.
    fake.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: group, id: 'vote-2', participant: '555@lid', fromMe: false },
          messageTimestamp: 1_700_000_000,
          message: {
            pollUpdateMessage: {
              pollCreationMessageKey: pollKey,
              vote: encryptVote(secret, 'poll-1', '333@s.whatsapp.net', '555@lid', 'Tuesday'),
              senderTimestampMs: 1_700_000_000_000,
            },
          },
        },
      ],
    });
    const tally = store.message(pollKey)!.text;
    assert.match(tally, /1\. Tuesday · 1/);
    assert.match(tally, /2\. Thursday · 1 ✓/);
    assert.equal(store.message({ remoteJid: group, id: 'vote-2' }), undefined);

    store.contacts([{ id: '444000@s.whatsapp.net', name: 'Saved Name' }]);
    assert.deepEqual(await client.participants(group), [
      { jid: '333@s.whatsapp.net', name: 'Notify Name' },
      { jid: '444@lid', name: 'Saved Name' },
    ]);

    await client.mute(jid, 3600);
    const until = patches[0].mute;
    assert.ok(Math.abs(until - (Date.now() + 3_600_000)) < 5_000, 'mute end is in milliseconds');
    assert.ok(isMuted(store.chat(jid)));
    fake.ev.emit('chats.update', [{ id: jid, muteEndTime: until }]);
    assert.ok(isMuted(store.chat(jid)), 'the echoed mute keeps the chat muted');
    fake.ev.emit('chats.update', [{ id: jid, muteEndTime: null }]);
    assert.ok(!isMuted(store.chat(jid)));
    await client.mute(jid, -1);
    assert.equal(patches[1].mute, -1);
    fake.ev.emit('chats.update', [{ id: jid, muteEndTime: -1 }]);
    assert.ok(isMuted(store.chat(jid)));
  } finally {
    await client.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/vote, /links and /mute act on the selection and current chat', async () => {
  const { DemoClient } = await import('../src/demo.js');
  const store = new Store(':memory:');
  const client = new DemoClient(store, tmpdir());
  const key = {
    remoteJid: '123@g.us',
    id: 'poll',
    participant: '456@s.whatsapp.net',
    fromMe: false,
  };
  store.ingest({
    key,
    message: {
      pollCreationMessage: {
        name: 'Lunch?',
        options: [{ optionName: 'Soup' }, { optionName: 'Salad' }],
        selectableOptionsCount: 1,
      },
    },
  });
  const ctx = (selected = store.message(key)!) => ({
    store,
    client,
    jid: '123@g.us',
    selected,
    visible: [],
    settings: { autoRead: true, notifications: false, theme: 'dark' as const },
  });
  try {
    assert.equal((await command('/vote 2', ctx())).notice, 'Voted for Salad');
    assert.match(store.message(key)!.text, /2\. Salad · 1 ✓/);
    await assert.rejects(command('/vote two', ctx()), /option numbers/);
    assert.equal((await command('/vote clear', ctx())).notice, 'Vote removed');
    assert.doesNotMatch(store.message(key)!.text, /✓/);
    store.ingest(raw('link', 'Docs at https://example.com/docs.'));
    const linked = store.message({ remoteJid: jid, id: 'link', fromMe: false })!;
    assert.deepEqual((await command('/links', ctx(linked))).links, ['https://example.com/docs']);
    await assert.rejects(command('/vote 1', ctx(linked)), /Select a poll/);
    assert.equal((await command('/mute always', ctx())).notice, 'Chat muted · always');
    assert.ok(isMuted(store.chat('123@g.us')));
    assert.equal((await command('/mute', ctx())).notice, 'Chat unmuted');
    assert.ok(!isMuted(store.chat('123@g.us')));
    assert.match((await command('/mute 8h', ctx())).notice!, /Chat muted until/);
  } finally {
    await client.stop();
    store.close();
  }
});
