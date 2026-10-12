import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { proto as original } from '@whiskeysockets/baileys';
import { lazyProtobuf } from '../scripts/protobuf-lazy.mjs';
import { Store } from '../src/store.js';
import { WhatsAppClient } from '../src/client.js';

const require = createRequire(import.meta.url);
let directory: string;
let proto: typeof original;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'chirp-protobuf-test-'));
  mkdirSync(join(directory, 'protocol'));
  const sourcePath = resolve('node_modules/@whiskeysockets/baileys/WAProto/index.js');
  const generated = lazyProtobuf(
    readFileSync(sourcePath, 'utf8'),
    sourcePath,
    (name: string, body: string) => {
      writeFileSync(
        join(directory, 'protocol', name),
        transformSync(body, { minify: true, platform: 'node', format: 'cjs', target: 'node24' })
          .code,
      );
    },
  );
  const modulePath = join(directory, 'protocol.mjs');
  const source = generated.code.replace(
    '"protobufjs/minimal.js"',
    JSON.stringify(pathToFileURL(require.resolve('protobufjs/minimal.js')).href),
  );
  writeFileSync(
    modulePath,
    transformSync(source, { minify: true, platform: 'node', format: 'esm', target: 'node24' }).code,
  );
  ({ proto } = await import(pathToFileURL(modulePath).href));
});
after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('production protobuf factories persist a timestamped SDK send result and deduplicate its echo', async () => {
  const store = new Store(':memory:');
  const jid = '123@s.whatsapp.net';
  const ev = new EventEmitter();
  let sends = 0;
  let sent: any;
  const socket: any = {
    ev,
    end() {},
    sendMessage: async (_jid: string, content: { text: string }) => {
      sends++;
      sent = proto.WebMessageInfo.fromObject({
        key: { remoteJid: jid, id: 'sent-with-timestamp', fromMe: true },
        messageTimestamp: '1791801000',
        message: { conversation: content.text },
        status: 2,
      });
      return sent;
    },
  };
  const client = new WhatsAppClient(store, directory, undefined, undefined, (() => socket) as any);
  try {
    await client.connect();
    ev.emit('connection.update', { connection: 'open' });
    await client.send(jid, 'Timestamp serialization regression');
    assert.equal(sends, 1);
    assert.equal(store.message(sent.key)?.text, 'Timestamp serialization regression');
    assert.equal(store.message(sent.key)?.timestamp, 1791801000);
    assert.equal(store.message(sent.key)?.status, 'sent');
    assert.equal(store.chat(jid)?.preview, 'Timestamp serialization regression');
    assert.equal(JSON.parse(JSON.stringify(sent)).messageTimestamp, '1791801000');
    ev.emit('messages.upsert', { type: 'notify', messages: [sent] });
    assert.equal(store.stats().messages, 1);
    ev.emit('message-receipt.update', [
      { key: sent.key, receipt: { userJid: jid, readTimestamp: 1791801001 } },
    ]);
    assert.equal(store.message(sent.key)?.status, 'read');
  } finally {
    await client.stop();
    store.close();
  }
});

test('all production protobuf 64-bit fields retain JSON, string and number conversion helpers', () => {
  let checked = 0;
  function walk(actual: any, expected: any, path: string) {
    if (typeof expected === 'function' && typeof expected.create === 'function') {
      const fields = [...expected.toObject.toString().matchAll(/longToString\(m\.(\w+)([^)]*)\)/g)];
      if (fields.length) {
        const input: Record<string, unknown> = {};
        for (const [, field, suffix] of fields) {
          const value = suffix.includes('true') ? '18446744073709551615' : '-9223372036854775808';
          const initial = expected.prototype[field];
          input[field] = Array.isArray(initial)
            ? [value]
            : initial && typeof initial === 'object' && !('low' in initial)
              ? { entry: value }
              : value;
        }
        const reference = expected.fromObject(input);
        const message = actual.decode(actual.encode(actual.fromObject(input)).finish());
        for (const longs of [String, Number])
          assert.deepEqual(
            actual.toObject(message, { longs }),
            expected.toObject(reference, { longs }),
            `${path} ${longs.name}`,
          );
        assert.deepEqual(
          JSON.parse(JSON.stringify(message)),
          JSON.parse(JSON.stringify(reference)),
          `${path} toJSON`,
        );
        checked += new Set(fields.map((field) => field[1])).size;
      }
    }
    for (const key of Object.keys(expected))
      if (typeof expected[key] === 'function' && typeof expected[key].create === 'function')
        walk(actual[key], expected[key], `${path}.${key}`);
  }
  walk(proto, original, 'proto');
  assert.ok(checked > 100, `Expected comprehensive nonempty 64-bit coverage, got ${checked}`);
});
