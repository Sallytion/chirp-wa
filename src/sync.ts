import type { SyncPhase } from './types.js';

// History completion can arrive before the SDK finishes downloading/applying
// that chunk. Keep the indicator active until its data reaches the local store.
export class ChatSyncTracker {
  private pendingReceived = false;
  private ready = false;
  private paused = false;
  private histories = new Map<number, { started: number; applied: number; complete: boolean }>();
  reset(ready = false) {
    this.ready = ready;
    this.pendingReceived = false;
    this.paused = false;
    this.histories.clear();
  }
  pending() {
    this.pendingReceived = true;
  }
  accountReady() {
    this.ready = true;
  }
  begin(type: number) {
    const previous = this.histories.get(type);
    this.histories.set(type, {
      started: (previous?.started || 0) + 1,
      applied: previous?.applied || 0,
      complete: false,
    });
    this.paused = false;
  }
  applied(type: number, progress?: number | null) {
    const history = this.histories.get(type) || { started: 1, applied: 0, complete: false };
    history.applied = history.started;
    history.complete ||= progress === 100;
    if (history.complete) this.histories.delete(type);
    else this.histories.set(type, history);
    this.paused = false;
  }
  status(type: number, status: 'complete' | 'paused') {
    if (status === 'paused') {
      this.histories.delete(type);
      this.paused = true;
      return;
    }
    const history = this.histories.get(type) || { started: 1, applied: 0, complete: false };
    history.complete = true;
    if (history.applied === history.started) this.histories.delete(type);
    else this.histories.set(type, history);
  }
  pause() {
    this.histories.clear();
    this.paused = true;
  }
  phase(): SyncPhase {
    return this.histories.size
      ? 'syncing'
      : this.paused
        ? 'paused'
        : this.ready && this.pendingReceived
          ? 'synced'
          : 'waiting';
  }
}
