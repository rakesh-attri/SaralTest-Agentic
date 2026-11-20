// Template: created by `npx reporting-labs init`, then adjusted. runDir is injected by the Runner via env.
import type { ReportingLabsOptions } from 'reporting-labs';

const runDir = process.env.QA_RUN_DIR ?? 'runs/local';

const config: ReportingLabsOptions = {
  title: `SF QA — ${process.env.QA_STORY_KEY ?? 'ad-hoc'}`,
  outputFolder: `${runDir}/reporting-labs`,
  history: { enabled: true, keep: 30 },
  dimensions: ['priority', 'severity', 'feature', 'owner', 'story'],
  links: { story: 'https://<your-site>.atlassian.net/browse/{id}' },
  maskKeys: ['password', 'token', 'sessionId', 'accessToken'],
};

export default config;
