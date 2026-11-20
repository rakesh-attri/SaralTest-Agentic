import type {
  AnalysisFinding,
  Clarification,
  ComponentVersion,
  ManualTestCase,
  Requirement,
  SourceDocument,
} from '../../src/core/schemas/index.js';
import type { OrgCheck } from '../../src/agents/sf-intelligence/schema.js';

/**
 * Small, synthetic SF-219-shaped design input for Phase 3 unit tests (story + BRD + manual tests + org checks +
 * snapshot components). Values are made up for tests; nothing here is read from a real org.
 */
export const SNAP = 'snap-test-1';
const STORY_REF = 'https://jira.example.invalid/browse/SF-219';
const BRD_REF = 'C:\\inputs\\BRD.pdf';

export const docs: SourceDocument[] = [
  {
    docId: 'SF-219',
    source: { type: 'jira', ref: STORY_REF, hash: 'h1' },
    title: 'Add Contacts from Account',
    meta: {},
    text: '',
    warnings: [],
    sections: [
      { ref: 'S3', kind: 'text', text: 'Mailing address should probably default from the Account.' },
      { ref: 'AC1', kind: 'ac', text: 'Creating a Contact from the Account sets Account Name to that Account.' },
      { ref: 'AC2', kind: 'ac', text: 'Saving without Last Name is blocked and an error is shown on Last Name.' },
      { ref: 'AC3', kind: 'ac', text: 'An invalid Email blocks save.' },
      { ref: 'AC5', kind: 'ac', text: 'A Phone that is not 10 digits blocks save.' },
      { ref: 'AC6', kind: 'ac', text: 'A Read Only user cannot create or edit Contacts.' },
    ],
  },
  {
    docId: 'BRD-CON-012',
    source: { type: 'file', ref: BRD_REF, hash: 'h2' },
    title: 'BRD',
    meta: {},
    text: '',
    warnings: [],
    sections: [
      { ref: 'BR-02', kind: 'rule', text: 'Last Name is required. Maximum length is 80 characters.' },
      { ref: 'BR-03', kind: 'rule', text: 'Email must be a valid address and is required.' },
      { ref: 'BR-04', kind: 'rule', text: 'Phone must have 10 digits; required when Lead Source is Web.' },
      { ref: 'BR-09', kind: 'rule', text: 'Account Number_of_Contacts__c updates immediately.' },
      { ref: 'A-02', kind: 'assumption', text: 'Titles are published by Sales Operations.' },
    ],
  },
];

const src = (doc: 'S' | 'B', section: string) => ({
  type: doc === 'S' ? ('jira' as const) : ('file' as const),
  ref: doc === 'S' ? STORY_REF : BRD_REF,
  hash: doc === 'S' ? 'h1' : 'h2',
  section,
});

const req = (
  id: string,
  type: Requirement['type'],
  sources: Requirement['sources'],
  extra: Partial<Requirement> = {},
): Requirement => ({
  id,
  title: id,
  businessObjective: `${id} objective`,
  actors: [],
  personas: [],
  preconditions: [],
  actions: [],
  businessRules: [],
  expectedOutcomes: [`${id} outcome`],
  dependencies: [],
  dataRequirements: [],
  risk: 'MEDIUM',
  assumptions: { known: [], unknown: [] },
  sources,
  type,
  status: 'EXECUTABLE',
  reviewReasons: [],
  ...extra,
});

export const requirements: Requirement[] = [
  req('SF-219-R36', 'functional', [src('S', 'S3'), src('S', 'AC1')], {
    risk: 'HIGH',
    status: 'REVIEW_REQUIRED',
    businessObjective: 'Every Contact created from the Account page is linked to that Account',
    expectedOutcomes: ['The Contact is linked to the Account'],
  }),
  req('SF-219-R10', 'validation', [src('S', 'AC2'), src('B', 'BR-02')], {
    expectedOutcomes: ['The Contact is not saved and an error is shown on the Last Name field'],
  }),
  req('SF-219-R41', 'validation', [src('S', 'AC3'), src('B', 'BR-03')]),
  req('SF-219-R14', 'validation', [src('S', 'AC5'), src('B', 'BR-04')], { status: 'REVIEW_REQUIRED' }),
  req('SF-219-R16', 'security', [src('S', 'AC6')], { risk: 'HIGH', personas: ['Read Only User'] }),
  req('SF-219-R23', 'data', [src('B', 'BR-09')], {
    businessObjective: 'Account Number_of_Contacts__c updates immediately when a Contact is added',
  }),
];

export const findings: AnalysisFinding[] = [
  {
    id: 'F-001',
    kind: 'AMBIGUITY',
    text: 'Vague wording "probably"',
    refs: ['SF-219#S3'],
    requirementIds: ['SF-219-R36'],
    severity: 'MEDIUM',
    origin: 'lint',
  } as unknown as AnalysisFinding,
];

export const clarifications: Clarification[] = [
  {
    id: 'Q1',
    requirementIds: ['SF-219-R14'],
    refs: ['BR-04'],
    question: 'Is Phone required when Lead Source is Web?',
    round: 1,
    status: 'ASSUMED',
    assumption: 'Phone is required only when Lead Source is Web',
  },
];

const check = (
  id: string,
  kind: OrgCheck['check'],
  result: OrgCheck['result'],
  subject: string,
  orgFact: string,
  refs: string[],
  requirementIds: string[],
  evidence: OrgCheck['evidence'] = [],
): OrgCheck => ({
  id,
  check: kind,
  subject,
  result,
  evidenceLevel: result === 'EXISTS' || result === 'CONSISTENT' ? 'DECLARED_CONFIG' : 'UNKNOWN_OR_CONTRADICTORY',
  orgFact,
  evidence,
  requirementIds,
  refs,
  findingIds: [],
  snapshotId: SNAP,
  environment: 'LIVE',
});

