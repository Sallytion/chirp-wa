import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatSyncTracker } from '../src/sync.js';
import { syncLabel } from '../src/ui/SyncStatus.js';

test('restored sessions wait for offline updates, while initial sessions also wait for app-state readiness', () => {
  const sync = new ChatSyncTracker();
  sync.reset(true);
  assert.equal(sync.phase(), 'waiting');
  sync.pending();
  assert.equal(sync.phase(), 'synced');
  sync.reset();
  sync.pending();
  assert.equal(sync.phase(), 'waiting');
  sync.accountReady();
  assert.equal(sync.phase(), 'synced');
});

test('early history milestones cannot mark sync complete before downloaded data is applied', () => {
  const sync = new ChatSyncTracker();
  sync.reset(true);
  sync.pending();
  sync.begin(0);
  sync.status(0, 'complete');
  assert.equal(sync.phase(), 'syncing');
  sync.applied(0);
  assert.equal(sync.phase(), 'synced');
  sync.begin(3);
  sync.applied(3, 40);
  assert.equal(sync.phase(), 'syncing');
  sync.begin(3);
  sync.status(3, 'complete');
  assert.equal(sync.phase(), 'syncing');
  sync.applied(3, 100);
  assert.equal(sync.phase(), 'synced');
  sync.begin(2);
  sync.begin(3);
  sync.applied(3, 100);
  assert.equal(sync.phase(), 'syncing');
  sync.status(2, 'paused');
  assert.equal(sync.phase(), 'paused');
  sync.begin(3);
  sync.applied(3, 100);
  assert.equal(sync.phase(), 'synced');
  sync.begin(6);
  sync.pause();
  assert.equal(sync.phase(), 'paused');
});

test('the sync label survives unrelated notices and distinguishes progress, completion, pause, and contact errors', () => {
  const state = {
    connection: 'open' as const,
    presence: {},
    notice: 'Message sent',
    historyProgress: 42,
    sync: { chats: 'syncing' as const, contacts: 'syncing' as const },
  };
  assert.equal(syncLabel(state), 'Syncing chats & contacts… · 42%');
  assert.equal(
    syncLabel({ ...state, sync: { chats: 'synced', contacts: 'syncing' } }),
    'Syncing contact names…',
  );
  assert.equal(
    syncLabel({ ...state, sync: { chats: 'synced', contacts: 'synced' } }),
    'Sync complete',
  );
  assert.match(syncLabel({ ...state, sync: { chats: 'paused', contacts: 'synced' } }), /paused/);
  assert.match(syncLabel({ ...state, sync: { chats: 'synced', contacts: 'error' } }), /failed/);
});
