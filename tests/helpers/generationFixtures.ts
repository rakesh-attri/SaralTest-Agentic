// Synthetic, SF-219-shaped inputs for Test Generator / Reviewer pass 2 unit tests (no org, no model).
import type { ComponentVersion } from '../../src/core/schemas/knowledge.js';
import type { Recipe } from '../../src/core/schemas/data.js';
import type { TestIR } from '../../src/core/schemas/generation.js';
import type { TestCase } from '../../src/core/schemas/testCase.js';
import type { LocatorEntry } from '../../src/knowledge/locatorRegistry.js';
import type { StoredSnapshot } from '../../src/knowledge/snapshotStore.js';
import type { GenerationContext } from '../../src/agents/test-generator/context.js';
import { buildCatalog } from '../../src/agents/test-generator/pageObjects.js';
import { buildDataPlan, recipeHash, SnapshotFacts } from '../../src/sf/data/plan.js';

export const ORG = '00DdN00000uQ5dKUAS';
const SNAP = 'snap-test-1';

function comp(type: string, apiName: string, body: Record<string, unknown>, parent?: string): ComponentVersion {
  return {
    snapshotId: SNAP,
    type,
    apiName,
    hash: `${type}:${apiName}`,
    dataScope: 'org',
    evidenceStatus: 'DECLARED',
    reviewStatus: 'APPROVED',
    ...(parent ? { parent } : {}),
    body,
  };
}
const field = (o: string, f: string, b: Record<string, unknown>): ComponentVersion =>
  comp('Field', `${o}.${f}`, { createable: true, required: false, ...b }, o);

export const SNAPSHOT: StoredSnapshot = {
  info: {
    id: SNAP,
    orgId: ORG,
    orgAlias: 'qa-prod',
    capturedAt: '2026-11-21T00:00:00.000Z',
    sourceType: 'METADATA',
    release: "Winter '27",
    environment: 'LIVE',
    apiVersion: '68.0',
    objects: ['Account', 'Contact'],
    componentCount: 0,
    unknownCount: 0,
  },
  dependencies: [],
  components: [
    comp('SObject', 'Account', { createable: true, deletable: true }),
    comp('SObject', 'Contact', { createable: true, deletable: true }),
    field('Account', 'Name', { type: 'string', length: 255, required: true }),
    field('Account', 'Industry', {
      type: 'picklist',
      picklistValues: [
        { value: 'Technology', active: true },
        { value: 'Banking', active: true },
      ],
    }),
    field('Account', 'BillingCountry', { type: 'string', length: 80 }),
    field('Account', 'QA_Run_Id__c', { type: 'string', length: 50 }),
    field('Contact', 'FirstName', { type: 'string', length: 40 }),
    field('Contact', 'LastName', { type: 'string', length: 80, required: true }),
    field('Contact', 'Email', { type: 'email', length: 80 }),
    field('Contact', 'Phone', { type: 'phone', length: 40 }),
    field('Contact', 'MailingCountry', { type: 'string', length: 80 }),
    field('Contact', 'AccountId', { type: 'reference', referenceTo: ['Account'] }),
    field('Contact', 'LeadSource', {
      type: 'picklist',
      picklistValues: [
        { value: 'Web', active: true },
        { value: 'Phone Inquiry', active: true },
      ],
    }),
    field('Contact', 'QA_Run_Id__c', { type: 'string', length: 50 }),
    comp(
      'ValidationRule',
      'Contact.Phone_Must_Be_10_Digits',
      {
        active: true,
        errorMessage: 'Enter a 10-digit phone number.',
        errorDisplayField: 'Phone',
        errorConditionFormula: 'AND( NOT( ISBLANK( Phone ) ), NOT( REGEX( Phone, "[0-9]{10}" ) ) )',
      },
      'Contact',
    ),
  ],
};

export const RECIPE: Recipe = {
  recipe: 'account-contact',
  approvedBy: 'Test Approver',
  objects: [
    {
      object: 'Account',
      recordType: null,
      fields: { Name: 'QA-{runId}-Acme {synthetic}', Industry: 'Technology', BillingCountry: 'India' },
    },
    {
      object: 'Contact',
      recordType: null,
      parent: { field: 'AccountId', ref: 'Account' },
      fields: {
        FirstName: '{synthetic}',
        LastName: 'QA-{runId}-{synthetic}',
        Email: 'qa+{runId}-{synthetic}@example.invalid',
      },
    },
  ],
  negativeVariants: [
    { name: 'missing-last-name', object: 'Contact', remove: ['LastName'], set: {}, expect: 'rejected' },
  ],
  cleanup: 'reverse-dependency',
};

