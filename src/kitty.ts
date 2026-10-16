import { randomInt } from 'node:crypto';
import { imageProcessor } from './image.js';

export type Graphics = 'kitty' | 'blocks';

// Kitty and Ghostty support Unicode placeholders, which keep images inside
// Ink's text layout. Multiplexers would need passthrough, so they use blocks.
export function detectGraphics(env: NodeJS.ProcessEnv = process.env): Graphics {
  if (env.TMUX || env.STY) return 'blocks';
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty') return 'kitty';
  if (env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-ghostty') return 'kitty';
  return 'blocks';
}

// Row/column diacritics from kitty's rowcolumn-diacritics.txt, in order.
const diacritics = (
  '0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357 035B 0363 0364 0365 ' +
  '0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484 0485 0486 0487 0592 0593 0594 0595 0597 ' +
  '0598 0599 059C 059D 059E 059F 05A0 05A1 05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612 0613 0614 0615 ' +
  '0616 0617 0657 0658 0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC 06DF 06E0 06E1 06E2 ' +
  '06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741 0743 0745 0747 0749 074A ' +
  '07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819 081B 081C 081D 081E 081F 0820 0821 0822 ' +
  '0823 0825 0826 0827 0829 082A 082B 082C 082D 0951 0953 0954 0F82 0F83 0F86 0F87 135D 135E 135F 17DD ' +
  '193A 1A17 1A75 1A76 1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D 1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0 1CD1 ' +
  '1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7 1DC8 1DC9 1DCB 1DCC 1DD1 1DD2 1DD3 1DD4 1DD5 ' +
  '1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF 1DE0 1DE1 1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 ' +
  '20D4 20D5 20D6 20D7 20DB 20DC 20E1 20E7 20E9 20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 ' +
  '2DE7 2DE8 2DE9 2DEA 2DEB 2DEC 2DED 2DEE 2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9 2DFA ' +
  '2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4 A8E5 A8E6 A8E7 A8E8 A8E9 ' +
  'A8EA A8EB A8EC A8ED A8EE A8EF A8F0 A8F1 AAB0 AAB2 AAB3 AAB7 AAB8 AABE AABF AAC1 FE20 FE21 FE22 FE23 ' +
  'FE24 FE25 FE26 10A0F 10A38 1D185 1D186 1D187 1D188 1D189 1D1AA 1D1AB 1D1AC 1D1AD 1D242 1D243 1D244'
)
  .split(' ')
  .map((hex) => String.fromCodePoint(parseInt(hex, 16)));
const placeholder = '\u{10EEEE}';
export const MAX_KITTY_ROWS = diacritics.length;

// Each row starts with a placeholder carrying row and column diacritics; the
// following placeholders inherit the row and advance one column each. The
// 24-bit foreground color encodes the image id.
export function kittyPlaceholders(id: number, columns: number, rows: number): string {
  const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
  const lines: string[] = [];
  for (let row = 0; row < Math.min(rows, MAX_KITTY_ROWS); row++)
    lines.push(
      `${color}${placeholder}${diacritics[row]}${diacritics[0]}${placeholder.repeat(Math.max(0, columns - 1))}\x1b[39m`,
    );
  return lines.join('\n');
}
// Transmit a PNG and create a virtual placement (U=1) of columns × rows cells.
// q=2 suppresses replies, so nothing is written back to the input stream.
export function kittyTransmit(id: number, png: Uint8Array, columns: number, rows: number): string {
  const data = Buffer.from(png).toString('base64');
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 4096) chunks.push(data.slice(i, i + 4096));
  return chunks
    .map((chunk, i) => {
      const more = i < chunks.length - 1 ? 1 : 0;
      const control =
        i === 0 ? `a=T,U=1,f=100,t=d,i=${id},c=${columns},r=${rows},q=2,m=${more}` : `m=${more}`;
      return `\x1b_G${control};${chunk}\x1b\\`;
    })
    .join('');
}
export function kittyDelete(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

export interface KittyImage {
  id: number;
  columns: number;
  rows: number;
  transmit: string;
  text: string;
  remove: string;
}
export async function kittyPreview(
  path: string,
  maxColumns: number,
  maxRows: number,
): Promise<KittyImage> {
  const sharp = await imageProcessor();
  const { data, info } = await sharp(path, { limitInputPixels: 20_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  // Terminal cells are roughly 8 × 16 pixels; never enlarge small images.
  const scale = Math.min(1, maxColumns / (info.width / 8), maxRows / (info.height / 16));
  const columns = Math.max(1, Math.round((info.width / 8) * scale));
  const rows = Math.max(1, Math.min(MAX_KITTY_ROWS, Math.round((info.height / 16) * scale)));
  const id = randomInt(1, 0xffffff);
  return {
    id,
    columns,
    rows,
    transmit: kittyTransmit(id, data, columns, rows),
    text: kittyPlaceholders(id, columns, rows),
    remove: kittyDelete(id),
  };
}
