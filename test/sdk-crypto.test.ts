import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as bridge from 'whatsapp-rust-bridge';
import * as node from '../src/sdk-crypto.js';

test('Node crypto adapter matches the SDK bridge for salted/unsalted HKDF, MD5 and app-state keys', () => {
  for (let i = 0; i < 150; i++) {
    const data = randomBytes(i);
    const salt = i % 2 ? randomBytes(32) : undefined;
    const options = {
      salt,
      info: [
        '',
        'WhatsApp Mutation Keys',
        'WhatsApp Patch Integrity',
        'WhatsApp Image Keys',
        'adv_secret',
        'é\0👍',
      ][i % 6],
    };
    for (const size of [32, 64, 112, 128, 160])
      assert.deepEqual(node.hkdf(data, size, options), bridge.hkdf(data, size, options));
    assert.deepEqual(Array.from(node.md5(data)), Array.from(bridge.md5(data)));
    const expected = bridge.expandAppStateKeys(data);
    const actual = node.expandAppStateKeys(data);
    for (const key of Object.keys(actual) as Array<keyof typeof actual>)
      assert.deepEqual(actual[key], expected[key]);
    expected.free();
  }
});

test('Node LT hash matches bridge subtraction/addition, overflow and reversibility without mutating inputs', () => {
  const expected = new bridge.LTHashAntiTampering();
  const actual = new node.LTHashAntiTampering();
  try {
    for (let i = 0; i < 100; i++) {
      const base = randomBytes(128);
      const copy = Buffer.from(base);
      const subtract = Array.from({ length: i % 5 }, () => randomBytes(32));
      const add = Array.from({ length: i % 7 }, () => randomBytes(32));
      assert.deepEqual(
        actual.subtractThenAdd(base, subtract, add),
        expected.subtractThenAdd(base, subtract, add),
      );
      assert.deepEqual(base, copy);
      assert.deepEqual(
        Array.from(actual.subtractThenAdd(actual.subtractThenAdd(base, [], add), add, [])),
        Array.from(base),
      );
    }
  } finally {
    expected.free();
  }
});