export const orgChecks: OrgCheck[] = [
  check(
    'OC-002',
    'required',
    'CONSISTENT',
    'Last Name is required',
    'Contact.LastName: required in the schema',
    ['AC2', 'BR-02'],
    ['SF-219-R10'],
    [{ componentType: 'Field', apiName: 'Contact.LastName', detail: 'nillable=false' }],
  ),
  check(
    'OC-003',
    'required',
    'CONFLICT',
    'Email is required',
    'Contact.Email is optional in the schema',
    ['AC3', 'BR-03'],
    ['SF-219-R41'],
  ),
  check(
    'OC-004',
    'format',
    'CONSISTENT',
    'Email format is validated',
    'Contact.Email is an Email-type field',
    ['AC3', 'BR-03'],
    ['SF-219-R41'],
    [{ componentType: 'Field', apiName: 'Contact.Email', detail: 'type=email' }],
  ),
  check(
    'OC-006',
    'required',
    'CONFLICT',
    'Business Phone is required',
    'Contact.Phone is optional',
    ['AC5', 'BR-04'],
    ['SF-219-R14'],
  ),
  check(
    'OC-007',
    'format',
    'CONSISTENT',
    'Phone must have 10 digits',
    'Contact.Phone_Must_Be_10_Digits active',
    ['AC5', 'BR-04'],
    ['SF-219-R14'],
    [{ componentType: 'ValidationRule', apiName: 'Contact.Phone_Must_Be_10_Digits', detail: 'active format rule' }],
  ),
  check(
    'OC-009',
    'persona',
    'EXISTS',
    'persona "Read Only User" maps to org security',
    'Profile "Read Only" exists',
    ['AC6'],
    ['SF-219-R16'],
    [{ componentType: 'Profile', apiName: 'Read Only', detail: 'Profile' }],
  ),
  check(
    'OC-010',
    'permission',
    'CONSISTENT',
    'Read Only cannot create or edit Contact',
    'profile Read Only on Contact: read=true, create=false, edit=false',
    ['AC6'],
    ['SF-219-R16'],
    [{ componentType: 'ObjectPermissions', apiName: 'Profile:Read Only.Contact', detail: 'create=false edit=false' }],
  ),
  check(
    'OC-013',
    'existence',
    'NOT_FOUND',
    'Number_of_Contacts__c exists on Account / Contact',
    'no field Number_of_Contacts__c',
    ['BR-09'],
    ['SF-219-R23'],
  ),
];

const cv = (
  type: string,
  apiName: string,
  body: Record<string, unknown>,
  extra: Partial<ComponentVersion> = {},
): ComponentVersion => ({
  snapshotId: SNAP,
  type,
  apiName,
  hash: `${type}:${apiName}`,
  dataScope: 'metadata',
  evidenceStatus: 'DECLARED',
  reviewStatus: 'APPROVED',
  parent: apiName.split('.')[0],
  body,
  ...extra,
});

export const components: ComponentVersion[] = [
  cv('SObject', 'Contact', {}, { parent: undefined }),
  cv(
    'Field',
    'Contact.LastName',
    { label: 'Last Name', type: 'string', length: 80, required: true, nillable: false },
    { label: 'Last Name' },
  ),
  cv(
    'Field',
    'Contact.Phone',
    { type: 'phone', length: 40, required: false, nillable: true },
    { label: 'Business Phone' },
  ),
  cv('Field', 'Contact.Email', { type: 'email', length: 80, required: false, nillable: true }, { label: 'Email' }),
  cv('ValidationRule', 'Contact.Phone_Must_Be_10_Digits', {
    active: true,
    errorConditionFormula: 'AND(NOT(ISBLANK(Phone)), NOT(REGEX(Phone, "[0-9]{10}")))',
    errorMessage: 'Phone must be exactly 10 digits.',
  }),
  cv('ValidationRule', 'Contact.Old_Rule', { active: false, errorConditionFormula: 'false', errorMessage: 'old' }),
  cv('ApexTrigger', 'Contact.ContactTrigger', { active: true }),
  cv(
    'ObjectPermissions',
    'Profile:Read Only.Contact',
    { create: false, read: true, edit: false, delete: false },
    { parent: 'Contact' },
  ),
];

export const manualTests: ManualTestCase[] = [
  {
    id: 'MTC-001',
    title: 'Create Contact from Account related list',
    requirementRefs: ['AC1', 'BR-01'],
    persona: 'Sales Rep',
    preconditions: [],
    steps: ['Open Account', 'Contacts > New', 'Save'],
    expected: 'Contact saved; Account Name = Acme Test',
    lastRun: { status: 'PASS' },
    source: { type: 'manual-test', ref: 'C:\\inputs\\tests.xlsx', hash: 'h3', section: 'MTC-001' },
  },
  {
    id: 'MTC-002',
    title: 'Last Name required',
    requirementRefs: ['AC2'],
    persona: 'Sales Rep',
    preconditions: [],
    steps: ['New Contact without Last Name', 'Save'],
    expected: 'Error on Last Name',
    lastRun: { status: 'FAIL', date: '2026-10-28' },
    source: { type: 'manual-test', ref: 'C:\\inputs\\tests.xlsx', hash: 'h3', section: 'MTC-002' },
  },
];
