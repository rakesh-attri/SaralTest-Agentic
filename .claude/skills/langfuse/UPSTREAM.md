# Upstream source

Vendored, unmodified, from https://github.com/langfuse/skills (`skills/langfuse/`).

- Commit: `f0bcb13088b490c04b3f4870bace17f6d57b199c` (2026-11-10)
- Installed: 2026-11-20
- License: MIT (see `LICENSE`, copyright Langfuse GmbH)

Project rules win over this skill: tracing follows PLAN.md (Phase 0, OpenTelemetry instrumented once,
`@langfuse/otel` span processor switched via `config/observability.yaml`, redaction before export) and
CLAUDE.md rules 10 and 17. Do not paste Langfuse keys into chat or prompts; keys come from `.env` only.

To update: re-clone the upstream repo, diff `skills/langfuse/` against this folder, review, then copy over
and bump the commit above.
