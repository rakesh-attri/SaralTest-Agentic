---
name: visual-testing
description: Visual QA for Salesforce Lightning and Experience Cloud — screenshot baselines with masking, local layout checks (overlap, clipping, hidden controls, layout shift), page-state checks, viewports and accessibility, and how to report differences as review candidates. Use when planning, generating or reviewing @visual / @ui / @a11y tests.
---

# Visual testing

## Baselines

- `await expect(region).toHaveScreenshot('<page>-<persona>-<viewport>.png', { mask: [...], maxDiffPixelRatio })`.
- Screenshot **regions** (record header, form section, custom LWC), not whole pages — Salesforce chrome changes often.
- Mask: dates/times, record IDs, owner/user names, counters, spinners, avatars, any PII (Full Copy data).
- Baselines are approved with `qa visual approve` (per page × persona × viewport), stored under `tests/visual-baselines/`
  and tagged with the org release; a Salesforce release upgrade marks them "re-approve".

## Local layout checks (no AI needed)

From `locator.boundingBox()` / `elementHandle.evaluate` on the page under test (read-only):
- overlapping interactive elements; text clipped (`scrollWidth > clientWidth`) on labels and buttons;
- required controls missing, hidden (`display:none`, zero size) or off-screen;
- layout shift during load (`PerformanceObserver` 'layout-shift' entries summed);
- blank page / loading never finished / error banner present.

## Viewports

From `config/execution.yaml` (desktop, laptop, tablet). Run `@visual` per viewport; functional tests on desktop only.

## Accessibility

`@axe-core/playwright` scoped to custom LWCs and Experience Cloud pages; accessible names and labels on inputs/buttons;
keyboard focus order through the form (Tab sequence matches visual order).

## Reporting rules

- Every difference is a **candidate** in the visual-diff report (baseline | actual | diff), never an automatic defect.
- The AI may classify a candidate from redacted text + ARIA snapshot; it sees the image only if `allowExternalUpload` is
  true for the run.
- A confirmed visual defect goes through the Defect Judge like any other.
