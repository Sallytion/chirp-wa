import makeWASocket, {
  Browsers,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';
import type {
  WASocket,
  BaileysEventMap,
  GroupMetadata,
  AnyMessageContent,
} from '@whiskeysockets/baileys';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { writeFile, stat, chmod, rename } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import mime from 'mime-types';
import pino from 'pino';
import type { Client, ClientState, Message, SyncPhase } from './types.js';
import { Store } from './store.js';
import { numeric } from './messages.js';
import { errorText, jidFor, privateDir } from './util.js';
import { protocolVersion } from './version.js';
import { isChannel } from './conversations.js';
import { fetchContactSnapshot } from './contacts.js';
import { archiveAccount, finishAccountReset } from './accounts.js';
import { ChatSyncTracker } from './sync.js';
import { LruMap, SignalCache } from './cache.js';

export class WhatsAppClient implements Client {
  state: ClientState = { connection: 'offline', notice: 'Starting WhatsApp…', presence: {} };
  private events = new EventEmitter();
  private socket?: WASocket;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private attempt = 0;
  private connecting = false;
  private loggingOut = false;
  private pairingRequested = false;
  private lastQr?: string;
  private credentialWrites: Promise<void> = Promise.resolve();
  private contactSync?: Promise<string>;
  private contactSyncSocket?: WASocket;
  private chatSync = new ChatSyncTracker();
  private syncTimer?: NodeJS.Timeout;
  private logger: ReturnType<typeof pino>;
  private logDestination: ReturnType<typeof pino.destination>;
  private stopPromise?: Promise<void>;
  private signalCache?: SignalCache;
  private groups = new LruMap<string, GroupMetadata>(128);
  private presenceTimers = new Map<string, NodeJS.Timeout>();
  constructor(
    public store: Store,
    public dir: string,
    private phone?: string,
    private bell?: () => boolean,
    private socketFactory: typeof makeWASocket = makeWASocket,
  ) {
    const destination = pino.destination({ dest: join(dir, 'connection.log'), sync: false });
    this.logDestination = destination;
    this.logger = pino(
      { level: 'error', redact: ['key', 'creds', 'auth', 'message', 'messages', 'qr'] },
      destination,
    );
  }
  subscribe = (cb: () => void) => {
    this.events.on('change', cb);
    return () => {
      this.events.off('change', cb);
    };
  };
  private update(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch };
    this.events.emit('change');
  }
  private notice(error: unknown) {
    this.update({ notice: errorText(error) });
  }
  private syncPhase(kind: 'chats' | 'contacts', phase: SyncPhase) {
    this.update({ sync: { chats: 'idle', contacts: 'idle', ...this.state.sync, [kind]: phase } });
  }
  private updateChatSync() {
    const phase = this.chatSync.phase();
    this.syncPhase('chats', phase);
    clearTimeout(this.syncTimer);
    if (phase === 'waiting' || phase === 'syncing') {
      this.syncTimer = setTimeout(() => {
        if (this.stopped || this.loggingOut || this.state.connection !== 'open') return;
        this.chatSync.pause();
        this.syncPhase('chats', 'paused');
      }, 120_000);
      this.syncTimer.unref();
    }
  }
  private on<K extends keyof BaileysEventMap>(
    socket: WASocket,
    name: K,
    fn: (event: BaileysEventMap[K]) => void | Promise<void>,
  ) {
    socket.ev.on(name, (event) => {
      if (this.stopped || this.loggingOut || this.socket !== socket) return;
      try {
        Promise.resolve(fn(event)).catch((error) => this.notice(error));
      } catch (error) {
        this.notice(error);
      }
    });
  }
  async connect() {
    if (this.stopped || this.loggingOut || this.connecting || this.state.connection === 'open')
      return;
    this.connecting = true;
    try {
      this.update({
        connection: this.attempt ? 'reconnecting' : 'connecting',
        notice: this.attempt ? 'Reconnecting…' : 'Connecting to WhatsApp…',
      });
      await finishAccountReset(this.store, this.dir);
      const authDir = privateDir(join(this.dir, 'auth'));
      // Pairing emits credentials immediately before the mandatory socket restart.
      // Never load the next socket from disk while those writes are still pending.
      await this.credentialWrites;
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      if (this.stopped) return;
      this.pairingRequested = false;
      this.lastQr = undefined;
      clearTimeout(this.syncTimer);
      this.chatSync.reset((state.creds.accountSyncCounter || 0) > 0);
      this.update({
        linked: !!state.creds.me?.id,
        qr: undefined,
        pairingCode: undefined,
        signedOut: false,
        historyProgress: undefined,
        sync: state.creds.me?.id ? { chats: 'waiting', contacts: 'idle' } : undefined,
      });
      const version =
        this.socketFactory === makeWASocket ? await protocolVersion(this.dir) : undefined;
      if (this.stopped) return;
      this.signalCache?.close();
      this.signalCache = new SignalCache();
      const socket = this.socketFactory({
        ...(version ? { version } : {}),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger, this.signalCache),
        },
        // Keep the registered browser identity through pairing and every reconnect.
        // Switching Chrome -> Desktop changes the login's webSubPlatform to DARWIN.
        logger: this.logger,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: true,
        shouldSyncHistoryMessage: (notification) => {
          // Baileys also calls this with a synthetic RECENT probe on reconnect.
          // Only a real notification represents a pending history download.
          if (
            (notification.directPath ||
              notification.mediaKey ||
              notification.initialHistBootstrapInlinePayload ||
              notification.progress != null) &&
            this.socket === socket &&
            !this.stopped &&
            !this.loggingOut
          ) {
            this.chatSync.begin(notification.syncType ?? -1);
            this.update({ historyProgress: notification.progress ?? undefined });
            this.updateChatSync();
          }
          return true;
        },
        markOnlineOnConnect: false,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => this.store.message(key)?.raw.message || undefined,
        cachedGroupMetadata: async (jid) => this.groups.get(jid),
      });
      this.socket = socket;
      this.on(socket, 'creds.update', async (credentials) => {
        Object.assign(state.creds, credentials);
        if ((credentials.accountSyncCounter || 0) > 0) {
          this.chatSync.accountReady();
          if (this.state.sync) this.updateChatSync();
        }
        this.credentialWrites = this.credentialWrites.then(async () => {
          await saveCreds();
          // Multi-file authentication also writes signal keys; protect all files.
          for (const file of readdirSync(authDir))
            await chmod(join(authDir, file), 0o600).catch(() => {});
        });
        await this.credentialWrites;
      });
      this.on(socket, 'connection.update', async (update) => {
        if (update.isNewLogin) {
          this.lastQr = undefined;
          this.update({
            linked: true,
            qr: undefined,
            pairingCode: undefined,
            connection: 'connecting',
            notice: 'QR accepted · finishing login…',
          });
        }
        if (update.qr) {
          this.lastQr = update.qr;
          if (this.phone && !state.creds.me?.id && !this.pairingRequested) {
            this.pairingRequested = true;
            try {
              const pairingCode = await socket.requestPairingCode(this.phone);
              this.update({
                connection: 'qr',
                pairingCode,
                qr: undefined,
                notice: 'On your phone: Linked devices → Link with phone number.',
              });
            } catch (error) {
              this.pairingRequested = false;
              throw error;
            }
          } else if (!this.phone)
            this.update({
              connection: 'qr',
              qr: update.qr,
              notice: 'Scan with WhatsApp → Linked devices → Link a device.',
            });
        }
        if (update.connection === 'open') {
          clearTimeout(this.timer);
          this.lastQr = undefined;
          this.attempt = 0;
          this.pairingRequested = false;
          this.update({
            connection: 'open',
            linked: true,
            qr: undefined,
            pairingCode: undefined,
            user: socket.user?.name || socket.user?.id,
            notice: 'Connected · history will sync in the background',
          });
          this.updateChatSync();
          if (socket.authState?.creds.myAppStateKeyId)
            void this.syncContacts().catch((error) => {
              if (!this.stopped && this.socket === socket)
                this.update({
                  notice: `Contact names will continue syncing · ${errorText(error)}`,
                });
            });
        }
        if (update.receivedPendingNotifications) {
          this.chatSync.pending();
          this.updateChatSync();
        }
        if (update.connection === 'close' && !this.stopped) {
          const reason = (update.lastDisconnect?.error as any)?.output?.statusCode;
          const terminal = [
            DisconnectReason.loggedOut,
            DisconnectReason.badSession,
            DisconnectReason.connectionReplaced,
            DisconnectReason.multideviceMismatch,
            DisconnectReason.forbidden,
          ].includes(reason);
          this.lastQr = undefined;
          this.logger.error(
            { event: 'disconnect', code: reason, paired: !!state.creds.me?.id },
            'WhatsApp socket disconnected',
          );
          clearTimeout(this.syncTimer);
          this.update({
            connection: terminal ? 'logged-out' : 'reconnecting',
            qr: undefined,
            pairingCode: undefined,
            sync: undefined,
            historyProgress: undefined,
            notice: terminal
              ? `Session disconnected (${reason}). Press Q to relink; credentials will be backed up and history kept.`
              : reason === DisconnectReason.restartRequired
                ? 'QR accepted · reconnecting to finish login…'
                : `Connection lost (${reason || 'unknown'}: ${errorText(update.lastDisconnect?.error || 'disconnected')}) · retrying…`,
          });
          if (!terminal)
            this.reconnect(reason === DisconnectReason.restartRequired ? 250 : undefined);
        }
      });
      this.on(socket, 'messaging-history.set', (event) => {
        this.syncPhase('chats', 'syncing');
        for (const mapping of event.lidPnMappings || []) this.store.alias(mapping.lid, mapping.pn);
        this.store.contacts(event.contacts);
        this.store.transaction(() => {
          for (const chat of event.chats)
            if (chat.id) this.store.upsertWAChat({ ...chat, id: chat.id });
          for (const message of event.messages) this.store.ingest(message);
        });
        this.update({
          historyProgress: event.progress ?? undefined,
          notice: `Synced ${this.store.stats().messages.toLocaleString()} messages${event.progress != null ? ` · ${event.progress}%` : ''}`,
        });
        this.chatSync.applied(event.syncType ?? -1, event.progress);
        this.updateChatSync();
      });
      this.on(socket, 'messaging-history.status', (event) => {
        this.chatSync.status(event.syncType, event.status);
        this.updateChatSync();
        this.update({
          notice:
            event.status === 'complete'
              ? 'History chunk received · applying chat updates'
              : 'History sync paused by WhatsApp · cached chats are available',
        });
      });
      this.on(socket, 'lid-mapping.update', (event) => this.store.alias(event.lid, event.pn));
      this.on(socket, 'chats.upsert', (chats) =>
        this.store.transaction(() =>
          chats.forEach((c) => {
            if (c.id) this.store.upsertWAChat({ ...c, id: c.id });
          }),
        ),
      );
      this.on(socket, 'chats.update', (chats) =>
        this.store.transaction(() =>
          chats.forEach((c) => {
            if (c.id) this.store.upsertWAChat({ ...c, id: c.id });
          }),
        ),
      );
      this.on(socket, 'contacts.upsert', (contacts) => this.store.contacts(contacts));
      this.on(socket, 'contacts.update', (contacts) => this.store.contacts(contacts));
      this.on(socket, 'messages.upsert', (event) => {
        let incoming = false;
        this.store.transaction(() => {
          for (const m of event.messages) {
            const fresh = this.store.ingest(m, event.type === 'notify');
            if (
              fresh &&
              event.type === 'notify' &&
              !m.key.fromMe &&
              m.key.remoteJid !== 'status@broadcast'
            ) {
              const muted = this.store.chat(m.key.remoteJid || '')?.muted || 0;
              if (muted < Date.now() / 1000) incoming = true;
            }
          }
        });
        if (incoming && this.bell?.()) process.stdout.write('\x07');
      });
      this.on(socket, 'messages.update', (updates) =>
        this.store.transaction(() => {
          for (const { key, update } of updates) {
            if (update.message === null)
              this.store.patch(key, { deleted: true, text: 'This message was deleted' });
            else this.store.updateRaw(key, update, !!update.message);
          }
        }),
      );
      this.on(socket, 'messages.delete', (event) =>
        this.store.transaction(() => {
          const keys =
            'keys' in event ? event.keys : this.store.allMessages(event.jid).map((m) => m.raw.key);
          for (const key of keys)
            this.store.patch(key, { deleted: true, text: 'This message was deleted' });
        }),
      );
      this.on(socket, 'messages.reaction', (reactions) => {
        for (const { key, reaction } of reactions)
          this.store.reaction(
            key,
            reaction.key?.participant ||
              (reaction.key?.fromMe ? 'You' : reaction.key?.remoteJid) ||
              'Unknown',
            reaction.text || '',
          );
      });
      this.on(socket, 'message-receipt.update', (updates) => {
        for (const { key, receipt } of updates)
          if (receipt.userJid)
            this.store.receipt(key, receipt.userJid, {
              ...(receipt.receiptTimestamp ? { delivered: numeric(receipt.receiptTimestamp) } : {}),
              ...(receipt.readTimestamp ? { read: numeric(receipt.readTimestamp) } : {}),
              ...(receipt.playedTimestamp ? { played: numeric(receipt.playedTimestamp) } : {}),
            });
      });
      this.on(socket, 'presence.update', (event) => {
        const jid = this.store.resolve(event.id);
        const presence = Object.values(event.presences).map((p) => p.lastKnownPresence);
        const label = presence.includes('composing')
          ? 'typing…'
          : presence.includes('recording')
            ? 'recording…'
            : presence.includes('available')
              ? 'online'
              : '';
        const nextPresence = { ...this.state.presence };
        if (label) nextPresence[jid] = label;
        else delete nextPresence[jid];
        this.update({ presence: nextPresence });
        clearTimeout(this.presenceTimers.get(jid));
        if (!label) {
          this.presenceTimers.delete(jid);
          return;
        }
        const timer = setTimeout(() => {
          const presence = { ...this.state.presence };
          delete presence[jid];
          this.update({ presence });
          this.presenceTimers.delete(jid);
        }, 12_000);
        timer.unref();
        this.presenceTimers.set(jid, timer);
      });
      this.on(socket, 'groups.upsert', (groups) => {
        for (const group of groups) {
          this.groups.set(group.id, group);
          this.store.upsertChat({ jid: group.id, name: group.subject });
        }
      });
      this.on(socket, 'groups.update', (groups) => {
        for (const group of groups) {
          if (!group.id) continue;
          this.groups.delete(group.id);
          if (group.subject) this.store.upsertChat({ jid: group.id, name: group.subject });
        }
      });
      this.on(socket, 'group-participants.update', (event) => {
        this.groups.delete(event.id);
      });
      this.on(socket, 'call', (calls) => {
        for (const call of calls)
          if (call.status === 'offer')
            this.update({
              notice: `Incoming ${call.isVideo ? 'video' : 'voice'} call from ${this.store.name(call.from)} · answer on your phone`,
            });
      });
    } catch (error) {
      clearTimeout(this.syncTimer);
      this.notice(error);
      this.update({ connection: 'reconnecting', sync: undefined });
      this.reconnect();
    } finally {
      this.connecting = false;
    }
  }
  private reconnect(delay?: number) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    const ms = delay ?? Math.min(30_000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.timer = setTimeout(() => {
      const previous = this.socket;
      this.socket = undefined;
      previous?.end(new Error('Reconnecting'));
      void this.connect();
    }, ms);
  }
  private online() {
    if (this.state.connection !== 'open' || !this.socket)
      throw new Error('WhatsApp is offline. Your draft is saved; reconnect before sending.');
    return this.socket;
  }
  private conversation(jid: string) {
    if (isChannel(jid))
      throw new Error('Channels are read-only here. Switch to Chats with Ctrl+N to send messages.');
  }
  async requestPairing(phone: string) {
    const number = phone.replace(/[+\s()-]/g, '');
    if (!/^\d{7,15}$/.test(number))
      throw new Error('Enter your phone number with country code, for example +919876543210.');
    if (!this.socket || this.state.connection !== 'qr' || !this.lastQr || this.state.linked)
      throw new Error('Wait for a fresh login QR before requesting a pairing code.');
    this.phone = number;
    this.pairingRequested = true;
    try {
      const pairingCode = await this.socket.requestPairingCode(number);
      this.update({
        pairingCode,
        qr: undefined,
        connection: 'qr',
        notice: 'On your phone: Linked devices → Link a device → Link with phone number.',
      });
    } catch (error) {
      this.pairingRequested = false;
      throw error;
    }
  }
  async useQr() {
    if (this.stopped) return;
    this.phone = undefined;
    this.pairingRequested = false;
    if (this.state.connection === 'logged-out') {
      clearTimeout(this.timer);
      const previous = this.socket;
      this.socket = undefined;
      previous?.end(new Error('Relinking'));
      await this.credentialWrites;
      await finishAccountReset(this.store, this.dir);
      // Archive only this profile's auth child. Relinking is reversible and leaves
      // the SQLite history, drafts, settings, and media cache in place.
      const authDir = join(resolve(this.dir), 'auth');
      if (existsSync(authDir))
        await rename(authDir, join(resolve(this.dir), `auth-backup-${Date.now()}`));
      this.lastQr = undefined;
      this.attempt = 0;
      this.update({
        linked: false,
        qr: undefined,
        pairingCode: undefined,
        connection: 'offline',
        notice: 'Previous credentials backed up · preparing a fresh QR…',
      });
      await this.connect();
      return;
    }
    this.update({
      pairingCode: undefined,
      qr: this.lastQr,
      ...(this.lastQr
        ? {
            connection: 'qr' as const,
            notice: 'Scan with WhatsApp → Linked devices → Link a device.',
          }
        : {}),
    });
  }
  stop(): Promise<void> {
    return (this.stopPromise ||= (async () => {
      this.stopped = true;
      clearTimeout(this.timer);
      clearTimeout(this.syncTimer);
      for (const timer of this.presenceTimers.values()) clearTimeout(timer);
      this.presenceTimers.clear();
      const socket = this.socket;
      this.socket = undefined;
      await socket?.end(new Error('Client closed'));
      await this.credentialWrites.catch((error) => {
        this.logger.error({ error: errorText(error) }, 'Could not save login credentials');
      });
      this.signalCache?.close();
      this.signalCache = undefined;
      this.groups.clear();
      this.events.removeAllListeners();
      this.state = { ...this.state, presence: {} };
      await new Promise<void>((resolve) => {
        this.logDestination.once('close', resolve);
        this.logDestination.end();
      });
    })());
  }
  async send(jid: string, text: string, quoted?: Message, mentions?: string[]) {
    this.conversation(jid);
    if (!text.trim()) return;
    const result = await this.online().sendMessage(
      jid,
      { text, ...(mentions?.length ? { mentions } : {}) },
      quoted ? { quoted: quoted.raw } : {},
    );
    if (result) this.store.ingest(result);
  }
  async sendFile(jid: string, path: string, caption = '', voice = false, quoted?: Message) {
    this.conversation(jid);
    const file = resolve(path);
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Attachment must be a file.');
    if (info.size > 100 * 1024 * 1024)
      throw new Error('Attachments are limited to 100 MB in chirp.');
    const mimetype = mime.lookup(file) || 'application/octet-stream';
    let content: AnyMessageContent;
    if (mimetype.startsWith('image/') && mimetype !== 'image/gif')
      content = { image: { url: file }, caption, mimetype };
    else if (mimetype.startsWith('video/')) content = { video: { url: file }, caption, mimetype };
    else if (mimetype.startsWith('audio/') || voice) {
      if (voice && mimetype !== 'audio/ogg' && mimetype !== 'audio/opus')
        throw new Error(
          'Voice notes require an Ogg/Opus file. Use /attach for other audio formats.',
        );
      content = {
        audio: { url: file },
        mimetype: voice ? 'audio/ogg; codecs=opus' : mimetype,
        ptt: voice,
      };
    } else content = { document: { url: file }, caption, mimetype, fileName: basename(file) };
    const result = await this.online().sendMessage(
      jid,
      content,
      quoted ? { quoted: quoted.raw } : {},
    );
    if (result) this.store.ingest(result);
  }
  async read(jid: string, messages: Message[]) {
    const unread = messages.filter(
      (m) => m.kind !== 'system' && !m.fromMe && !m.localRead && !m.deleted,
    );
    if (!unread.length) return;
    if (isChannel(jid)) {
      this.store.readLocal(jid, unread);
      return;
    }
    await this.online().readMessages(unread.map((m) => m.raw.key));
    this.store.readLocal(jid, unread);
  }
  async typing(jid: string, active: boolean) {
    if (isChannel(jid)) return;
    if (this.state.connection !== 'open') return;
    const socket = this.online();
    if (!active) await socket.presenceSubscribe(jid);
    await socket.sendPresenceUpdate(active ? 'composing' : 'paused', jid);
  }
  async history(jid: string, oldest?: Message) {
    if (isChannel(jid))
      throw new Error(
        'Channels show the updates WhatsApp has synced locally. Browse them with PageUp / PageDown.',
      );
    if (!oldest)
      throw new Error('No cached message to use as a history cursor. Wait for initial phone sync.');
    await this.online().fetchMessageHistory(50, oldest.raw.key, oldest.timestamp);
    this.update({
      notice: 'Requested 50 older messages from your phone. WhatsApp may return fewer or none.',
    });
  }
  async syncContacts() {
    const socket = this.online();
    if (this.contactSync && this.contactSyncSocket === socket) return this.contactSync;
    this.contactSyncSocket = socket;
    this.syncPhase('contacts', 'syncing');
    const pending = (this.contactSync = (async () => {
      this.update({ notice: 'Syncing WhatsApp contact names…' });
      const recovered = this.store.recoverContactNames();
      const contacts = await fetchContactSnapshot(socket);
      if (this.stopped || this.loggingOut || this.socket !== socket)
        throw new Error('Contact sync interrupted by a reconnect. Try again when connected.');
      if (contacts) this.store.contacts(contacts);
      else await socket.resyncAppState(['critical_unblock_low'], false);
      if (this.stopped || this.loggingOut || this.socket !== socket)
        throw new Error('Contact sync interrupted by a reconnect.');
      const count = Number(
        this.store.db.prepare('SELECT count(*) AS n FROM contacts').get()?.n || 0,
      );
      const notice = `Contact sync complete · ${count.toLocaleString()} names cached${recovered ? ` · ${recovered.toLocaleString()} recovered from messages` : ''}. Names update as WhatsApp supplies them.`;
      this.syncPhase('contacts', 'synced');
      this.update({ notice });
      return notice;
    })());
    try {
      return await pending;
    } catch (error) {
      if (!this.stopped && !this.loggingOut && this.socket === socket)
        this.syncPhase('contacts', 'error');
      throw error;
    } finally {
      if (this.contactSync === pending) {
        this.contactSync = undefined;
        this.contactSyncSocket = undefined;
      }
    }
  }
  async download(message: Message) {
    if (message.viewOnce)
      throw new Error('View-once media is protected. Open it in the official WhatsApp app.');
    if (!['image', 'video', 'audio', 'document', 'sticker'].includes(message.kind))
      throw new Error('Select a message with an attachment.');
    if (message.deleted) throw new Error('This message was deleted.');
    const content = normalizeMessageContent(message.raw.message);
    const media =
      content?.imageMessage ||
      content?.videoMessage ||
      content?.audioMessage ||
      content?.documentMessage ||
      content?.stickerMessage;
    if (Number(media?.fileLength || 0) > 100 * 1024 * 1024)
      throw new Error('Media downloads are limited to 100 MB in chirp.');
    const cache = privateDir(join(this.dir, 'media'));
    const extension =
      mime.extension(message.mimetype || '') ||
      ({ image: 'jpg', video: 'mp4', audio: 'ogg', sticker: 'webp' } as Record<string, string>)[
        message.kind
      ] ||
      'bin';
    const hash = createHash('sha256')
      .update(`${message.jid}:${message.id}:${message.fromMe}`)
      .digest('hex')
      .slice(0, 32);
    const file = join(cache, `${hash}.${extension}`);
    if (existsSync(file)) return file;
    const socket = this.online();
    const buffer = await downloadMediaMessage(
      message.raw,
      'buffer',
      {},
      { logger: this.logger, reuploadRequest: socket.updateMediaMessage },
    );
    await writeFile(file, buffer, { mode: 0o600 });
    return file;
  }
  async react(message: Message, emoji: string) {
    await this.online().sendMessage(message.raw.key.remoteJid || message.jid, {
      react: { text: emoji, key: message.raw.key },
    });
    this.store.reaction(message.raw.key, 'You', emoji);
  }
  async edit(message: Message, text: string) {
    if (!message.fromMe || message.deleted || message.kind !== 'text')
      throw new Error('Select one of your own text messages to edit.');
    await this.online().sendMessage(message.raw.key.remoteJid || message.jid, {
      text,
      edit: message.raw.key,
    });
    this.store.updateRaw(message.raw.key, { message: { conversation: text } }, true);
  }
  async delete(message: Message) {
    if (!message.fromMe)
      throw new Error('Only your own messages can be deleted for everyone here.');
    await this.online().sendMessage(message.raw.key.remoteJid || message.jid, {
      delete: message.raw.key,
    });
    this.store.patch(message.raw.key, { deleted: true, text: 'This message was deleted' });
  }
  async forward(message: Message, jid: string) {
    if (message.viewOnce || message.deleted)
      throw new Error('Cannot forward protected or deleted media.');
    const result = await this.online().sendMessage(jid, { forward: message.raw });
    if (result) this.store.ingest(result);
  }
  async modifyChat(jid: string, action: 'archive' | 'pin' | 'mute' | 'unread', value: boolean) {
    this.conversation(jid);
    const lastMessages = this.store
      .history(jid, 10)
      .reverse()
      .map((m) => ({ key: m.raw.key, messageTimestamp: m.timestamp }));
    const patch =
      action === 'archive'
        ? { archive: value, lastMessages }
        : action === 'pin'
          ? { pin: value }
          : action === 'mute'
            ? { mute: value ? -1 : null }
            : { markRead: !value, lastMessages };
    await this.online().chatModify(patch, jid);
    this.store.upsertChat({
      jid,
      ...(action === 'archive'
        ? { archived: value }
        : action === 'pin'
          ? { pinned: value ? Math.floor(Date.now() / 1000) : 0 }
          : action === 'mute'
            ? { muted: value ? Number.MAX_SAFE_INTEGER : 0 }
            : { unread: value ? 1 : 0 }),
    });
  }
  async group(jid: string, action: string, args: string[]) {
    const socket = this.online();
    if (action === 'create') {
      if (args.length < 2) throw new Error('/group create "Name" +number [+number…]');
      const group = await socket.groupCreate(args[0], args.slice(1).map(jidFor));
      this.groups.set(group.id, group);
      this.store.upsertChat({ jid: group.id, name: group.subject });
      return `Created ${group.subject} · ${group.id}`;
    }
    if (!jid.endsWith('@g.us')) throw new Error('Open a group chat first.');
    if (action === 'info') {
      const group = await socket.groupMetadata(jid);
      this.groups.set(jid, group);
      return `${group.subject}\n${group.desc || ''}\n${group.participants.map((p) => `${this.store.name(p.id)} · ${p.id}${p.admin ? ` (${p.admin})` : ''}`).join('\n')}`;
    }
    if (['add', 'remove', 'promote', 'demote'].includes(action)) {
      if (!args.length) throw new Error('Supply participant phone numbers or JIDs.');
      return JSON.stringify(
        await socket.groupParticipantsUpdate(
          jid,
          args.map(jidFor),
          action as 'add' | 'remove' | 'promote' | 'demote',
        ),
        null,
        2,
      );
    }
    if (action === 'subject') {
      if (!args.length) throw new Error('Supply a group name.');
      await socket.groupUpdateSubject(jid, args.join(' '));
    } else if (action === 'description') await socket.groupUpdateDescription(jid, args.join(' '));
    else if (action === 'invite')
      return `https://chat.whatsapp.com/${await socket.groupInviteCode(jid)}`;
    else if (action === 'leave') {
      if (args[0] !== 'confirm') throw new Error('Use /group leave confirm to leave this group.');
      await socket.groupLeave(jid);
    } else if (action === 'ephemeral') {
      const n = Number(args[0]);
      if (![0, 86400, 604800, 7776000].includes(n))
        throw new Error('Use 0, 86400, 604800 or 7776000 seconds.');
      await socket.groupToggleEphemeral(jid, n);
    } else
      throw new Error(
        'Group actions: info, create, add, remove, promote, demote, subject, description, invite, ephemeral, leave confirm',
      );
    this.groups.delete(jid);
    return `Group ${action} updated`;
  }
  async poll(jid: string, title: string, options: string[]) {
    this.conversation(jid);
    if (options.length < 2 || options.length > 12) throw new Error('Use 2–12 poll options.');
    const result = await this.online().sendMessage(jid, {
      poll: { name: title, values: options, selectableCount: 1 },
    });
    if (result) this.store.ingest(result);
  }
  async logout() {
    const socket = this.online();
    this.loggingOut = true;
    clearTimeout(this.timer);
    clearTimeout(this.syncTimer);
    this.update({ notice: 'Logging out · archiving this account’s local data…' });
    let unlinked = false;
    try {
      await this.credentialWrites;
      const archive = await archiveAccount(this.store, this.dir, async () => {
        await socket.logout();
        unlinked = true;
        this.socket = undefined;
        socket.end(new Error('Logged out'));
        await this.credentialWrites;
      });
      for (const timer of this.presenceTimers.values()) clearTimeout(timer);
      this.presenceTimers.clear();
      this.groups.clear();
      this.phone = undefined;
      this.lastQr = undefined;
      this.attempt = 0;
      this.update({
        connection: 'logged-out',
        signedOut: true,
        linked: false,
        user: undefined,
        qr: undefined,
        pairingCode: undefined,
        historyProgress: undefined,
        sync: undefined,
        presence: {},
        notice: `Logged out · previous account saved in ${basename(archive)}. Press Q to link another account.`,
      });
    } catch (error) {
      if (unlinked)
        this.update({
          connection: 'logged-out',
          signedOut: true,
          linked: false,
          user: undefined,
          qr: undefined,
          pairingCode: undefined,
          notice: `Logged out · account archive needs to finish: ${errorText(error)}. Press Q to retry.`,
        });
      else this.update({ notice: `Logout failed · ${errorText(error)}` });
      throw error;
    } finally {
      this.loggingOut = false;
    }
  }
}
