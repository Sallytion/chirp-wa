import baseWidth from 'string-width';
import stripAnsi from 'strip-ansi';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const indic = /[\u0900-\u0dff]/u;

// Legacy terminal cells remain additive across Indic conjunct consonants.
// Preserve clusters when truncating, but account for every printable scalar
// when measuring them. Emoji/CJK retain string-width's existing rules.
export default function cellWidth(
  input: string,
  options?: Parameters<typeof baseWidth>[1],
): number {
  if (!indic.test(input)) return baseWidth(input, options);
  const text = options?.countAnsiEscapeCodes ? input : stripAnsi(input);
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (indic.test(segment))
      for (const character of segment) width += baseWidth(character, options);
    else width += baseWidth(segment, options);
  }
  return width;
}
