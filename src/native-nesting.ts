import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { availableParallelism } from 'node:os';
import type { ContinuousNestingBackend } from '../vendor/dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/types';

import { createNativeProblem } from '../vendor/dxf-editor-v2/src/frontend/lib/continuous-nesting-codec';
export { createNativeProblem };

const active = new Set<Promise<void>>();
export async function waitForNestingExit() { await Promise.allSettled([...active]); }
function terminate(child: ChildProcess) {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 150); force.unref();
  child.once('close', () => clearTimeout(force));
}
export function createNativeNestingBackend(executable: string, signal: AbortSignal): ContinuousNestingBackend {
  return async input => {
    if (signal.aborted) return;
    const started = performance.now();
    const { request, decode, height } = createNativeProblem(input);
    const workers = Math.max(1, Math.min(input.workers ?? 2, 3, Math.floor(availableParallelism() / 2)));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let bestHeight = Math.min(input.seed.usedHeight, input.warmSeed?.usedHeight ?? Infinity);
    const heartbeat = setInterval(() => input.onProgress?.(), 500);
    const run = async (index: number) => {
      if (controller.signal.aborted) return;
      const remaining = Math.floor(input.timeBudgetMs - (performance.now() - started));
      if (remaining < 100) return;
      const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, RAYON_NUM_THREADS: '1' } });
      let diagnostic = '', spawnError: Error | undefined;
      const closed = new Promise<void>(resolve => {
        child.once('error', error => { spawnError = error; });
        child.once('close', () => resolve());
      });
      active.add(closed); void closed.then(() => active.delete(closed));
      child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-4000); });
      child.stdin.on('error', () => {});
      const cancel = () => terminate(child);
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; cancel(); }, remaining + 250);
      const lifeline = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write('\n'); }, 500);
      child.stdin.write(JSON.stringify({ ...request, timeBudgetMs: remaining, rngSeed: [42, 314159, 271828][index] }) + '\n');
      try {
        for await (const line of createInterface({ input: child.stdout })) {
          if (controller.signal.aborted) break;
          if (line.length > 4 * 1024 * 1024) throw new Error('Native Antwort zu groß');
          const message = JSON.parse(line);
          if (message.type === 'start') input.onStart?.({ workers, rngSeed: message.rngSeed, warmStarted: message.warmStarted === true });
          if (message.type === 'solution') {
            const layout = decode(message.solution), usedHeight = height(layout);
            if (usedHeight >= bestHeight - .0001) continue;
            if (await input.onCandidate(layout)) {
              bestHeight = Math.min(bestHeight, usedHeight);
              if (input.stopAtTarget && input.targetLengthMm && usedHeight < input.targetLengthMm - .0001) controller.abort();
            }
          }
        }
        await closed;
        if (spawnError || (child.exitCode !== 0 && !timedOut && !controller.signal.aborted)) throw spawnError || new Error(diagnostic || 'Native Suche beendet');
      } finally {
        clearInterval(lifeline); clearTimeout(deadline); controller.signal.removeEventListener('abort', cancel);
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) terminate(child);
        await closed;
      }
    };
    try {
      const results = await Promise.allSettled(Array.from({ length: workers }, (_, index) => run(index)));
      if (results.every(result => result.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
    } finally { clearInterval(heartbeat); signal.removeEventListener('abort', abort); }
  };
}
