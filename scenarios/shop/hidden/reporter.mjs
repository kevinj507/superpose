// A node:test reporter for check.mjs: one JSON line per top-level test result
// or diagnostic, keeping what tells a failed assertion from a test that could
// not run (the name and code of the error it failed with).
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (data?.nesting !== 0) continue;
    if (type === 'test:diagnostic') yield line({ type: 'diagnostic', message: String(data.message) });
    else if (type === 'test:pass') yield line({ type: 'pass', name: data.name });
    else if (type === 'test:fail') {
      const failure = data.details?.error;
      const cause = failure?.cause;
      const error =
        cause && typeof cause === 'object'
          ? { name: cause.name, code: cause.code, message: String(cause.message ?? '') }
          : { name: failure?.name, code: failure?.code, message: String(cause ?? failure?.message ?? '') };
      yield line({ type: 'fail', name: data.name, failureType: failure?.failureType, error });
    }
  }
}

function line(record) {
  return `${JSON.stringify(record)}\n`;
}