const MAIN = "getByRole('main')";
const DIALOG = "getByRole('dialog', { name: 'New Contact' })";
const CONTACTS = "getByRole('article', { name: 'Contacts', exact: true })";
function entry(
  page: string,
  scope: string,
  role: string,
  name: string,
  extra: Partial<LocatorEntry> = {},
): LocatorEntry {
  return {
    org: ORG,
    page,
    element: `${role}:${name}`,
    persona: 'system-admin',
    scope,
    role,
    accessibleName: name,
    expression: `${scope.split(' › ').join('.')}.getByRole('${role}', { name: '${name}', exact: true })`,
    strategy: 'role',
    strategyRank: 1,
    lastVerifiedAt: '2026-11-20T00:00:00.000Z',
    verifiedBy: 'explorer',
    observationId: 'obs',
    status: 'ACTIVE',
    environment: 'LIVE',
    ...extra,
  };
}
export const ENTRIES: LocatorEntry[] = [
  entry('account-record', MAIN, 'tab', 'Related'),
  entry('account-record', `${MAIN} › ${CONTACTS}`, 'button', 'New'),
  entry('contact-new', DIALOG, 'textbox', 'First Name', { fieldApiName: 'Contact.FirstName' }),
  entry('contact-new', DIALOG, 'textbox', 'Last Name', { fieldApiName: 'Contact.LastName' }),
  entry('contact-new', DIALOG, 'combobox', 'Account Name', { fieldApiName: 'Contact.AccountId' }),
  entry('contact-new', DIALOG, 'combobox', 'Lead Source', { fieldApiName: 'Contact.LeadSource' }),
  entry('contact-new', DIALOG, 'textbox', 'Mailing Country', { fieldApiName: 'Contact.MailingCountry' }),
  entry('contact-new', DIALOG, 'textbox', 'Phone', { fieldApiName: 'Contact.Phone', status: 'RE_VERIFY' }),
  entry('contact-new', DIALOG, 'button', 'Save'),
  entry('contact-new', DIALOG, 'button', 'Cancel'),
  entry('contact-record', MAIN, 'tab', 'Details'),
];

export function generationContext(): GenerationContext {
  const facts = new SnapshotFacts(SNAPSHOT);
  const plan = buildDataPlan({
    loaded: { recipe: RECIPE, hash: recipeHash(RECIPE), file: 'x' },
    facts,
    org: {
      orgId: ORG,
      alias: 'qa-prod',
      profile: 'dedicated-qa-prod',
      instanceUrl: 'https://x.my.salesforce.com',
      release: 'r',
      runTagField: 'QA_Run_Id__c',
      environment: 'LIVE',
      allowedEmailDomains: ['example.invalid'],
    },
    runId: 'build-preview',
  });
  return {
    storyKey: 'SF-219',
    designRunId: 'run-p3-test',
    snapshotId: SNAP,
    orgAlias: 'qa-prod',
    environment: 'LIVE',
    catalog: buildCatalog({
      entries: ENTRIES,
      org: ORG,
      orgAlias: 'qa-prod',
      environment: 'LIVE',
      persona: 'system-admin',
    }),
    recipes: [{ name: 'account-contact', plan }],
    facts,
    personas: ['system-admin'],
  };
}

/** TC-SF-219-003 shape: Last Name required (UI + declared schema). */
export const CASE: TestCase = {
  id: 'TC-SF-219-003',
  title: 'Last Name is required when creating a Contact',
  requirementIds: ['SF-219-R10'],
  riskIds: [],
  technique: 'error guessing',
  persona: 'system-admin',
  type: 'negative',
  priority: 'P2',
  severity: 'MINOR',
  preconditions: ['Creating a Contact from an Account'],
  steps: [
    {
      action: 'Leave Last Name empty, fill other required fields, and click Save',
      expected: {
        text: 'The Contact is not saved and an error is shown on the Last Name field',
        evidenceLevel: 'APPROVED_REQUIREMENT',
        evidenceIds: ['SF-219#AC2'],
      },
    },
    {
      action: 'Verify system schema and validation constraints for empty Last Name',
      expected: {
        text: 'Save blocked due to schema requirement where Last Name is required and nillable is false',
        evidenceLevel: 'DECLARED_CONFIG',
        evidenceIds: ['OC-002', 'Field:Contact.LastName'],
      },
    },
  ],
  tags: ['@negative', '@P2', '@SF-219', '@persona:system-admin', '@mandatory'],
  reviewStatus: 'APPROVED',
  snapshotId: SNAP,
  reviewReasons: [],
  origin: 'manual-reuse',
  refs: ['AC2'],
  obligationIds: [],
  regressionTier: 'mandatory',
};

export const GOOD_IR: TestIR = {
  caseId: 'TC-SF-219-003',
  data: ['Account'],
  steps: [
    {
      caseStep: 0,
      title: 'Save a new Contact without Last Name',
      actions: [
        { do: 'openNewFromRelatedList', parentRef: 'Account', relatedList: 'Contacts' },
        { do: 'click', element: 'contact-new.saveButton' },
      ],
      assertions: [
        { check: 'fieldError', element: 'contact-new.lastName', expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] } },
        { check: 'visible', element: 'contact-new.root', expect: { caseStep: 0, evidenceIds: ['SF-219#AC2'] } },
      ],
    },
    {
      caseStep: 1,
      title: 'API rejects a Contact without Last Name',
      actions: [],
      assertions: [
        {
          check: 'apiRejects',
          object: 'Contact',
          basedOn: 'Contact',
          fields: {},
          remove: ['LastName'],
          errorCodes: ['REQUIRED_FIELD_MISSING'],
          expect: { caseStep: 1, evidenceIds: ['OC-002'] },
        },
      ],
    },
  ],
  notes: [],
};
