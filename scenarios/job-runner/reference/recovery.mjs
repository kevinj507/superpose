import { completeOnce } from './ledger.mjs';
export function recover(interruption, retry) {
  if (interruption?.cause === 'budget_limit') return { action: 'stop', retry: false };
  if (interruption?.cause === 'capacity_limit') return { action: 'retry', retry: true, result: retry(interruption) };
  return { action: 'unresolved', retry: false };
}
export async function runBatch(jobs, { budget, capacity, effects = new Map() }) {
  if (!Number.isFinite(budget) || budget < 0 || !Number.isInteger(capacity) || capacity < 1) throw new TypeError('invalid limits');
  const completed = [], interrupted = [], queued = [];
  let spend = 0, active = 0, peakConcurrency = 0;
  const pending = [];
  async function execute(job) {
    active++; peakConcurrency = Math.max(peakConcurrency, active);
    try { if (typeof job.execute === 'function') await job.execute();
      else if (Number.isFinite(job.workMs) && job.workMs > 0) await new Promise(resolve => setTimeout(resolve, job.workMs));
      completeOnce(effects, job.id); completed.push({ ...job, state: 'complete', reused: false });
    } finally { active--; }
  }
  for (const job of jobs) {
    if (!job || typeof job.id !== 'string' || !Number.isFinite(job.cost) || job.cost < 0) throw new TypeError('invalid job');
    if (effects.has(job.id)) { completed.push({ ...job, state: 'complete', reused: true }); continue; }
    if (spend + job.cost > budget) { interrupted.push({ id: job.id, cause: 'budget_limit' }); continue; }
    spend += job.cost;
    if (peakConcurrency >= capacity) queued.push(job.id);
    pending.push(execute(job));
    if (pending.length === capacity) await Promise.all(pending.splice(0));
  }
  await Promise.all(pending);
  return { completed, interrupted, queued, peakConcurrency, capacityLimited: queued.length > 0 };
}
