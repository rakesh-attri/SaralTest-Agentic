import { describe, expect, it } from 'vitest';
import type { Runner } from '../../util/exec.js';
import { runList, runTypecheck } from './toolchain.js';

const F = 'tests/generated/SF-219/TC-SF-219-003-last-name.spec.ts';

describe('toolchain result parsing', () => {
  it('maps tsc errors to the generated files', async () => {
    const runner: Runner = () =>
      Promise.resolve({
        code: 2,
        stdout: `${F}(12,5): error TS2304: Cannot find name 'x'.\nsrc/other.ts(1,1): error TS1005: ';' expected.\n`,
        stderr: '',
      });
    const r = await runTypecheck('.', [F], runner);
    expect(r.byFile[F]).toEqual(["12:5 TS2304 Cannot find name 'x'."]);
    expect(r.error).toBeUndefined();
  });

  it('reads listed tests per file from the JSON list reporter (nothing is executed)', async () => {
    const report = {
      suites: [
        {
          file: 'SF-219/TC-SF-219-003-last-name.spec.ts',
          specs: [],
          suites: [{ title: 'SF-219 x', specs: [{ title: 'TC-SF-219-003 Last Name is required' }] }],
        },
      ],
      errors: [],
    };
    const runner: Runner = (_c, args) => {
      expect(args).toEqual(expect.arrayContaining(['test', '--list', '--reporter=json', F]));
      return Promise.resolve({ code: 0, stdout: `noise\n${JSON.stringify(report)}`, stderr: '' });
    };
    const r = await runList('.', [F], runner);
    expect(r.byFile[F]).toEqual(['TC-SF-219-003 Last Name is required']);
  });

  it('a tool that cannot run is reported, never treated as a pass', async () => {
    const runner: Runner = () => Promise.resolve({ code: null, stdout: '', stderr: '', error: 'spawn npx ENOENT' });
    expect((await runList('.', [F], runner)).error).toMatch(/not JSON/);
    expect((await runTypecheck('.', [F], runner)).error).toMatch(/ENOENT/);
  });
});
