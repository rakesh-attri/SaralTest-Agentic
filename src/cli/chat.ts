import type { Prompter } from './prompter.js';
import type { Autonomy, InputRequest } from '../core/state.js';
import type { QAGraphStateType } from '../graph/state.js';
import { explain, startAnalysis, summary, type Runtime } from './analyze.js';

const HELP = `Commands:
  (paste a story, then a line with only "." to analyse it)
  /file <path>       analyse a spec file (.md .pdf .docx .feature .json .yaml)
  /story <KEY>       analyse a JIRA story
  /tests <path>      add existing manual test cases (.xlsx/.csv) to the next analysis
  /status            summary of the last analysis
  /why <id>          explain a requirement, question (Q1), finding (F-001) or issue from the evidence
  /help              this help
  /quit              leave`;

/**
 * Chat REPL (PLAN.md §7a "Chat / plain-English story"). Questions from the Spec Analyst are asked inline; answers
 * resume the graph. Everything shown comes from the run state / evidence ledger, not from model memory.
 */
export async function chatLoop(
  rt: Runtime,
  rl: Prompter,
  autonomy: Autonomy,
  root: string,
  out: (s: string) => void = (s) => process.stdout.write(`${s}\n`),
): Promise<void> {
  const say = (m: string): void => {
    process.stderr.write(`${m}\n`);
  };
  out(`sf-qa-agent chat (autonomy ${autonomy}). Type /help for commands.`);
  let last: QAGraphStateType | undefined;
  let tests: string[] = [];
  let buffer: string[] = [];

  const analyse = async (inputs: InputRequest[]): Promise<void> => {
    const all = [...inputs, ...tests.map((t) => ({ kind: 'manual-tests' as const, value: t }))];
    last = await startAnalysis(rt, { inputs: all, autonomy, interactive: true, rl }, say);
    out(summary(last, root));
    tests = [];
  };

  for (;;) {
    const line = await rl.ask(buffer.length ? '... ' : 'qa> ');
    if (line === undefined) return; // input closed
    const t = line.trim();
    if (buffer.length || (!t.startsWith('/') && t)) {
      if (t === '.') {
        const text = buffer.join('\n');
        buffer = [];
        if (text.trim()) await analyse([{ kind: 'chat', value: text }]);
      } else buffer.push(line);
      continue;
    }
    const [cmd = '', ...rest] = t.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase()) {
      case '':
        break;
      case '/quit':
      case '/exit':
        return;
      case '/help':
        out(HELP);
        break;
      case '/file':
        if (arg) await analyse([{ kind: 'file', value: arg }]);
        else out('usage: /file <path>');
        break;
      case '/story':
        if (arg) await analyse([{ kind: 'jira', value: arg }]);
        else out('usage: /story <KEY>');
        break;
      case '/tests':
        if (arg) {
          tests.push(arg);
          out(`Manual tests ${arg} will be included in the next analysis.`);
        } else out('usage: /tests <path>');
        break;
      case '/status':
        out(last ? summary(last, root) : 'No analysis yet.');
        break;
      case '/why':
        out(last ? explain(last, arg) : 'No analysis yet.');
        break;
      default:
        out(`Unknown command ${cmd}. /help lists commands.`);
    }
  }
}
