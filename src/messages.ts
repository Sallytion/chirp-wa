import { normalizeMessageContent, proto } from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { Message, MessageKind, ReceiptStatus } from './types.js';
import { safeText } from './util.js';

export function statusOf(status?: number | null): ReceiptStatus {
  switch (status) {
    case 0:
      return 'failed';
    case 1:
      return 'pending';
    case 2:
      return 'sent';
    case 3:
      return 'delivered';
    case 4:
      return 'read';
    case 5:
      return 'played';
    default:
      return 'sent';
  }
}
export const numeric = (v: unknown): number => Number(v || 0);
export function systemText(raw: WAMessage): string | undefined {
  const value: unknown = raw.messageStubType;
  const stub = proto.WebMessageInfo.StubType;
  // Protobuf's toJSON serializes enums by name. Old cached history therefore
  // contains strings such as E2E_IDENTITY_CHANGED, while live events use numbers.
  const type =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? typeof (stub as Record<string, unknown>)[value] === 'number'
          ? Number((stub as Record<string, unknown>)[value])
          : /^\d+$/.test(value)
            ? Number(value)
            : undefined
        : undefined;
  if (
    type == null ||
    [
      stub.E2E_IDENTITY_CHANGED,
      stub.E2E_ENCRYPTED,
      stub.E2E_DEVICE_CHANGED,
      stub.E2E_ENCRYPTED_NOW,
      stub.E2E_IDENTITY_UNAVAILABLE,
      stub.GENERIC_NOTIFICATION,
    ].includes(type)
  )
    return;
  const labels: Partial<Record<number, string>> = {
    [stub.REVOKE]: 'This message was deleted',
    [stub.FUTUREPROOF]: 'Unsupported WhatsApp message · open it on your phone',
    [stub.CIPHERTEXT]: 'Waiting for this message. Check WhatsApp on your phone.',
    [stub.GROUP_CREATE]: 'Group created',
    [stub.GROUP_CHANGE_SUBJECT]: 'Group name changed',
    [stub.GROUP_CHANGE_DESCRIPTION]: 'Group description changed',
    [stub.GROUP_CHANGE_ICON]: 'Group photo changed',
    [stub.GROUP_CHANGE_INVITE_LINK]: 'Group invite link changed',
    [stub.GROUP_CHANGE_RESTRICT]: 'Group settings changed',
    [stub.GROUP_CHANGE_ANNOUNCE]: 'Group messaging permissions changed',
    [stub.GROUP_PARTICIPANT_ADD]: 'Participant added to the group',
    [stub.GROUP_PARTICIPANT_REMOVE]: 'Participant removed from the group',
    [stub.GROUP_PARTICIPANT_PROMOTE]: 'Participant made a group admin',
    [stub.GROUP_PARTICIPANT_DEMOTE]: 'Group admin removed',
    [stub.GROUP_PARTICIPANT_INVITE]: 'Participant invited to the group',
    [stub.GROUP_PARTICIPANT_LEAVE]: 'Participant left the group',
    [stub.GROUP_PARTICIPANT_CHANGE_NUMBER]: 'A group participant changed their phone number',
    [stub.INDIVIDUAL_CHANGE_NUMBER]: 'Contact changed their phone number',
    [stub.GROUP_DELETE]: 'Group deleted',
    [stub.CALL_MISSED_VOICE]: 'Missed voice call',
    [stub.CALL_MISSED_VIDEO]: 'Missed video call',
    [stub.CALL_MISSED_GROUP_VOICE]: 'Missed group voice call',
    [stub.CALL_MISSED_GROUP_VIDEO]: 'Missed group video call',
    [stub.CHANGE_EPHEMERAL_SETTING]: 'Disappearing message settings changed',
    [stub.GROUP_PARTICIPANT_ADD_REQUEST_JOIN]: 'Participant requested to join the group',
    [stub.GROUP_MEMBER_ADD_MODE]: 'Group participant permissions changed',
    [stub.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE]: 'Group join approval settings changed',
  };
  return labels[type];
}
// Keep background security/protocol notices for diagnostics, but exclude them
// from conversations, unread counts, search, receipts, and inbox ordering.
export function normalize(raw: WAMessage, includeBackground = false): Message | undefined {
  if (!raw.key.remoteJid || !raw.key.id) return;
  const content =
    normalizeMessageContent(raw.message) || (raw.messageStubType != null ? {} : undefined);
  if (!content) return;
  let kind: MessageKind = 'text';
  let text = '';
  let media: any;
  if (content.conversation != null) text = content.conversation;
  else if (content.extendedTextMessage) {
    text = content.extendedTextMessage.text || '';
    media = content.extendedTextMessage;
  } else if (content.imageMessage) {
    kind = 'image';
    media = content.imageMessage;
    text = media.caption || '';
  } else if (content.videoMessage) {
    kind = 'video';
    media = content.videoMessage;
    text = media.caption || '';
  } else if (content.audioMessage) {
    kind = 'audio';
    media = content.audioMessage;
    text = `${media.ptt ? 'Voice note' : 'Audio'} · ${media.seconds || 0}s`;
  } else if (content.documentMessage) {
    kind = 'document';
    media = content.documentMessage;
    text = media.caption || media.fileName || 'Document';
  } else if (content.stickerMessage) {
    kind = 'sticker';
    media = content.stickerMessage;
    text = 'Sticker';
  } else if (content.contactMessage || content.contactsArrayMessage) {
    kind = 'contact';
    const c = content.contactMessage;
    text = c
      ? `${c.displayName || 'Contact'}\n${c.vcard || ''}`
      : (content.contactsArrayMessage?.contacts || [])
          .map((c) => `${c.displayName || ''}\n${c.vcard || ''}`)
          .join('\n');
  } else if (content.locationMessage || content.liveLocationMessage) {
    kind = 'location';
    const l = content.locationMessage || content.liveLocationMessage!;
    text = `${('name' in l && l.name) || 'Location'}\nhttps://maps.google.com/?q=${l.degreesLatitude},${l.degreesLongitude}`;
  } else if (
    content.pollCreationMessage ||
    content.pollCreationMessageV2 ||
    content.pollCreationMessageV3
  ) {
    kind = 'poll';
    const p =
      content.pollCreationMessage ||
      content.pollCreationMessageV2 ||
      content.pollCreationMessageV3!;
    text = `${p.name}\n${(p.options || []).map((o, i) => `${i + 1}. ${o.optionName}`).join('\n')}`;
  } else if (
    content.reactionMessage ||
    content.protocolMessage ||
    content.senderKeyDistributionMessage
  )
    return;
  else {
    kind = 'system';
    if (raw.messageStubType != null) {
      const label = systemText(raw);
      if (!label && !includeBackground) return;
      text = label || '';
    } else {
      const keys = Object.keys(content);
      if (!keys.length) return;
      text = `[Unsupported message: ${keys.join(', ')}]`;
    }
  }
  return {
    jid: raw.key.remoteJid,
    id: raw.key.id,
    fromMe: !!raw.key.fromMe,
    sender: safeText(raw.pushName || raw.key.participant || raw.key.remoteJid),
    timestamp:
      raw.messageTimestamp == null ? Math.floor(Date.now() / 1000) : numeric(raw.messageTimestamp),
    text: safeText(text),
    kind,
    status: statusOf(raw.status),
    edited: false,
    deleted: false,
    starred: !!raw.starred,
    localRead: !!raw.key.fromMe || kind === 'system',
    viewOnce: !!(
      raw.message?.viewOnceMessage ||
      raw.message?.viewOnceMessageV2 ||
      raw.message?.viewOnceMessageV2Extension ||
      media?.viewOnce
    ),
    reactions: {},
    receipts: {},
    quotedId: media?.contextInfo?.stanzaId,
    filename: safeText(media?.fileName || ''),
    mimetype: media?.mimetype ? safeText(media.mimetype) : undefined,
    raw,
  };
}
export function protocolChange(raw: WAMessage) {
  const p = normalizeMessageContent(raw.message)?.protocolMessage;
  if (!p?.key?.id) return;
  if (p.type === proto.Message.ProtocolMessage.Type.REVOKE) return { key: p.key, deleted: true };
  if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && p.editedMessage)
    return { key: p.key, content: p.editedMessage };
}
