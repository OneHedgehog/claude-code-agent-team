/**
 * The end-to-end harness (tasks.md T032).
 *
 * Every `tests/e2e/**` scenario imports from here and from nowhere else under `harness/`, so the
 * seam between "what the suite drives" and "how it reaches GitHub" stays one file wide. R-015's
 * rule — the fixture repository is real and `ScriptedModelClient` is the only substitution — is
 * enforced in `review-run.ts`; this barrel is what makes it the obvious path.
 */

export {
  fixtureEnvironment,
  preflight,
  requireFixtureEnvironment,
  statusOf,
  GATED_BASE_BRANCH,
  UNGATED_BASE_BRANCH,
  HarnessError,
  type FixtureEnvironment,
  type InstallationCredential,
  type FixtureRepositoryRef,
  type PreflightReport,
  type UnmetPrerequisite,
} from "./environment.js";

export {
  createFixtureClient,
  type CreatedResources,
  type EscalationRecord,
  type FixtureClient,
  type FixtureFile,
  type FixturePullRequest,
  type GateRunWait,
  type OpenPullRequestOptions,
  type PostedFinding,
} from "./fixture-repository.js";

export {
  composeAgainstFixture,
  fixtureCheckout,
  isolatedStateDirectory,
  runDaemonUntil,
  runEnvironment,
  runReview,
  type ComposeFixtureOptions,
  type DaemonRun,
  type DaemonRunOptions,
  type ModelCredentialState,
  type ReviewRun,
  type RunEnvironmentOptions,
  type RunReviewOptions,
} from "./review-run.js";

export {
  ledgerAtPlatformReserve,
  ledgerDrawnToReviewerReserve,
  ledgerExhausted,
  saturateHostSlots,
  seedConcludedRound,
  seedCrashedRound,
  ungatedPullRequest,
  type SaturatedHost,
} from "./seeds.js";

export {
  anchoredFinding,
  bothApprove,
  pullRequestLevelFinding,
  response,
  script,
  SCRIPTED_USAGE,
  type FindingOptions,
} from "./scripts.js";
