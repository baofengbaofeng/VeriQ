import { test, type Page, type TestInfo, type Route } from "@playwright/test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { pathToFileURL } from "node:url";
import {
  validateSchema,
  type AssetSnapshotV1,
  type CompiledCase,
  type ExecutionSnapshotV1,
  type JsonObject,
  type JsonValue,
  type FixtureV1,
  type CleanupStatus,
  type AttemptOutcome,
} from "@veriq/contracts";
import {
  createStepContext,
  type StepContext,
  type StepContextOptions,
  type StepResult,
} from "./context.js";
import { executeStep } from "./execute-step.js";
const fixtureSchemas = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(fixtureSchemas);
export interface CredentialProvider {
  resolve(
    reference: { workspaceId: string; secretRef: string; versionId: string },
    signal: AbortSignal,
  ): Promise<JsonValue>;
}
export interface LifecycleContext {
  page: Page;
  execution: ExecutionSnapshotV1;
  signal: AbortSignal;
  credentials?: CredentialProvider;
}
export interface LifecycleProvider {
  authenticate(context: LifecycleContext): Promise<{ identityId: string }>;
  prepare?(
    fixture: FixtureV1,
    context: LifecycleContext,
  ): Promise<{ variables: JsonObject; cleanupToken: JsonValue }>;
  cleanup?(
    fixture: FixtureV1,
    token: JsonValue | undefined,
    context: LifecycleContext,
  ): Promise<void>;
}
export interface CaseResult {
  outcome: AttemptOutcome;
  businessOutcome: AttemptOutcome;
  cleanupStatus: CleanupStatus;
  steps: StepResult[];
  errorCode?: string;
}
export type SdkEvent =
  | { type: "STEP_FINISHED"; step: StepResult }
  | { type: "CASE_FINISHED"; result: CaseResult };
