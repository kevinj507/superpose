// Independently checked shared work; preserve it when retiring a plan.
export function completeOnce(effects,id){if(!effects.has(id))effects.set(id,1);return effects.get(id);}
