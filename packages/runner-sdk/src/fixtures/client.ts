import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { FixtureV1, JsonObject, JsonValue } from "@veriq/contracts";
import type { LifecycleContext, LifecycleProvider } from "../register-case.js";
import { authorizedURL } from "../http.js";
import { authenticatedRequest, authenticateBusiness } from "./auth.js";
const schemas = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(schemas);
export interface FixtureRequest {
  fixture: FixtureV1;
  context: LifecycleContext;
}
export interface FixtureContext extends FixtureRequest {
  fixtureId: string;
  namespace: string;
  variables: JsonObject;
  cleanupToken: JsonValue;
}
export interface CleanupReceipt {
  status: "CLEANED" | "ALREADY_CLEANED";
  fixtureId?: string;
}
function envelope(context: LifecycleContext) {
  const e = context.execution;
  return {
    workspaceId: e.workspaceId,
    caseExecutionId: e.caseExecutionId,
    attemptNo: e.attemptNo,
    namespace: e.namespace,
    idempotencyKey: `${e.workspaceId}:${e.caseExecutionId}:${e.attemptNo}`,
  };
}
async function call(
  request: FixtureRequest,
  operation: "prepare" | "cleanup",
  token?: JsonValue,
): Promise<JsonObject> {
  const { context, fixture } = request;
  const identity = context.execution.environment.fixtureIdentity,
    base = context.execution.environment.fixtureBaseURL;
  if (!identity || !base) throw new Error("FIXTURE_IDENTITY_REQUIRED");
  const endpoint = fixture[operation],
    url = authorizedURL(
      endpoint.path,
      base,
      context.execution.environment.allowedOrigins,
    ).href;
  const authenticated = await authenticatedRequest(context, identity, base);
  try {
    const response = await authenticated.client.fetch(url, {
      method: endpoint.method,
      data: {
        ...envelope(context),
        ...(operation === "prepare"
          ? {
              input: context.fixtureInput ?? {},
              ttlSeconds: fixture.ttlSeconds,
            }
          : { ...(token === undefined ? {} : { cleanupToken: token }) }),
      },
      maxRedirects: 0,
      maxRetries: 0,
      timeout: 15000,
    });
    try {
      if (response.status() === 409) throw new Error("FIXTURE_CONFLICT");
      if (!response.ok()) throw new Error("FIXTURE_REQUEST_FAILED");
      return (await response.json()) as JsonObject;
    } finally {
      await response.dispose();
    }
  } catch (error) {
    if (context.signal.aborted) throw new Error("CANCELLED");
    if (error instanceof Error && error.message === "FIXTURE_CONFLICT")
      throw error;
    // Playwright's call log includes request headers; never expose it as an error.
    throw new Error("FIXTURE_REQUEST_FAILED");
  } finally {
    await authenticated.dispose();
  }
}
export async function prepareFixture(
  request: FixtureRequest,
): Promise<FixtureContext> {
  if (
    !schemas.compile(request.fixture.inputSchema)(
      request.context.fixtureInput ?? {},
    )
  )
    throw new Error("FIXTURE_INPUT_INVALID");
  const result = await call(request, "prepare");
  request.context.protect?.(result.cleanupToken ?? null);
  if (
    typeof result.fixtureId !== "string" ||
    result.namespace !== request.context.execution.namespace ||
    !Object.hasOwn(result, "cleanupToken")
  )
    throw new Error("FIXTURE_RESPONSE_INVALID");
  if (!schemas.compile(request.fixture.outputSchema)(result.variables))
    throw new Error("FIXTURE_OUTPUT_INVALID");
  return {
    ...request,
    fixtureId: result.fixtureId,
    namespace: result.namespace,
    variables: result.variables as JsonObject,
    cleanupToken: result.cleanupToken!,
  };
}
export async function cleanupFixture(
  context: FixtureRequest & { cleanupToken?: JsonValue },
): Promise<CleanupReceipt> {
  const result = await call(context, "cleanup", context.cleanupToken);
  if (result.status !== "CLEANED" && result.status !== "ALREADY_CLEANED")
    throw new Error("CLEANUP_RESPONSE_INVALID");
  return {
    status: result.status,
    ...(typeof result.fixtureId === "string"
      ? { fixtureId: result.fixtureId }
      : {}),
  };
}
export function createHttpLifecycle(): LifecycleProvider & {
  dispose(): Promise<void>;
} {
  let release: (() => Promise<void>) | undefined;
  return {
    async authenticate(context) {
      const auth = await authenticateBusiness(context);
      release = auth.dispose;
      return { identityId: auth.identityId };
    },
    async prepare(fixture, context) {
      return prepareFixture({ fixture, context });
    },
    async cleanup(fixture, cleanupToken, context) {
      await cleanupFixture({
        fixture,
        context,
        ...(cleanupToken === undefined ? {} : { cleanupToken }),
      });
    },
    async dispose() {
      await release?.();
    },
  };
}
