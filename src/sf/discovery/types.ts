import { z } from 'zod';

/**
 * Component types discovery produces (salesforce-platform skill harvest checklist). `apiName` conventions:
 * SObject `Contact` · Field `Contact.Phone` · RecordType `Account.Business` · ValidationRule `Contact.Phone_Format` ·
 * ApexTrigger `Contact.ContactTrigger` · Layout `Contact.Contact Layout` · FlexiPage / Flow / ApexClass / LWC by
 * developer name · ObjectPermissions / FieldPermissions `<Profile|PermissionSet>:<name>.<Object>`.
 */
export const COMPONENT_TYPES = [
  'SObject',
  'Field',
  'RecordType',
  'ValidationRule',
  'ApexTrigger',
  'ApexClass',
  'Flow',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'Layout',
  'FlexiPage',
  'Profile',
  'PermissionSet',
  'PermissionSetGroup',
  'ObjectPermissions',
  'FieldPermissions',
  'DuplicateRule',
  'CustomMetadataType',
  'CustomSetting',
] as const;
export const ComponentType = z.enum(COMPONENT_TYPES);
export type ComponentType = z.infer<typeof ComponentType>;

export const DiscoveredComponent = z.object({
  type: ComponentType,
  apiName: z.string(),
  label: z.string().optional(),
  /** Owning object for object-scoped components (Field, ValidationRule, Layout, …). */
  parent: z.string().optional(),
  version: z.string().optional(),
  /** Canonical content used for the hash and the graph. Never record data, never secrets. */
  body: z.record(z.string(), z.unknown()),
  /**
   * DECLARED = read from metadata. UNKNOWN = could not be read (permission / feature off): a placeholder with
   * `apiName` `<parent>.*` or `*` means "this whole area is unknown", which the diff never reports as removed.
   */
  evidenceStatus: z.enum(['DECLARED', 'UNKNOWN']),
});
export type DiscoveredComponent = z.infer<typeof DiscoveredComponent>;

/** A metadata dependency edge (Tooling MetadataComponentDependency or derived from describe / formulas / flows). */
export const Dependency = z.object({
  fromType: z.string(),
  fromName: z.string(),
  toType: z.string(),
  toName: z.string(),
  kind: z.string(),
  source: z.enum(['MetadataComponentDependency', 'describe', 'formula', 'flow', 'apex', 'layout']),
});
export type Dependency = z.infer<typeof Dependency>;

export interface AreaResult {
  area: string;
  ok: boolean;
  count: number;
  /** IssueKind-like reason when the area could not be read. */
  error?: string;
  durationMs: number;
}

export interface DiscoveryResult {
  environment: 'LIVE' | 'FIXTURE';
  orgId: string;
  apiVersion: string;
  objects: string[];
  components: DiscoveredComponent[];
  dependencies: Dependency[];
  areas: AreaResult[];
  startedAt: string;
  finishedAt: string;
}
