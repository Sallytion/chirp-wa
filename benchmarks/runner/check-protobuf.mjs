import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { lazyProtobuf } from '../../scripts/protobuf-lazy.mjs';
import { proto as original } from '@whiskeysockets/baileys';

const filename = resolve('node_modules/@whiskeysockets/baileys/WAProto/index.js');
mkdirSync('benchmarks/protocol', { recursive: true });
const rewritten = lazyProtobuf(readFileSync(filename, 'utf8'), filename, (name, contents) =>
  writeFileSync(resolve('benchmarks/protocol', name), contents),
);
writeFileSync('benchmarks/lazy-protobuf-validation.mjs', rewritten.code);
const { proto } = await import('../lazy-protobuf-validation.mjs');
assert.ok(Object.getOwnPropertyDescriptor(proto, 'Message').get);
const first = proto.Message;
assert.equal(proto.Message, first);
assert.equal(Object.getOwnPropertyDescriptor(proto, 'Message').writable, true);
let types = 0;
let enums = 0;
function check(actual, expected, path) {
  if (typeof expected === 'function' && typeof expected.create === 'function') {
    types++;
    assert.deepEqual(
      actual.toObject(actual.decode(actual.encode(actual.fromObject({})).finish()), {
        defaults: true,
      }),
      expected.toObject(expected.fromObject({}), { defaults: true }),
      path,
    );
  }
  for (const key of Object.keys(expected)) {
    const next = expected[key];
    if (typeof next === 'function' && typeof next.create === 'function')
      check(actual[key], next, path + '.' + key);
    else if (
      next &&
      typeof next === 'object' &&
      Object.values(next).every((value) => typeof value === 'number' || typeof value === 'string')
    ) {
      enums++;
      assert.deepEqual(actual[key], next, path + '.' + key);
    }
  }
}
check(proto, original, 'proto');
const examples = [
  {
    key: { remoteJid: '123@s.whatsapp.net', id: 'text', fromMe: true },
    messageTimestamp: '1791801000',
    message: { conversation: 'दोनों आउटलेट पर उपलब्ध है।' },
    status: 3,
  },
  {
    key: { remoteJid: '123@g.us', id: 'image', participant: '456@s.whatsapp.net' },
    messageTimestamp: '1791801000',
    message: {
      imageMessage: {
        caption: 'Photo',
        mediaKeyTimestamp: '1791801000',
        mediaKey: Buffer.from([1, 2, 3]),
        jpegThumbnail: Buffer.from([4, 5]),
      },
    },
  },
  {
    key: { remoteJid: '123@s.whatsapp.net', id: 'edit' },
    messageTimestamp: '1791801000',
    message: {
      protocolMessage: {
        type: 14,
        timestampMs: '1791801000000',
        key: { id: 'text' },
        editedMessage: { conversation: 'Edited text' },
      },
    },
  },
];
for (const example of examples) {
  const before = original.WebMessageInfo.encode(
    original.WebMessageInfo.fromObject(example),
  ).finish();
  const after = proto.WebMessageInfo.encode(proto.WebMessageInfo.fromObject(example)).finish();
  assert.deepEqual(after, before);
  assert.deepEqual(
    proto.WebMessageInfo.toObject(proto.WebMessageInfo.decode(before)),
    original.WebMessageInfo.toObject(original.WebMessageInfo.decode(before)),
  );
  for (const longs of [String, Number])
    assert.deepEqual(
      proto.WebMessageInfo.toObject(proto.WebMessageInfo.decode(before), { longs }),
      original.WebMessageInfo.toObject(original.WebMessageInfo.decode(before), { longs }),
    );
  assert.deepEqual(
    JSON.parse(JSON.stringify(proto.WebMessageInfo.decode(before))),
    JSON.parse(JSON.stringify(original.WebMessageInfo.decode(before))),
  );
}
const result = {
  lazy_descriptors: rewritten.transformed,
  message_types_verified: types,
  enums_verified: enums,
  binary_fixtures: examples.length,
};
writeFileSync('benchmarks/protobuf-validation.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
