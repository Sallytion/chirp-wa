import {
  getAggregateVotesInPollMessage,
  normalizeMessageContent,
  proto,
} from '@whiskeysockets/baileys';
import type { WAMessage } from '@whiskeysockets/baileys';
import type { Message, MessageKind, ReceiptStatus } from './types.js';
import { safeText } from './util.js';

// Shared contact cards arrive as raw vCards; show the name, organisation,
// phone numbers and email addresses instead of the vCard source.
export function vcardText(
  displayName: string | null | undefined,
  vcard: string | null | undefined,
) {
  let name = displayName || '';
  let org = '';
  const phones: string[] = [];
  const emails: string[] = [];
  const unescape = (value: string) =>
    value
      .replace(/\\n/gi, ' ')
      .replace(/\\([,;:\\])/g, '$1')
      .trim();
  for (const line of String(vcard || '')
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const head = line.slice(0, separator);
    const value = unescape(line.slice(separator + 1));
    const property = head.split(';')[0].split('.').pop()!.toUpperCase();
    if (property === 'FN' && !name) name = value;
    else if (property === 'ORG') org = value.replace(/;+/g, ' ').trim();
    else if (property === 'TEL') {
      const waid = /waid=(\d+)/i.exec(head)?.[1];
      const phone = value || (waid ? `+${waid}` : '');
      if (phone) phones.push(phone);
    } else if (property === 'EMAIL' && value) emails.push(value);
  }
  return [name || 'Contact', org, ...phones.map((p) => `☎ ${p}`), ...emails.map((e) => `✉ ${e}`)]
    .filter(Boolean)
    .join('\n');
}

export type PollContent = proto.Message.IPollCreationMessage;
export function pollOf(raw: WAMessage): PollContent | undefined {
  const content = normalizeMessageContent(raw.message);
  return (
    content?.pollCreationMessage ||
    content?.pollCreationMessageV2 ||
    content?.pollCreationMessageV3 ||
    undefined
  );
}
// WhatsApp uses 0 for "any number of options"; missing means single choice.
export function pollLimit(poll: PollContent): number {
  return poll.selectableOptionsCount ?? 1;
}
// Received and local votes, with 'me' marking your own selection.
export function pollTally(raw: WAMessage): { name: string; voters: string[] }[] {
  try {
    return getAggregateVotesInPollMessage(
      { message: normalizeMessageContent(raw.message), pollUpdates: raw.pollUpdates || [] },
      'me',
    );
  } catch {
    return (pollOf(raw)?.options || []).map((o) => ({ name: o.optionName || '', voters: [] }));
  }
}
function pollText(raw: WAMessage, poll: PollContent): string {
  const tally = pollTally(raw);
  const votes = tally.some((o) => o.voters.length);
  const limit = pollLimit(poll);
  const choice = limit === 1 ? '' : limit ? `\nSelect up to ${limit}` : '\nSelect any number';
  return `${poll.name}\n${(poll.options || [])
    .map((o, i) => {
      const voters = tally.find((t) => t.name === (o.optionName || ''))?.voters || [];
      const count = votes ? ` · ${voters.length}` : '';
      return `${i + 1}. ${o.optionName}${count}${voters.includes('me') ? ' ✓' : ''}`;
    })
    .join('\n')}${choice}`;
}

export function contextOf(raw: WAMessage): proto.IContextInfo | undefined {
  const content = normalizeMessageContent(raw.message);
  if (!content) return;
  for (const value of Object.values(content))
    if (value && typeof value === 'object' && 'contextInfo' in value && value.contextInfo)
      return value.contextInfo as proto.IContextInfo;
}
export function mentionsOf(raw: WAMessage): string[] {
  return (contextOf(raw)?.mentionedJid || []).filter(Boolean);
}
// The quoted message as the sender's client embedded it in the reply.
export function quotedOf(m: Message): Message | undefined {
  const context = contextOf(m.raw);
  if (!context?.stanzaId || !context.quotedMessage) return;
  return normalize({
    key: {
      remoteJid: m.jid,
      id: context.stanzaId,
      participant: context.participant || undefined,
      fromMe: false,
    },
    message: context.quotedMessage,
    messageTimestamp: m.timestamp,
  });
}

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
      ? vcardText(c.displayName, c.vcard)
      : (content.contactsArrayMessage?.contacts || [])
          .map((c) => vcardText(c.displayName, c.vcard))
          .join('\n\n');
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
    text = pollText(raw, pollOf(raw)!);
  } else if (
    content.reactionMessage ||
    content.protocolMessage ||
    content.senderKeyDistributionMessage ||
    // Encrypted votes are applied to their poll; they are not chat messages.
    content.pollUpdateMessage
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
