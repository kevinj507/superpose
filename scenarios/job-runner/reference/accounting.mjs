export const RATES = Object.freeze({ small: Object.freeze({ input: 0.001, output: 0.002 }) });
export function estimateCost(requests) {
  const seen = new Set(); let total = 0;
  for (const r of requests) {
    if (r.id && seen.has(r.id)) continue;
    const rate = RATES[r.model];
    if (!rate || !Number.isFinite(r.input) || r.input < 0 || !Number.isFinite(r.output) || r.output < 0) throw new TypeError('invalid request');
    if (r.id) seen.add(r.id);
    total += (r.input * rate.input + r.output * rate.output) / 1000;
  }
  return total;
}
