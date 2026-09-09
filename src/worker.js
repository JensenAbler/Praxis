import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { JobStore } from './jobs.js';

export async function runWorker({ dataDirectory, pollIntervalMs = 200, signal } = {}) {
  if (!dataDirectory) throw new Error('PRAXIS_DATA_DIR is required.');
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 1000) throw new Error('Invalid worker poll interval.');
  const workerId = randomUUID();
  let store;
  let locked = false;
  let active = null;
  let started = 0;
  try {
    store = new JobStore(dataDirectory);
    store.acquireWorker(workerId);
    locked = true;
    store.interruptRunning();
    let heartbeat = 0;
    let nextHeartbeat = 0;
    while (!signal?.aborted) {
      if (!active) {
        active = store.claimNext(workerId);
        if (active) {
          started = performance.now();
          heartbeat = 0;
          nextHeartbeat = active.intervalSeconds;
        }
      }
      if (active) {
        const elapsedSeconds = (performance.now() - started) / 1000;
        const heartbeatDue = elapsedSeconds >= nextHeartbeat && nextHeartbeat <= active.durationSeconds;
        const result = store.workerStep({
          jobId: active.id,
          workerId,
          elapsedSeconds,
          heartbeat: heartbeatDue ? ++heartbeat : null,
          finish: elapsedSeconds >= active.durationSeconds ? 'completed' : null,
        });
        if (heartbeatDue) nextHeartbeat = (Math.floor(elapsedSeconds / active.intervalSeconds) + 1) * active.intervalSeconds;
        if (!result.active) active = null;
      }
      try { await delay(pollIntervalMs, undefined, { signal }); } catch (error) {
        if (error.name !== 'AbortError') throw error;
      }
    }
    if (active) {
      store.workerStep({ jobId: active.id, workerId, elapsedSeconds: (performance.now() - started) / 1000, finish: 'interrupted', reason: 'Worker stopped before completion.' });
      active = null;
    }
  } catch (error) {
    if (active && store) {
      try {
        store.workerStep({ jobId: active.id, workerId, elapsedSeconds: (performance.now() - started) / 1000, finish: 'failed', reason: 'Worker encountered an internal error.' });
      } catch { /* The next worker marks an uncommitted terminal result interrupted. */ }
    }
    throw error;
  } finally {
    try { if (locked) store.releaseWorker(workerId); } finally { store?.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runWorker({ dataDirectory: process.env.PRAXIS_DATA_DIR, signal: controller.signal }).catch((error) => {
    console.error(JSON.stringify({ event: 'worker_error', code: error.code ?? 'INTERNAL_ERROR', message: error.message }));
    process.exitCode = 1;
  });
}
