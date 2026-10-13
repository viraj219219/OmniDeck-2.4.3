// SerialSaveQueue — the single persistence pipeline for one data file.
//
// Invariant: at most ONE write is active at a time, and every write
// serializes the CURRENT in-memory state at the moment it starts (`writeFn`
// must snapshot then, not earlier), so the last write always reflects the
// latest state.
//
//   change A -> save A starts
//   change B while A is writing -> B waits (does not overlap)
//   change C while A is still writing -> B and C COALESCE into one
//       follow-up write that starts after A and captures the state with
//       both changes
//
// request() resolves only after a write that STARTED AFTER the call has
// succeeded — so `await request()` means "the state as of this call is on
// disk" — and rejects with that write's error if it failed. A failed write
// never poisons later ones: the next request() simply tries again with
// whatever the latest state is.

import { registerFlusher } from "../services/ShutdownService.js";

export class SerialSaveQueue {
  /**
   * @param {() => Promise<void>} writeFn performs one complete write of the
   *   current state (snapshotting it synchronously at call time).
   * @param {{name?: string}} [opts] `name` registers the queue with the
   *   shutdown coordinator so app close waits for it.
   */
  constructor(writeFn, { name } = {}) {
    this._writeFn = writeFn;
    this._waiters = [];
    this._active = false;
    this._idleResolvers = [];
    this.lastError = null;
    this.writesStarted = 0;
    this.maxConcurrent = 0; // observable proof of the invariant, for tests
    this._concurrent = 0;
    if (name) {
      registerFlusher(name, {
        flush: () => this.flush(),
        isDirty: () => this.hasPending,
      });
    }
  }

  get hasPending() {
    return this._active || this._waiters.length > 0;
  }

  request() {
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
      this._kick();
    });
  }

  /**
   * Resolves once nothing is active or waiting. If the most recent write
   * FAILED, the state it was carrying is still only in memory, so flush()
   * makes one fresh attempt (and rejects if that fails too) — this is what
   * lets "close the app" or "enter Present Mode" retry a failed save.
   */
  async flush() {
    while (this.hasPending) {
      await new Promise((resolve) => this._idleResolvers.push(resolve));
    }
    if (this.lastError) await this.request();
  }

  _kick() {
    if (this._active || this._waiters.length === 0) return;
    const batch = this._waiters;
    this._waiters = [];
    this._active = true;
    this._concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this._concurrent);
    this.writesStarted += 1;
    (async () => {
      let failure = null;
      try {
        await this._writeFn();
        this.lastError = null;
      } catch (err) {
        failure = err;
        this.lastError = err;
      }
      this._concurrent -= 1;
      this._active = false;
      for (const w of batch) failure ? w.reject(failure) : w.resolve();
      if (this._waiters.length) {
        this._kick();
      } else {
        const resolvers = this._idleResolvers;
        this._idleResolvers = [];
        resolvers.forEach((r) => r());
      }
    })();
  }
}
