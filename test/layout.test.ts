import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from '../src/ui/width.js';
import { fit, pad, transcript, viewport } from '../src/ui/layout.js';
import { normalize } from '../src/messages.js';

test('single-line fitting preserves Indic and emoji graphemes and matches the renderer cell width', () => {
  for (const value of [
    'अब से कचौरी उपलब्ध है।',
    'Dwarika Sweets और नमकीन',
    '👨‍👩‍👧‍👦 👍🏽 🇮🇳 नमस्ते',
    'क्षेत्र कचौरी हिन्दी',
    'Name\nwith\ttabs',
  ]) {
    for (let width = 1; width <= 32; width++) {
      const fitted = fit(value, width);
      assert.ok(stringWidth(fitted) <= width);
      assert.doesNotMatch(fitted, /[\n\r\t]/);
      assert.equal(stringWidth(pad(value, width)), width);
      const original = value.replace(/[\r\n\t]/g, ' ');
      if (fitted.endsWith('…') && fitted !== original) {
        const prefix = fitted.slice(0, -1);
        assert.ok(
          [...new Intl.Segmenter().segment(original)].some(
            (segment) => segment.index + segment.segment.length === prefix.length,
          ) || prefix.length === 0,
        );
      }
    }
  }
});

test('Indic conjunct widths match terminal cells rather than counting each conjunct as one column', () => {
  assert.equal(stringWidth('दोनों आउटलेट पर उपलब्ध है।'), 22);
  assert.equal(stringWidth('अब से कचौरी उपलब्ध है।'), 19);
  assert.equal(stringWidth('क्षेत्र हिन्दी नमस्ते'), 15);
  assert.equal(stringWidth('\x1b[32mक्षेत्र हिन्दी नमस्ते\x1b[0m'), 15);
  assert.equal(stringWidth('👨‍👩‍👧‍👦 👍🏽 🇮🇳'), 8);
});

test('short viewports show a labelled last message and exclude detached reactions from older bubbles', () => {
  const first = normalize({
    key: { remoteJid: '123@s.whatsapp.net', id: 'first', fromMe: true },
    messageTimestamp: 1,
    message: { conversation: 'An older message' },
  })!;
  first.reactions = { other: '💚' };
  const last = normalize({
    key: { remoteJid: '123@s.whatsapp.net', id: 'last' },
    pushName: 'Maya',
    messageTimestamp: 2,
    message: {
      conversation:
        'A long last message which spans several lines and should stay readable in a very short terminal.',
    },
  })!;
  const lines = transcript([first, last], 34);
  const short = viewport(lines, 3);
  assert.equal(short.length, 3);
  assert.equal(short[0].header, true);
  assert.match(short[0].text, /Maya/);
  assert.ok(short.at(-1)?.text.trim());
  const start = lines.findIndex((line) => line.message?.id === 'first' && line.text.includes('💚'));
  assert.ok(viewport(lines, lines.length - start).every((line) => line.message?.id !== 'first'));
});
