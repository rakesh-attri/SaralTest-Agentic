// MECHANICAL skeleton for TC-SF-219-003 — the Test Generator could not produce a checked test (INVALID_LLM_OUTPUT: test-generator: output still invalid after reflect-retries and fallback).
// Case hash bfbd355eea31feb8 · design run run-p3-live-5. REVIEW_REQUIRED: a human must implement it; it is skipped (fixme).
import { test } from '../../fixtures/index.js';
import { meta } from 'reporting-labs';

test.describe('SF-219 Last Name is required when creating a Contact', () => {
  test.fixme(
    'TC-SF-219-003 Last Name is required when creating a Contact',
    { tag: ['@negative', '@P2', '@SF-219', '@persona:system-admin', '@mandatory', '@mechanical'] },
    async () => {
      meta({
        priority: 'P2',
        severity: 'minor',
        feature: 'Contact',
        story: 'SF-219',
        owner: 'qa-agent',
        testCase: 'TC-SF-219-003',
      });
      await test.step('1. Leave Last Name empty, fill other required fields, and click Save', async () => {
        // Expected (APPROVED_REQUIREMENT): The Contact is not saved and an error is shown on the Last Name field
      });
      await test.step('2. Verify system schema and validation constraints for empty Last Name', async () => {
        // Expected (DECLARED_CONFIG): Save blocked due to schema requirement where Last Name is required and nillable is false
      });
    },
  );
});