export interface ExecutionOptions {
  page: Page;
  execution: ExecutionSnapshotV1;
  lifecycle?: LifecycleProvider;
  credentials?: CredentialProvider;
  signal?: AbortSignal;
  files?: StepContextOptions["files"];
  downloads?: StepContextOptions["downloads"];
  emit?: (event: SdkEvent) => Promise<void>;
  redact?: (value: JsonValue) => JsonValue;
}
async function bounded<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectWait: ((e: Error) => void) | undefined;
  const abort = () => {
    controller.abort();
    rejectWait?.(new Error("CANCELLED"));
  };
  const failure = new Promise<never>((_, reject) => {
    rejectWait = reject;
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("LIFECYCLE_TIMEOUT"));
    }, ms);
  });
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  try {
    return await Promise.race([run(controller.signal), failure]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}
export async function executeCase(
  plan: CompiledCase,
  source: AssetSnapshotV1,
  options: ExecutionOptions,
): Promise<CaseResult> {
  const result: CaseResult = {
    outcome: "ERROR",
    businessOutcome: "ERROR",
    cleanupStatus: "NOT_REQUIRED",
    steps: [],
  };
  const execution = structuredClone(options.execution);
  let ctx: StepContext | undefined,
    fixture: FixtureV1 | undefined,
    token: JsonValue | undefined,
    preparing = false;
  let originFailure = false;
  const route = async (r: Route) => {
    const url = new URL(r.request().url());
    if (!execution.environment.allowedOrigins.includes(url.origin)) {
      originFailure = true;
      await r.abort("blockedbyclient");
    } else await r.continue();
  };
  const lifecycleContext = (signal: AbortSignal): LifecycleContext => ({
    page: options.page,
    execution,
    signal,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  async function emit(event: SdkEvent) {
    if (options.emit) {
      if (!options.redact) throw new Error("REDACTION_PROVIDER_REQUIRED");
      await options.emit(
        options.redact(event as unknown as JsonValue) as unknown as SdkEvent,
      );
    }
  }
  try {
    if (validateSchema("ExecutionSnapshotV1", execution).length)
      throw new Error("INVALID_EXECUTION_CONTEXT");
    if (
      execution.workspaceId !== source.workspaceId ||
      execution.assetSourceHash !== source.sourceHash ||
      execution.caseVersionId !== plan.caseVersionId
    )
      throw new Error("EXECUTION_CONTEXT_MISMATCH");
    const catalog = source.assets.find(
      (a) => a.versionId === plan.document.catalogVersionId,
    );
    if (catalog?.kind !== "ELEMENT_CATALOG")
      throw new Error("CATALOG_REQUIRED");
    if (!options.lifecycle?.authenticate)
      throw new Error("AUTH_PROVIDER_REQUIRED");
    if (options.emit && !options.redact)
      throw new Error("REDACTION_PROVIDER_REQUIRED");
    const role = execution.environment.roles.find(
      (r) => r.roleKey === execution.roleKey,
    );
    if (!role) throw new Error("ROLE_NOT_FOUND");
    if (plan.document.fixtureVersionId) {
      const asset = source.assets.find(
        (a) => a.versionId === plan.document.fixtureVersionId,
      );
      if (asset?.kind !== "FIXTURE") throw new Error("FIXTURE_REQUIRED");
      fixture = asset.document;
      if (!options.lifecycle.prepare || !options.lifecycle.cleanup)
        throw new Error("FIXTURE_PROVIDER_REQUIRED");
    }
    await options.page.context().route("**/*", route);
    const identity = await bounded(
      (signal) => options.lifecycle!.authenticate(lifecycleContext(signal)),
      60000,
      options.signal,
    );
    if (
      !identity.identityId ||
      (role.allowedIdentityIds &&
        !role.allowedIdentityIds.includes(identity.identityId))
    )
      throw new Error("IDENTITY_NOT_ALLOWED");
    let variables = execution.variables;
    if (fixture) {
      preparing = true;
      result.cleanupStatus = "PENDING";
      const prepared = await bounded(
        (signal) =>
          options.lifecycle!.prepare!(fixture!, lifecycleContext(signal)),
        60000,
        options.signal,
      );
      token = prepared.cleanupToken;
      if (!fixtureSchemas.compile(fixture.outputSchema)(prepared.variables))
        throw new Error("FIXTURE_OUTPUT_INVALID");
      variables = { ...variables, ...prepared.variables };
    }
    ctx = createStepContext({
      page: options.page,
      environment: execution.environment,
      catalog: catalog.document,
      data: execution.dataRow?.values ?? {},
      vars: variables,
      deadline: Date.now() + 120000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.files ? { files: options.files } : {}),
      ...(options.downloads ? { downloads: options.downloads } : {}),
    });
    result.businessOutcome = plan.steps.length ? "PASSED" : "INCOMPLETE";
    for (const step of plan.steps) {
      const r = await executeStep(step, ctx);
      result.steps.push(r);
      await emit({ type: "STEP_FINISHED", step: r });
      if (r.cancelled) {
        result.businessOutcome = "CANCELLED";
        break;
      }
      if (r.status !== "PASSED") {
        result.businessOutcome = "FAILED";
        if (step.step.failurePolicy !== "CONTINUE") break;
      }
    }
    const allSteps = (steps: StepResult[]): StepResult[] =>
      steps.flatMap((s) => [s, ...allSteps(s.children)]);
    if (plan.document.kind === "WRITE" && result.businessOutcome === "PASSED") {
      const checkpoint = allSteps(result.steps).find(
        (s) => s.id === plan.persistenceCheckpointStepId,
      );
      if (
        !checkpoint ||
        checkpoint.status !== "PASSED" ||
        !checkpoint.assertions.some(
          (a) => a.status === "PASSED" && a.severity !== "WARN",
        )
      ) {
        result.businessOutcome = "FAILED";
        result.errorCode = "PERSISTENCE_CHECKPOINT_FAILED";
      }
    }
    if (originFailure) {
      result.businessOutcome = "FAILED";
      result.errorCode = "ORIGIN_NOT_ALLOWED";
    }
  } catch (e) {
    result.businessOutcome = options.signal?.aborted ? "CANCELLED" : "ERROR";
    result.errorCode =
      e instanceof Error && /^[A-Z_]+$/.test(e.message)
        ? e.message
        : "EXECUTION_ERROR";
  } finally {
    ctx?.dispose();
    if (preparing) {
      try {
        await bounded(
          (signal) =>
            options.lifecycle!.cleanup!(
              fixture!,
              token,
              lifecycleContext(signal),
            ),
          30000,
        );
        result.cleanupStatus = "SUCCEEDED";
      } catch {
        result.cleanupStatus = "FAILED";
        result.errorCode = "CLEANUP_FAILED";
      }
    }
    await options.page
      .context()
      .unroute("**/*", route)
      .catch(() => {});
  }
  result.outcome =
    result.cleanupStatus === "FAILED" ? "ERROR" : result.businessOutcome;
  try {
    await emit({ type: "CASE_FINISHED", result });
  } catch {
    result.outcome = "ERROR";
    result.errorCode = "EVENT_EMISSION_FAILED";
  }
  return result;
}
export type ExecutionContextProvider = (
  info: TestInfo,
) => Promise<Omit<ExecutionOptions, "page">>;
let provider: ExecutionContextProvider | undefined;
/** Called by a trusted worker setup module, never by generated DSL or source context. */
export function configureExecution(
  contextProvider: ExecutionContextProvider,
): void {
  provider = contextProvider;
}
export function registerCase(
  plan: CompiledCase,
  source: AssetSnapshotV1,
): void {
  test.describe(plan.caseVersionId, () => {
    test.describe.configure({ retries: 0 });
    test(plan.document.title, async ({ page }, info) => {
      info.setTimeout(240000);
      if (!provider && process.env.VERIQ_EXECUTION_CONTEXT_MODULE) {
        const module = (await import(
          pathToFileURL(process.env.VERIQ_EXECUTION_CONTEXT_MODULE).href
        )) as { createExecutionContext?: ExecutionContextProvider };
        provider = module.createExecutionContext;
      }
      if (!provider) throw new Error("EXECUTION_CONTEXT_PROVIDER_REQUIRED");
      const options = await provider(info),
        result = await executeCase(plan, source, { ...options, page });
      if (!options.redact) throw new Error("REDACTION_PROVIDER_REQUIRED");
      await info.attach("veriq-result", {
        body: Buffer.from(
          JSON.stringify(options.redact(result as unknown as JsonValue)),
        ),
        contentType: "application/json",
      });
      if (result.outcome !== "PASSED")
        throw new Error(
          `VERIQ_${result.outcome}: ${result.errorCode ?? "CASE_FAILED"}`,
        );
    });
  });
}
