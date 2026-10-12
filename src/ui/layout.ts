import wrapAnsi from 'wrap-ansi';
import stringWidth from './width.js';
import type { Message } from '../types.js';
import { receiptLabel } from '../types.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export interface Line {
  text: string;
  message?: Message;
  meta?: boolean;
  bubbleWidth?: number;
  day?: boolean;
  header?: boolean;
}
export function transcript(
  messages: Message[],
  width: number,
  senderName?: (message: Message) => string,
): Line[] {
  const lines: Line[] = [];
  let day = '';
  for (const m of messages) {
    const date = new Date(m.timestamp * 1000);
    const label = dayFormat.format(date);
    if (label !== day) {
      lines.push({ text: `─ ${label} ─`, meta: true, day: true }, { text: '' });
      day = label;
    }
    const time = timeFormat.format(date);
    if (m.kind === 'system') {
      for (const textLine of wrapAnsi(`· ${m.text} · ${time}`, Math.max(10, width - 3), {
        hard: true,
      }).split('\n'))
        lines.push({ text: `  ${textLine}`, message: m, meta: true });
      lines.push({ text: '', message: m });
      continue;
    }
    const maxWidth = Math.max(12, Math.min(76, Math.floor(width * 0.86)));
    const block: Line[] = [];
    const header = `${m.fromMe ? 'You' : senderName?.(m) || m.sender.split('@')[0]}  ${time}${m.fromMe ? `  ${receiptLabel[m.status]}` : ''}${m.edited ? '  edited' : ''}${m.starred ? '  ★' : ''}`;
    block.push({ text: fit(header, maxWidth - 2), message: m, meta: true, header: true });
    if (m.quotedId)
      block.push({ text: `↳ Reply to ${m.quotedId.slice(-10)}`, message: m, meta: true });
    const media =
      m.kind !== 'text'
        ? `${({ image: '▧ Image', video: '▷ Video', audio: '♫ Audio', document: '▤ File', sticker: '◇ Sticker', contact: '♙ Contact', location: '⌖ Location', poll: '▥ Poll' } as Record<string, string>)[m.kind]}${m.viewOnce ? ' · view once' : ['image', 'sticker', 'video', 'audio', 'document'].includes(m.kind) ? ' · Ctrl+P preview' : ''}\n`
        : '';
    const text = m.deleted ? 'This message was deleted' : media + (m.text || '');
    for (const textLine of wrapAnsi(text, Math.max(10, maxWidth - 2), {
      hard: true,
      trim: false,
    }).split('\n'))
      block.push({ text: textLine, message: m });
    if (Object.keys(m.reactions).length)
      block.push({ text: Object.values(m.reactions).join(' '), message: m, meta: true });
    const bubbleWidth = Math.min(
      maxWidth,
      Math.max(18, ...block.map((line) => stringWidth(line.text) + 2)),
    );
    for (const line of block)
      lines.push({ ...line, text: ` ${pad(line.text, bubbleWidth - 2)} `, bubbleWidth });
    lines.push({ text: '', message: m });
  }
  return lines;
}
export function viewport(lines: Line[], height: number, selectedId?: string | null): Line[] {
  let end = lines.length;
  if (selectedId) {
    const first = lines.findIndex((l) => l.message?.id === selectedId);
    if (first >= 0) end = Math.min(lines.length, first + height - 2);
  }
  while (end > 0 && !lines[end - 1].text.trim()) end--;
  let start = Math.max(0, end - height);
  // Never begin the viewport with a detached reaction or the tail of a bubble
  // when a complete, newer message can fit below it.
  const first = lines[start];
  if (first?.message && first.bubbleWidth && !first.header) {
    const next = lines.findIndex(
      (line, index) =>
        index > start && index < end && !!line.header && line.message?.id !== first.message?.id,
    );
    if (next >= 0) start = next;
  }
  while (start < end && !lines[start].text.trim()) start++;
  const visible = lines.slice(start, end);
  // Very short terminals still show who sent the last message instead of a
  // blank viewport or an unlabelled fragment of a long message.
  if (visible.length >= 2 && visible[0].bubbleWidth && !visible[0].header) {
    const header = lines
      .slice(0, start)
      .findLast((line) => line.message?.id === visible[0].message?.id && line.header);
    if (header) visible[0] = header;
  }
  return visible;
}
export function fit(value: string, width: number): string {
  value = value.replace(/[\r\n\t]/g, ' ');
  if (width <= 0) return '';
  if (stringWidth(value) <= width) return value;
  let text = '';
  for (const { segment } of graphemes.segment(value)) {
    if (stringWidth(text + segment) > width - 1) break;
    text += segment;
  }
  return text + '…';
}
export function pad(value: string, width: number): string {
  const text = fit(value, width);
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}
export function qrText(matrix: { size: number; data: Uint8Array }): string {
  const size = matrix.size;
  const lines: string[] = [];
  const dark = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < size && y < size && !!matrix.data[y * size + x];
  for (let y = -4; y < size + 4; y += 2) {
    let line = '';
    for (let x = -4; x < size + 4; x++)
      line += dark(x, y) ? (dark(x, y + 1) ? '█' : '▀') : dark(x, y + 1) ? '▄' : ' ';
    lines.push(line);
  }
  return lines.join('\n');
}
