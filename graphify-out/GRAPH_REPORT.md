# Graph Report - SaralTest-Agentic  (2026-11-27)

## Corpus Check
- 345 files · ~347,861 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 9 file(s) not represented in the graph (top: (none) 5, .css 2, .example 1)

## Summary
- 3372 nodes · 10395 edges · 118 communities (109 shown, 9 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 233 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5c9a7537`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- SnapshotFacts
- server.ts
- errors.ts
- ContactRecordPage
- judge_model.py
- harvest.ts
- cli/jiraComment.ts
- results.ts
- data.test.ts
- AccountRecordPage
- classifyError
- a11y.spec.ts
- report/execution.ts
- engine.ts
- chunkers.ts
- router.ts
- mcp/client.ts
- fixtures/index.ts
- doctor.test.ts
- SnapshotStore
- dependencies
- visual-helpers.test.ts
- runDoctor.ts
- pass2.ts
- ContactEditForm
- NewContactDialog
- coder
- vitest
- inputs/index.ts
- package.json
- cli/jiraComment.ts
- zod
- test-generator/graph.ts
- structured.ts
- spec-analyst/graph.ts
- approve.ts
- obligations.ts
- test-reviewer/graph.ts
- QAError
- compilerOptions
- guarded.ts
- buildReport.ts
- EvidenceIndex
- collect.ts
- steps
- design.test.ts
- test-planner/graph.ts
- GuardedSalesforce
- steps
- orgs
- build.ts
- knowledge.test.ts
- browserState.ts
- SqliteCheckpointSaver
- test-generator/context.ts
- pageObjects.ts
- execute.ts
- sf/context.ts
- fields
- backfill-spec-deps.ts
- probe-coder.ts
- explorer.ts
- snapshotStore.ts
- RequirementIdStore
- cli/discover.ts
- ModelRouter
- test-generator/context.ts
- expression.ts
- analyze.ts
- testCase.ts
- dataFactory.ts
- visual
- tracing.ts
- validate-build.ts
- cli/discover.ts
- report/execution.ts
- loader.ts
- index.js
- observability.example.yaml
- edits
- execute.ts
- Redactor
- decisions/SF-219.yaml
- orgPolicy.ts
- support/layout.ts
- core/state.ts
- scripts
- schemas/visual.ts
- designReport.ts
- registerObserve
- fixture/formula.ts
- atlassian-rovo
- personas
- issues
- playwright.visual.config.ts
- ref_node_path
- visual/visual.test.ts
- initTracing
- JsforceApi
- SfReader
- messages.ts
- ref_node_crypto
- TestData
- policy.yaml
- eslint-plugin-sf-locators/package.json
- allowBuilds
- record-page.js
- manifest.json
- hardStops
- security
- RedactingSpanProcessor
- waitMinutes
- .prettierrc.json
- exploration
- approvals
- retry
- qa-eval

## God Nodes (most connected - your core abstractions)
1. `QAError` - 161 edges
2. `ContactRecordPage` - 77 edges
3. `AccountRecordPage` - 73 edges
4. `Redactor` - 73 edges
5. `zod` - 73 edges
6. `vitest` - 69 edges
7. `NewContactDialog` - 58 edges
8. `classifyError()` - 52 edges
9. `startFixtureServer()` - 48 edges
10. `SnapshotStore` - 46 edges

## Surprising Connections (you probably didn't know these)
- `project()` --calls--> `makeTempProject()`  [EXTRACTED]
  src/doctor/doctor.test.ts → tests/helpers/tempProject.ts
- `WorkerFixtures` --references--> `GuardedSalesforce`  [EXTRACTED]
  tests/fixtures/index.ts → src/sf/client.ts
- `generationContext()` --calls--> `SnapshotFacts`  [EXTRACTED]
  tests/helpers/generationFixtures.ts → src/sf/data/plan.ts
- `test` --calls--> `QAError`  [EXTRACTED]
  tests/fixtures/index.ts → src/core/errors.ts
- `test` --calls--> `WriteLedger`  [EXTRACTED]
  tests/fixtures/index.ts → src/security/idempotency.ts

## Import Cycles
- None detected.

## Communities (118 total, 9 thin omitted)

### Community 0 - "SnapshotFacts"
Cohesion: 0.18
Nodes (5): messages(), refreshCaseWording(), changedSnapshot(), SnapshotFacts, SNAPSHOT

### Community 1 - "server.ts"
Cohesion: 0.06
Nodes (55): ADMIN, fixtureDir, READONLY, applyLayout(), fixtureContactLayouts(), FixtureLayout, FORM_FIELDS, loadFixtureLayout() (+47 more)

### Community 2 - "errors.ts"
Cohesion: 0.07
Nodes (50): admin, seed, admin, FIXTURE_DIR, requirements, seed, SECRET_ENV_KEYS, Autonomy (+42 more)

### Community 4 - "judge_model.py"
Cohesion: 0.06
Nodes (19): DeepEvalBaseLLM, Endpoint, extract_json(), load_chain_from_env(), _openai_client(), OpenAICompatibleJudge, ProviderLimiter, RateLimited (+11 more)

### Community 5 - "harvest.ts"
Cohesion: 0.09
Nodes (44): formulaFieldRefs(), FormulaRefs, KEYWORDS, RelationshipMap, stripLiteralsAndComments(), add(), decodeValidFor(), dep() (+36 more)

### Community 6 - "cli/jiraComment.ts"
Cohesion: 0.16
Nodes (23): createRuntime(), offlineFetch(), registerIngest(), Say, registerJiraComment(), runOrgId(), Say, jiraBaseUrl() (+15 more)

### Community 7 - "results.ts"
Cohesion: 0.10
Nodes (23): GateItem, root, runIds, Environment, ResultCleanup, Annotation, Attachment, caseIdOf() (+15 more)

### Community 8 - "data.test.ts"
Cohesion: 0.10
Nodes (26): ApiName, CleanupEntry, DataPlanIssue, DataPlanIssueCode, FieldCheck, FieldSource, NegativePlan, NegativeVariant (+18 more)

### Community 10 - "classifyError"
Cohesion: 0.09
Nodes (36): ALL, issue(), NONE, applyReorder(), handledInside(), LATER_PHASE, NodeCapabilities, RESOLUTION (+28 more)

### Community 11 - "a11y.spec.ts"
Cohesion: 0.06
Nodes (40): @playwright/test, ComponentShape, DescribeLayout, DescribeLayouts, DescribeSection, ExpectedOrder, expectedTabOrder(), fieldsOf() (+32 more)

### Community 12 - "report/execution.ts"
Cohesion: 0.24
Nodes (19): caseOf(), renderCleanup(), renderExecutionHtml(), renderExecutionReport(), renderImpactCoverage(), renderReleaseConfidence(), resultOf(), stateCell() (+11 more)

### Community 13 - "engine.ts"
Cohesion: 0.23
Nodes (14): CleanupReport, CreatedRecord, DataPlan, NegativeOutcome, RecordVerification, SubRunOutcome, DataClient, DataEngineOptions (+6 more)

### Community 14 - "chunkers.ts"
Cohesion: 0.07
Nodes (27): MockEmbeddings, approxTokens(), Chunk, chunkLocators(), chunkManualTests(), chunkRequirements(), chunkSnapshot(), chunkSourceDocument() (+19 more)

### Community 15 - "router.ts"
Cohesion: 0.05
Nodes (71): @langchain/google-genai@^2.3.6, @langchain/ollama@^1.3.0, @langchain/openai@^1.8.4, @langchain/core, @langchain/google-genai, @langchain/ollama, @langchain/openai, EnvKey (+63 more)

### Community 16 - "mcp/client.ts"
Cohesion: 0.08
Nodes (23): HardStopReason, mcpCheck(), needsOAuth(), remoteUrl(), defaultDeps(), defaultProbeBrowser(), isPlaceholder(), ToolAllowList (+15 more)

### Community 17 - "fixtures/index.ts"
Cohesion: 0.21
Nodes (24): reporting-labs, soqlString(), fitUnique(), personaId(), test, fieldPath(), historyFields(), name() (+16 more)

### Community 18 - "doctor.test.ts"
Cohesion: 0.13
Nodes (13): @modelcontextprotocol/sdk, deps(), fakeFetch(), okRun(), ONLINE, project(), roots, allow (+5 more)

### Community 19 - "SnapshotStore"
Cohesion: 0.16
Nodes (14): createBuild(), observedFor(), createDesignHook(), planExecution(), LineageEntry, SnapshotInfo, json(), newSnapshotId() (+6 more)

### Community 20 - "dependencies"
Cohesion: 0.05
Nodes (41): dependencies, apache-arrow@^21.2.0, commander@^15.1.0, cross-spawn@^7.0.6, @cucumber/gherkin@^43.0.0, @cucumber/messages@^35.0.0, dotenv@^18.0.10, exceljs@^4.4.0 (+33 more)

### Community 21 - "visual-helpers.test.ts"
Cohesion: 0.09
Nodes (41): ElementBox, observeLayoutShift(), Clip, contentClip(), COUNTER_PATTERN, DATE_PATTERNS, EMAIL_PATTERN, escapeRegExp() (+33 more)

### Community 22 - "runDoctor.ts"
Cohesion: 0.08
Nodes (39): Env, AllConfigResults, CONFIG_NAMES, ProjectPaths, BrowserName, configCheck(), secretsCheck(), defaultVerifyIdentity() (+31 more)

### Community 23 - "pass2.ts"
Cohesion: 0.09
Nodes (42): AttemptRecord, BUILD_TIME_VALUE, fieldErrorRule(), GeneratedSpec, writePageObjects(), A11Y_SCOPE_NOTE, ToolchainResult, astViolations() (+34 more)

### Community 26 - "coder"
Cohesion: 0.06
Nodes (38): budgets, minutesPerRun, tokensPerRun, fallback, model, provider, responseFormat, temperature (+30 more)

### Community 27 - "vitest"
Cohesion: 0.07
Nodes (42): vitest, elsewhere, QA, root, LoggerOptions, nullLogger(), SECRET_PATHS, initialRunState() (+34 more)

### Community 28 - "inputs/index.ts"
Cohesion: 0.06
Nodes (74): RFC-4180, QAError, ChangedComponent, DefectRecord, ExploratoryObjective, SectionKind, htmlToText(), Item (+66 more)

### Community 29 - "package.json"
Cohesion: 0.07
Nodes (37): bin, qa, description, devDependencies, @axe-core/playwright@4.14.0, cross-env@^10.1.0, eslint-config-prettier@^10.1.8, @eslint/js@^10.0.1 (+29 more)

### Community 30 - "cli/jiraComment.ts"
Cohesion: 0.13
Nodes (23): JiraCommentDraft, releaseConfidence(), COMMENT_TOOL, commentSubject(), draftJiraComment(), failureKind(), McpCaller, PUBLISH_CHECKPOINT (+15 more)

### Community 31 - "zod"
Cohesion: 0.09
Nodes (37): zod, root, CrossCheckInput, SpecAnalystInput, SpecAnalystResult, LintRule, decide(), DecideOptions (+29 more)

### Community 32 - "test-generator/graph.ts"
Cohesion: 0.26
Nodes (13): caseHash(), fill(), GenerateResult, generateTests(), generatorPrompt(), loadPrompts(), recipeText(), hashText() (+5 more)

### Community 33 - "structured.ts"
Cohesion: 0.15
Nodes (20): composeSystemPrompt(), converse(), errMessage(), escapeControlCharsInStrings(), extractJson(), parseLenient(), runStructured(), schemaText() (+12 more)

### Community 34 - "spec-analyst/graph.ts"
Cohesion: 0.06
Nodes (40): analyzeSpec(), CLARIFICATION_DOC_ID, clarificationDocument(), fill(), identifiedItems(), loadPrompts(), mechanicalDrafts(), significantWords() (+32 more)

### Community 35 - "approve.ts"
Cohesion: 0.16
Nodes (28): executionConfig(), orgOf(), registerVisual(), Say, visualSummaryText(), BaselineRecord, VISUAL_REGIONS, VisualRunSummary (+20 more)

### Community 36 - "obligations.ts"
Cohesion: 0.13
Nodes (28): componentsOf(), denyPersona(), deriveObligations(), escape(), fieldFor(), NEGATIVE_CHECKS, objectsIn(), ObligationInput (+20 more)

### Community 37 - "test-reviewer/graph.ts"
Cohesion: 0.07
Nodes (38): pino, args, result, ri, root, DesignEnvironment, PlannerContext, PlanResult (+30 more)

### Community 38 - "QAError"
Cohesion: 0.23
Nodes (6): DataPlanStep, reconcileRun(), DataEngine, emailDomains(), errText(), sfErrorCodes()

### Community 39 - "compilerOptions"
Cohesion: 0.06
Nodes (31): compilerOptions, noEmit, outDir, rootDir, exclude, extends, include, compilerOptions (+23 more)

### Community 40 - "guarded.ts"
Cohesion: 0.08
Nodes (18): HardStopError, TimeoutError, defaultSleep(), checkVectors(), DEFAULT_429_COOLDOWN_MS, estimateTokens(), GuardedChatModel, GuardedEmbeddings (+10 more)

### Community 41 - "buildReport.ts"
Cohesion: 0.62
Nodes (6): banners(), BuildSummary, renderBuildHtml(), renderBuildReport(), summarizeBuild(), writeBuildReport()

### Community 42 - "EvidenceIndex"
Cohesion: 0.10
Nodes (21): RefIndex, EvidenceLevel, ExpectedResult, DesignSummary, APPROVED_KINDS, CITABLE_TYPES, componentLevel(), componentText() (+13 more)

### Community 43 - "collect.ts"
Cohesion: 0.13
Nodes (20): BaselineManifest, layoutFindingKey(), sha256Buffer(), A11yAttachment, A11yViolation, Attachment, body(), CollectInput (+12 more)

### Community 44 - "steps"
Cohesion: 0.06
Nodes (30): GOOGLE_API_KEY, JIRA_API_TOKEN, JIRA_EMAIL, story, jobs, qa, name, on (+22 more)

### Community 45 - "design.test.ts"
Cohesion: 0.09
Nodes (29): base, index, personas, configured, ctx, index, obligations, obligationsRaw (+21 more)

### Community 46 - "test-planner/graph.ts"
Cohesion: 0.08
Nodes (49): batches(), buildCases(), buildCharter(), buildRtm(), caseEvidence(), designedRows(), draftProblems(), fill() (+41 more)

### Community 47 - "GuardedSalesforce"
Cohesion: 0.09
Nodes (11): MutationGuard, ApiVersion, ApiVersions, AUTH_CODES, isAuthError(), QueryOptions, QueryPage, SfApi (+3 more)

### Community 48 - "steps"
Cohesion: 0.07
Nodes (29): include, GOOGLE_API_KEY, JIRA_API_TOKEN, artifact, secureFile, targetPath, versionSpec, pool (+21 more)

### Community 49 - "orgs"
Cohesion: 0.07
Nodes (29): authorization, blocked, bulk, cleanupDefault, confirmBulkDeleteOver, mutations, mutations, orgs (+21 more)

### Community 50 - "build.ts"
Cohesion: 0.11
Nodes (39): commander, runDryRun(), createReadline(), loadAnswersFile(), parseModelChain(), startAnalysis(), summary(), registerAuth() (+31 more)

### Community 51 - "knowledge.test.ts"
Cohesion: 0.26
Nodes (9): changedKeys(), DiffSide, diffSnapshots(), isPlaceholder(), key(), unknownCover(), canonicalJson(), contentHash() (+1 more)

### Community 52 - "browserState.ts"
Cohesion: 0.10
Nodes (29): playwright, PageEnv, RunExplorerInput, DryRunPagesInput, RunDryRunInput, catalog(), ENTRIES, ExecutionConfig (+21 more)

### Community 53 - "SqliteCheckpointSaver"
Cohesion: 0.14
Nodes (9): @langchain/langgraph, decode(), encode(), SqliteCheckpointSaver, Storage, dirs, S, threadOfWriteKey() (+1 more)

### Community 54 - "test-generator/context.ts"
Cohesion: 0.18
Nodes (26): canonicalList(), dialogForList(), action(), isCreateSave(), listRegion(), nameFieldOf(), navigationShorthand(), normalizeIr() (+18 more)

### Community 55 - "pageObjects.ts"
Cohesion: 0.11
Nodes (20): buildCatalog(), camel(), CatalogMember, doc(), FIELD_IN_DETAILS, joinPath(), LIST_IN_RELATED, memberName() (+12 more)

### Community 56 - "execute.ts"
Cohesion: 0.17
Nodes (16): Browser, Autonomy, BrowserChoice, BrowserProbe, playwrightProbe(), resolveBrowser(), ExecuteDeps, ExecuteOptions (+8 more)

### Community 57 - "sf/context.ts"
Cohesion: 0.07
Nodes (31): Seed, FakeFetch, jwtEnv, keyDir, keyFile, liveOrg, noKeyring(), persona (+23 more)

### Community 58 - "fields"
Cohesion: 0.08
Nodes (24): approvedBy, cleanup, BillingCity, BillingCountry, BillingPostalCode, BillingStreet, Email, FirstName (+16 more)

### Community 59 - "backfill-spec-deps.ts"
Cohesion: 0.09
Nodes (29): catalog, ctxCache, file, manifest, org, root, store, GenerationContext (+21 more)

### Community 60 - "probe-coder.ts"
Cohesion: 0.09
Nodes (19): args, Call, content(), gp, loader, maxTokens, models, noTools (+11 more)

### Community 61 - "explorer.ts"
Cohesion: 0.12
Nodes (26): ACTIONABLE_ROLES, AriaNode, parseAriaSnapshot(), SCOPE_ROLES, assetsFromRegistry(), Capture, CONTACT_EDIT_ROOT, contactEditForm (+18 more)

### Community 62 - "snapshotStore.ts"
Cohesion: 0.09
Nodes (31): DiscoverInput, discoverOrg(), DiscoverOutcome, esc(), writeDiscoveryReport(), OrgCrossCheck, DiffChange, DiffEntry (+23 more)

### Community 63 - "RequirementIdStore"
Cohesion: 0.28
Nodes (3): SpecAnalystDeps, idPrefix(), RequirementIdStore

### Community 64 - "cli/discover.ts"
Cohesion: 0.13
Nodes (23): crossCheckEvidence(), crossCheckFindings(), refreshStaleMarks(), registryLookup(), StaleRefresh, storiesWithManifest(), storyManifestFile(), snapshotCurrency() (+15 more)

### Community 65 - "ModelRouter"
Cohesion: 0.09
Nodes (16): RunStructuredOptions, GeneratorDeps, ReviewerDeps, Pass2Deps, RuntimeOptions, ModelRef, ModelRole, DesignDeps (+8 more)

### Community 66 - "test-generator/context.ts"
Cohesion: 0.13
Nodes (25): acceptedMessage(), bindRecipe(), caseCorpus(), caseObjects(), CLICKABLE, derivableErrorCodes(), DISPLAYED_AS_ENTERED, featureOf() (+17 more)

### Community 67 - "expression.ts"
Cohesion: 0.22
Nodes (15): check(), dryRunPages(), applyLocator(), ArgValue, Cursor, LocatorCall, METHODS, parseChain() (+7 more)

### Community 68 - "analyze.ts"
Cohesion: 0.07
Nodes (37): @opentelemetry/api, ReorderHook, AnalyzeOptions, AnswersFile, applyRoleChains(), AskOptions, collectAnswers(), drive() (+29 more)

### Community 69 - "testCase.ts"
Cohesion: 0.13
Nodes (17): ASSERTABLE_LEVELS, CaseOrigin, isAssertable(), isAutomatable(), RtmStatus, TestCase, TestStep, applyCaseEdits() (+9 more)

### Community 70 - "dataFactory.ts"
Cohesion: 0.21
Nodes (18): registerData(), Say, sayCleanup(), sayPlan(), Approval, subRunDirs(), ApprovalStore, checkpointRequired() (+10 more)

### Community 71 - "visual"
Cohesion: 0.10
Nodes (19): a11y, customNamespaces, standardNamespaces, browser, fallbackBrowser, headless, testIdAttribute, viewports (+11 more)

### Community 72 - "tracing.ts"
Cohesion: 0.09
Nodes (19): @opentelemetry/core@^2.12.1, @opentelemetry/resources@~2.9.0, @opentelemetry/sdk-trace-base@^2.12.0, @opentelemetry/sdk-trace-node@~2.12.1, @opentelemetry/core, @opentelemetry/resources, @opentelemetry/sdk-trace-base, @opentelemetry/sdk-trace-node (+11 more)

### Community 73 - "validate-build.ts"
Cohesion: 0.19
Nodes (17): args, fail(), lines, ok(), parse(), result, root, runs (+9 more)

### Community 74 - "cli/discover.ts"
Cohesion: 0.17
Nodes (13): blocksBlank(), C, crossCheckRequirements(), escapeRe(), GENERIC_PERSONAS, Index, phrase(), refsOf() (+5 more)

### Community 75 - "report/execution.ts"
Cohesion: 0.14
Nodes (18): ManualOnlyCase, ReleaseConfidence, ReleaseVerdict, RunHistoryEntry, ResultState, acsFromRtm(), CharterFile, countBy() (+10 more)

### Community 76 - "loader.ts"
Cohesion: 0.12
Nodes (13): CONFIG_SCHEMAS, ConfigError, ConfigName, ConfigOf, exists(), findPlaceholders(), formatZodIssues(), loadAllConfig() (+5 more)

### Community 77 - "index.js"
Cohesion: 0.13
Nodes (11): eslint@^10.15.0, typescript-eslint@^8.73.0, BANNED_SELECTOR_PATTERNS, fragileReason(), noFragileLocators, plugin, SELECTOR_METHODS, URL_PATTERNS (+3 more)

### Community 78 - "observability.example.yaml"
Cohesion: 0.11
Nodes (17): exporters, langfuse, phoenix, includeScreenshots, enabled, onExporterError, perOrgProfile, prod-test-org (+9 more)

### Community 79 - "edits"
Cohesion: 0.11
Nodes (17): decidedBy, decidedOn, dropSteps, caseId, reason, step, edits, caseId (+9 more)

### Community 80 - "execute.ts"
Cohesion: 0.17
Nodes (19): staleReason(), ExecutionSummary, ManifestArtifact, StateCounts, StoryManifest, TestResult, ReportData, countStates() (+11 more)

### Community 81 - "Redactor"
Cohesion: 0.15
Nodes (8): isSecretKey(), PII_FIELDS, PiiCategory, REDACTED, Redactor, RedactorOptions, SECRET_KEYS, SECRET_PATTERNS

### Community 82 - "decisions/SF-219.yaml"
Cohesion: 0.12
Nodes (16): answers, answer, expectedOutcomes, id, resolvesFindings, settlesRequirement, decidedBy, decidedOn (+8 more)

### Community 83 - "orgPolicy.ts"
Cohesion: 0.17
Nodes (10): OrgProfile, MutationRequest, decide(), deny(), intentOf(), MutationIntent, OrgPolicyOptions, ORG (+2 more)

### Community 84 - "support/layout.ts"
Cohesion: 0.21
Nodes (15): layoutFindingFails(), VisualRegion, analyzeLayout(), analyzePageState(), area(), checkLayout(), collectLayout(), collectPageState() (+7 more)

### Community 85 - "core/state.ts"
Cohesion: 0.12
Nodes (18): activeBudget, BudgetTracker, currentBudget(), runWithBudget(), BudgetExceededError, applyUpdate(), NodeCtx, NodeFn (+10 more)

### Community 86 - "scripts"
Cohesion: 0.12
Nodes (17): scripts, build, format, format:check, graph:update, lint, qa, test (+9 more)

### Community 87 - "schemas/visual.ts"
Cohesion: 0.17
Nodes (14): A11yBaselineEntry, A11yFinding, A11yFindingStatus, A11yRegionCheck, CandidateStatus, LayoutBaselineEntry, LayoutFinding, LayoutFindingKind (+6 more)

### Community 88 - "designReport.ts"
Cohesion: 0.53
Nodes (8): banners(), LEVELS, renderDesignHtml(), renderTestCases(), renderTestPlan(), summarizeDesign(), writeDesignReport(), writeRtmXlsx()

### Community 89 - "registerObserve"
Cohesion: 0.29
Nodes (5): observedMessagesFile(), registerObserve(), renderObserveReport(), ObservedMessage, ObservedMessageStore

### Community 90 - "fixture/formula.ts"
Cohesion: 0.23
Nodes (12): blank(), cache, errorConditionHolds(), evaluate(), FormulaError, Node, parse(), PREC (+4 more)

### Community 91 - "atlassian-rovo"
Cohesion: 0.15
Nodes (12): atlassian-rovo, blocked, mutate, observe, playwright, blocked, mutate, observe (+4 more)

### Community 92 - "personas"
Cohesion: 0.15
Nodes (12): defaultPersona, missingPersonaPolicy, nonAdminCheckRequiredFor, personas, id, permissionSets, profile, recordTypes (+4 more)

### Community 93 - "issues"
Cohesion: 0.15
Nodes (13): issues, AMBIGUOUS_SPEC, AUTH, BUDGET, DATA, ENVIRONMENT, HARD_STOP, INVALID_LLM_OUTPUT (+5 more)

### Community 94 - "playwright.visual.config.ts"
Cohesion: 0.19
Nodes (11): projects, reportingLabs, s, personaIds, personas, projects, s, viewports (+3 more)

### Community 95 - "ref_node_path"
Cohesion: 0.08
Nodes (17): built, root, yaml, Att, PwRes, PwSpec, PwTest, root (+9 more)

### Community 96 - "visual/visual.test.ts"
Cohesion: 0.27
Nodes (10): snapshotName(), VISUAL_BASELINE_CHECKPOINT, approve(), deps(), fakeFindings(), FakeOpts, fakeSpawn(), run() (+2 more)

### Community 97 - "initTracing"
Cohesion: 0.22
Nodes (9): @arizeai/openinference-instrumentation-langchain@^4.2.1, @langfuse/otel@^6.1.1, @opentelemetry/exporter-trace-otlp-proto@0.223.2, @arizeai/openinference-instrumentation-langchain, @langfuse/otel, @opentelemetry/exporter-trace-otlp-proto, warnVia(), initTracing() (+1 more)

### Community 99 - "SfReader"
Cohesion: 0.32
Nodes (5): RetryOptions, RagStoreOptions, SfReader, DiscoveryOptions, retrying()

### Community 100 - "messages.ts"
Cohesion: 0.22
Nodes (11): AttemptOutcome, closePopovers(), describedText(), field(), messageFromAriaSnapshot(), MessageSf, observeMessages(), attempt() (+3 more)

### Community 102 - "ref_node_crypto"
Cohesion: 0.18
Nodes (7): DataWrite, DataWriteState, ALLOWED, idempotencyKey(), LedgerEvent, WriteLedger, DataSession

### Community 105 - "policy.yaml"
Cohesion: 0.20
Nodes (9): autonomy, checkpoints, defectPublication, enabled, fieldMapping, project, healing, allowAssertionChanges (+1 more)

### Community 106 - "eslint-plugin-sf-locators/package.json"
Cohesion: 0.22
Nodes (8): description, exports, main, name, private, type, types, version

### Community 107 - "allowBuilds"
Cohesion: 0.22
Nodes (8): allowBuilds, core-js, core-js-pure, esbuild, onnxruntime-node, protobufjs, sharp, packages

### Community 109 - "record-page.js"
Cohesion: 0.36
Nodes (5): clearErrors(), close(), closeList(), open(), setPicklist()

### Community 111 - "manifest.json"
Cohesion: 0.25
Nodes (7): artifacts, buildRun, designRun, environment, manualOnly, org, storyKey

### Community 112 - "hardStops"
Cohesion: 0.29
Nodes (7): hardStops, identityMismatch, metadataWrites, profileForbiddenMutation, secretsInPrompts, unlistedOrg, untaggedDataCleanup

### Community 113 - "security"
Cohesion: 0.29
Nodes (7): security, allowExternalUpload, auditLog, defaultBlocked, idempotencyKeys, reconcileUncertainWrites, redactPii

### Community 115 - "waitMinutes"
Cohesion: 0.33
Nodes (6): clarification, maxQuestionsPerRound, waitMinutes, L1, L2, L3

### Community 116 - ".prettierrc.json"
Cohesion: 0.33
Nodes (5): endOfLine, printWidth, semi, singleQuote, trailingComma

### Community 117 - "exploration"
Cohesion: 0.40
Nodes (5): exploration, maxCharters, minutesPerRun, priority, promoteFindingsVia

### Community 118 - "approvals"
Cohesion: 0.50
Nodes (4): approvals, L1, L2, L3

### Community 119 - "retry"
Cohesion: 0.67
Nodes (3): retry, backoffSeconds, maxAttempts

## Knowledge Gaps
- **2 isolated node(s):** `qa-eval`, `RFC-4180`
  These have ≤1 connection - possible missing edges. (Counts symbols only; 1220 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `zod` connect `zod` to `server.ts`, `errors.ts`, `harvest.ts`, `cli/jiraComment.ts`, `results.ts`, `data.test.ts`, `classifyError`, `a11y.spec.ts`, `chunkers.ts`, `router.ts`, `mcp/client.ts`, `dependencies`, `runDoctor.ts`, `inputs/index.ts`, `package.json`, `structured.ts`, `spec-analyst/graph.ts`, `obligations.ts`, `test-reviewer/graph.ts`, `collect.ts`, `test-planner/graph.ts`, `GuardedSalesforce`, `build.ts`, `browserState.ts`, `pageObjects.ts`, `sf/context.ts`, `backfill-spec-deps.ts`, `explorer.ts`, `snapshotStore.ts`, `cli/discover.ts`, `ModelRouter`, `analyze.ts`, `testCase.ts`, `validate-build.ts`, `report/execution.ts`, `loader.ts`, `orgPolicy.ts`, `core/state.ts`, `schemas/visual.ts`, `ref_node_path`, `ref_node_crypto`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **What connects `qa-eval`, `RFC-4180` to the rest of the system?**
  _2 weakly-connected nodes found - possible missing edges._
- **Should `server.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06142728093947606 - nodes in this community are weakly interconnected._
- **Why does `QAError` connect `inputs/index.ts` to `errors.ts`, `cli/jiraComment.ts`, `results.ts`, `data.test.ts`, `classifyError`, `engine.ts`, `chunkers.ts`, `router.ts`, `mcp/client.ts`, `fixtures/index.ts`, `SnapshotStore`, `runDoctor.ts`, `pass2.ts`, `cli/jiraComment.ts`, `zod`, `test-generator/graph.ts`, `structured.ts`, `spec-analyst/graph.ts`, `approve.ts`, `test-reviewer/graph.ts`, `QAError`, `guarded.ts`, `test-planner/graph.ts`, `GuardedSalesforce`, `build.ts`, `browserState.ts`, `execute.ts`, `sf/context.ts`, `explorer.ts`, `cli/discover.ts`, `ModelRouter`, `expression.ts`, `analyze.ts`, `dataFactory.ts`, `execute.ts`, `core/state.ts`, `registerObserve`, `JsforceApi`, `ref_node_crypto`?**
  _High betweenness centrality (0.067) - this node is a cross-community bridge._
- **Should `errors.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07372229760289462 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `vitest` to `SnapshotFacts`, `server.ts`, `errors.ts`, `cli/jiraComment.ts`, `results.ts`, `data.test.ts`, `classifyError`, `a11y.spec.ts`, `chunkers.ts`, `router.ts`, `fixtures/index.ts`, `doctor.test.ts`, `visual-helpers.test.ts`, `runDoctor.ts`, `pass2.ts`, `inputs/index.ts`, `package.json`, `cli/jiraComment.ts`, `structured.ts`, `spec-analyst/graph.ts`, `design.test.ts`, `knowledge.test.ts`, `browserState.ts`, `SqliteCheckpointSaver`, `pageObjects.ts`, `sf/context.ts`, `explorer.ts`, `test-generator/context.ts`, `analyze.ts`, `testCase.ts`, `tracing.ts`, `validate-build.ts`, `report/execution.ts`, `loader.ts`, `index.js`, `orgPolicy.ts`, `core/state.ts`, `fixture/formula.ts`, `ref_node_path`, `visual/visual.test.ts`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Should `ContactRecordPage` be split into smaller, more focused modules?**
  _Cohesion score 0.030303030303030304 - nodes in this community are weakly interconnected._