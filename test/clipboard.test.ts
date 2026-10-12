import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { readClipboard } from '../src/clipboard.js';
import { deleteWordAtCursor, moveWordCursor } from '../src/ui/input.js';

test('clipboard images become private PNG attachments and text paste preserves newlines without terminal controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chirp-clipboard-'));
  const png = await sharp({ create: { width: 8, height: 5, channels: 3, background: '#35deb0' } })
    .png()
    .toBuffer();
  const reader = {
    hasImage: () => true,
    getImageBase64: async () => png.toString('base64'),
    hasText: () => false,
    getText: async () => '',
  };
  try {
    const image = await readClipboard(dir, reader);
    assert.equal(image.type, 'image');
    if (image.type === 'image') {
      assert.equal(image.width, 8);
      assert.equal(image.height, 5);
      assert.equal((await sharp(readFileSync(image.path)).metadata()).format, 'png');
      assert.equal(image.path.startsWith(join(dir, 'media')), true);
    }
    const text = await readClipboard(dir, {
      ...reader,
      hasImage: () => false,
      hasText: () => true,
      getText: async () => 'one\r\ntwo\x1b[31m\x1b[0m',
    });
    assert.deepEqual(text, { type: 'text', text: 'one\ntwo' });
    await assert.rejects(
      readClipboard(dir, { ...reader, hasImage: () => false }),
      /no image or text/,
    );
    await assert.rejects(
      readClipboard(dir, {
        ...reader,
        getImageBase64: async () => Buffer.from('not an image').toString('base64'),
      }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('word editing works at the cursor with whitespace, Indic text, emoji, and forward deletion', () => {
  assert.deepEqual(deleteWordAtCursor('hello world', 11, true), { value: 'hello ', cursor: 6 });
  assert.deepEqual(deleteWordAtCursor('hello world  ', 13, true), { value: 'hello ', cursor: 6 });
  assert.deepEqual(deleteWordAtCursor('hello world suffix', 11, true), {
    value: 'hello  suffix',
    cursor: 6,
  });
  const hindi = 'नमस्ते दुनिया';
  assert.deepEqual(deleteWordAtCursor(hindi, Array.from(hindi).length, true), {
    value: 'नमस्ते ',
    cursor: Array.from('नमस्ते ').length,
  });
  const emoji = 'hello 👨‍👩‍👧‍👦';
  assert.deepEqual(deleteWordAtCursor(emoji, Array.from(emoji).length, true), {
    value: 'hello ',
    cursor: 6,
  });
  assert.deepEqual(deleteWordAtCursor('one two', 0, false), { value: ' two', cursor: 0 });
  assert.equal(moveWordCursor('one two', 7, -1), 4);
  assert.equal(moveWordCursor('one two', 0, 1), 3);
});
