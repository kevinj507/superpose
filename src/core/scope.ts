// Declared scope is a list of path patterns: `**` matches any number of path
// segments, `*` matches within one segment, anything else is literal.

function patternToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      re += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function inScope(path: string, scope: string[]): boolean {
  return scope.some((pattern) => patternToRegExp(pattern).test(path));
}

export function outOfScope(paths: string[], scope: string[]): string[] {
  return paths.filter((p) => !inScope(p, scope));
}
