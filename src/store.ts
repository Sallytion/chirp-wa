import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
import {
  BufferJSON,
  normalizeMessageContent,
  updateMessageWithPollUpdate,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import type { WAMessage, WAMessageKey, Chat as WAChat, Contact } from '@whiskeysockets/baileys';
import { EventEmitter } from 'node:events';
import { chmodSync } from 'node:fs';
import type { Chat, Message, ReceiptStatus } from './types.js';
import { normalize, numeric, protocolChange, statusOf } from './messages.js';
import { safeText } from './util.js';
import { sectionClause, type ChatSection } from './conversations.js';

const encode = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
const decode = (value: string) => JSON.parse(value, BufferJSON.reviver);
const ranks: Record<ReceiptStatus, number> = {
  failed: -1,
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
};
const activeConversation =
  '(EXISTS (SELECT 1 FROM messages WHERE messages.jid=chats.jid AND visible=1) OR NOT EXISTS (SELECT 1 FROM messages WHERE messages.jid=chats.jid))';

export class Store {
  db: DatabaseSync;
  private events = new EventEmitter();
  private depth = 0;
  private statements = new Map<string, StatementSync>();
  private statsCache?: { chats: number; messages: number };
  private sectionCounts = new Map<ChatSection, number>();
  revision = 0;
  private statement(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.db.prepare(sql);
    if (this.statements.size >= 128) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chats(jid TEXT PRIMARY KEY,name TEXT NOT NULL,timestamp INTEGER DEFAULT 0,unread INTEGER DEFAULT 0,archived INTEGER DEFAULT 0,pinned INTEGER DEFAULT 0,muted INTEGER DEFAULT 0,preview TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS messages(jid TEXT NOT NULL,id TEXT NOT NULL,from_me INTEGER NOT NULL,timestamp INTEGER NOT NULL,text TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(jid,id,from_me));
      CREATE INDEX IF NOT EXISTS messages_history ON messages(jid,timestamp DESC,id DESC);
      CREATE TABLE IF NOT EXISTS contacts(jid TEXT PRIMARY KEY,name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases(alias TEXT PRIMARY KEY,jid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(jid TEXT PRIMARY KEY,text TEXT NOT NULL);
      `);
    const version = Number(this.statement('PRAGMA user_version').get()?.user_version || 0);
    // Older contact migrations can merge aliased messages, so their writes must
    // already understand the new visibility column.
    if (
      version < 3 &&
      !this.statement('PRAGMA table_info(messages)')
        .all()
        .some((c) => c.name === 'visible')
    )
      this.db.exec('ALTER TABLE messages ADD COLUMN visible INTEGER NOT NULL DEFAULT 1');
    if (version < 2) {
      this.transaction(() => {
        const columns = this.statement('PRAGMA table_info(contacts)').all();
        // Existing contact names are retained as saved names until WhatsApp sends
        // a more recent saved-name update; profile notifications cannot erase them.
        if (!columns.some((c) => c.name === 'name_rank'))
          this.db.exec('ALTER TABLE contacts ADD COLUMN name_rank INTEGER NOT NULL DEFAULT 3');
        for (const row of this.statement('SELECT alias,jid FROM aliases').all())
          this.mergeContact(String(row.alias), String(row.jid));
        this.recoverContactNames();
        this.db.exec('PRAGMA user_version=2');
      });
    }
    if (version < 4) {
      this.transaction(() => {
        if (
          !this.statement('PRAGMA table_info(messages)')
            .all()
            .some((c) => c.name === 'visible')
        )
          this.db.exec('ALTER TABLE messages ADD COLUMN visible INTEGER NOT NULL DEFAULT 1');
        this.db.exec(
          'CREATE INDEX IF NOT EXISTS messages_visible_history ON messages(jid,visible,timestamp DESC,id DESC)',
        );
        const affected = new Map<string, number>();
        for (const row of this.statement(
          "SELECT data FROM messages WHERE json_extract(data,'$.kind')='system'",
        ).iterate()) {
          const old = decode(String(row.data)) as Message;
          if (old.raw.messageStubType == null) continue;
          const next = normalize(old.raw);
          if (next) this.writeMessage({ ...old, text: next.text, localRead: true });
          else
            this.statement('UPDATE messages SET visible=0 WHERE jid=? AND id=? AND from_me=?').run(
              old.jid,
              old.id,
              +old.fromMe,
            );
          affected.set(
            old.jid,
            (affected.get(old.jid) || 0) + (!old.fromMe && !old.localRead ? 1 : 0),
          );
        }
        for (const [jid, excluded] of affected) this.refreshSummary(jid, excluded);
        this.db.exec('PRAGMA user_version=4');
      });
    }
    if (path !== ':memory:') {
      try {
        chmodSync(path, 0o600);
      } catch {}
    }
  }
  subscribe = (cb: () => void) => {
    this.events.on('change', cb);
    return () => {
      this.events.off('change', cb);
    };
  };
  changed() {
    this.statsCache = undefined;
    this.sectionCounts.clear();
    this.revision++;
    if (!this.depth) this.events.emit('change');
  }
  transaction(fn: () => void) {
    if (this.depth) {
      fn();
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth--;
      this.changed();
    }
  }
  resolve(jid: string): string {
    const normalized = jidNormalizedUser(jid);
    return (
      (
        this.statement('SELECT jid FROM aliases WHERE alias=?').get(normalized) as
          { jid: string } | undefined
      )?.jid || normalized
    );
  }
  alias(lid: string, pn: string) {
    if (!lid || !pn || lid === pn) return;
    if (this.statement('SELECT jid FROM aliases WHERE alias=?').get(lid)?.jid === pn) return;
    this.transaction(() => {
      const old = this.chat(lid);
      const target = this.chat(pn);
      for (const row of this.statement('SELECT data,visible FROM messages WHERE jid=?').iterate(
        lid,
      )) {
        const message = decode(String(row.data)) as Message;
        message.jid = pn;
        this.writeMessage(message, !!row.visible);
      }
      this.statement('DELETE FROM messages WHERE jid=?').run(lid);
      if (old)
        this.upsertChat({
          ...old,
          jid: pn,
          name: target?.name || old.name,
          timestamp: Math.max(old.timestamp, target?.timestamp || 0),
          preview: target && target.timestamp > old.timestamp ? target.preview : old.preview,
          unread: Math.max(old.unread, target?.unread || 0),
        });
      this.statement('DELETE FROM chats WHERE jid=?').run(lid);
      this.statement('INSERT OR REPLACE INTO aliases VALUES(?,?)').run(lid, pn);
      this.mergeContact(lid, pn);
      const draft = this.statement('SELECT text FROM drafts WHERE jid=?').get(lid);
      if (draft && !this.draft(pn)) this.saveDraft(pn, String(draft.text));
      this.statement('DELETE FROM drafts WHERE jid=?').run(lid);
      if (this.hasBackground(pn)) this.refreshSummary(pn);
    });
  }
  name(jid: string) {
    const resolved = this.resolve(jid);
    return resolved.endsWith('@g.us') || resolved.endsWith('@newsletter')
      ? this.chat(resolved)?.name || this.contactName(resolved) || resolved.split('@')[0]
      : this.contactName(resolved) || this.chat(resolved)?.name || resolved.split('@')[0];
  }
  contactName(jid: string): string | undefined {
    return (
      this.statement('SELECT name FROM contacts WHERE jid=?').get(this.resolve(jid)) as
        { name: string } | undefined
    )?.name;
  }
  senderName(message: Message): string {
    if (message.fromMe) return 'You';
    if (message.jid.endsWith('@newsletter')) return this.name(message.jid);
    return (
      this.contactName(message.raw.key.participant || message.jid) || message.sender.split('@')[0]
    );
  }
  private writeContact(jid: string, name: string, rank: number) {
    const clean = safeText(name).trim();
    if (!clean) return;
    this.statement(
      `INSERT INTO contacts(jid,name,name_rank) VALUES(?,?,?) ON CONFLICT(jid) DO UPDATE SET name=excluded.name,name_rank=excluded.name_rank WHERE excluded.name_rank>=contacts.name_rank`,
    ).run(jid, clean, rank);
    const preferred = this.contactName(jid)!;
    this.statement('UPDATE chats SET name=? WHERE jid=?').run(preferred, jid);
  }
  private mergeContact(lid: string, pn: string) {
    const source = this.statement('SELECT name,name_rank FROM contacts WHERE jid=?').get(lid);
    const target = this.statement('SELECT name_rank FROM contacts WHERE jid=?').get(pn);
    if (source && (!target || Number(source.name_rank) > Number(target.name_rank)))
      this.writeContact(pn, String(source.name), Number(source.name_rank));
    this.statement('DELETE FROM contacts WHERE jid=?').run(lid);
    const name = this.contactName(pn);
    if (name) this.statement('UPDATE chats SET name=? WHERE jid=?').run(name, pn);
  }
  contacts(contacts: Partial<Contact>[]) {
    this.transaction(() => {
      for (const c of contacts) {
        if (!c.id) continue;
        const id = jidNormalizedUser(c.id);
        const lid = c.lid || (id.endsWith('@lid') ? id : undefined);
        const pn = c.phoneNumber || (id.endsWith('@s.whatsapp.net') ? id : undefined);
        if (lid && pn) this.alias(jidNormalizedUser(lid), jidNormalizedUser(pn));
        const name = c.name?.trim() || c.verifiedName?.trim() || c.notify?.trim() || '';
        if (!name) continue;
        this.writeContact(
          this.resolve(id),
          name,
          c.name?.trim() ? 3 : c.verifiedName?.trim() ? 2 : 1,
        );
      }
    });
  }
  private rememberSender(raw: WAMessage) {
    const key = raw.key;
    for (const [id, alternate] of [
      [key.remoteJid, key.remoteJidAlt],
      [key.participant, key.participantAlt],
    ]) {
      if (id?.endsWith('@lid') && alternate?.endsWith('@s.whatsapp.net')) this.alias(id, alternate);
      else if (id?.endsWith('@s.whatsapp.net') && alternate?.endsWith('@lid'))
        this.alias(alternate, id);
    }
    if (key.fromMe || !raw.pushName) return;
    const sender = key.participant || key.remoteJid;
    if (!sender || !(sender.endsWith('@lid') || sender.endsWith('@s.whatsapp.net'))) return;
    this.writeContact(this.resolve(sender), raw.pushName, 1);
  }
  recoverContactNames(): number {
    const before = Number(this.statement('SELECT count(*) AS n FROM contacts').get()?.n || 0);
    this.transaction(() => {
      for (const row of this.statement('SELECT data FROM messages ORDER BY timestamp').iterate()) {
        const message = JSON.parse(String(row.data)) as Message;
        this.rememberSender(message.raw);
      }
      this.db.exec(
        'UPDATE chats SET name=(SELECT name FROM contacts WHERE contacts.jid=chats.jid) WHERE jid IN (SELECT jid FROM contacts)',
      );
    });
    return Number(this.statement('SELECT count(*) AS n FROM contacts').get()?.n || 0) - before;
  }
  upsertWAChat(c: Partial<WAChat> & { id: string }) {
    if (c.name && (c.id.endsWith('@lid') || c.id.endsWith('@s.whatsapp.net')))
      this.contacts([{ id: c.id, name: c.name }]);
    this.upsertChat({
      jid: c.id,
      name: c.name || undefined,
      timestamp: c.conversationTimestamp == null ? undefined : numeric(c.conversationTimestamp),
      unread: c.unreadCount == null ? undefined : Math.max(0, c.unreadCount),
      archived: c.archived == null ? undefined : !!c.archived,
      pinned: c.pinned == null ? undefined : numeric(c.pinned),
      muted: c.muteEndTime == null ? undefined : numeric(c.muteEndTime),
    });
    if (this.hasBackground(c.id)) this.refreshSummary(this.resolve(c.id));
  }
  private hasBackground(jid: string) {
    return !!this.statement('SELECT 1 FROM messages WHERE jid=? AND visible=0 LIMIT 1').get(
      this.resolve(jid),
    );
  }
  private refreshSummary(jid: string, excluded?: number) {
    const last = this.statement(
      'SELECT timestamp,text,data FROM messages WHERE jid=? AND visible=1 ORDER BY timestamp DESC,id DESC LIMIT 1',
    ).get(jid);
    const preview = last
      ? (String(last.text) || `[${(JSON.parse(String(last.data)) as Message).kind}]`).split('\n')[0]
      : '';
    if (excluded != null) {
      this.statement(
        'UPDATE chats SET timestamp=?,preview=?,unread=CASE WHEN ?=0 THEN 0 ELSE max(0,unread-?) END WHERE jid=?',
      ).run(Number(last?.timestamp || 0), preview, +!!last, excluded, jid);
    } else
      this.statement('UPDATE chats SET timestamp=?,preview=? WHERE jid=?').run(
        Number(last?.timestamp || 0),
        preview,
        jid,
      );
  }
  upsertChat(patch: Partial<Chat> & { jid: string }) {
    const jid = this.resolve(patch.jid);
    const previous = this.chat(jid);
    const next: Chat = {
      jid,
      name: this.nameFallback(jid),
      timestamp: 0,
      unread: 0,
      archived: false,
      pinned: 0,
      muted: 0,
      preview: '',
      ...previous,
    };
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined && k !== 'jid') (next as any)[k] = v;
    next.name = safeText(next.name);
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))
      next.name = this.contactName(jid) || next.name;
    next.timestamp = Math.max(previous?.timestamp || 0, next.timestamp);
    this.statement('INSERT OR REPLACE INTO chats VALUES(?,?,?,?,?,?,?,?)').run(
      jid,
      next.name,
      next.timestamp,
      next.unread,
      +next.archived,
      next.pinned,
      next.muted,
      next.preview,
    );
    this.changed();
  }
  private nameFallback(jid: string) {
    return (
      (
        this.statement('SELECT name FROM contacts WHERE jid=?').get(jid) as
          { name: string } | undefined
      )?.name || jid.split('@')[0]
    );
  }
  chat(jid: string): Chat | undefined {
    const row = this.statement('SELECT * FROM chats WHERE jid=?').get(this.resolve(jid));
    return row ? ({ ...row, archived: !!row.archived } as unknown as Chat) : undefined;
  }
  chats(filter = '', mode = 'all', section: ChatSection = 'chats'): Chat[] {
    let clause = mode === 'archived' ? 'archived=1' : 'archived=0';
    clause += ` AND ${sectionClause(section)} AND ${activeConversation}`;
    if (mode === 'unread') clause += ' AND unread>0';
    if (mode === 'groups') clause += " AND jid LIKE '%@g.us'";
    const rows = this.statement(
      `SELECT * FROM chats WHERE ${clause} AND (name LIKE ? ESCAPE '\\' OR jid LIKE ? ESCAPE '\\') ORDER BY pinned DESC,timestamp DESC LIMIT 500`,
    ).all(like(filter), like(filter));
    return rows.map((row) => ({ ...row, archived: !!row.archived }) as unknown as Chat);
  }
  sectionCount(section: ChatSection): number {
    const cached = this.sectionCounts.get(section);
    if (cached != null) return cached;
    const count = Number(
      this.statement(
        `SELECT count(*) AS n FROM chats WHERE ${sectionClause(section)} AND archived=0 AND ${activeConversation}`,
      ).get()?.n || 0,
    );
    this.sectionCounts.set(section, count);
    return count;
  }
  directory(filter = '', section: ChatSection = 'chats'): Chat[] {
    const chats = [
      ...this.chats(filter, 'all', section),
      ...this.chats(filter, 'archived', section),
    ];
    const seen = new Set(chats.map((c) => c.jid));
    const contacts = this.statement(
      `SELECT jid,name FROM contacts WHERE ${sectionClause(section)} AND (name LIKE ? ESCAPE '\\' OR jid LIKE ? ESCAPE '\\') ORDER BY name LIMIT 500`,
    ).all(like(filter), like(filter));
    for (const contact of contacts)
      if (!seen.has(String(contact.jid)))
        chats.push({
          jid: String(contact.jid),
          name: String(contact.name),
          timestamp: 0,
          unread: 0,
          archived: false,
          pinned: 0,
          muted: 0,
          preview: '',
        });
    return chats;
  }
  message(key: WAMessageKey): Message | undefined {
    if (!key.remoteJid || !key.id) return;
    let row =
      key.fromMe == null
        ? this.statement(
            'SELECT data FROM messages WHERE jid=? AND id=? AND visible=1 LIMIT 1',
          ).get(this.resolve(key.remoteJid), key.id)
        : this.statement(
            'SELECT data FROM messages WHERE jid=? AND id=? AND from_me=? AND visible=1',
          ).get(this.resolve(key.remoteJid), key.id, +!!key.fromMe);
    return row ? decode(row.data as string) : undefined;
  }
  private writeMessage(m: Message, visible = true) {
    this.statement(
      'INSERT OR REPLACE INTO messages(jid,id,from_me,timestamp,text,data,visible) VALUES(?,?,?,?,?,?,?)',
    ).run(m.jid, m.id, +m.fromMe, m.timestamp, m.text, encode(m), +visible);
  }
  ingest(raw: WAMessage, notify = false): boolean {
    this.rememberSender(raw);
    const protocol = protocolChange(raw);
    if (protocol) {
      const key = { ...protocol.key, remoteJid: protocol.key.remoteJid || raw.key.remoteJid };
      if (protocol.deleted) this.patch(key, { deleted: true, text: 'This message was deleted' });
      else if (protocol.content) this.updateRaw(key, { message: protocol.content }, true);
      return false;
    }
    const reaction = normalizeMessageContent(raw.message)?.reactionMessage;
    if (reaction?.key) {
      this.reaction(
        reaction.key,
        raw.key.participant || (raw.key.fromMe ? 'You' : raw.key.remoteJid) || 'Unknown',
        reaction.text || '',
      );
      return false;
    }
    const visible = normalize(raw);
    const message = visible || normalize(raw, true);
    if (!message || message.jid === 'status@broadcast') return false;
    message.jid = this.resolve(message.jid);
    if (!visible) {
      this.writeMessage(message, false);
      this.refreshSummary(message.jid);
      this.changed();
      return false;
    }
    const existing = this.message(raw.key);
    if (existing) {
      message.status =
        ranks[existing.status] > ranks[message.status] ? existing.status : message.status;
      message.reactions = existing.reactions;
      message.receipts = existing.receipts;
      message.localRead = existing.localRead;
      message.starred = existing.starred;
      message.edited = existing.edited;
      message.deleted = existing.deleted;
      if (existing.deleted || existing.edited) {
        message.text = existing.text;
        message.raw = existing.raw;
      }
    }
    this.writeMessage(message);
    const chat = this.chat(message.jid);
    this.upsertChat({
      jid: message.jid,
      timestamp: message.timestamp,
      preview:
        !chat || message.timestamp >= chat.timestamp
          ? (message.text || `[${message.kind}]`).split('\n')[0]
          : undefined,
      unread:
        (chat?.unread || 0) +
        (notify && !existing && !message.fromMe && message.kind !== 'system' ? 1 : 0),
    });
    return !existing && message.kind !== 'system';
  }
  patch(key: WAMessageKey, patch: Partial<Message>) {
    const m = this.message(key);
    if (!m) return;
    if (patch.status && patch.status !== 'failed' && ranks[patch.status] < ranks[m.status])
      delete patch.status;
    Object.assign(m, patch);
    this.writeMessage(m);
    this.changed();
  }
  updateRaw(key: WAMessageKey, update: Partial<WAMessage>, edited = false) {
    const m = this.message(key);
    if (!m) return;
    const polls = { pollUpdates: m.raw.pollUpdates || [] };
    if (update.pollUpdates)
      for (const vote of update.pollUpdates) updateMessageWithPollUpdate(polls, vote);
    m.raw = { ...m.raw, ...update, key: m.raw.key };
    if (update.pollUpdates) m.raw.pollUpdates = polls.pollUpdates;
    if (update.message) {
      const normalized = normalize(m.raw);
      if (normalized) {
        m.text = normalized.text;
        m.kind = normalized.kind;
      }
      m.edited = edited || m.edited;
    }
    if (update.status != null) {
      const status = statusOf(update.status);
      if (status === 'failed' || ranks[status] > ranks[m.status]) m.status = status;
    }
    this.writeMessage(m);
    this.changed();
  }
  reaction(key: WAMessageKey, sender: string, emoji: string) {
    const m = this.message(key);
    if (!m) return;
    if (emoji) m.reactions[sender] = safeText(emoji);
    else delete m.reactions[sender];
    this.patch(key, { reactions: m.reactions });
  }
  receipt(
    key: WAMessageKey,
    user: string,
    receipt: { delivered?: number; read?: number; played?: number },
  ) {
    const m = this.message(key);
    if (!m) return;
    m.receipts[user] = { ...m.receipts[user], ...receipt };
    // A participant receipt is not proof that the entire group has read a message.
    const status = m.jid.endsWith('@g.us')
      ? m.status
      : receipt.played
        ? 'played'
        : receipt.read
          ? 'read'
          : receipt.delivered
            ? 'delivered'
            : m.status;
    this.patch(key, { receipts: m.receipts, status });
  }
  history(jid: string, limit = 60, offset = 0): Message[] {
    return this.statement(
      'SELECT data FROM messages WHERE jid=? AND visible=1 ORDER BY timestamp DESC,id DESC LIMIT ? OFFSET ?',
    )
      .all(this.resolve(jid), limit, offset)
      .map((r) => decode(r.data as string))
      .reverse();
  }
  allMessages(jid: string): Message[] {
    return this.statement(
      'SELECT data FROM messages WHERE jid=? AND visible=1 ORDER BY timestamp,id',
    )
      .all(this.resolve(jid))
      .map((r) => decode(r.data as string));
  }
  count(jid: string) {
    return Number(
      this.statement('SELECT count(*) AS n FROM messages WHERE jid=? AND visible=1').get(
        this.resolve(jid),
      )?.n || 0,
    );
  }
  search(query: string, jid?: string, section: ChatSection = 'chats'): Message[] {
    const sql =
      "SELECT data FROM messages WHERE visible=1 AND text LIKE ? ESCAPE '\\'" +
      (jid ? ' AND jid=?' : ` AND ${sectionClause(section)}`) +
      ' ORDER BY timestamp DESC LIMIT 100';
    return this.statement(sql)
      .all(...(jid ? [like(query), this.resolve(jid)] : [like(query)]))
      .map((r) => decode(r.data as string));
  }
  readLocal(jid: string, messages: Message[]) {
    this.transaction(() => {
      let count = 0;
      for (const m of messages) {
        const current = this.message(m.raw.key);
        if (current && !current.fromMe && !current.localRead) count++;
        this.patch(m.raw.key, { localRead: true });
      }
      this.upsertChat({ jid, unread: Math.max(0, (this.chat(jid)?.unread || 0) - count) });
    });
  }
  draft(jid: string) {
    return String(
      this.statement('SELECT text FROM drafts WHERE jid=?').get(this.resolve(jid))?.text || '',
    );
  }
  saveDraft(jid: string, text: string) {
    this.statement('INSERT OR REPLACE INTO drafts VALUES(?,?)').run(this.resolve(jid), text);
  }
  stats() {
    return (this.statsCache ||= {
      chats: Number(
        this.statement(`SELECT count(*) AS n FROM chats WHERE ${activeConversation}`).get()?.n,
      ),
      messages: Number(
        this.statement('SELECT count(*) AS n FROM messages WHERE visible=1').get()?.n,
      ),
    });
  }
  async archive(path: string) {
    await backup(this.db, path);
    chmodSync(path, 0o600);
  }
  clearAccount() {
    this.transaction(() => {
      for (const table of ['messages', 'chats', 'contacts', 'aliases', 'drafts'])
        this.db.exec(`DELETE FROM ${table}`);
    });
  }
  close() {
    this.events.removeAllListeners();
    this.statements.clear();
    this.statsCache = undefined;
    this.sectionCounts.clear();
    this.db.close();
  }
}
function like(value: string) {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}
