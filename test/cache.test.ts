import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { LruMap, SignalCache } from '../src/cache.js';

test('signal cache bounds memory without losing persistent keys on eviction, expiry, or shutdown', async () => {
  let now = 0;
  const cache = new SignalCache(2, 100, () => now);
  const disk = new Map<string, unknown>();
  let reads = 0;
  const store: any = {
    get: async (type: string, ids: string[]) => {
      reads++;
      return Object.fromEntries(ids.map((id) => [id, disk.get(type + '.' + id)]));
    },
    set: async (data: any) => {
      for (const type in data)
        for (const id in data[type]) disk.set(type + '.' + id, data[type][id]);
    },
    clear: () => {
      throw new Error('Persistent credentials must never be cleared during cache cleanup');
    },
  };
  const keys = makeCacheableSignalKeyStore(store, undefined, cache);
  await keys.set({
    session: { a: Buffer.from('a'), b: Buffer.from('b'), c: Buffer.from('c') },
  } as any);
  assert.equal(cache.size, 2);
  assert.equal(disk.size, 3);
  assert.deepEqual((await keys.get('session', ['a'])).a, Buffer.from('a'));
  assert.equal(reads, 1);
  now = 101;
  assert.deepEqual((await keys.get('session', ['a'])).a, Buffer.from('a'));
  assert.equal(reads, 2);
  cache.close();
  assert.equal(cache.size, 0);
  assert.equal(disk.size, 3);
  assert.deepEqual((await keys.get('session', ['b'])).b, Buffer.from('b'));
  assert.equal(reads, 3);
});

test('bounded group cache evicts least recently used metadata and updates existing entries', () => {
  const cache = new LruMap<string, number>(2);
  cache.set('a', 1).set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  cache.set('a', 4).set('d', 5);
  assert.equal(cache.has('c'), false);
  assert.equal(cache.get('a'), 4);
  cache.clear();
  assert.equal(cache.size, 0);
});
