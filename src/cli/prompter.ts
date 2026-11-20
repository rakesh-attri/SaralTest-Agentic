import { createInterface, type Interface } from 'node:readline';

/**
 * Line-based prompts that work for a real terminal AND for piped stdin (CI, tests, `Get-Content answers.txt | qa …`).
 * readline's own `question()` loses lines that arrive before it is called; this queues every line instead.
 * `ask()` resolves `undefined` when input has ended, and rejects when the optional signal aborts (wait time over).
 */
export class Prompter {
  private readonly queue: string[] = [];
  private readonly waiters: ((line: string | undefined) => void)[] = [];
  private closed = false;

  constructor(
    private readonly rl: Interface,
    private readonly out: NodeJS.WritableStream = process.stderr,
  ) {
    rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.queue.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(undefined);
    });
  }

  static forStdio(): Prompter {
    const rl = createInterface({
      input: process.stdin,
      ...(process.stdin.isTTY ? { output: process.stderr, terminal: true } : {}),
    });
    return new Prompter(rl);
  }

  ask(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    this.out.write(prompt);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('no answer in time'));
      };
      const waiter = (line: string | undefined): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve(line);
      };
      if (signal?.aborted) {
        reject(new Error('no answer in time'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.rl.close();
  }
}
