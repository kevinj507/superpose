import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep the old reasoning in the operator's record, outside the replacement
// container. Product code and Git history stay available for selective reuse.
export function retireLocalContext(cwd, archiveDir, evidence) {
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  const archived = [];
  for (const name of ['.experiment', '.superpose']) {
    const source = join(cwd, name);
    if (!existsSync(source)) continue;
    cpSync(source, join(archiveDir, name), { recursive: true });
    rmSync(source, { recursive: true });
    archived.push(name);
  }
  mkdirSync(join(cwd, '.experiment'), { mode: 0o700 });
  writeFileSync(join(cwd, '.experiment/evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  return { archived, archiveDir };
}
