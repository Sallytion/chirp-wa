export type ChatSection = 'chats' | 'channels';
export function isChannel(jid: string): boolean {
  return jid.endsWith('@newsletter');
}
export function sectionFor(jid: string): ChatSection {
  return isChannel(jid) ? 'channels' : 'chats';
}
export function sectionClause(section: ChatSection): string {
  return section === 'channels'
    ? "jid LIKE '%@newsletter'"
    : "jid NOT LIKE '%@newsletter' AND jid NOT LIKE '%@broadcast'";
}
