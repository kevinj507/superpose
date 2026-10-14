export function completeOnce(effects, id) { if (!effects.has(id)) effects.set(id, 1); return effects.get(id); }
