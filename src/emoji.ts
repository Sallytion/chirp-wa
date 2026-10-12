import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export interface EmojiSuggestion {
  emoji: string;
  shortcode: string;
  label: string;
}
interface Entry {
  emoji: string;
  label: string;
  aliases: string[];
  keywords: string[];
  order: number;
}
interface EmojiData {
  unicode: string;
  label: string;
  hexcode: string;
  order?: number;
  group?: number;
  tags?: string[];
  skins?: EmojiData[];
}
const normalize = (text: string) => text.toLowerCase().replace(/[\s-]+/g, '_');
const aliasesFor = (hex: string, source: Record<string, string | string[]>) => {
  const names = source[hex];
  return names ? (Array.isArray(names) ? names : [names]) : [];
};
let entries: Entry[] | undefined;
function emojiEntries(): Entry[] {
  if (entries) return entries;
  const require = createRequire(import.meta.url);
  const read = (path: string) => JSON.parse(readFileSync(require.resolve(path), 'utf8'));
  const data = read('emojibase-data/en/compact.json') as EmojiData[];
  const github = read('emojibase-data/en/shortcodes/github.json');
  const shortcodes = read('emojibase-data/en/shortcodes/emojibase.json');
  entries = [];
  for (const emoji of data) {
    if (emoji.group === undefined) continue;
    for (const variant of [emoji, ...(emoji.skins || [])]) {
      entries.push({
        emoji: variant.unicode,
        label: variant.label,
        aliases: [
          ...new Set([
            ...aliasesFor(variant.hexcode, github),
            ...aliasesFor(variant.hexcode, shortcodes),
            normalize(variant.label).replace(/[^a-z0-9_+-]/g, ''),
          ]),
        ],
        keywords: [...(emoji.tags || []), variant.label].map(normalize),
        order: variant.order ?? 99999,
      });
    }
  }
  return entries;
}
const cache = new Map<string, EmojiSuggestion[]>();
export function searchEmoji(query: string): EmojiSuggestion[] {
  const normalized = normalize(query);
  const cached = cache.get(normalized);
  if (cached) return cached;
  const matches = emojiEntries()
    .flatMap((entry) => {
      const exact = entry.aliases.find((alias) => alias === normalized);
      const prefix = entry.aliases.find((alias) => alias.startsWith(normalized));
      const keyword = entry.keywords.some((word) =>
        word.split('_').some((part) => part.startsWith(normalized)),
      );
      const substring = entry.aliases.find((alias) => alias.includes(normalized));
      if (!exact && !prefix && !keyword && !substring) return [];
      return [
        {
          entry,
          shortcode: exact || prefix || substring || entry.aliases[0],
          rank: exact ? 0 : prefix ? 1 : keyword ? 2 : 3,
        },
      ];
    })
    .sort((a, b) => a.rank - b.rank || a.entry.order - b.entry.order)
    .slice(0, 8)
    .map(({ entry, shortcode }) => ({ emoji: entry.emoji, shortcode, label: entry.label }));
  if (cache.size >= 128) cache.clear();
  cache.set(normalized, matches);
  return matches;
}

export interface EmojiToken {
  start: number;
  end: number;
  query: string;
  key: string;
}
export function emojiToken(value: string, cursor: number): EmojiToken | undefined {
  const chars = Array.from(value);
  const before = chars.slice(0, cursor).join('');
  const match = /(?:^|[\s([{]):([a-z0-9_+-]{1,64}):?$/i.exec(before);
  if (!match || /[a-z0-9_+-]/i.test(chars[cursor] || '')) return;
  const length = Array.from(match[0].trimStart().replace(/^[([{]/, '')).length;
  const start = cursor - length;
  const end = cursor + (chars[cursor] === ':' ? 1 : 0);
  return { start, end, query: match[1], key: `${start}:${end}:${match[1].toLowerCase()}` };
}
export function insertEmoji(
  value: string,
  token: EmojiToken,
  emoji: string,
): { value: string; cursor: number } {
  const chars = Array.from(value);
  chars.splice(token.start, token.end - token.start, ...Array.from(emoji));
  return { value: chars.join(''), cursor: token.start + Array.from(emoji).length };
}
