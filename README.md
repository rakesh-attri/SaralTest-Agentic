# sf-qa-agent — Claude Code starter kit

Plan + rules + skills for building an Autonomous Salesforce AI QA Engineer with Claude Code.

## What's inside

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Rules Claude Code follows while building (read automatically) |
| `PLAN.md` | Architecture, agents, contracts, resilience policy, memory, phases with checklists and exit criteria |
| `.claude/skills/*/SKILL.md` | 15 skills (Salesforce, locators, auth, data, API, Playwright, requirements, test design, exploratory testing, visual testing, safety & approvals, investigation, QA Lead, reporting, learning). Claude Code uses them while building; the runtime agents load the same files. |
| `config/*.example.yaml` | Models (provider-agnostic roles), resilience policy, personas, orgs |
| `.mcp.example.json` | Salesforce DX MCP, Playwright MCP, Atlassian Rovo MCP (JIRA) |
| `templates/` | playwright.config.ts and reporting-labs.config.ts starting points |
| `ci/` | GitHub Actions and Azure Pipelines templates (nightly + PR regression, JWT login) |
| `examples/` | Account → Contact demo story and approved data recipe |

## Start building (Windows)

1. Install Node.js 22 LTS, pnpm, Git, Python 3.12 + `uv`, Salesforce CLI (`sf`), and (optional) Ollama. No Docker needed: tracing goes to Langfuse Cloud (keys in `.env`); Arize Phoenix
   (`uvx arize-phoenix serve`) is an optional local tracer for sensitive runs.
2. Ask your Salesforce admin to create an External Client App with JWT Bearer (see PLAN.md §7b), then authorize each
   test user: `sf org login jwt --client-id <key> --jwt-key-file server.key --username <user> --alias <alias>`.
3. Unzip this kit into an empty folder, `git init`, copy `*.example.*` files to real names and fill them in.
4. Open the folder in a terminal and run `claude`.
5. First prompt to Claude Code:

   > Read CLAUDE.md and PLAN.md. Start Phase 0. Work through its checklist, run typecheck/lint/tests after each task,
   > and stop at the exit criteria to show me `qa doctor` output.

6. Continue one phase at a time: "Start Phase 1", etc. Answer the open decisions in PLAN.md §12 when asked.

Phases 0, 1, 3 and 5 give you a working spec-in → test-out version early; the rest adds intelligence.
