import type { CheckInputs } from './types';

export function validateCheckInputs(required: string[], values: CheckInputs['values']): void {
  if (!Array.isArray(required) || required.length > 8 || required.some(x => typeof x !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(x)) || new Set(required).size !== required.length) throw new Error('Required check inputs must be up to eight distinct simple names');
  if (!values || Array.isArray(values) || typeof values !== 'object' || JSON.stringify(values).length > 32768) throw new Error('Check input data must be an object under 32 KB');
  for (const [name, data] of Object.entries(values)) {
    if (!required.includes(name) || !data || typeof data.revision !== 'string' || !data.revision.trim() || data.revision.length > 100 || typeof data.json !== 'string') throw new Error('Each declared input needs its revision and public JSON text');
    JSON.parse(data.json);
  }
}

export function checkInputEnv(inputs?: CheckInputs): Record<string, string> {
  return inputs ? { SUPERPOSE_CHECK_INPUTS: JSON.stringify(inputs) } : {};
}

// Runs before any project setup/check, without Git credentials. Missing data
// is a verifier error; it is not proof that a product promise was contradicted.
export const CHECK_INPUT_GUARD = `
if [ -n "\${SUPERPOSE_CHECK_INPUTS:-}" ]; then
  node -e 'const s=JSON.parse(process.env.SUPERPOSE_CHECK_INPUTS);for(const n of s.required){if(!s.values[n]||typeof s.values[n].json!=="string"){console.error("Required check input unavailable: "+n);process.exit(94);}JSON.parse(s.values[n].json);}' || exit 94
fi
`;
