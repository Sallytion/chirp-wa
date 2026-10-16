import type { WAMessage, WAMessageKey } from '@whiskeysockets/baileys';

export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'contact'
  | 'location'
  | 'poll'
  | 'system';
export type ReceiptStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'played' | 'failed';
export interface Chat {
  jid: string;
  name: string;
  timestamp: number;
  unread: number;
  archived: boolean;
  pinned: number;
  muted: number;
  preview: string;
}
export interface Message {
  jid: string;
  id: string;
  fromMe: boolean;
  sender: string;
  timestamp: number;
  text: string;
  kind: MessageKind;
  status: ReceiptStatus;
  edited: boolean;
  deleted: boolean;
  starred: boolean;
  localRead: boolean;
  viewOnce: boolean;
  reactions: Record<string, string>;
  receipts: Record<string, { delivered?: number; read?: number; played?: number }>;
  quotedId?: string;
  filename?: string;
  mimetype?: string;
  raw: WAMessage;
}
export interface ClientState {
  connection: 'offline' | 'connecting' | 'qr' | 'open' | 'reconnecting' | 'logged-out';
  qr?: string;
  pairingCode?: string;
  linked?: boolean;
  notice: string;
  historyProgress?: number;
  presence: Record<string, string>;
  user?: string;
  signedOut?: boolean;
  sync?: { chats: SyncPhase; contacts: SyncPhase };
}
export type SyncPhase = 'waiting' | 'syncing' | 'synced' | 'paused' | 'error' | 'idle';
export interface Settings {
  autoRead: boolean;
  notifications: boolean;
  theme: 'dark' | 'light';
  // Optional so older settings objects keep their previous behavior.
  typing?: boolean;
  images?: 'auto' | 'kitty' | 'blocks';
}
export interface Participant {
  jid: string;
  name: string;
}
// Chat.muted holds the unmute time in Unix seconds; -1 means always muted.
export function isMuted(chat: Pick<Chat, 'muted'> | undefined, now = Date.now()): boolean {
  return !!chat && (chat.muted < 0 || chat.muted > now / 1000);
}
export interface Client {
  state: ClientState;
  subscribe(listener: () => void): () => void;
  connect(): Promise<void>;
  requestPairing(phone: string): Promise<void>;
  useQr(): void | Promise<void>;
  stop(): Promise<void>;
  send(jid: string, text: string, quoted?: Message, mentions?: string[]): Promise<void>;
  sendFile(
    jid: string,
    path: string,
    caption?: string,
    voice?: boolean,
    quoted?: Message,
  ): Promise<void>;
  read(jid: string, messages: Message[]): Promise<void>;
  typing(jid: string, active: boolean): Promise<void>;
  // Subscribe to a contact's presence without announcing a chat state.
  watchPresence(jid: string): Promise<void>;
  history(jid: string, oldest?: Message): Promise<void>;
  syncContacts(): Promise<string>;
  download(message: Message): Promise<string>;
  react(message: Message, emoji: string): Promise<void>;
  edit(message: Message, text: string): Promise<void>;
  delete(message: Message): Promise<void>;
  forward(message: Message, jid: string): Promise<void>;
  modifyChat(jid: string, action: 'archive' | 'pin' | 'unread', value: boolean): Promise<void>;
  // Mute for a number of seconds, -1 for always, or null to unmute.
  mute(jid: string, seconds: number | null): Promise<void>;
  group(jid: string, action: string, args: string[]): Promise<string>;
  participants(jid: string): Promise<Participant[]>;
  poll(jid: string, title: string, options: string[]): Promise<void>;
  // Option indexes are zero-based; an empty list removes your vote.
  vote(message: Message, options: number[]): Promise<void>;
  logout(): Promise<void>;
}
export const keyOf = (m: Message): WAMessageKey => m.raw.key;
export const receiptLabel: Record<ReceiptStatus, string> = {
  pending: '◷',
  sent: '✓',
  delivered: '✓✓',
  read: '✓✓',
  played: '▶✓',
  failed: '!',
};
