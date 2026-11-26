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
  opts?: {
    timeoutMs?: number;
    cwd?: string;
    /** Extra environment variables (merged over process.env). */
    env?: Record<string, string>;
    /** Called with every output chunk (stdout and stderr) as it arrives — for streaming into a run log. */
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  },
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
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd,
      windowsHide: true,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
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
    child.stdout?.on('data', (d: Buffer) => {
      const t = d.toString('utf8');
      stdout += t;
      opts.onOutput?.(t, 'stdout');
    });
    child.stderr?.on('data', (d: Buffer) => {
      const t = d.toString('utf8');
      stderr += t;
      opts.onOutput?.(t, 'stderr');
    });
    child.on('error', (err) => {
      done({ code: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      done({ code, stdout, stderr });
    });
  });
