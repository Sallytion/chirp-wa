import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { Jimp } from 'jimp';
import { join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import mime from 'mime-types';
import type { Client, ClientState, Message, Participant } from './types.js';
import { Store } from './store.js';
import { pollLimit, pollOf } from './messages.js';
import { MAX_MEDIA_BYTES } from './media.js';

export const DEMO_JID = '919876543210@s.whatsapp.net';
export const DEMO_CHANNEL_JID = '120363000000001@newsletter';
export class DemoClient implements Client {
  state: ClientState = {
    connection: 'open',
    user: 'You · demo',
    notice: 'Demo mode · all messages stay on this computer',
    presence: { [DEMO_JID]: 'online' },
  };
  private events = new EventEmitter();
  private timers = new Set<NodeJS.Timeout>();
  private media = new Map<string, string>();
  constructor(
    public store: Store,
    private dir: string,
  ) {}
  subscribe = (cb: () => void) => {
    this.events.on('change', cb);
    return () => {
      this.events.off('change', cb);
    };
  };
  async connect() {
    const image = new Jimp({ width: 240, height: 120, color: 0x142c3dff });
    image.scan(0, 0, 240, 120, (x, y, index) => {
      const sun = (x - 170) ** 2 + (y - 35) ** 2 < 18 ** 2;
      const mountain = y > 65 - 35 * Math.sin(x / 58) && y < 88;
      const c = sun
        ? [255, 202, 115]
        : y > 85
          ? [20, 96 + Math.floor(y / 3), 125]
          : mountain
            ? [42, 77, 82]
            : [31 + Math.floor(y / 4), 48 + Math.floor(y / 2), 83 + Math.floor(y / 4)];
      image.bitmap.data[index] = c[0];
      image.bitmap.data[index + 1] = c[1];
      image.bitmap.data[index + 2] = c[2];
    });
    const path = join(this.dir, 'demo-landscape.png');
    await image.write(path as `${string}.png`);
    const now = Math.floor(Date.now() / 1000);
    this.store.transaction(() => {
      this.store.contacts([
        { id: DEMO_JID, name: 'Maya Shah' },
        { id: '919000000001@s.whatsapp.net', name: 'Mom' },
        { id: '919000000002@s.whatsapp.net', name: 'Arjun Mehta' },
      ]);
      for (const [jid, name, unread] of [
        [DEMO_JID, 'Maya Shah', 2],
        ['120363000000000001@g.us', 'Design team', 4],
        ['919000000001@s.whatsapp.net', 'Mom', 0],
        ['919000000002@s.whatsapp.net', 'Arjun Mehta', 1],
        ['120363000000000002@g.us', 'Weekend plans', 0],
      ] as const)
        this.store.upsertChat({
          jid,
          name,
          unread,
          pinned: jid === DEMO_JID ? now : 0,
          timestamp: 0,
        });
      for (let i = 0; i < 110; i++)
        this.store.ingest({
          key: { remoteJid: DEMO_JID, id: `past-${i}`, fromMe: i % 2 === 0 },
          pushName: 'Maya',
          messageTimestamp: now - 86400 - (110 - i) * 600,
          message: {
            conversation: [
              'Let’s try the new terminal workflow.',
              'Everything is saved locally, so history is still here after restarting.',
              'I love being able to keep my hands on the keyboard.',
            ][i % 3],
          },
          status: 4,
        });
      const messages = [
        { id: 'a', fromMe: false, text: 'Hey! How’s the WhatsApp CLI coming along?' },
        {
          id: 'b',
          fromMe: true,
          text: 'Looking good. Chats on the left, conversation in the middle, composer at the bottom.',
        },
        {
          id: 'c',
          fromMe: false,
          text: 'That’s exactly what I had in mind. Can we preview images without leaving the terminal?',
        },
        {
          id: 'd',
          fromMe: true,
          text: 'Yes — select an image with ↑ / ↓ and press Ctrl+P. You can also reply, react, and search history.',
        },
        { id: 'photo', fromMe: false, text: 'A little inspiration for the weekend 🌅' },
        {
          id: 'e',
          fromMe: false,
          text: 'Try /help to see everything. And /settings shows the read-receipt controls.',
        },
      ];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        this.store.ingest({
          key: { remoteJid: DEMO_JID, id: m.id, fromMe: m.fromMe },
          messageTimestamp: now - (messages.length - i) * 120,
          pushName: 'Maya',
          status: m.fromMe ? 4 : 2,
          message:
            m.id === 'photo'
              ? { imageMessage: { caption: m.text, mimetype: 'image/png' } }
              : { conversation: m.text },
        });
      }
      this.store.reaction({ remoteJid: DEMO_JID, id: 'b', fromMe: true }, 'Maya', '💚');
      this.store.ingest({
        key: {
          remoteJid: '120363000000000001@g.us',
          id: 'group-1',
          participant: DEMO_JID,
          fromMe: false,
        },
        pushName: 'Maya',
        messageTimestamp: now - 90,
        message: { conversation: 'The terminal layout looks clean. Ready for a review?' },
      });
      const group = '120363000000000001@g.us';
      this.store.ingest({
        key: { remoteJid: group, id: 'group-poll', participant: DEMO_JID, fromMe: false },
        pushName: 'Maya',
        messageTimestamp: now - 80,
        message: {
          pollCreationMessage: {
            name: 'Review day?',
            options: [{ optionName: 'Tuesday' }, { optionName: 'Thursday' }],
            selectableOptionsCount: 1,
          },
        },
        pollUpdates: [
          {
            pollUpdateMessageKey: {
              remoteJid: group,
              id: 'group-vote',
              participant: '919000000002@s.whatsapp.net',
              fromMe: false,
            },
            vote: { selectedOptions: [createHash('sha256').update('Thursday').digest()] },
            senderTimestampMs: (now - 75) * 1000,
          },
        ],
      });
      this.store.ingest({
        key: {
          remoteJid: group,
          id: 'group-2',
          participant: '919000000002@s.whatsapp.net',
          fromMe: false,
        },
        pushName: 'Arjun',
        messageTimestamp: now - 70,
        message: {
          extendedTextMessage: {
            text: 'Yes! Draft notes: https://example.com/chirp-review',
            contextInfo: {
              stanzaId: 'group-1',
              participant: DEMO_JID,
              quotedMessage: {
                conversation: 'The terminal layout looks clean. Ready for a review?',
              },
            },
          },
        },
      });
      this.store.ingest({
        key: { remoteJid: '919000000001@s.whatsapp.net', id: 'mom-1', fromMe: false },
        pushName: 'Mom',
        messageTimestamp: now - 7200,
        message: { conversation: 'Don’t forget dinner at 8 ❤️' },
      });
      this.store.ingest({
        key: { remoteJid: '919000000002@s.whatsapp.net', id: 'arjun-1', fromMe: false },
        pushName: 'Arjun',
        messageTimestamp: now - 1800,
        message: { conversation: 'Coffee tomorrow?' },
      });
    });
    this.store.upsertChat({ jid: DEMO_CHANNEL_JID, name: 'Design Dispatch' });
    this.store.ingest(
      {
        key: { remoteJid: DEMO_CHANNEL_JID, id: 'channel-1', fromMe: false },
        messageTimestamp: now - 900,
        message: {
          conversation: 'Welcome to Design Dispatch. Channel updates have their own page.',
        },
      },
      true,
    );
    this.store.ingest(
      {
        key: { remoteJid: DEMO_CHANNEL_JID, id: 'channel-photo', fromMe: false },
        messageTimestamp: now - 600,
        message: {
          imageMessage: { caption: 'A little color for your feed.', mimetype: 'image/png' },
        },
      },
      true,
    );
    this.media.set('photo', path);
    this.media.set('channel-photo', path);
    this.events.emit('change');
  }
  async stop() {
    for (const t of this.timers) clearTimeout(t);
    this.events.removeAllListeners();
  }
  async requestPairing() {
    throw new Error('Exit demo mode to link WhatsApp.');
  }
  useQr() {}
  async syncContacts() {
    this.store.recoverContactNames();
    return 'Demo contact names are up to date.';
  }
  async send(jid: string, text: string, quoted?: Message, mentions?: string[]) {
    const contextInfo = {
      ...(quoted
        ? {
            stanzaId: quoted.id,
            participant: quoted.fromMe ? undefined : quoted.raw.key.participant || quoted.jid,
            quotedMessage: quoted.raw.message,
          }
        : {}),
      ...(mentions?.length ? { mentionedJid: mentions } : {}),
    };
    const raw = {
      key: { remoteJid: jid, id: randomUUID(), fromMe: true },
      messageTimestamp: Math.floor(Date.now() / 1000),
      status: 2,
      message: Object.keys(contextInfo).length
        ? { extendedTextMessage: { text, contextInfo } }
        : { conversation: text },
    };
    this.store.ingest(raw);
    for (const [ms, status] of [
      [600, 'delivered'],
      [1500, 'read'],
    ] as const) {
      const timer = setTimeout(() => {
        this.store.patch(raw.key, { status });
        this.timers.delete(timer);
      }, ms);
      this.timers.add(timer);
    }
  }
  async sendFile(jid: string, path: string, caption = '', voice = false, quoted?: Message) {
    const file = resolve(path);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_MEDIA_BYTES)
      throw new Error('Select a file under 100 MB.');
    const id = randomUUID();
    this.media.set(id, file);
    const mimetype = mime.lookup(path) || 'application/octet-stream';
    const message = mimetype.startsWith('image/')
      ? { imageMessage: { caption, mimetype } }
      : mimetype.startsWith('video/')
        ? { videoMessage: { caption, mimetype } }
        : mimetype.startsWith('audio/') || voice
          ? { audioMessage: { mimetype, ptt: voice } }
          : { documentMessage: { fileName: path.split(/[\\/]/).pop(), caption, mimetype } };
    if (quoted)
      for (const content of Object.values(message))
        Object.assign(content, { contextInfo: { stanzaId: quoted.id } });
    this.store.ingest({
      key: { remoteJid: jid, id, fromMe: true },
      messageTimestamp: Math.floor(Date.now() / 1000),
      status: 4,
      message,
    });
  }
  async read(jid: string, messages: Message[]) {
    this.store.readLocal(jid, messages);
  }
  async typing() {}
  async watchPresence() {}
  async history() {
    this.state = {
      ...this.state,
      notice: 'Demo history is already cached · use PageUp to browse 110 older messages',
    };
    this.events.emit('change');
  }
  async download(m: Message) {
    const path = this.media.get(m.id);
    if (!path) throw new Error('No attachment for this demo message.');
    return path;
  }
  async react(m: Message, emoji: string) {
    this.store.reaction(m.raw.key, 'You', emoji);
  }
  async edit(m: Message, text: string) {
    if (!m.fromMe) throw new Error('Only your own messages can be edited.');
    this.store.updateRaw(m.raw.key, { message: { conversation: text } }, true);
  }
  async delete(m: Message) {
    if (!m.fromMe) throw new Error('Only your own messages can be deleted.');
    this.store.patch(m.raw.key, { deleted: true, text: 'This message was deleted' });
  }
  async forward(m: Message, jid: string) {
    await this.send(jid, m.text);
  }
  async modifyChat(jid: string, action: 'archive' | 'pin' | 'unread', value: boolean) {
    this.store.upsertChat({
      jid,
      ...(action === 'archive'
        ? { archived: value }
        : action === 'pin'
          ? { pinned: value ? 1 : 0 }
          : { unread: value ? 1 : 0 }),
    });
  }
  async mute(jid: string, seconds: number | null) {
    this.store.upsertChat({
      jid,
      muted:
        seconds == null
          ? 0
          : seconds < 0
            ? -1
            : Math.floor(Date.now() / 1000) + Math.floor(seconds),
    });
  }
  async group(jid: string) {
    return `Demo group\n${jid}\nMaya · member\nYou · admin`;
  }
  async participants(jid: string): Promise<Participant[]> {
    if (!jid.endsWith('@g.us')) return [];
    return [DEMO_JID, '919000000002@s.whatsapp.net', '919000000001@s.whatsapp.net'].map(
      (participant) => ({ jid: participant, name: this.store.name(participant) }),
    );
  }
  async poll(jid: string, title: string, options: string[]) {
    this.store.ingest({
      key: { remoteJid: jid, id: randomUUID(), fromMe: true },
      messageTimestamp: Math.floor(Date.now() / 1000),
      status: 2,
      message: {
        pollCreationMessage: {
          name: title,
          options: options.map((optionName) => ({ optionName })),
          selectableOptionsCount: 1,
        },
      },
    });
  }
  async vote(m: Message, options: number[]) {
    const poll = pollOf(m.raw);
    if (m.kind !== 'poll' || !poll) throw new Error('Select a poll to vote.');
    const names = (poll.options || []).map((o) => o.optionName || '');
    if (options.some((i) => i < 0 || i >= names.length))
      throw new Error(`Choose options between 1 and ${names.length}.`);
    const limit = pollLimit(poll);
    if (limit && options.length > limit) throw new Error('This poll allows one choice.');
    this.store.updateRaw(m.raw.key, {
      pollUpdates: [
        {
          pollUpdateMessageKey: { remoteJid: m.jid, id: randomUUID(), fromMe: true },
          vote: {
            selectedOptions: options.map((i) => createHash('sha256').update(names[i]).digest()),
          },
          senderTimestampMs: Date.now(),
        },
      ],
    });
  }
  async logout() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.store.clearAccount();
    this.state = {
      connection: 'logged-out',
      signedOut: true,
      linked: false,
      notice: 'Demo logged out · press Q to link another account',
      presence: {},
    };
    this.events.emit('change');
  }
}
