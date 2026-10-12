import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';
import { createRequire } from 'node:module';
import { silenceBackgroundConsole } from '../src/ui/console.js';

test('session Buffer dumps and asynchronous dependency warnings never reach TUI streams or get formatted', async () => {
  let output = '';
  let formatted = false;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const target = new Console({ stdout: stream, stderr: stream });
  const originalInfo = target.info;
  const originalWarn = target.warn;
  const session = {
    key: Buffer.from('private session data'),
    [inspect.custom]() {
      formatted = true;
      return 'Buffer dump';
    },
  };
  target.info('Before TUI');
  assert.match(output, /Before TUI/);
  output = '';
  const restore = silenceBackgroundConsole(target);
  try {
    target.info('Closing session:', session);
    target.warn('Session already closed', session);
    target.dir(session);
    target.table(session);
    target.trace('Session error', session);
    target.assert(false, session);
    target.count('session');
    target.time('session');
    target.timeEnd('session');
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        target.error('Asynchronous session error', session);
        resolve();
      }),
    );
    assert.equal(output, '');
    assert.equal(formatted, false);
  } finally {
    restore();
  }
  assert.equal(target.info, originalInfo);
  assert.equal(target.warn, originalWarn);
  target.info('After TUI');
  target.error('Normal command error');
  assert.match(output, /After TUI/);
  assert.match(output, /Normal command error/);
  restore();
  assert.equal(target.info, originalInfo);
});

test('actual libsignal session transitions reproduce the Buffer flash and remain functional with the guard', async () => {
  const { SessionRecord } = createRequire(import.meta.url)('libsignal');
  const record = new SessionRecord();
  const session = {
    indexInfo: { closed: -1, baseKey: Buffer.alloc(32, 1) },
    currentRatchet: { rootKey: Buffer.alloc(32, 2) },
  };
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const target = new Console({ stdout: stream, stderr: stream });
  const originalInfo = console.info;
  let restore: (() => void) | undefined;
  try {
    console.info = target.info.bind(target);
    record.closeSession(session);
    assert.match(output, /Closing session:/);
    assert.match(output, /<Buffer/);
    output = '';
    restore = silenceBackgroundConsole();
    record.openSession(session);
    assert.equal(session.indexInfo.closed, -1);
    await new Promise<void>((resolve) =>
      setImmediate(() => {
        record.closeSession(session);
        resolve();
      }),
    );
    assert.ok(session.indexInfo.closed > 0);
    assert.equal(output, '');
    restore();
    record.openSession(session);
    assert.match(output, /Opening session:/);
  } finally {
    restore?.();
    console.info = originalInfo;
  }
});
