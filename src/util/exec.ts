import spawn from 'cross-spawn';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failure (ENOENT…) or timeout. */
  error?: string;
}

export type Runner = (
  cmd: string,
  args: readonly string[],
  opts?: { timeoutMs?: number; cwd?: string },
) => Promise<ExecResult>;

/**
 * Run a command without a shell (cross-spawn resolves `.cmd` shims on Windows, so `pnpm`, `sf`, `npx` work and
 * paths with spaces are passed safely as single arguments).
 */
export const run: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(cmd, [...args], { cwd: opts.cwd, windowsHide: true, env: process.env });
    const done = (r: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout, stderr, error: `timed out after ${opts.timeoutMs ?? 30_000} ms` });
    }, opts.timeoutMs ?? 30_000);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      done({ code: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      done({ code, stdout, stderr });
    });
  });
