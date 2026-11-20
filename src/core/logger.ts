import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger } from 'pino';

/** Field names always censored, whatever the redactor does (rule 10). */
const SECRET_PATHS = [
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.sessionId',
  '*.apiKey',
  '*.secret',
  '*.authorization',
  '*.Authorization',
  'headers.authorization',
  'headers.Authorization',
];

export interface LoggerOptions {
  level?: pino.Level;
  /** Also write JSON lines to this file (e.g. runs/<runId>/logs/run.log). */
  file?: string;
  /** Deep redaction of every log object (T6 `Redactor.redactValue`). */
  redact?: (obj: Record<string, unknown>) => Record<string, unknown>;
  /** Write to stderr (default) so stdout stays clean for CLI output / --json. */
  console?: boolean;
  base?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const streams: pino.StreamEntry[] = [];
  if (opts.console !== false) streams.push({ level: opts.level ?? 'info', stream: process.stderr });
  if (opts.file) {
    mkdirSync(dirname(opts.file), { recursive: true });
    streams.push({ level: 'debug', stream: pino.destination({ dest: opts.file, sync: true }) });
  }
  const redact = opts.redact;
  return pino(
    {
      level: 'debug',
      base: opts.base ?? null,
      redact: { paths: SECRET_PATHS, censor: '[REDACTED]' },
      formatters: redact ? { log: (obj) => redact(obj) } : {},
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    streams.length ? pino.multistream(streams) : pino.destination({ dest: process.stderr.fd, sync: true }),
  );
}

/** Silent logger for tests. */
export function nullLogger(): Logger {
  return pino({ level: 'silent' });
}
