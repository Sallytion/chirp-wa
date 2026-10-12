import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emojiToken, insertEmoji, searchEmoji } from '../src/emoji.js';
import { deleteAtCursor, isTerminalBackspace, moveCursor } from '../src/ui/input.js';

test('terminal Backspace sequences stay distinct from forward Delete', () => {
  for (const sequence of ['\x08', '\x7f', '\x1b\x7f', '\x1b[127u', '\x1b[127;1u', '\x1b[8;1u'])
    assert.equal(isTerminalBackspace(sequence), true, JSON.stringify(sequence));
  for (const sequence of ['\x1b[3~', '\x1b[3;2~', '\x1b[57349u', 'x'])
    assert.equal(isTerminalBackspace(sequence), false, JSON.stringify(sequence));
});

test('cursor movement and deletion preserve entire Unicode graphemes', () => {
  for (const emoji of ['😄', '👍🏽', '🇮🇳', '👨‍👩‍👧‍👦', '❤️', 'e\u0301']) {
    const text = `a${emoji}b`;
    const after = 1 + Array.from(emoji).length;
    assert.equal(moveCursor(text, 1, 1), after);
    assert.equal(moveCursor(text, after, -1), 1);
    assert.deepEqual(deleteAtCursor(text, after, true), { value: 'ab', cursor: 1 });
    assert.deepEqual(deleteAtCursor(text, 1, false), { value: 'ab', cursor: 1 });
  }
  assert.deepEqual(deleteAtCursor('abc', 0, true), { value: 'abc', cursor: 0 });
  assert.deepEqual(deleteAtCursor('abc', 3, false), { value: 'abc', cursor: 3 });
});

test('emoji search prefers exact aliases and includes modern emoji and skin tones', () => {
  assert.equal(searchEmoji('smile')[0].emoji, '😄');
  assert.equal(searchEmoji('SMILE')[0].shortcode, 'smile');
  assert.equal(searchEmoji('+1')[0].label, 'thumbs up');
  assert.equal(searchEmoji('thumbsup_tone3')[0].emoji, '👍🏽');
  assert.equal(searchEmoji('melting')[0].emoji, '🫠');
  assert.ok(searchEmoji('happy').length > 1);
  assert.ok(searchEmoji('family').some((item) => item.emoji.includes('\u200d')));
  assert.deepEqual(searchEmoji('zzzz_no_such_emoji'), []);
});

test('completion replaces the colon token at the cursor and preserves surrounding text', () => {
  const value = 'Hi 🌅 (:smile: later';
  const cursor = Array.from('Hi 🌅 (:smile').length;
  const token = emojiToken(value, cursor)!;
  assert.equal(token.query, 'smile');
  assert.deepEqual(insertEmoji(value, token, '😄'), {
    value: 'Hi 🌅 (😄 later',
    cursor: Array.from('Hi 🌅 (😄').length,
  });
  assert.equal(emojiToken(':smile:', 7)?.query, 'smile');
  assert.equal(emojiToken('hello\n:heart', 12)?.query, 'heart');
  for (const value of [
    'https://example.com',
    '12:30',
    'hello:smile',
    '::smile',
    'text :',
    'text :unknown!',
  ])
    assert.equal(emojiToken(value, Array.from(value).length), undefined, value);
  assert.equal(emojiToken(':smile', 4), undefined, 'cursor within an existing alias');
});
