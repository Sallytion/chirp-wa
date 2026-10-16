import type { Participant } from './types.js';

export interface MentionToken {
  start: number;
  end: number;
  query: string;
  key: string;
}
// "@que" directly before the cursor, at the start or after whitespace.
// Cursor positions are code points, like the composer's.
export function mentionToken(value: string, cursor: number): MentionToken | undefined {
  const chars = Array.from(value);
  const before = chars.slice(0, cursor).join('');
  const match = /(?:^|\s)@([^\s@]{0,32})$/u.exec(before);
  if (!match || /[^\s]/.test(chars[cursor] || ' ')) return;
  const start = cursor - Array.from(match[1]).length - 1;
  return { start, end: cursor, query: match[1], key: `@${start}:${match[1].toLowerCase()}` };
}
const user = (jid: string) => jid.split('@')[0].split(':')[0];
const pattern = (jid: string) => user(jid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function searchParticipants(participants: Participant[], query: string): Participant[] {
  const q = query.toLowerCase().replace(/^\+/, '');
  return participants
    .filter((p) => !q || p.name.toLowerCase().includes(q) || user(p.jid).includes(q))
    .sort(
      (a, b) =>
        +!a.name.toLowerCase().startsWith(q) - +!b.name.toLowerCase().startsWith(q) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 8);
}
// WhatsApp mentions are "@<user>" in the text plus the JID in mentionedJid.
export function insertMention(
  value: string,
  token: MentionToken,
  participant: Participant,
): { value: string; cursor: number } {
  const chars = Array.from(value);
  const inserted = Array.from(`@${user(participant.jid)} `);
  chars.splice(token.start, token.end - token.start, ...inserted);
  return { value: chars.join(''), cursor: token.start + inserted.length };
}
export function mentionsIn(text: string, participants: Participant[]): string[] {
  return participants
    .filter((p) => new RegExp(`(?:^|\\W)@${pattern(p.jid)}(?!\\d)`).test(text))
    .map((p) => p.jid);
}
// Show "@Maya" for "@919876543210" when the message mentions that JID.
export function displayMentions(
  text: string,
  mentioned: string[],
  name: (jid: string) => string,
): string {
  let result = text;
  for (const jid of mentioned)
    result = result.replace(new RegExp(`@${pattern(jid)}(?!\\d)`, 'g'), () => `@${name(jid)}`);
  return result;
}
