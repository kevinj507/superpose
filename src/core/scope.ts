// Declared scope is a list of path patterns: `**` matches any number of path
// segments (including none), `*` matches within one segment, anything else is
// literal. Matching is done segment by segment with a table, not with regular
// expressions, so no pattern can make it backtrack for long: one claim's scope
// can never stall the graph.

const MAX_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 256;

export function validScope(scope: string[]): boolean {
  return scope.length <= MAX_PATTERNS && scope.every((p) => p.length > 0 && p.length <= MAX_PATTERN_LENGTH);
}

// `*` within one segment: classic wildcard matching, O(len(a) * len(b)).
function segmentMatches(pattern: string, text: string): boolean {
  if (!pattern.includes('*')) return pattern === text;
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

function pathMatches(pattern: string, path: string): boolean {
  // Repeated `**` segments mean the same as one.
  const ps = pattern.split('/').filter((seg, i, all) => !(seg === '**' && all[i - 1] === '**'));
  const ts = path.split('/');
  // can[i][j]: pattern segments from i match path segments from j.
  let next = new Array<boolean>(ts.length + 1).fill(false);
  next[ts.length] = true;
  for (let i = ps.length - 1; i >= 0; i--) {
    const cur = new Array<boolean>(ts.length + 1).fill(false);
    for (let j = ts.length; j >= 0; j--) {
      // A trailing `**` means "everything inside", so it needs at least one
      // more segment: `src/**` does not match a file named `src`.
      if (ps[i] === '**' && i === ps.length - 1) cur[j] = j < ts.length;
      else if (ps[i] === '**') cur[j] = next[j]! || (j < ts.length && cur[j + 1]!);
      else cur[j] = j < ts.length && segmentMatches(ps[i]!, ts[j]!) && next[j + 1]!;
    }
    next = cur;
  }
  return next[0]!;
}

export function inScope(path: string, scope: string[]): boolean {
  return scope.some((pattern) => pathMatches(pattern, path));
}

export function outOfScope(paths: string[], scope: string[]): string[] {
  return paths.filter((p) => !inScope(p, scope));
}
