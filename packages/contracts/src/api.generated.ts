/*
 * Generated from openapi/platform.yaml. Run pnpm contracts:generate.
 */
import type { JsonValue as ContractJsonValue,
    BindingJsonValue as ContractBindingJsonValue } from "./types.generated.js";
export interface paths {
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["liveness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["readiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/build-info": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * @description Returns validated nonsecret installed frontend metadata; development without a published
         * frontend returns 503 BUILD_INFO_UNAVAILABLE.
         */
        get: operations["buildInfo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head: operations["headBuildInfo"];
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Requires a same-origin Origin header and the CSRF token returned by GET /api/v1/setup; public
         * access does not require a user session.
         */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["session"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password-reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Requires a same-origin Origin header and the CSRF token returned by GET /api/v1/setup; public
         * access does not require a user session.
         */
        post: operations["requestPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password-reset/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Requires a same-origin Origin header and the CSRF token returned by GET /api/v1/setup; public
         * access does not require a user session.
         */
        post: operations["confirmPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/invitations/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["acceptInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listWorkspaces"];
        put?: never;
        post: operations["createWorkspace"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getWorkspace"];
        put?: never;
        post?: never;
        delete: operations["archiveWorkspace"];
        options?: never;
        head?: never;
        patch: operations["renameWorkspace"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listMembers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/members/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["updateMember"];
        post?: never;
        delete: operations["removeMember"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listInvitations"];
        put?: never;
        post: operations["inviteMember"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * @description Resource list. With kind=DATASET, items include the saved draft summary.
         */
        get: operations["listResources"];
        put?: never;
        post: operations["createResource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/dataset-copies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listDatasetCopySources"];
        put?: never;
        post: operations["copyDataset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getResource"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateResource"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/draft": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getDraft"];
        put: operations["updateDraft"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/http-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Preview masked mapped rows from an approved connection
         */
        post: operations["previewHttpDataset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["validateResource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["publishResource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/versions/{versionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getVersion"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/dependents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listDependents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/agent/settings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAgentSettings"];
        put: operations["updateAgentSettings"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/agent/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAgentSessions"];
        put?: never;
        post: operations["createAgentSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/agent/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAgentSession"];
        put?: never;
        post?: never;
        delete: operations["archiveAgentSession"];
        options?: never;
        head?: never;
        patch: operations["renameAgentSession"];
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/agent/sessions/{sessionId}/turns": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAgentTurns"];
        put?: never;
        post: operations["submitAgentTurn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/agent/sessions/{sessionId}/turns/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit an employee conversation turn as a server-sent event stream
         * @description Uses the same input and ownership checks as submitAgentTurn. The stream emits start, delta,
         * thinking (provider summary only), step, and either done with the authoritative turn or error with a domain
         * code. Replays and confirmations can complete immediately.
         */
        post: operations["streamAgentTurn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/agent/sessions/{sessionId}/turns/{turnId}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["confirmAgentTurn"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/execution-plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listExecutionPlans"];
        put?: never;
        post: operations["createExecutionPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/execution-plans/{planId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getExecutionPlan"];
        put: operations["updateExecutionPlan"];
        post?: never;
        delete: operations["deleteExecutionPlan"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listProviders"];
        put?: never;
        post: operations["createProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/providers/{providerId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getProvider"];
        put: operations["updateProvider"];
        post?: never;
        delete: operations["deleteProvider"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/service-accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listServiceAccounts"];
        put?: never;
        post: operations["createServiceAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/execution-plans/{planId}/trigger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["triggerExecutionPlan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listRuns"];
        put?: never;
        post: operations["createRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs/{runId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getRun"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs/{runId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelRun"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs/{runId}/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getRunReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs/{runId}/junit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCIJUnit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/jobs/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runtimes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listRuntimes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runtimes/{runtimeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getRuntime"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runtimes/{runtimeId}/grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["updateRuntimeGrants"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runtimes/{runtimeId}/trust": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["updateRuntimeTrust"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runtimes/{runtimeId}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeRuntime"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runtime-enrollments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["requestEnrollment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runtime-enrollments/{enrollmentId}/approve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["approveEnrollment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runtime-enrollments/poll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["pollEnrollment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/bundles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listBundles"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/bundles/{bundleId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getBundle"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/providers/{providerId}/connection-tests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["testProvider"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/generations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listGenerations"];
        put?: never;
        post: operations["generateDraft"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/generations/{generationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getGeneration"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/generations/{generationId}/review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reviewGeneration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getWorkspaceAudit"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listServiceTokens"];
        put?: never;
        post: operations["issueServiceToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["claimJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["heartbeat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["appendEvents"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/finish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Upload exact CompletionManifestV1 bytes first. The server verifies current device/requester,
         * active lease/fence and retained evidence. VALIDATE success requires a compiled descriptor; VALIDATE ERROR
         * prohibits a descriptor and requires a bounded failureCode, approved engineInventorySha256 and verified
         * nonempty LOG evidence. Failure never creates a ValidationReceipt. Exact completed manifest replay returns the
         * original receipt under current identity.
         */
        post: operations["finishAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["reconcileAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/datasets/http": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Read a frozen HTTP dataset with current Attempt proof
         * @description Authorize the frozen CASE, environment, actor, device and lease before each page and before
         * delivery. The mapped sample is private and non-cacheable.
         */
        post: operations["fetchHttpDataset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/datasets/static": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fetch canonical frozen bytes with current Attempt proof
         * @description Return canonical bytes for the frozen selection after checking current workspace, device, lease
         * and fence.
         */
        post: operations["fetchStaticDataset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/credentials/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Deny by default until T08/T09 inject a server verifier for authenticated device, active
         * assignment, membership/grants, lease and fence. Never accepts caller trust labels as proof.
         */
        post: operations["resolveCredentials"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/artifact-uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description T12 authorization obligation: raw Trace, screenshots, HTML and downloads are
         * CREDENTIAL_RESTRICTED regardless of producer claims; require current Workspace/Attempt authorization and
         * MANAGE_ENVIRONMENT to receive raw paths or bytes. Ordinary report access exposes redacted structured metadata
         * only. This schema does not implement storage or authorization.
         */
        post: operations["createArtifactUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/maintenance/expired-leases/reap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["maintenanceExpireLeases"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/maintenance/fixture-cleanups/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["maintenanceCleanupFixtures"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/maintenance/artifacts/expire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["expireArtifacts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/maintenance/capacity/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["maintenanceReconcileCapacity"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/jobs/{jobId}/validation-receipt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Retrieve a successful job validation receipt for publication
         * @description Authorize current caller Workspace membership/service scope and job/resource ownership. Only a
         * successful VALIDATE job returns its immutable receipt; pending, failed, cancelled or other-kind jobs return
         * 409 VALIDATION_RECEIPT_UNAVAILABLE. Unknown/inaccessible Workspace/job returns 404. The receipt is bound to
         * Workspace/job/resource/revision/sourceHash/engineVersion/compiledBundleSha256; publish rechecks these
         * bindings against current draft and authorization.
         */
        get: operations["getValidationReceipt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/workspaces/{workspaceId}/attempts/{attemptId}/content/{sha256}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download exact immutable bytes from the authorized attempt closure
         * @description DeviceToken is necessary but not sufficient. Authorize the current device, Workspace
         * membership/grant/trust, assigned Attempt and current unexpired lease/fencing proof on every download, then
         * require sha256 membership in that Attempt immutable closure. A hash never grants access. Closure includes the
         * claim job manifest, manifest subject, compiled bundle descriptor, and every listed file. No global hash
         * lookup or cross-Workspace access. Unknown/out-of-closure hashes return 404; revoked/unauthorized devices
         * return 403; expired lease or stale fencing returns 409. Proof headers are transport secrets and must be
         * redacted from logs; never include them in URLs/manifests. Return original application/octet-stream bytes
         * without JSON envelope, decoding or reserialization; client verifies SHA-256 of exact received bytes (and
         * FileEntry sizeBytes) before parsing/execution. snapshotUrl in ClaimDTO is this route for
         * claim.snapshotSha256. All manifest subject/bundle/file hashes resolve through the same Workspace/Attempt
         * route; clients send credentials only to the enrolled control-service origin and reject download redirects.
         */
        get: operations["downloadAttemptContent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/setup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSetup"];
        put?: never;
        /**
         * @description Requires a same-origin Origin header and the CSRF token returned by GET /api/v1/setup; public
         * access does not require a user session.
         */
        post: operations["initializeInstallation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List notifications for the current employee
         */
        get: operations["listNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/read-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark visible notifications through the current snapshot read
         */
        post: operations["markAllNotificationsRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/agent-seen": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Acknowledge a displayed completed Agent reply
         */
        post: operations["acknowledgeNotificationAgentReply"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Subscribe to inbox version changes
         * @description The first inbox frame and each updated frame contain NotificationInboxEvent. A revoked session
         * closes the stream with a NotificationAuthorizationEvent. Heartbeat comments carry no payload; reconnects
         * obtain the current version.
         */
        post: operations["subscribeNotificationInbox"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{notificationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the current notification details
         */
        get: operations["getNotification"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{notificationId}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark one notification read
         */
        post: operations["markNotificationRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/notifications/{notificationId}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept a pending invitation from the inbox
         */
        post: operations["acceptNotificationInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/account": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAccount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/account/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["changePassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/account/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * @description Own unexpired sessions only, bounded keyset pagination in stable createdAt/ID order.
         */
        get: operations["listAccountSessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/account/sessions/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeAccountSessions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/account/sessions/{sessionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * @description Revoke another unexpired session of the current account. Requires a trusted Origin.
         */
        delete: operations["revokeAccountSession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * @description Bounded keyset pagination in stable email/ID order. Concurrent changes are not a frozen
         * snapshot; restart paging to refresh filters or see newly inserted preceding rows.
         */
        get: operations["listGlobalUsers"];
        put?: never;
        post: operations["createGlobalUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["updateGlobalUser"];
        trace?: never;
    };
    "/api/v1/admin/users/{userId}/reset-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["issueUserResetLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{userId}/sessions/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeUserSessions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLiveness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReadiness"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/invitations/{invitationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["revokeInvitation"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/validation-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["previewResourceValidation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listCredentials"];
        put?: never;
        post: operations["createCredential"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/credentials/{secretRef}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["rotateCredential"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/credentials/{secretRef}/versions/{versionId}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeCredential"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/auth-adapters": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAuthAdapters"];
        put?: never;
        post: operations["createAuthAdapter"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/auth-adapters/{versionId}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeAuthAdapter"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/runtime-enrollments/inspect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["inspectEnrollment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/runtime": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getDeviceRuntime"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/runtime/token/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["rotateDeviceToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/runtime/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["logoutDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/runtime-enrollments/service": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["enrollServiceRuntime"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["disableServiceAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/service-accounts/{serviceAccountId}/tokens/{tokenId}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["revokeServiceToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runtimes/{runtimeId}/credential-delivery": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * @description Current Workspace OWNER/ADMIN approves credential delivery only after independent system-admin
         * MANAGED trust and owner sharing consent. Does not grant hardware trust.
         */
        put: operations["updateRuntimeCredentialDelivery"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["activateAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/attempts/{attemptId}/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["auditReconcileAttempt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/attempts/{attemptId}/artifact-uploads/{uploadId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * @description T12 authorization obligation: raw Trace, screenshots, HTML and downloads are
         * CREDENTIAL_RESTRICTED regardless of producer claims; require current Workspace/Attempt authorization and
         * MANAGE_ENVIRONMENT to receive raw paths or bytes. Ordinary report access exposes redacted structured metadata
         * only. This schema does not implement storage or authorization.
         */
        put: operations["uploadArtifactChunk"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/resources/{resourceId}/versions/{versionId}/compiled-source": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * View exact retained generated TypeScript for an immutable published version
         * @description Current Workspace VIEW, resource/version/receipt/descriptor membership are required. Omit path
         * for an allowlisted TypeScript file listing. A path returns exact retained text/plain bytes verified against
         * descriptor hash/size; caller hashes, arbitrary files and raw evidence are not accepted.
         */
        get: operations["getPublishedCompiledSource"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs/{runId}/events/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["streamRunReport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/attempts/{attemptId}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAttemptHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/attempts/{attemptId}/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAttemptArtifacts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/attempts/{attemptId}/artifacts/{artifactId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["downloadAttemptArtifact"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs/{runId}/attempts/{attemptId}/display": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getReportDisplay"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["previewAiContext"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/ai/generations/{generationId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["cancelGeneration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/issuer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read issuer public keys through current authenticated device binding
         */
        get: operations["getIssuerTrust"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/runs/{runId}/ci-report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCIReport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/maintenance/lifecycle/expire": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * @description Expire bounded completed lifecycle records under current Workspace service-token authorization
         * and active-reference barriers. No internal scheduler.
         */
        post: operations["maintenanceExpireLifecycle"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/workspaces/{workspaceId}/operations/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * @description Current OWNER or ADMIN employee session is required; data is scoped to the selected Workspace.
         * Dependency timeouts return 503.
         */
        get: operations["getWorkspaceOperationsMetrics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/examples/sample-workspace": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * @description Authenticated employee read of the bundled synthetic sample resource package. Contains no live
         * credentials or server configuration.
         */
        get: operations["getSampleWorkspacePackage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        0: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "CASE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["CaseDslV1"];
        };
        1: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "ELEMENT_CATALOG";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["ElementCatalogV1"];
        };
        2: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "ASSERTION_TEMPLATE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["AssertionTemplateV1"];
        };
        4: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "FLOW";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["FlowV1"];
        };
        5: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "FIXTURE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["FixtureV1"];
        };
        6: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "SUITE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["SuiteV1"];
        };
        7: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "ENVIRONMENT";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["EnvironmentV1"];
        };
        /**
         * Format: uuid
         * @description Hyphenated 8-4-4-4-12 hexadecimal UUID, case-insensitive; no URN, braces or surrounding
         * whitespace.
         */
        Id: string;
        Sha256: string;
        Key: string;
        Version: string;
        /**
         * @description Interpolated DSL string. Only {{data.identifier}} and {{vars.identifier}} dotted bindings are
         * supported; arbitrary executable expressions are rejected. Never use for inert evidence or diagnostics.
         */
        SafeString: string;
        /**
         * @description Inert portable JSON. Strings are literal, including arbitrary braces and invalid DSL
         * expressions; consumers must never evaluate or recursively interpolate this type.
         */
        JsonValue: ContractJsonValue;
        JsonObject: {
            [key: string]: components["schemas"]["JsonValue"];
        };
        JsonSchema: {
            [key: string]: components["schemas"]["JsonValue"];
        };
        /**
         * @enum {string}
         */
        ValueType: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
        ParameterTypes: {
            [key: string]: components["schemas"]["ValueType"];
        };
        Timeout: number;
        Pointer: string;
        /**
         * @description Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls.
         * After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized
         * base/allowedOrigins before any request/navigation, and enforce policy on redirects.
         */
        Path: string & components["schemas"]["SafeString"];
        /**
         * Format: uri
         */
        HttpUrl: string;
        SourceRef: string;
        ResponseRef: string;
        RequestRef: string;
        /**
         * @enum {string}
         */
        HttpMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
        /**
         * @enum {string}
         */
        Browser: "chromium" | "firefox" | "webkit";
        /**
         * @enum {string}
         */
        ResourceKind: "CASE" | "ELEMENT_CATALOG" | "ASSERTION_TEMPLATE" | "DATASET" | "FLOW" | "FIXTURE" | "SUITE"
            | "ENVIRONMENT";
        /**
         * @enum {string}
         */
        Outcome: "PASSED" | "FAILED" | "ERROR" | "UNSTABLE" | "CANCELLED" | "INCOMPLETE" | "SKIPPED";
        /**
         * @enum {string}
         */
        AttemptOutcome: "PASSED" | "FAILED" | "ERROR" | "CANCELLED" | "INCOMPLETE" | "SKIPPED";
        /**
         * @enum {string}
         */
        CleanupStatus: "NOT_REQUIRED" | "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
        /**
         * @enum {string}
         */
        TrustStatus: "MANAGED" | "USER_REGISTERED" | "REVOKED";
        /**
         * @enum {string}
         */
        RunSource: "MANAGED_CLOUD" | "CONNECTED_LOCAL" | "OFFLINE_IMPORT";
        FilePath: string;
        FileEntry: {
            path: components["schemas"]["FilePath"];
            sha256: components["schemas"]["Sha256"];
            sizeBytes: number;
        };
        DependencyVersion: {
            name: string;
            version: components["schemas"]["Version"];
            integrity: string;
        };
        ObserverWindow: {
            /**
             * @constant
             */
            mode: "UNTIL_ACTION_SETTLED";
            quietMs?: number;
        } | {
            /**
             * @constant
             */
            mode: "FIXED";
            durationMs: components["schemas"]["Timeout"];
        };
        ObserverV1: components["schemas"]["NetworkObserverV1"] | components["schemas"]["DialogObserverV1"]
            | components["schemas"]["NewPageObserverV1"] | components["schemas"]["DownloadObserverV1"];
        ExtractionV1: {
            source: components["schemas"]["SourceRef"];
            pointer: components["schemas"]["Pointer"];
            to: components["schemas"]["Key"];
            valueType: components["schemas"]["ValueType"];
            required: boolean;
        };
        AssertionV1: {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "ui";
            target: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            operator: "visible" | "enabled" | "checked" | "attached" | "editable";
            expected: boolean;
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "ui";
            target: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            operator: "textEquals" | "textContains" | "valueEquals";
            expected: components["schemas"]["SafeString"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "ui";
            target: components["schemas"]["Key"];
            /**
             * @constant
             */
            operator: "countEquals";
            expected: number;
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "url";
            /**
             * @constant
             */
            source: "page";
            /**
             * @enum {string}
             */
            operator: "equals" | "contains";
            expected: components["schemas"]["SafeString"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "httpStatus";
            source: components["schemas"]["ResponseRef"];
            /**
             * @constant
             */
            operator: "equals";
            expected: number;
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "request";
            source: components["schemas"]["RequestRef"];
            /**
             * @constant
             */
            operator: "methodEquals";
            expected: components["schemas"]["HttpMethod"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "request";
            source: components["schemas"]["RequestRef"];
            /**
             * @constant
             */
            operator: "pathEquals";
            expected: components["schemas"]["Path"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseSchema";
            source: components["schemas"]["ResponseRef"];
            /**
             * @constant
             */
            operator: "matchesSchema";
            expected: components["schemas"]["JsonSchema"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "duration";
            source: components["schemas"]["SourceRef"];
            /**
             * @constant
             */
            operator: "lessThanOrEqual";
            expected: number;
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestCount";
            source: components["schemas"]["RequestRef"];
            /**
             * @constant
             */
            operator: "equals";
            expected: number;
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "eventually";
            query: {
                /**
                 * @constant
                 */
                method: "GET";
                path: components["schemas"]["Path"];
                query?: components["schemas"]["BindingJsonObject"];
            };
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "equals";
            expected: components["schemas"]["BindingJsonValue"];
            intervalMs?: number;
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "template";
            versionId: components["schemas"]["Id"];
            parameters?: components["schemas"]["BindingJsonObject"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @enum {string}
             */
            operator: "equals" | "notEquals";
            expected: components["schemas"]["BindingJsonValue"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "contains";
            expected: components["schemas"]["SafeString"] | components["schemas"]["BindingJsonValue"][];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "in";
            expected: components["schemas"]["BindingJsonValue"][];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "exists";
            expected: boolean;
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @enum {string}
             */
            operator: "equals" | "notEquals";
            expected: components["schemas"]["BindingJsonValue"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "contains";
            expected: components["schemas"]["SafeString"] | components["schemas"]["BindingJsonValue"][];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "in";
            expected: components["schemas"]["BindingJsonValue"][];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "exists";
            expected: boolean;
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "ui";
            target: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            operator: "visible" | "enabled" | "checked" | "attached" | "editable";
            pageKey?: components["schemas"]["Key"];
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "ui";
            target: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            operator: "textEquals" | "textContains" | "valueEquals";
            pageKey?: components["schemas"]["Key"];
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "ui";
            target: components["schemas"]["Key"];
            /**
             * @constant
             */
            operator: "countEquals";
            pageKey?: components["schemas"]["Key"];
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "url";
            /**
             * @constant
             */
            source: "page";
            /**
             * @enum {string}
             */
            operator: "equals" | "contains";
            pageKey?: components["schemas"]["Key"];
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "httpStatus";
            source: components["schemas"]["ResponseRef"];
            /**
             * @constant
             */
            operator: "equals";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "request";
            source: components["schemas"]["RequestRef"];
            /**
             * @constant
             */
            operator: "methodEquals";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "request";
            source: components["schemas"]["RequestRef"];
            /**
             * @constant
             */
            operator: "pathEquals";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "duration";
            source: components["schemas"]["SourceRef"];
            /**
             * @constant
             */
            operator: "lessThanOrEqual";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestCount";
            source: components["schemas"]["RequestRef"];
            /**
             * @constant
             */
            operator: "equals";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "eventually";
            query: {
                /**
                 * @constant
                 */
                method: "GET";
                path: components["schemas"]["Path"];
                query?: components["schemas"]["BindingJsonObject"];
            };
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "equals";
            intervalMs?: number;
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @enum {string}
             */
            operator: "equals" | "notEquals";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "contains";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "in";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "responseField";
            source: components["schemas"]["ResponseRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "exists";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @enum {string}
             */
            operator: "equals" | "notEquals";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "contains";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "in";
            datasetExpected: components["schemas"]["DatasetQuery"];
        } | {
            id: components["schemas"]["Key"];
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            type: "requestField";
            source: components["schemas"]["RequestRef"];
            pointer: components["schemas"]["Pointer"];
            /**
             * @constant
             */
            operator: "exists";
            datasetExpected: components["schemas"]["DatasetQuery"];
        };
        StepV1: {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "goto";
            path: components["schemas"]["Path"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "click";
            target: components["schemas"]["Key"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "check";
            target: components["schemas"]["Key"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "uncheck";
            target: components["schemas"]["Key"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "fill";
            target: components["schemas"]["Key"];
            value: components["schemas"]["SafeString"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "press";
            target: components["schemas"]["Key"];
            value: components["schemas"]["SafeString"];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "selectOption";
            target: components["schemas"]["Key"];
            value: components["schemas"]["SafeString"] | components["schemas"]["SafeString"][];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "upload";
            target: components["schemas"]["Key"];
            value: components["schemas"]["FilePath"][];
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "reload";
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "apiRequest";
            method: components["schemas"]["HttpMethod"];
            path: components["schemas"]["Path"];
            query?: components["schemas"]["BindingJsonObject"];
            body?: components["schemas"]["BindingJsonValue"];
            headers?: {
                [key: string]: components["schemas"]["SafeString"];
            };
            pageKey?: components["schemas"]["Key"];
        } | {
            id: components["schemas"]["Key"];
            critical?: boolean;
            beforeAssertions?: components["schemas"]["AssertionV1"][];
            observers?: components["schemas"]["ObserverV1"][];
            afterAssertions?: components["schemas"]["AssertionV1"][];
            extract?: components["schemas"]["ExtractionV1"][];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @enum {string}
             */
            failurePolicy?: "STOP_CASE" | "CONTINUE";
            /**
             * @constant
             */
            action: "callFlow";
            versionId: components["schemas"]["Id"];
            parameters?: components["schemas"]["BindingJsonObject"];
            pageKey?: components["schemas"]["Key"];
        };
        CaseDslV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            caseKey: components["schemas"]["Key"];
            title: string;
            /**
             * @enum {string}
             */
            kind: "READ" | "WRITE";
            roleKey: components["schemas"]["Key"];
            catalogVersionId: components["schemas"]["Id"];
            fixtureVersionId?: components["schemas"]["Id"];
            datasetVersionId?: components["schemas"]["Id"];
            persistenceCheckpointStepId?: components["schemas"]["Key"];
            lifecycle?: {
                prepare?: components["schemas"]["StepV1"][];
                cleanup?: {
                    /**
                     * @enum {unknown}
                     */
                    on: "SUCCESS" | "FAILURE" | "CANCELLED";
                    steps: components["schemas"]["StepV1"][];
                }[];
            };
            steps: components["schemas"]["StepV1"][];
            fixtureInput?: components["schemas"]["BindingJsonObject"];
            initialVariables?: components["schemas"]["ParameterTypes"];
            datasetBindings?: components["schemas"]["DatasetBindings"];
        };
        LocatorV1: {
            /**
             * @constant
             */
            by: "veriqId";
            value: components["schemas"]["Key"];
        } | {
            /**
             * @constant
             */
            by: "role";
            role: string;
            name?: components["schemas"]["SafeString"];
            exact?: boolean;
        };
        CatalogElementV1: {
            key: components["schemas"]["Key"];
            locator: components["schemas"]["LocatorV1"];
            scope?: components["schemas"]["Key"];
            recordKey?: components["schemas"]["SafeString"];
        };
        ElementCatalogV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            elements: components["schemas"]["CatalogElementV1"][];
        };
        AssertionTemplateV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            parameters?: components["schemas"]["ParameterTypes"];
            assertions: components["schemas"]["AssertionV1"][];
        };
        DataRowV1: {
            key: components["schemas"]["Key"];
            values: components["schemas"]["JsonObject"];
        };
        DatasetV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            columns: components["schemas"]["ParameterTypes"];
            rows: components["schemas"]["DataRowV1"][];
        };
        DataFieldV2: {
            /**
             * @enum {unknown}
             */
            type: "string" | "number" | "integer" | "boolean" | "object" | "array";
            required: boolean;
            nullable: boolean;
        };
        DatasetFieldsV2: {
            [key: string]: components["schemas"]["DataFieldV2"];
        };
        TreeDataRowV2: {
            key: components["schemas"]["Key"];
            values: components["schemas"]["JsonObject"];
            parentKey: components["schemas"]["Key"] | null;
            order: number;
        };
        DataRowV2: components["schemas"]["DataRowV1"] | components["schemas"]["TreeDataRowV2"];
        DatasetV2: {
            /**
             * @constant
             */
            schemaVersion: "2.0";
            /**
             * @constant
             */
            shape: "TABLE";
            fields: components["schemas"]["DatasetFieldsV2"];
            source: {
                /**
                 * @constant
                 */
                kind: "STATIC";
                rows: components["schemas"]["DataRowV1"][];
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "2.0";
            /**
             * @constant
             */
            shape: "TREE";
            fields: components["schemas"]["DatasetFieldsV2"];
            source: {
                /**
                 * @constant
                 */
                kind: "STATIC";
                rows: components["schemas"]["TreeDataRowV2"][];
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "2.0";
            /**
             * @enum {unknown}
             */
            shape: "TABLE" | "TREE";
            fields: components["schemas"]["DatasetFieldsV2"];
            source: components["schemas"]["DatasetHttpSource"];
        };
        DatasetDocument: components["schemas"]["DatasetV1"] | components["schemas"]["DatasetV2"];
        DatasetQuery: {
            parameters?: components["schemas"]["BindingJsonObject"];
            alias: components["schemas"]["Key"];
            /**
             * @constant
             */
            op: "field";
            key: components["schemas"]["BindingJsonValue"];
            field: components["schemas"]["Key"];
        } | {
            parameters?: components["schemas"]["BindingJsonObject"];
            alias: components["schemas"]["Key"];
            /**
             * @constant
             */
            op: "contains";
            key: components["schemas"]["BindingJsonValue"];
        } | {
            parameters?: components["schemas"]["BindingJsonObject"];
            alias: components["schemas"]["Key"];
            /**
             * @constant
             */
            op: "filter";
            field: components["schemas"]["Key"];
            equals: components["schemas"]["BindingJsonValue"];
            select: components["schemas"]["Key"];
        } | {
            parameters?: components["schemas"]["BindingJsonObject"];
            alias: components["schemas"]["Key"];
            /**
             * @constant
             */
            op: "path";
            key: components["schemas"]["BindingJsonValue"];
        } | {
            parameters?: components["schemas"]["BindingJsonObject"];
            alias: components["schemas"]["Key"];
            /**
             * @constant
             */
            op: "children";
            parentKey: components["schemas"]["BindingJsonValue"];
        };
        FlowV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            parameters?: components["schemas"]["ParameterTypes"];
            steps: components["schemas"]["StepV1"][];
        };
        FixtureEndpointV1: {
            /**
             * @enum {string}
             */
            method: "POST" | "DELETE";
            path: components["schemas"]["Path"];
        };
        FixtureV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            prepare: {
                /**
                 * @constant
                 */
                method: "POST";
                path: components["schemas"]["Path"];
            };
            query: {
                /**
                 * @constant
                 */
                method: "GET";
                path: components["schemas"]["Path"];
            };
            cleanup: components["schemas"]["FixtureEndpointV1"];
            inputSchema: components["schemas"]["JsonSchema"];
            outputSchema: components["schemas"]["JsonSchema"];
            ttlSeconds: number;
        };
        SuiteV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            cases: {
                versionId: components["schemas"]["Id"];
                datasetVersionId?: components["schemas"]["Id"];
                roleKeys?: components["schemas"]["Key"][];
                browsers?: components["schemas"]["Browser"][];
            }[];
        };
        EnvironmentRoleV1: {
            roleKey: components["schemas"]["Key"];
            authAdapterVersionId: components["schemas"]["Id"];
            secretRef: components["schemas"]["Key"];
            secretVersionId: components["schemas"]["Id"];
            allowedIdentityIds?: string[];
        };
        EnvironmentV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            baseURL: components["schemas"]["HttpUrl"];
            apiBaseURL: components["schemas"]["HttpUrl"];
            fixtureBaseURL?: components["schemas"]["HttpUrl"];
            allowedOrigins: components["schemas"]["HttpUrl"][];
            locale: string;
            timezone: string;
            roles: components["schemas"]["EnvironmentRoleV1"][];
            buildSha?: string;
            fixtureIdentity?: components["schemas"]["FixtureIdentityV1"];
        };
        ResourceDocumentV1: {
            /**
             * @constant
             */
            kind: "CASE";
            document: components["schemas"]["CaseDslV1"];
        } | {
            /**
             * @constant
             */
            kind: "ELEMENT_CATALOG";
            document: components["schemas"]["ElementCatalogV1"];
        } | {
            /**
             * @constant
             */
            kind: "ASSERTION_TEMPLATE";
            document: components["schemas"]["AssertionTemplateV1"];
        } | {
            /**
             * @constant
             */
            kind: "DATASET";
            document: components["schemas"]["DatasetDocument"];
        } | {
            /**
             * @constant
             */
            kind: "FLOW";
            document: components["schemas"]["FlowV1"];
        } | {
            /**
             * @constant
             */
            kind: "FIXTURE";
            document: components["schemas"]["FixtureV1"];
        } | {
            /**
             * @constant
             */
            kind: "SUITE";
            document: components["schemas"]["SuiteV1"];
        } | {
            /**
             * @constant
             */
            kind: "ENVIRONMENT";
            document: components["schemas"]["EnvironmentV1"];
        };
        AssetVersionV1: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "CASE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["CaseDslV1"];
        } | {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "ELEMENT_CATALOG";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["ElementCatalogV1"];
        } | {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "ASSERTION_TEMPLATE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["AssertionTemplateV1"];
        } | {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "DATASET";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["DatasetDocument"];
        } | {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "FLOW";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["FlowV1"];
        } | {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "FIXTURE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["FixtureV1"];
        } | {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "SUITE";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["SuiteV1"];
        } | {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "ENVIRONMENT";
            sha256: components["schemas"]["Sha256"];
            document: components["schemas"]["EnvironmentV1"];
        };
        ConnectedDatasetV2: {
            /**
             * @constant
             */
            kind: "DATASET";
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            sha256: components["schemas"]["Sha256"];
            schema: {
                /**
                 * @constant
                 */
                schemaVersion: "1.0";
                columns: components["schemas"]["ParameterTypes"];
            } | {
                /**
                 * @constant
                 */
                schemaVersion: "2.0";
                /**
                 * @enum {unknown}
                 */
                shape: "TABLE" | "TREE";
                fields: components["schemas"]["DatasetFieldsV2"];
            };
            contentSha256: components["schemas"]["Sha256"];
        };
        ConnectedSourceSnapshotV2: {
            /**
             * @constant
             */
            schemaVersion: "2.0";
            workspaceId: components["schemas"]["Id"];
            sourceHash: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            entryCaseVersionIds: components["schemas"]["Id"][];
            assets: (components["schemas"]["0"] | components["schemas"]["1"] | components["schemas"]["2"]
                | components["schemas"]["4"] | components["schemas"]["5"] | components["schemas"]["6"]
                | components["schemas"]["7"] | components["schemas"]["ConnectedDatasetV2"])[];
            validationTarget?: components["schemas"]["ValidationTargetV1"];
            authAdapters?: components["schemas"]["AuthAdapterVersionV1"][];
            originalSha256: components["schemas"]["Sha256"];
        } & unknown;
        ConnectedExecutionSnapshotV2: {
            /**
             * @constant
             */
            schemaVersion: "2.0";
            workspaceId: components["schemas"]["Id"];
            runId: components["schemas"]["Id"];
            caseExecutionId: components["schemas"]["Id"];
            assetSourceHash: components["schemas"]["Sha256"];
            environmentVersionId: components["schemas"]["Id"];
            environment: components["schemas"]["EnvironmentV1"];
            roleKey: components["schemas"]["Key"];
            browser: components["schemas"]["Browser"];
            variables: components["schemas"]["JsonObject"];
            secretVersions: {
                secretRef: components["schemas"]["Key"];
                versionId: components["schemas"]["Id"];
            }[];
            namespace: components["schemas"]["Key"];
            attemptNo: number;
            caseVersionId: components["schemas"]["Id"];
            authAdapters?: components["schemas"]["AuthAdapterVersionV1"][];
            datasetVersionId?: components["schemas"]["Id"];
            suiteEntryIndex?: number;
            datasetBindings?: components["schemas"]["DatasetBindings"];
            selectedRow?: {
                versionId: components["schemas"]["Id"];
                rowKey: components["schemas"]["Key"];
                rowSha256: components["schemas"]["Sha256"];
            };
        };
        HttpDatasetSelection: {
            versionId: components["schemas"]["Id"];
            parameters: components["schemas"]["JsonObject"];
        };
        HttpDatasetSample: {
            sourceVersionId: components["schemas"]["Id"];
            /**
             * Format: date-time
             */
            fetchedAt: string;
        };
        HttpDatasetResponse: {
            sourceVersionId: components["schemas"]["Id"];
            fetchedAt: components["schemas"]["Timestamp"];
            rows: components["schemas"]["DataRowV2"][];
        };
        StaticDatasetSelection: {
            /**
             * @constant
             */
            selection: "VALIDATION_SOURCE";
        } | {
            /**
             * @constant
             */
            selection: "DATASET";
            versionId: components["schemas"]["Id"];
        } | {
            /**
             * @constant
             */
            selection: "ROW";
            versionId: components["schemas"]["Id"];
            rowKey: components["schemas"]["Key"];
        };
        AssetSnapshotV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            workspaceId: components["schemas"]["Id"];
            sourceHash: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            entryCaseVersionIds: components["schemas"]["Id"][];
            assets: components["schemas"]["AssetVersionV1"][];
            validationTarget?: components["schemas"]["ValidationTargetV1"];
            authAdapters?: components["schemas"]["AuthAdapterVersionV1"][];
        } & unknown;
        SnapshotV1: components["schemas"]["AssetSnapshotV1"];
        ExecutionSnapshotV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            workspaceId: components["schemas"]["Id"];
            runId: components["schemas"]["Id"];
            caseExecutionId: components["schemas"]["Id"];
            assetSourceHash: components["schemas"]["Sha256"];
            environmentVersionId: components["schemas"]["Id"];
            environment: components["schemas"]["EnvironmentV1"];
            roleKey: components["schemas"]["Key"];
            browser: components["schemas"]["Browser"];
            dataRow?: components["schemas"]["DataRowV1"];
            variables: components["schemas"]["JsonObject"];
            secretVersions: {
                secretRef: components["schemas"]["Key"];
                versionId: components["schemas"]["Id"];
            }[];
            namespace: components["schemas"]["Key"];
            attemptNo: number;
            caseVersionId: components["schemas"]["Id"];
            authAdapters?: components["schemas"]["AuthAdapterVersionV1"][];
            datasetVersionId?: components["schemas"]["Id"];
            suiteEntryIndex?: number;
            datasetBindings?: components["schemas"]["DatasetBindings"];
        };
        CompiledAssetBundle: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            sourceHash: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            compilerVersion: components["schemas"]["Version"];
            runnerSdkVersion: components["schemas"]["Version"];
            entrypoints: components["schemas"]["CaseEntrypointV1"][];
            files: components["schemas"]["FileEntry"][];
            dependencies: components["schemas"]["DependencyVersion"][];
            validationOnly?: boolean;
        } & unknown;
        /**
         * @description VeriQ
         * Runtime能力合同仅允许linux/x64、win32/x64、darwin/x64及darwin/arm64；Mac目标最低系统为macOS15，但合同接受不代
         * 表设备通过原生执行、进程监督、凭据或安装验收。
         */
        RuntimeCapabilitiesV1: {
            engineVersion: components["schemas"]["Version"];
            /**
             * @enum {string}
             */
            os: "linux" | "win32" | "darwin";
            /**
             * @enum {string}
             */
            arch: "x64" | "arm64";
            browsers: components["schemas"]["Browser"][];
            jobKinds?: ("TEST" | "VALIDATE" | "CLEANUP")[];
            /**
             * @constant
             */
            httpDatasets?: "1.0";
            /**
             * @constant
             */
            connectedDatasets?: "2.0";
        } & ({
            /**
             * @constant
             */
            os: "linux";
            /**
             * @constant
             */
            arch: "x64";
        } | {
            /**
             * @constant
             */
            os: "win32";
            /**
             * @constant
             */
            arch: "x64";
        } | {
            /**
             * @constant
             */
            os: "darwin";
            /**
             * @constant
             */
            arch: "x64";
        } | {
            /**
             * @constant
             */
            os: "darwin";
            /**
             * @constant
             */
            arch: "arm64";
        });
        ClaimRequest: {
            runnerId: components["schemas"]["Id"];
            clientRequestId: components["schemas"]["Id"];
            availableSlots: number;
            capabilities: components["schemas"]["RuntimeCapabilitiesV1"];
        };
        ClaimDTO: {
            jobId: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            jobKind: "TEST" | "VALIDATE" | "CLEANUP";
            attemptId: components["schemas"]["Id"];
            leaseToken: string;
            fencingToken: number;
            expiresAt: components["schemas"]["Timestamp"];
            snapshotUrl: components["schemas"]["HttpUrl"];
            snapshotSha256: components["schemas"]["Sha256"];
            serverTime: components["schemas"]["Timestamp"];
            leaseDurationMs: number;
            /**
             * @constant
             */
            activationRequired: true;
        };
        TestJobManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            workspaceId: components["schemas"]["Id"];
            jobId: components["schemas"]["Id"];
            snapshotSha256: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            /**
             * @constant
             */
            kind: "TEST";
            caseExecutionId: components["schemas"]["Id"];
            compiledBundleSha256: components["schemas"]["Sha256"];
            executionSnapshotSha256: components["schemas"]["Sha256"];
            caseVersionId: components["schemas"]["Id"];
        };
        ValidateJobManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            workspaceId: components["schemas"]["Id"];
            jobId: components["schemas"]["Id"];
            snapshotSha256: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            /**
             * @constant
             */
            kind: "VALIDATE";
            resourceId: components["schemas"]["Id"];
            revision: number;
            sourceHash: components["schemas"]["Sha256"];
        };
        CleanupJobManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            workspaceId: components["schemas"]["Id"];
            jobId: components["schemas"]["Id"];
            snapshotSha256: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            /**
             * @constant
             */
            kind: "CLEANUP";
            maintenanceId: components["schemas"]["Id"];
            fixtureVersionId: components["schemas"]["Id"];
            namespace: components["schemas"]["Key"];
            cleanupRef: string;
        };
        JobManifestV1: components["schemas"]["TestJobManifestV1"] | components["schemas"]["ValidateJobManifestV1"]
            | components["schemas"]["CleanupJobManifestV1"];
        ExecutionEventV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId?: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "ATTEMPT_STARTED";
            payload: {
                engineVersion: components["schemas"]["Version"];
                sourceHash: components["schemas"]["Sha256"];
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId?: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "PHASE_CHANGED";
            payload: {
                /**
                 * @enum {string}
                 */
                phase: "LEASED" | "PREPARING" | "RUNNING" | "CLEANING" | "FINALIZING" | "FINISHED";
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "STEP_STARTED";
            payload: Record<string, never>;
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "STEP_FINISHED";
            payload: components["schemas"]["StepFinishedPayloadV1"];
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId: components["schemas"]["Key"];
            assertionId: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "ASSERTION_RESULT";
            payload: components["schemas"]["AssertionResultPayloadV1"];
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "OBSERVER_RESULT";
            payload: components["schemas"]["ObserverResultPayloadV1"];
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "VARIABLE_EXTRACTED";
            payload: {
                name: components["schemas"]["Key"];
                valueType: components["schemas"]["ValueType"];
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId?: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "LOG";
            payload: {
                /**
                 * @enum {string}
                 */
                level: "DEBUG" | "INFO" | "WARN" | "ERROR";
                message: components["schemas"]["DiagnosticText"];
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId?: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "CLEANUP_RESULT";
            payload: {
                cleanupStatus: components["schemas"]["CleanupStatus"];
                errorCode?: components["schemas"]["Key"];
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId?: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "ARTIFACT_CREATED";
            payload: {
                artifactId: components["schemas"]["Id"];
                file: components["schemas"]["EvidenceFileEntryV1"];
                /**
                 * @enum {string}
                 */
                kind: "SCREENSHOT" | "TRACE" | "HTML" | "JUNIT" | "LOG" | "SOURCE" | "MANIFEST" | "DOWNLOAD";
            };
        } | {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: components["schemas"]["Timestamp"];
            stepId?: components["schemas"]["Key"];
            assertionId?: components["schemas"]["Key"];
            /**
             * @constant
             */
            type: "ATTEMPT_FINISHED";
            payload: {
                outcome: components["schemas"]["AttemptOutcome"];
                cleanupStatus: components["schemas"]["CleanupStatus"];
                authentication?: components["schemas"]["BrowserSsoResultV1"];
            };
        };
        BundleManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            bundleId: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            issuerId: components["schemas"]["Key"];
            keyId: components["schemas"]["Key"];
            createdAt: components["schemas"]["Timestamp"];
            expiresAt: components["schemas"]["Timestamp"];
            sourceHash: components["schemas"]["Sha256"];
            snapshotSha256: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            /**
             * @enum {string}
             */
            validationStatus: "VALIDATED" | "UNVALIDATED_DEBUG";
            files: components["schemas"]["FileEntry"][];
        };
        OfflineAttemptV1: {
            attemptId: components["schemas"]["Id"];
            caseVersionId: components["schemas"]["Id"];
            attemptNo: number;
            outcome: components["schemas"]["AttemptOutcome"];
            cleanupStatus: components["schemas"]["CleanupStatus"];
            lastSequence: number;
            events: components["schemas"]["ExecutionEventV1"][];
            artifacts: components["schemas"]["OfflineArtifactV1"][];
            execution?: components["schemas"]["ExecutionSnapshotV1"];
            processStopped?: boolean;
            /**
             * @enum {unknown}
             */
            retrySafety?: "READ_ONLY_OBSERVED" | "WRITE_POSSIBLE" | "UNKNOWN";
            /**
             * @enum {unknown}
             */
            sourceKind?: "PUBLISHED" | "DRAFT_DEBUG";
            variantKey?: components["schemas"]["Sha256"];
            failureCode?: string;
            diagnostics?: {
                code: string;
                path: string;
                /**
                 * @enum {unknown}
                 */
                pathStatus: "EXACT" | "REDACTED";
                message: string;
            }[];
            processStopScope?: components["schemas"]["ProcessStopScope"];
        };
        OfflineResultV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            workspaceId: components["schemas"]["Id"];
            bundleId: components["schemas"]["Id"];
            localRunId: components["schemas"]["Id"];
            deviceId: components["schemas"]["Id"];
            /**
             * @constant
             */
            source: "OFFLINE_IMPORT";
            trustStatus: components["schemas"]["TrustStatus"];
            dirty: boolean;
            /**
             * @enum {string}
             */
            revocationStatus: "CURRENT" | "UNKNOWN" | "REVOKED";
            manifestSha256: components["schemas"]["Sha256"];
            startedAt: components["schemas"]["Timestamp"];
            finishedAt: components["schemas"]["Timestamp"];
            outcome: components["schemas"]["Outcome"];
            actualEnvironment: components["schemas"]["EnvironmentV1"];
            attempts: components["schemas"]["OfflineAttemptV1"][];
            executionChoices?: components["schemas"]["OfflineExecutionChoicesV1"];
        };
        ValidationIssue: {
            path: string;
            /**
             * @enum {string}
             */
            code: "SCHEMA_VIOLATION" | "INVALID_JSON";
            message: string;
        };
        HeartbeatRequest: {
            leaseToken: string;
            fencingToken: number;
            progress: {
                /**
                 * @enum {string}
                 */
                phase: "LEASED" | "PREPARING" | "RUNNING" | "CLEANING" | "FINALIZING";
                stepId?: components["schemas"]["Key"];
                completedSteps?: number;
            };
        };
        HeartbeatDTO: {
            leaseExpiresAt: components["schemas"]["Timestamp"];
            cancelRequested: boolean;
            /**
             * @description Cooperative page cleanup is authorized for this active, explicitly cancelled test within its
             * existing lease.
             */
            pageCleanupAllowed?: boolean;
            serverTime: components["schemas"]["Timestamp"];
            leaseDurationMs: number;
        };
        EventBatchRequest: {
            leaseToken: string;
            fencingToken: number;
            events: components["schemas"]["ExecutionEventV1"][];
        };
        EventBatchDTO: {
            acceptedThrough: number;
        };
        FinishRequest: {
            leaseToken: string;
            fencingToken: number;
            /**
             * @enum {string}
             */
            kind: "TEST" | "VALIDATE" | "CLEANUP";
            outcome: components["schemas"]["AttemptOutcome"];
            manifestSha256: components["schemas"]["Sha256"];
            lastSequence: number;
            cleanupStatus: components["schemas"]["CleanupStatus"];
        };
        FinishDTO: {
            attemptId: components["schemas"]["Id"];
            /**
             * @constant
             */
            accepted: true;
            outcome: components["schemas"]["AttemptOutcome"];
            manifestSha256: components["schemas"]["Sha256"];
        };
        ErrorEnvelope: {
            code: string;
            message: string;
            details: components["schemas"]["JsonObject"];
            requestId: string;
        };
        Empty: Record<string, never>;
        UserDTO: {
            id: components["schemas"]["Id"];
            /**
             * Format: email
             */
            email: string;
            displayName: string;
            disabled: boolean;
            createdAt?: components["schemas"]["Timestamp"];
        };
        LoginRequest: {
            /**
             * Format: email
             */
            email: string;
            password: string;
        };
        SessionDTO: {
            user: components["schemas"]["UserDTO"];
            csrfToken: string;
            expiresAt: components["schemas"]["Timestamp"];
        };
        EmailRequest: {
            /**
             * Format: email
             */
            email: string;
        };
        ResetPasswordRequest: {
            token: string;
            newPassword: string;
        };
        /**
         * @description Existing accounts require the matching authenticated session and token only; credentials cannot
         * be replaced. New accounts require password and displayName, creating an ordinary user without a session.
         */
        InvitationAcceptRequest: {
            token: string;
            password?: string;
            displayName?: string;
        };
        WorkspaceDTO: {
            id: components["schemas"]["Id"];
            key: components["schemas"]["Key"];
            name: string;
            /**
             * @enum {string}
             */
            role: "OWNER" | "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER";
            archived: boolean;
            createdAt: components["schemas"]["Timestamp"];
        };
        WorkspaceWrite: {
            key: components["schemas"]["Key"];
            name: string;
        };
        WorkspaceRename: {
            name: string;
        };
        MemberDTO: {
            userId: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            role: "OWNER" | "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER";
            /**
             * @enum {string}
             */
            status: "ACTIVE" | "DISABLED";
            /**
             * Format: email
             */
            email: string;
            displayName: string;
            userDisabled: boolean;
        };
        MemberWrite: {
            /**
             * @enum {string}
             */
            role: "OWNER" | "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER";
            /**
             * @enum {string}
             */
            status: "ACTIVE" | "DISABLED";
        };
        InviteRequest: {
            /**
             * Format: email
             */
            email: string;
            /**
             * @enum {string}
             */
            role: "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER";
            /**
             * @default false
             */
            sendEmail: boolean;
        };
        InviteDTO: {
            id: components["schemas"]["Id"];
            expiresAt: components["schemas"]["Timestamp"];
            invitationUrl: components["schemas"]["HttpUrl"];
            /**
             * @enum {string}
             */
            delivery: "NOT_REQUESTED" | "SENT" | "FAILED";
        };
        ResourceDTO: {
            id: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            kind: components["schemas"]["ResourceKind"];
            key: components["schemas"]["Key"];
            name: string;
            /**
             * @enum {string}
             */
            status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
            latestVersionId?: components["schemas"]["Id"];
            datasetSummary?: components["schemas"]["DatasetSummary"];
        };
        HttpDatasetPreviewRequest: {
            document: components["schemas"]["DatasetV2"];
            arguments: components["schemas"]["JsonObject"];
            verifySignature?: {
                /**
                 * Format: date-time
                 */
                at: string;
                expected: string;
            };
        };
        HttpDatasetPreviewResult: {
            rowCount: number;
            sample: {
                fields: string[];
            }[];
        } | {
            signatureMatches: boolean;
        };
        HttpDatasetPreviewEnvelope: {
            data: components["schemas"]["HttpDatasetPreviewResult"];
            requestId: string;
        };
        DatasetCopyRequest: {
            sourceWorkspaceId: components["schemas"]["Id"];
            sourceDatasetVersionId: components["schemas"]["Id"];
            key: components["schemas"]["Key"];
            name: string;
        };
        DatasetCopySource: {
            resourceId: components["schemas"]["Id"];
            key: components["schemas"]["Key"];
            name: string;
            versionId: components["schemas"]["Id"];
            versionNo: number;
        };
        DatasetCopySourcePageEnvelope: {
            data: {
                items: components["schemas"]["DatasetCopySource"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ResourceCreate: {
            kind: components["schemas"]["ResourceKind"];
            key: components["schemas"]["Key"];
            name: string;
            content: components["schemas"]["ResourceDocumentV1"];
            /**
             * @description Optional creation identity scoped to the current employee and Workspace.
             */
            clientDraftId?: components["schemas"]["Id"];
        };
        ResourceUpdate: {
            name: string;
            archived?: boolean;
        };
        DraftDTO: {
            resourceId: components["schemas"]["Id"];
            revision: number;
            content: components["schemas"]["ResourceDocumentV1"];
            updatedAt: components["schemas"]["Timestamp"];
            documentHash: components["schemas"]["Sha256"];
        };
        DraftWrite: {
            revision: number;
            content: components["schemas"]["ResourceDocumentV1"];
        };
        ValidationRequest: {
            revision: number;
            sourceHash: components["schemas"]["Sha256"];
        };
        /**
         * @description Successful VALIDATE proof bound to Workspace, job, resource, immutable draft revision, source
         * hash, engine version and compiled bundle. Server compilation supplies serverCompilationId. Historical Runtime
         * receipts supply runtimeId and attemptId. Publish rejects stale or foreign receipts.
         */
        ValidationReceiptDTO: {
            id: components["schemas"]["Id"];
            resourceId: components["schemas"]["Id"];
            revision: number;
            sourceHash: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            compiledBundleSha256: components["schemas"]["Sha256"];
            validatedAt: components["schemas"]["Timestamp"];
            workspaceId: components["schemas"]["Id"];
            jobId: components["schemas"]["Id"];
            runtimeId?: components["schemas"]["Id"];
            attemptId?: components["schemas"]["Id"];
            serverCompilationId?: components["schemas"]["Id"];
            /**
             * @constant
             */
            compilerTrust: "MANAGED";
        } & ({
            serverCompilationId: components["schemas"]["Id"];
            runtimeId?: never;
            attemptId?: never;
        } | {
            serverCompilationId?: never;
            runtimeId: components["schemas"]["Id"];
            attemptId: components["schemas"]["Id"];
        });
        PublishRequest: {
            revision: number;
            validationReceiptId: components["schemas"]["Id"];
        };
        ResourceVersionDTO: {
            id: components["schemas"]["Id"];
            resourceId: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            versionNo: number;
            /**
             * @constant
             */
            schemaVersion: "1.0";
            sha256: components["schemas"]["Sha256"];
            content: components["schemas"]["ResourceDocumentV1"];
            publishedAt: components["schemas"]["Timestamp"];
        };
        RuntimeDTO: {
            id: components["schemas"]["Id"];
            ownerId: components["schemas"]["Id"];
            name: string;
            /**
             * @enum {string}
             */
            location: "MANAGED_CLOUD" | "CONNECTED_LOCAL";
            trustStatus: components["schemas"]["TrustStatus"];
            /**
             * @enum {string}
             */
            status: "PENDING" | "ONLINE" | "OFFLINE" | "REVOKED";
            capabilities: components["schemas"]["RuntimeCapabilitiesV1"];
            lastSeenAt?: components["schemas"]["Timestamp"];
            workspaceId: components["schemas"]["Id"];
            /**
             * @enum {unknown}
             */
            ownerType: "USER" | "SERVICE_ACCOUNT";
            /**
             * @constant
             */
            capabilitiesSource: "DEVICE_REPORTED";
            sharedWithWorkspace: boolean;
            sharedWithUserIds: components["schemas"]["Id"][];
            allowCredentialDelivery: boolean;
            canManage: boolean;
        };
        EnrollmentRequest: {
            name: string;
            /**
             * @enum {string}
             */
            location: "CONNECTED_LOCAL";
            capabilities: components["schemas"]["RuntimeCapabilitiesV1"];
        };
        EnrollmentDTO: {
            id: components["schemas"]["Id"];
            deviceCode: string;
            userCode: string;
            verificationUrl: components["schemas"]["HttpUrl"];
            expiresAt: components["schemas"]["Timestamp"];
            /**
             * @constant
             */
            intervalSeconds: 5;
        };
        EnrollmentApprove: {
            workspaceId: components["schemas"]["Id"];
            private: boolean;
            sharedWithUserIds: components["schemas"]["Id"][];
            userCode: string;
        };
        EnrollmentPoll: {
            deviceCode: string;
        };
        DeviceCredentialsDTO: {
            runnerId: components["schemas"]["Id"];
            deviceToken: string;
            expiresAt: components["schemas"]["Timestamp"];
            issuerId?: components["schemas"]["Key"];
            trustedKeys?: {
                keyId: components["schemas"]["Key"];
                /**
                 * @constant
                 */
                algorithm: "Ed25519";
                publicKey: string;
                fingerprint: components["schemas"]["Sha256"];
            }[];
            workspaceId: components["schemas"]["Id"];
        };
        RuntimeGrantWrite: {
            workspaceId: components["schemas"]["Id"];
            userIds: components["schemas"]["Id"][];
            sharedWithWorkspace: boolean;
        };
        RuntimeTrustWrite: {
            /**
             * @enum {string}
             */
            trustStatus: "MANAGED" | "USER_REGISTERED";
            allowCredentialDelivery: boolean;
        };
        AgentSettingsWrite: {
            defaultProviderId: components["schemas"]["Id"] | null;
            agentProviderId: components["schemas"]["Id"] | null;
        };
        AgentSettingsDTO: {
            defaultProviderId: components["schemas"]["Id"] | null;
            agentProviderId: components["schemas"]["Id"] | null;
            resolvedProviderId: components["schemas"]["Id"] | null;
            /**
             * @enum {string}
             */
            providerStatus: "READY" | "UNCONFIGURED" | "UNAVAILABLE";
            /**
             * @description Whether the resolved conversation model is configured for image input.
             */
            supportsImages?: boolean;
            /**
             * @enum {string}
             */
            errorCode?: "AI_PROVIDER_NOT_FOUND" | "AI_PROVIDER_DISABLED" | "AI_ENDPOINT_FORBIDDEN";
        };
        AgentSessionCreate: {
            title?: string;
        };
        AgentSessionRename: {
            title: string;
        };
        AgentSessionDTO: {
            id: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            title: string;
            createdAt: components["schemas"]["Timestamp"];
            archived: boolean;
        };
        AgentTurnSubmit: {
            requestId: components["schemas"]["Id"];
            expectedProposalId?: components["schemas"]["Id"];
            text: string;
            attachments?: components["schemas"]["AgentAttachmentUpload"][];
        };
        /**
         * @enum {string}
         */
        AgentAttachmentMediaType: "text/plain" | "text/markdown" | "text/csv" | "image/png" | "image/jpeg";
        AgentAttachmentUpload: {
            name: string;
            mediaType: components["schemas"]["AgentAttachmentMediaType"];
            /**
             * @description Standard Base64 file bytes. Attachments total at most 2 MiB decoded per turn.
             */
            dataBase64: string;
        };
        AgentAttachmentDTO: {
            name: string;
            mediaType: components["schemas"]["AgentAttachmentMediaType"];
            sizeBytes: number;
        };
        AgentPlanPreview: {
            name: string;
            suiteVersionId: components["schemas"]["Id"];
            environmentVersionId: components["schemas"]["Id"];
            browsers: components["schemas"]["Browser"][];
            runtimeIds: components["schemas"]["Id"][];
            roleKeys: string[];
            /**
             * @enum {string}
             */
            overlapPolicy: "QUEUE" | "SKIP" | "REJECT";
            maxCaseRetries: number;
            revision?: number;
        };
        AgentRunSelection: {
            caseVersionIds: components["schemas"]["Id"][];
            environmentVersionId: components["schemas"]["Id"];
            browsers: components["schemas"]["Browser"][];
            runtimeIds: components["schemas"]["Id"][];
            roleKeys: string[];
            maxRetries?: number;
        } | {
            suiteVersionId: components["schemas"]["Id"];
            environmentVersionId: components["schemas"]["Id"];
            browsers: components["schemas"]["Browser"][];
            runtimeIds: components["schemas"]["Id"][];
            roleKeys: string[];
            maxRetries?: number;
        };
        AgentProposal: {
            /**
             * @constant
             */
            type: "SAVE_PLAN";
            planId?: components["schemas"]["Id"];
            plan: components["schemas"]["AgentPlanPreview"];
            previousPlan?: components["schemas"]["AgentPlanPreview"];
        } | {
            /**
             * @constant
             */
            type: "TRIGGER_PLAN";
            planId: components["schemas"]["Id"];
            planRevision: number;
            triggerInput?: {
                buildSha?: string;
                reason?: string;
            };
        } | {
            /**
             * @constant
             */
            type: "RUN_ONCE";
            selection: components["schemas"]["AgentRunSelection"];
            planId?: components["schemas"]["Id"];
            planRevision?: number;
        } | components["schemas"]["AgentResourceDraftProposal"];
        AgentReceipt: {
            /**
             * @constant
             */
            type: "SAVE_PLAN";
            planId: components["schemas"]["Id"];
            planRevision: number;
        } | {
            /**
             * @constant
             */
            type: "TRIGGER_PLAN";
            planId: components["schemas"]["Id"];
            planRevision: number;
            runId: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            decision: "ENQUEUED" | "REUSED" | "SKIPPED";
        } | {
            /**
             * @constant
             */
            type: "RUN_ONCE";
            runId: components["schemas"]["Id"];
        } | {
            /**
             * @constant
             */
            type: "SAVE_RESOURCE_DRAFT";
            resourceId: components["schemas"]["Id"];
            revision: number;
            kind: components["schemas"]["AgentConfigurableResourceKind"];
        };
        AgentTurnDTO: {
            id: components["schemas"]["Id"];
            text: string;
            attachments?: components["schemas"]["AgentAttachmentDTO"][];
            /**
             * @enum {string}
             */
            status: "RUNNING" | "COMPLETED" | "FAILED";
            createdAt: components["schemas"]["Timestamp"];
            reply?: string;
            errorCode?: string;
            providerId?: components["schemas"]["Id"];
            providerRevision?: number;
            relatedRunId?: components["schemas"]["Id"];
            proposal?: components["schemas"]["AgentProposal"];
            receipt?: components["schemas"]["AgentReceipt"];
            thinking?: string;
            steps?: components["schemas"]["AgentTurnStepDTO"][];
        };
        AgentTurnStepDTO: {
            name: string;
            summary?: string;
            /**
             * @enum {string}
             */
            status: "SUCCEEDED" | "FAILED";
            errorCode?: string;
        };
        AgentSettingsDTOEnvelope: {
            data: components["schemas"]["AgentSettingsDTO"];
            requestId: components["schemas"]["Id"];
        };
        AgentSessionDTOEnvelope: {
            data: components["schemas"]["AgentSessionDTO"];
            requestId: components["schemas"]["Id"];
        };
        AgentTurnDTOEnvelope: {
            data: components["schemas"]["AgentTurnDTO"];
            requestId: components["schemas"]["Id"];
        };
        AgentSessionDTOPageEnvelope: {
            data: {
                items: components["schemas"]["AgentSessionDTO"][];
                nextCursor: string | null;
            };
            requestId: components["schemas"]["Id"];
        };
        AgentTurnDTOPageEnvelope: {
            data: {
                items: components["schemas"]["AgentTurnDTO"][];
                nextCursor: string | null;
            };
            requestId: components["schemas"]["Id"];
        };
        ExecutionPlanWrite: {
            name: string;
            suiteVersionId: components["schemas"]["Id"];
            environmentVersionId: components["schemas"]["Id"];
            browsers: components["schemas"]["Browser"][];
            runtimeIds: components["schemas"]["Id"][];
            /**
             * @enum {string}
             */
            overlapPolicy: "QUEUE" | "SKIP" | "REJECT";
            maxCaseRetries: number;
            roleKeys: string[];
            variables: components["schemas"]["JsonObject"];
            revision?: number;
        };
        ExecutionPlanDTO: {
            name: string;
            suiteVersionId: components["schemas"]["Id"];
            environmentVersionId: components["schemas"]["Id"];
            browsers: components["schemas"]["Browser"][];
            runtimeIds: components["schemas"]["Id"][];
            /**
             * @enum {string}
             */
            overlapPolicy: "QUEUE" | "SKIP" | "REJECT";
            maxCaseRetries: number;
            roleKeys: string[];
            variables: components["schemas"]["JsonObject"];
            revision: number;
            id: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            archived: boolean;
        };
        TriggerRequest: {
            buildSha?: string;
            reason?: string;
        };
        RunCreate: {
            caseVersionIds?: components["schemas"]["Id"][];
            suiteVersionId?: components["schemas"]["Id"];
            environmentVersionId: components["schemas"]["Id"];
            roleKeys: components["schemas"]["Key"][];
            browsers: components["schemas"]["Browser"][];
            runtimeIds: components["schemas"]["Id"][];
            variables?: components["schemas"]["JsonObject"];
            /**
             * @enum {unknown}
             */
            executionLocation?: "MANAGED_CLOUD" | "CONNECTED_LOCAL";
            maxRetries?: number;
            draftValidationJobId?: components["schemas"]["Id"];
            /**
             * @description Static matrix row keys for one frozen draft CASE; rows retain frozen order.
             */
            dataRowKeys?: components["schemas"]["Key"][];
        };
        RunDTO: {
            id: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            source: components["schemas"]["RunSource"];
            /**
             * @enum {string}
             */
            state: "QUEUED" | "RUNNING" | "CANCEL_REQUESTED" | "FINISHED";
            outcome?: components["schemas"]["Outcome"];
            snapshotHash: components["schemas"]["Sha256"];
            createdAt: components["schemas"]["Timestamp"];
            gateAtExecution?: boolean;
            gateNow?: boolean;
            /**
             * @enum {unknown}
             */
            triggerKind?: "MANUAL" | "DEBUG" | "HTTP_TRIGGER" | "OFFLINE_IMPORT";
            reasonCode?: string;
        };
        NotificationWorkspaceInviteDTO: {
            id: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "WORKSPACE_INVITED";
            workspaceId: components["schemas"]["Id"];
            workspaceName: string;
            occurredAt: components["schemas"]["Timestamp"];
            readAt: components["schemas"]["Timestamp"] | null;
            invitationId: components["schemas"]["Id"];
            actorName: string;
            /**
             * @enum {unknown}
             */
            invitationRole: "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER";
            /**
             * @enum {unknown}
             */
            invitationStatus: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED" | "UNAVAILABLE";
        };
        NotificationAgentReplyDTO: {
            id: components["schemas"]["Id"];
            /**
             * @constant
             */
            kind: "AGENT_REPLY";
            workspaceId: components["schemas"]["Id"];
            workspaceName: string;
            occurredAt: components["schemas"]["Timestamp"];
            readAt: components["schemas"]["Timestamp"] | null;
            sessionId: components["schemas"]["Id"];
            turnId: components["schemas"]["Id"];
            sessionTitle: string;
            preview: string;
        };
        NotificationRunDTO: {
            id: components["schemas"]["Id"];
            /**
             * @enum {unknown}
             */
            kind: "RUN_STARTED" | "RUN_FINISHED";
            workspaceId: components["schemas"]["Id"];
            workspaceName: string;
            occurredAt: components["schemas"]["Timestamp"];
            readAt: components["schemas"]["Timestamp"] | null;
            runId: components["schemas"]["Id"];
            planName: string;
            outcome: components["schemas"]["Outcome"] | null;
        };
        NotificationDTO: components["schemas"]["NotificationWorkspaceInviteDTO"]
            | components["schemas"]["NotificationAgentReplyDTO"] | components["schemas"]["NotificationRunDTO"];
        NotificationInboxDTO: {
            items: components["schemas"]["NotificationDTO"][];
            nextCursor?: string;
            unreadCount: number;
            readThrough: string;
        };
        NotificationReadAllRequest: {
            through: string;
        };
        NotificationReadAllDTO: {
            updated: number;
        };
        NotificationAcceptDTO: {
            workspaceId: components["schemas"]["Id"];
        };
        NotificationAgentSeenRequest: {
            workspaceId: components["schemas"]["Id"];
            sessionId: components["schemas"]["Id"];
            turnId: components["schemas"]["Id"];
        };
        NotificationAgentSeenDTO: {
            acknowledged: boolean;
        };
        NotificationInboxEvent: {
            revision: string;
        };
        NotificationAuthorizationEvent: {
            /**
             * @constant
             */
            code: "AUTHENTICATION_REQUIRED";
        };
        NotificationDTOEnvelope: {
            data: components["schemas"]["NotificationDTO"];
            requestId: string;
        };
        NotificationInboxDTOEnvelope: {
            data: components["schemas"]["NotificationInboxDTO"];
            requestId: string;
        };
        NotificationReadAllDTOEnvelope: {
            data: components["schemas"]["NotificationReadAllDTO"];
            requestId: string;
        };
        NotificationAcceptDTOEnvelope: {
            data: components["schemas"]["NotificationAcceptDTO"];
            requestId: string;
        };
        NotificationAgentSeenDTOEnvelope: {
            data: components["schemas"]["NotificationAgentSeenDTO"];
            requestId: string;
        };
        JobDTO: {
            id: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            kind: "TEST" | "VALIDATE" | "CLEANUP";
            /**
             * @enum {string}
             */
            state: "QUEUED" | "LEASED" | "RUNNING" | "CANCEL_REQUESTED" | "FINISHED";
            /**
             * @enum {string}
             */
            waitReason?: "RUNTIME_OFFLINE" | "NO_CAPABILITY" | "CAPACITY" | "RESOURCE_LOCK" | "QUARANTINED";
            activeAttemptId?: components["schemas"]["Id"];
            outcome?: components["schemas"]["AttemptOutcome"];
            /**
             * @description Safe code projected from validated server compilation or historical Attempt facts. Raw log
             * content is unavailable.
             */
            errorCode?: string;
            diagnostics?: components["schemas"]["CompilerDiagnosticV1"][];
        };
        ArtifactDTO: {
            id: components["schemas"]["Id"];
            attemptId: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            kind: "SCREENSHOT" | "TRACE" | "HTML" | "JUNIT" | "LOG" | "SOURCE" | "MANIFEST" | "DOWNLOAD";
            filename: string;
            contentType: string;
            sha256: components["schemas"]["Sha256"];
            sizeBytes: number;
            sensitivity: components["schemas"]["ArtifactSensitivity"];
        };
        BundleCreate: components["schemas"]["BundleSelectionV1"];
        BundleDTO: {
            id: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            manifestSha256: components["schemas"]["Sha256"];
            snapshotSha256: components["schemas"]["Sha256"];
            /**
             * @enum {string}
             */
            validationStatus: "VALIDATED" | "UNVALIDATED_DEBUG";
            createdAt: components["schemas"]["Timestamp"];
        };
        ImportDTO: {
            id: components["schemas"]["Id"];
            runId: components["schemas"]["Id"];
            localRunId: components["schemas"]["Id"];
            duplicate: boolean;
            /**
             * @constant
             */
            source: "OFFLINE_IMPORT";
            /**
             * @constant
             */
            officialGatePassed: false;
        };
        ProviderWrite: {
            name: string;
            /**
             * @enum {unknown}
             */
            adapter: "OPENAI_COMPATIBLE" | "ANTHROPIC";
            baseURL: string;
            model: string;
            enabled: boolean;
            supportsImages?: boolean;
            monthlyBudgetUsd: number;
            inputUsdPerMillion: number;
            outputUsdPerMillion: number;
            maxOutputTokens: number;
            maxRequestUsd: number;
            apiKey?: string;
        };
        ProviderDTO: {
            name: string;
            /**
             * @enum {unknown}
             */
            adapter: "OPENAI_COMPATIBLE" | "ANTHROPIC";
            baseURL: string;
            model: string;
            enabled: boolean;
            supportsImages?: boolean;
            monthlyBudgetUsd: number;
            inputUsdPerMillion: number;
            outputUsdPerMillion: number;
            maxOutputTokens: number;
            maxRequestUsd: number;
            id: components["schemas"]["Id"];
            revision: number;
            keyConfigured: boolean;
            budget: components["schemas"]["AiBudgetDTO"];
        };
        GenerationRequest: {
            requestId: components["schemas"]["Id"];
            providerId: components["schemas"]["Id"];
            /**
             * @enum {unknown}
             */
            purpose: "CASE_DRAFT" | "BOUNDARY_SUGGESTION" | "FAILURE_ANALYSIS";
            resourceId?: components["schemas"]["Id"];
            runId?: components["schemas"]["Id"];
            prompt: string;
            openapi?: components["schemas"]["JsonObject"];
            data?: components["schemas"]["JsonValue"];
            versionIds?: components["schemas"]["Id"][];
            contextHash?: string;
        };
        GenerationDTO: {
            id: components["schemas"]["Id"];
            providerId: components["schemas"]["Id"];
            requestId: components["schemas"]["Id"];
            createdAt: components["schemas"]["Timestamp"];
            /**
             * @enum {unknown}
             */
            status: "RUNNING" | "SUCCEEDED" | "FAILED" | "REVIEWED" | "REJECTED" | "CANCELLED";
            /**
             * @enum {unknown}
             */
            purpose: "CASE_DRAFT" | "BOUNDARY_SUGGESTION" | "FAILURE_ANALYSIS" | "CONNECTION_TEST";
            output?: components["schemas"]["JsonValue"];
            inputTokens?: number;
            outputTokens?: number;
            costUsd?: number;
            reservedUsd: number;
            /**
             * @enum {unknown}
             */
            costState: "ESTIMATED" | "UNKNOWN";
            errorCode?: string;
            diagnostics?: components["schemas"]["JsonObject"][];
            context?: components["schemas"]["JsonObject"];
            provenance?: components["schemas"]["JsonObject"][];
            pricing?: components["schemas"]["JsonObject"];
            resourceId?: components["schemas"]["Id"];
            /**
             * @constant
             */
            resourceState?: "DRAFT";
            revision?: number;
            original?: components["schemas"]["JsonValue"];
        };
        GenerationReview: {
            /**
             * @enum {unknown}
             */
            decision: "ACCEPT_DRAFT" | "REJECT";
            key?: components["schemas"]["Key"];
            name?: string;
            revision?: number;
        };
        ConnectionTestDTO: {
            ok: boolean;
            latencyMs?: number;
            errorCode?: string;
        };
        MaintenanceRequest: {
            limit: number;
            workspaceId?: components["schemas"]["Id"];
            cursor?: string;
        };
        MaintenanceDTO: {
            id: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            status: "QUEUED" | "RUNNING" | "FINISHED";
            processedCount: number;
            hasMore: boolean;
            nextCursor?: string;
        };
        SecretWrite: {
            key: components["schemas"]["Key"];
            value: {
                username?: string;
                password?: string;
                token?: string;
            };
            allowedRoleKeys: components["schemas"]["Key"][];
        };
        SecretDTO: {
            id: components["schemas"]["Id"];
            key: components["schemas"]["Key"];
            versionId: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            status: "ACTIVE" | "REVOKED";
            createdAt: components["schemas"]["Timestamp"];
        };
        AuditDTO: {
            id: components["schemas"]["Id"];
            workspaceId?: components["schemas"]["Id"];
            actorId: components["schemas"]["Id"];
            action: string;
            subjectId?: components["schemas"]["Id"];
            timestamp: components["schemas"]["Timestamp"];
            details: components["schemas"]["JsonObject"];
        };
        HealthDTO: {
            /**
             * @enum {string}
             */
            status: "ok" | "degraded";
            checks: {
                [key: string]: boolean;
            };
        };
        BuildInfoDTO: {
            version: string;
            commit: string;
            buildId: string;
            staticManifestHash: components["schemas"]["Sha256"];
        };
        ReconcileRequest: {
            fencingToken: number;
            processStopped: boolean;
            cleanupStatus: components["schemas"]["CleanupStatus"];
            stoppedAt: components["schemas"]["Timestamp"];
            processStopScope?: components["schemas"]["ProcessStopScope"];
        };
        ReconcileDTO: {
            attemptId: components["schemas"]["Id"];
            capacityReleased: boolean;
            auditId: components["schemas"]["Id"];
        };
        CredentialResolveRequest: {
            secretRef: string;
            /**
             * Format: uuid
             */
            versionId: string;
        };
        CredentialResolveDTO: {
            secretRef: string;
            versionId: components["schemas"]["Id"];
            value: components["schemas"]["JsonObject"];
        };
        ArtifactUploadRequest: {
            leaseToken: string;
            fencingToken: number;
            /**
             * @enum {string}
             */
            kind: "SCREENSHOT" | "TRACE" | "HTML" | "JUNIT" | "LOG" | "SOURCE" | "MANIFEST" | "DOWNLOAD";
            filename: components["schemas"]["FilePath"];
            contentType: string;
            sha256: components["schemas"]["Sha256"];
            sizeBytes: number;
            sensitivity: components["schemas"]["ArtifactSensitivity"];
        };
        ArtifactUploadDTO: {
            artifactId: components["schemas"]["Id"];
            uploadUrl: components["schemas"]["HttpUrl"];
            /**
             * @constant
             */
            method: "PUT";
            expiresAt: components["schemas"]["Timestamp"];
        };
        ArtifactCommitRequest: {
            leaseToken: string;
            fencingToken: number;
            sha256: components["schemas"]["Sha256"];
        };
        CancelRequest: {
            reason: string;
        };
        ReportDTO: {
            run: components["schemas"]["RunDTO"];
            cases: components["schemas"]["ReportCaseDTO"][];
            gateAtExecution: components["schemas"]["GateDTO"];
            gateNow: components["schemas"]["GateDTO"];
            statistics: {
                caseCount: number;
                firstPassCount: number;
                retryPassCount: number;
                infrastructureErrorCount: number;
            };
        };
        ServiceAccountWrite: {
            name: string;
            scopes: ("RUN_TRIGGER" | "MAINTENANCE" | "READ_REPORTS")[];
            planIds: components["schemas"]["Id"][];
        };
        ServiceAccountDTO: {
            id: components["schemas"]["Id"];
            workspaceId: components["schemas"]["Id"];
            name: string;
            disabled: boolean;
        };
        ServiceTokenDTO: {
            id: components["schemas"]["Id"];
            token: string;
            /**
             * @enum {unknown}
             */
            purpose: "RUNTIME_ENROLLMENT" | "MAINTENANCE" | "EXECUTION";
            expiresAt: components["schemas"]["Timestamp"];
        };
        HealthDTOEnvelope: {
            data: components["schemas"]["HealthDTO"];
            requestId: string;
        };
        BuildInfoDTOEnvelope: {
            data: components["schemas"]["BuildInfoDTO"];
            requestId: string;
        };
        SessionDTOEnvelope: {
            data: components["schemas"]["SessionDTO"];
            requestId: string;
        };
        EmptyEnvelope: {
            data: components["schemas"]["Empty"];
            requestId: string;
        };
        UserDTOEnvelope: {
            data: components["schemas"]["UserDTO"];
            requestId: string;
        };
        WorkspaceDTOPageEnvelope: {
            data: {
                items: components["schemas"]["WorkspaceDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        WorkspaceDTOEnvelope: {
            data: components["schemas"]["WorkspaceDTO"];
            requestId: string;
        };
        MemberDTOPageEnvelope: {
            data: {
                items: components["schemas"]["MemberDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        MemberDTOEnvelope: {
            data: components["schemas"]["MemberDTO"];
            requestId: string;
        };
        InviteDTOEnvelope: {
            data: components["schemas"]["InviteDTO"];
            requestId: string;
        };
        ResourceDTOPageEnvelope: {
            data: {
                items: components["schemas"]["ResourceDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ResourceDTOEnvelope: {
            data: components["schemas"]["ResourceDTO"];
            requestId: string;
        };
        DraftDTOEnvelope: {
            data: components["schemas"]["DraftDTO"];
            requestId: string;
        };
        JobDTOEnvelope: {
            data: components["schemas"]["JobDTO"];
            requestId: string;
        };
        ResourceVersionDTOEnvelope: {
            data: components["schemas"]["ResourceVersionDTO"];
            requestId: string;
        };
        ResourceVersionDTOPageEnvelope: {
            data: {
                items: components["schemas"]["ResourceVersionDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ExecutionPlanDTOPageEnvelope: {
            data: {
                items: components["schemas"]["ExecutionPlanDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ExecutionPlanDTOEnvelope: {
            data: components["schemas"]["ExecutionPlanDTO"];
            requestId: string;
        };
        ProviderDTOPageEnvelope: {
            data: {
                items: components["schemas"]["ProviderDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ProviderDTOEnvelope: {
            data: components["schemas"]["ProviderDTO"];
            requestId: string;
        };
        ServiceAccountDTOPageEnvelope: {
            data: {
                items: components["schemas"]["ServiceAccountDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ServiceAccountDTOEnvelope: {
            data: components["schemas"]["ServiceAccountDTO"];
            requestId: components["schemas"]["Id"];
        };
        RunDTOEnvelope: {
            data: components["schemas"]["RunDTO"];
            requestId: string;
        };
        RunDTOPageEnvelope: {
            data: {
                items: components["schemas"]["RunDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ReportDTOEnvelope: {
            data: components["schemas"]["ReportDTO"];
            requestId: string;
        };
        JobDTOPageEnvelope: {
            data: {
                items: components["schemas"]["JobDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ArtifactDTOEnvelope: {
            data: components["schemas"]["ArtifactDTO"];
            requestId: string;
        };
        RuntimeDTOPageEnvelope: {
            data: {
                items: components["schemas"]["RuntimeDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        RuntimeDTOEnvelope: {
            data: components["schemas"]["RuntimeDTO"];
            requestId: string;
        };
        EnrollmentDTOEnvelope: {
            data: components["schemas"]["EnrollmentDTO"];
            requestId: string;
        };
        DeviceCredentialsDTOEnvelope: {
            data: components["schemas"]["DeviceCredentialsDTO"];
            requestId: string;
        };
        BundleDTOEnvelope: {
            data: components["schemas"]["BundleDTO"];
            requestId: string;
        };
        BundleDTOPageEnvelope: {
            data: {
                items: components["schemas"]["BundleDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        BundleManifestV1Envelope: {
            data: components["schemas"]["BundleManifestV1"];
            requestId: string;
        };
        ImportDTOEnvelope: {
            data: components["schemas"]["ImportDTO"];
            requestId: string;
        };
        ConnectionTestDTOEnvelope: {
            data: components["schemas"]["ConnectionTestDTO"];
            requestId: string;
        };
        GenerationDTOEnvelope: {
            data: components["schemas"]["GenerationDTO"];
            requestId: string;
        };
        GenerationDTOPageEnvelope: {
            data: {
                items: components["schemas"]["GenerationDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        SecretDTOEnvelope: {
            data: components["schemas"]["SecretDTO"];
            requestId: string;
        };
        SecretDTOPageEnvelope: {
            data: {
                items: components["schemas"]["SecretDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        AuditDTOPageEnvelope: {
            data: {
                items: components["schemas"]["AuditDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ServiceTokenDTOEnvelope: {
            data: components["schemas"]["ServiceTokenDTO"];
            requestId: components["schemas"]["Id"];
        };
        MaintenanceDTOEnvelope: {
            data: components["schemas"]["MaintenanceDTO"];
            requestId: string;
        };
        ClaimDTOEnvelope: {
            data: components["schemas"]["ClaimDTO"];
            requestId: string;
        };
        HeartbeatDTOEnvelope: {
            data: components["schemas"]["HeartbeatDTO"];
            requestId: string;
        };
        EventBatchDTOEnvelope: {
            data: components["schemas"]["EventBatchDTO"];
            requestId: string;
        };
        FinishDTOEnvelope: {
            data: components["schemas"]["FinishDTO"];
            requestId: string;
        };
        ReconcileDTOEnvelope: {
            data: components["schemas"]["ReconcileDTO"];
            requestId: string;
        };
        CredentialResolveDTOEnvelope: {
            data: components["schemas"]["CredentialResolveDTO"];
            requestId: string;
        };
        ArtifactUploadDTOEnvelope: {
            data: components["schemas"]["ArtifactUploadDTO"];
            requestId: string;
        };
        /**
         * Format: date-time
         * @description Supported RFC3339 profile: real Gregorian date, year 0001-9999, T/t separator, seconds 00-59,
         * optional fractional seconds, mandatory Z/z or numeric offset (00-23:00-59). No leap seconds, spaces or
         * surrounding whitespace. Emit UTC uppercase T/Z for server timestamps.
         */
        Timestamp: string;
        ValidationReceiptDTOEnvelope: {
            data: components["schemas"]["ValidationReceiptDTO"];
            requestId: string;
        };
        SetupRequest: {
            installationSecret: string;
            /**
             * Format: email
             */
            email: string;
            displayName: string;
            password: string;
        };
        SetupDTO: {
            initialized: boolean;
            csrfToken: string;
        };
        AdminUserDTO: {
            id: components["schemas"]["Id"];
            /**
             * Format: email
             */
            email: string;
            displayName: string;
            disabled: boolean;
            systemAdmin: boolean;
            createdAt: components["schemas"]["Timestamp"];
            /**
             * @enum {string|null}
             */
            role?: "OWNER" | "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER" | null;
            isMember?: boolean;
        };
        CreateUserRequest: {
            /**
             * Format: email
             */
            email: string;
            displayName: string;
            password: string;
            systemAdmin: boolean;
        };
        UpdateUserRequest: {
            disabled?: boolean;
            systemAdmin?: boolean;
        };
        ChangePasswordRequest: {
            currentPassword: string;
            newPassword: string;
        };
        ResetLinkDTO: {
            /**
             * Format: uri
             */
            url: string;
            expiresAt: components["schemas"]["Timestamp"];
        };
        AccountSessionDTO: {
            id: components["schemas"]["Id"];
            createdAt: components["schemas"]["Timestamp"];
            expiresAt: components["schemas"]["Timestamp"];
            current: boolean;
            /**
             * @description Browser family inferred at sign-in. Omitted when unavailable.
             * @enum {string}
             */
            browser?: "CHROME" | "CHROMIUM" | "EDGE" | "FIREFOX" | "SAFARI" | "OPERA" | "ELECTRON" | "OTHER";
            /**
             * @description Operating system family inferred at sign-in. Omitted when unavailable.
             * @enum {string}
             */
            operatingSystem?: "WINDOWS" | "MACOS" | "LINUX" | "IOS" | "ANDROID" | "CHROMEOS" | "OTHER";
            /**
             * @description Last recorded sign-in or successful authenticated application activity.
             */
            lastActiveAt?: components["schemas"]["Timestamp"];
        };
        AdminUsersDTO: {
            items: components["schemas"]["AdminUserDTO"][];
            nextCursor: string | null;
        };
        AccountSessionsDTO: {
            items: components["schemas"]["AccountSessionDTO"][];
            nextCursor: string | null;
        };
        SetupDTOEnvelope: {
            data: components["schemas"]["SetupDTO"];
            requestId: string;
        };
        AdminUserDTOEnvelope: {
            data: components["schemas"]["AdminUserDTO"];
            requestId: string;
        };
        AdminUsersDTOEnvelope: {
            data: components["schemas"]["AdminUsersDTO"];
            requestId: string;
        };
        ResetLinkDTOEnvelope: {
            data: components["schemas"]["ResetLinkDTO"];
            requestId: string;
        };
        AccountSessionsDTOEnvelope: {
            data: components["schemas"]["AccountSessionsDTO"];
            requestId: string;
        };
        LivenessDTO: {
            alive: boolean;
        };
        LivenessDTOEnvelope: {
            data: components["schemas"]["LivenessDTO"];
            requestId: string;
        };
        ReadinessDTO: {
            ready: boolean;
        };
        ReadinessDTOEnvelope: {
            data: components["schemas"]["ReadinessDTO"];
            requestId: string;
        };
        InvitationSummaryDTO: {
            id: components["schemas"]["Id"];
            /**
             * Format: email
             */
            email: string;
            /**
             * @enum {string}
             */
            role: "ADMIN" | "EDITOR" | "EXECUTOR" | "VIEWER";
            expiresAt: components["schemas"]["Timestamp"];
            /**
             * @enum {string}
             */
            status: "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";
            createdAt: components["schemas"]["Timestamp"];
        };
        InvitationSummaryDTOPageEnvelope: {
            data: {
                items: components["schemas"]["InvitationSummaryDTO"][];
                nextCursor: string | null;
            };
            requestId: string;
        };
        ValidationPreviewDTO: {
            resourceId: components["schemas"]["Id"];
            candidateVersionId: components["schemas"]["Id"];
            documentHash: components["schemas"]["Sha256"];
            sourceHash: components["schemas"]["Sha256"];
            engineVersion: components["schemas"]["Version"];
            revision: number;
        };
        ValidationPreviewDTOEnvelope: {
            data: components["schemas"]["ValidationPreviewDTO"];
            requestId: string;
        };
        CredentialRotate: {
            value: components["schemas"]["JsonObject"];
            allowedIdentityIds: string[];
        };
        CredentialCreate: {
            value: components["schemas"]["JsonObject"];
            allowedIdentityIds: string[];
            secretRef: string;
        };
        EmptyObject: Record<string, never>;
        CredentialDTO: {
            secretRef: string;
            /**
             * Format: uuid
             */
            versionId: string;
            revoked: boolean;
            allowedIdentityIds: string[];
            /**
             * Format: date-time
             */
            createdAt: string;
        };
        CredentialListDTO: {
            items: components["schemas"]["CredentialDTO"][];
            nextCursor: string | null;
        };
        CredentialDTOEnvelope: {
            data: components["schemas"]["CredentialDTO"];
            requestId: string;
        };
        CredentialListDTOEnvelope: {
            data: components["schemas"]["CredentialListDTO"];
            requestId: string;
        };
        AuthAdapterCreate: {
            configuration: components["schemas"]["AuthAdapterConfigV1"];
        };
        AuthAdapterDTO: {
            workspaceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            contentHash: components["schemas"]["Sha256"];
            configuration: components["schemas"]["AuthAdapterConfigV1"];
            revoked: boolean;
        };
        AuthAdapterListDTO: {
            items: components["schemas"]["AuthAdapterDTO"][];
            nextCursor: string | null;
        };
        AuthAdapterDTOEnvelope: {
            data: components["schemas"]["AuthAdapterDTO"];
            requestId: string;
        };
        AuthAdapterListDTOEnvelope: {
            data: components["schemas"]["AuthAdapterListDTO"];
            requestId: string;
        };
        EnrollmentInspect: {
            userCode: string;
        };
        EnrollmentPreview: {
            id: components["schemas"]["Id"];
            name: string;
            capabilities: components["schemas"]["RuntimeCapabilitiesV1"];
        };
        EnrollmentPreviewEnvelope: {
            data: components["schemas"]["EnrollmentPreview"];
            requestId: components["schemas"]["Id"];
        };
        ServiceAccountCreate: {
            name: string;
        };
        ServiceTokenIssue: {
            /**
             * @enum {unknown}
             */
            purpose: "RUNTIME_ENROLLMENT" | "MAINTENANCE" | "EXECUTION";
            operations?: ("expired-leases/reap" | "fixture-cleanups/reconcile" | "capacity/reconcile"
                | "artifacts/expire" | "lifecycle/expire" | "trigger" | "read" | "cancel")[];
            planIds?: components["schemas"]["Id"][];
        } & (unknown & unknown & unknown);
        ServiceEnrollmentRequest: {
            name: string;
            capabilities: components["schemas"]["RuntimeCapabilitiesV1"];
            sharedWithWorkspace: boolean;
        };
        RuntimeCredentialDeliveryWrite: {
            allowCredentialDelivery: boolean;
        };
        LeaseProofRequest: {
            leaseToken: string;
            fencingToken: number;
        };
        ActivationDTO: {
            attemptId: components["schemas"]["Id"];
            /**
             * @constant
             */
            activated: true;
            fencingToken: number;
        };
        ActivationDTOEnvelope: {
            data: components["schemas"]["ActivationDTO"];
            requestId: string;
        };
        AdminReconcileRequest: {
            /**
             * @constant
             */
            processStopped: true;
            reason: string;
        };
        UploadChunkDTO: {
            artifactId: components["schemas"]["Id"];
            receivedBytes: number;
            complete: boolean;
        };
        UploadChunkDTOEnvelope: {
            data: components["schemas"]["UploadChunkDTO"];
            requestId: string;
        };
        CompletionManifestV1: components["schemas"]["TestCompletionManifestV1"]
            | components["schemas"]["ValidateCompletionManifestV1"]
            | components["schemas"]["CleanupCompletionManifestV1"];
        DeviceRotationRequest: Record<string, never> | {
            clientRequestId: components["schemas"]["Id"];
            replacementToken: string;
        };
        CompiledSourceDTO: {
            descriptorSha256: components["schemas"]["Sha256"];
            files: components["schemas"]["FileEntry"][];
        };
        CompiledSourceDTOEnvelope: {
            data: components["schemas"]["CompiledSourceDTO"];
            requestId: string;
        };
        CompilerDiagnosticV1: {
            code: string;
            path: string;
            /**
             * @enum {unknown}
             */
            pathStatus: "EXACT" | "REDACTED";
            message: string;
        };
        GateDTO: {
            passed: boolean;
            reasons: string[];
        };
        ReportAttemptDTO: {
            id: components["schemas"]["Id"];
            attemptNo: number;
            runtimeId: components["schemas"]["Id"] | null;
            phase: string;
            outcome: string | null;
            facts: {
                [key: string]: components["schemas"]["JsonValue"];
            };
            createdAt: string;
            activatedAt: string | null;
            lastSequence: number;
            provenance: components["schemas"]["JsonValue"];
            gateAtExecution: components["schemas"]["GateDTO"];
            gateNow: components["schemas"]["GateDTO"];
            compensations: {
                id: string;
                state: string;
                outcome: string | null;
            }[];
            /**
             * Format: date-time
             * @description Server database UTC terminal time, independent of physical process-stop proof; null for
             * historical unknown.
             */
            finishedAt: string | null;
        };
        ReportCaseDTO: {
            id: components["schemas"]["Id"];
            caseVersionId: components["schemas"]["Id"];
            state: string;
            outcome: string | null;
            provenance: {
                [key: string]: components["schemas"]["JsonValue"];
            };
            attempts: components["schemas"]["ReportAttemptDTO"][];
        };
        RunReportDTO: {
            run: components["schemas"]["RunDTO"];
            cases: components["schemas"]["ReportCaseDTO"][];
            gateAtExecution: components["schemas"]["GateDTO"];
            gateNow: components["schemas"]["GateDTO"];
            statistics: {
                caseCount: number;
                firstPassCount: number;
                retryPassCount: number;
                infrastructureErrorCount: number;
            };
        };
        ReportStreamRequest: {
            cursor?: string;
        };
        ReportEventDTO: {
            schemaVersion: string;
            attemptId: components["schemas"]["Id"];
            sequence: number;
            timestamp: string;
            type: string;
            payload: components["schemas"]["JsonValue"];
            valuesAvailable: boolean;
            stepId?: string;
            assertionId?: string;
        };
        ReportHistoryDTO: {
            items: components["schemas"]["ReportEventDTO"][];
            nextSequence: number;
            hasMore: boolean;
        };
        ReportArtifactDTO: {
            id: components["schemas"]["Id"];
            attemptId: components["schemas"]["Id"];
            sha256: components["schemas"]["Sha256"];
            sizeBytes: number;
            kind: string;
            /**
             * @constant
             */
            sensitivity: "CREDENTIAL_RESTRICTED";
            /**
             * @enum {unknown}
             */
            state: "AVAILABLE" | "EXPIRED";
        };
        ReportArtifactsDTO: {
            items: components["schemas"]["ReportArtifactDTO"][];
        };
        ReportAuditDTO: {
            items: {
                id: components["schemas"]["Id"];
                actorId: string | null;
                targetId: string | null;
                action: string;
                createdAt: string;
            }[];
            nextCursor: string | null;
        };
        RunReportDTOEnvelope: {
            data: components["schemas"]["RunReportDTO"];
            requestId: string;
        };
        ReportHistoryDTOEnvelope: {
            data: components["schemas"]["ReportHistoryDTO"];
            requestId: string;
        };
        ReportArtifactsDTOEnvelope: {
            data: components["schemas"]["ReportArtifactsDTO"];
            requestId: string;
        };
        ReportAuditDTOEnvelope: {
            data: components["schemas"]["ReportAuditDTO"];
            requestId: string;
        };
        ReportCaseDisplayDTO: {
            caseVersionId: components["schemas"]["Id"];
            caseKey: components["schemas"]["Key"];
            title: string;
            steps: {
                id: components["schemas"]["Key"];
                sourceId: components["schemas"]["Key"];
                sourcePath: string;
                action: string;
                order: number;
                parentId?: components["schemas"]["Key"];
                assertions: {
                    id: components["schemas"]["Key"];
                    sourceId: components["schemas"]["Key"];
                    sourcePath: string;
                    type: string;
                    operator?: string;
                    expectedSource: string;
                    /**
                     * @enum {unknown}
                     */
                    severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
                }[];
                observers: {
                    id: components["schemas"]["Key"];
                    kind: string;
                    method?: string;
                    path?: string;
                }[];
            }[];
        };
        ReportDisplayDTO: {
            display: components["schemas"]["ReportCaseDisplayDTO"] | null;
            /**
             * @enum {unknown}
             */
            metadataStatus: "AVAILABLE" | "ABSENT" | "REDACTED";
            environment: {
                [key: string]: string;
            };
        };
        ReportDisplayDTOEnvelope: {
            data: components["schemas"]["ReportDisplayDTO"];
            requestId: string;
        };
        AiBudgetDTO: {
            month: string;
            estimatedUsedUsd: number;
            heldUsd: number;
            availableUsd: number;
            /**
             * @constant
             */
            pricingBasis: "CONFIGURED_ESTIMATE";
        };
        AiContextDTO: {
            context: components["schemas"]["JsonObject"];
            contextHash: string;
            inputTokenBound: number;
            reservedUsd: number;
            provenance: components["schemas"]["JsonObject"][];
        };
        AiConnectionRequest: {
            requestId: components["schemas"]["Id"];
        };
        AiContextDTOEnvelope: {
            data: components["schemas"]["AiContextDTO"];
            requestId: components["schemas"]["Id"];
        };
        IssuerTrustV1: {
            issuerId: components["schemas"]["Key"];
            revision: number;
            keys: components["schemas"]["IssuerKeyV1"][];
        };
        IssuerTrustEnvelope: {
            data: components["schemas"]["IssuerTrustV1"];
            requestId: string;
        };
        OfflineArtifactV1: {
            path: components["schemas"]["FilePath"];
            sha256: components["schemas"]["Sha256"];
            sizeBytes: number;
            sensitivity: components["schemas"]["ArtifactSensitivity"];
            /**
             * @enum {unknown}
             */
            kind?: "TRACE" | "DOWNLOAD" | "LOG" | "SOURCE" | "MANIFEST" | "HTML" | "JUNIT" | "SCREENSHOT";
            artifactId?: components["schemas"]["Id"];
        };
        OfflineUploadRequest: {
            bundleId: components["schemas"]["Id"];
            localRunId: components["schemas"]["Id"];
            attemptId: components["schemas"]["Id"];
            file: components["schemas"]["OfflineArtifactV1"];
        };
        OfflineUploadDTO: {
            id: components["schemas"]["Id"];
            uploadUrl: string;
        };
        OfflineChunkDTO: {
            id: components["schemas"]["Id"];
            receivedBytes: number;
            complete: boolean;
        };
        OfflineUploadDTOEnvelope: {
            data: components["schemas"]["OfflineUploadDTO"];
            requestId: components["schemas"]["Id"];
        };
        OfflineChunkDTOEnvelope: {
            data: components["schemas"]["OfflineChunkDTO"];
            requestId: components["schemas"]["Id"];
        };
        ExecutionPlanArchive: {
            revision: number;
        };
        TriggerReceipt: {
            /**
             * @enum {unknown}
             */
            decision: "ENQUEUED" | "REUSED" | "SKIPPED";
            runId: components["schemas"]["Id"];
            statusUrl: string;
        };
        TriggerReceiptEnvelope: {
            data: components["schemas"]["TriggerReceipt"];
            requestId: components["schemas"]["Id"];
        };
        CIReport: {
            run: components["schemas"]["RunDTO"];
            gatePassed: boolean;
            cases: {
                id: components["schemas"]["Id"];
                /**
                 * @enum {unknown}
                 */
                state: "QUEUED" | "RUNNING" | "FINISHED";
                /**
                 * @enum {string|null}
                 */
                outcome: "PASSED" | "FAILED" | "ERROR" | "UNSTABLE" | "CANCELLED" | "INCOMPLETE" | "SKIPPED" | null;
            }[];
            statistics: {
                caseCount: number;
                firstPassCount: number;
                retryPassCount: number;
                infrastructureErrorCount: number;
            };
        };
        CIReportEnvelope: {
            data: components["schemas"]["CIReport"];
            requestId: components["schemas"]["Id"];
        };
        ServiceTokenMetadata: {
            id: components["schemas"]["Id"];
            /**
             * @enum {unknown}
             */
            purpose: "RUNTIME_ENROLLMENT" | "MAINTENANCE" | "EXECUTION";
            operations: string[];
            planIds: components["schemas"]["Id"][];
            /**
             * Format: date-time
             */
            expiresAt: string;
            revoked: boolean;
            consumed: boolean;
        };
        ServiceTokenPage: {
            items: components["schemas"]["ServiceTokenMetadata"][];
            nextCursor: string | null;
        };
        ServiceTokenPageEnvelope: {
            data: components["schemas"]["ServiceTokenPage"];
            requestId: components["schemas"]["Id"];
        };
        /**
         * @enum {string}
         */
        ProcessStopScope: "FULL_DESCENDANT_TREE" | "CONTROLLED_WORKER_BROWSER" | "NO_PROCESS_SPAWNED";
        OperationsMetricsDTO: {
            workspaceId: components["schemas"]["Id"];
            observedAt: components["schemas"]["Timestamp"];
            queue: {
                [key: string]: number;
            };
            capacity: {
                [key: string]: number;
            };
            leases: {
                active: number;
                expired: number;
            };
            heartbeat: {
                devices: number;
                stale: number;
            };
            events: {
                persisted: number;
                accepted: number;
                backlog: number;
            };
            cleanup: {
                [key: string]: number;
            };
            storage: {
                objects: number;
                bytes: number;
                pendingDeletions: number;
                pendingPublications: number;
                incompleteUploads: number;
            };
            modelCost: {
                recordedMicros: number;
                reservedMicros: number;
                unknown: number;
            };
        };
        OperationsMetricsDTOEnvelope: {
            data: components["schemas"]["OperationsMetricsDTO"];
            requestId: string;
        };
        SampleWorkspacePackageDTO: {
            /**
             * @enum {string}
             */
            schemaVersion: "1.0";
            manifest: components["schemas"]["JsonValue"];
            assets: {
                [key: string]: components["schemas"]["JsonValue"];
            };
            sourceInventory: {
                [key: string]: string;
            };
        };
        SampleWorkspacePackageDTOEnvelope: {
            data: components["schemas"]["SampleWorkspacePackageDTO"];
            requestId: string;
        };
        DatasetSummary: {
            /**
             * @enum {unknown}
             */
            format: "STATIC_TABLE" | "STATIC_TREE" | "HTTP_TABLE" | "HTTP_TREE";
            fieldCount: number;
            entryCount?: number;
            lastSavedAt: components["schemas"]["Timestamp"];
            hasUnpublishedChanges: boolean;
        };
        /**
         * @description JSON used only in interpolated DSL fields, recursively restricted to SafeString bindings.
         */
        BindingJsonValue: ContractBindingJsonValue;
        BindingJsonObject: {
            [key: string]: components["schemas"]["BindingJsonValue"];
        };
        NetworkObserverV1: {
            id: components["schemas"]["Key"];
            method: components["schemas"]["HttpMethod"];
            path: components["schemas"]["Path"];
            queryMatch?: components["schemas"]["BindingJsonObject"];
            bodyMatch?: components["schemas"]["BindingJsonObject"];
            timeoutMs?: components["schemas"]["Timeout"];
            window?: components["schemas"]["ObserverWindow"];
            expectedCount?: number;
            /**
             * @enum {string}
             */
            retryPolicy?: "FORBID" | "ALLOW_MATCHING_RETRIES";
        } & unknown;
        DialogObserverV1: {
            id: components["schemas"]["Key"];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            kind: "dialog";
            /**
             * @enum {unknown}
             */
            dialogType: "alert" | "beforeunload" | "confirm" | "prompt";
            message: components["schemas"]["SafeString"];
            /**
             * @enum {unknown}
             */
            handling: "accept" | "dismiss";
            promptText?: components["schemas"]["SafeString"];
        } & unknown;
        NewPageObserverV1: {
            id: components["schemas"]["Key"];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            kind: "newPage";
            pageKey: components["schemas"]["Key"];
        };
        DownloadObserverV1: {
            id: components["schemas"]["Key"];
            timeoutMs?: components["schemas"]["Timeout"];
            /**
             * @constant
             */
            kind: "download";
        };
        DatasetBindings: {
            [key: string]: components["schemas"]["Id"];
        };
        DatasetSignatureInput: {
            /**
             * @enum {unknown}
             */
            op: "QUERY" | "PATH" | "BODY" | "METHOD" | "TIMESTAMP";
        } | {
            /**
             * @constant
             */
            op: "PARAMETER";
            name: components["schemas"]["Key"];
        } | {
            /**
             * @constant
             */
            op: "LITERAL";
            value: string;
        } | {
            /**
             * @enum {unknown}
             */
            op: "PERCENT_ENCODE" | "SHA256" | "BASE64";
            input: components["schemas"]["DatasetSignatureInput"];
        } | {
            /**
             * @constant
             */
            op: "JOIN";
            separator: string;
            parts: components["schemas"]["DatasetSignatureInput"][];
        } | {
            /**
             * @constant
             */
            op: "SORTED_QUERY";
            names?: string[];
        };
        DatasetHttpAuth: {
            /**
             * @constant
             */
            kind: "NONE";
        } | {
            /**
             * @enum {unknown}
             */
            kind: "BEARER" | "BASIC";
            secretRef: components["schemas"]["Key"] | null;
            secretVersionId: components["schemas"]["Id"] | null;
        } | {
            /**
             * @constant
             */
            kind: "SIGNED";
            secretRef: components["schemas"]["Key"] | null;
            secretVersionId: components["schemas"]["Id"] | null;
            header: string;
            /**
             * @enum {unknown}
             */
            algorithm: "HMAC_SHA256" | "AES256_GCM";
            input: components["schemas"]["DatasetSignatureInput"];
        } | {
            /**
             * @constant
             */
            kind: "API_KEY";
            header: string;
            secretRef: components["schemas"]["Key"] | null;
            secretVersionId: components["schemas"]["Id"] | null;
        };
        DatasetHttpMapping: {
            rows: string;
            key: string;
            values: {
                [key: string]: string;
            };
            parentKey?: string;
            order?: string;
        };
        DatasetHttpSource: {
            /**
             * @constant
             */
            kind: "HTTP";
            connectionRef: components["schemas"]["Id"] | null;
            environmentVersionId: components["schemas"]["Id"] | null;
            /**
             * @enum {unknown}
             */
            method: "GET" | "POST";
            path: string;
            query: {
                name: string;
                value: string | {
                    parameter: components["schemas"]["Key"];
                };
            }[];
            headers: {
                [key: string]: string;
            };
            parameters: {
                [key: string]: components["schemas"]["ValueType"];
            };
            body: {
                json: components["schemas"]["JsonValue"];
            } | null | {
                parameter: components["schemas"]["Key"];
            } | {
                raw: string | {
                    parameter: components["schemas"]["Key"];
                };
            } | {
                form: {
                    name: string;
                    value: string | {
                        parameter: components["schemas"]["Key"];
                    };
                }[];
            };
            auth: components["schemas"]["DatasetHttpAuth"];
            mapping: components["schemas"]["DatasetHttpMapping"];
            pagination?: {
                /**
                 * @enum {unknown}
                 */
                kind: "PAGE" | "CURSOR";
                parameter: components["schemas"]["Key"];
                next: string;
                maxPages: number;
            };
        };
        FixtureIdentityV1: {
            authAdapterVersionId: components["schemas"]["Id"];
            secretRef: components["schemas"]["Key"];
            secretVersionId: components["schemas"]["Id"];
            allowedIdentityIds?: string[];
        };
        /**
         * @enum {string}
         */
        AgentConfigurableResourceKind: "CASE" | "SUITE" | "DATASET" | "ELEMENT_CATALOG" | "ASSERTION_TEMPLATE" | "FLOW";
        AgentResourceDraftProposal: {
            /**
             * @constant
             */
            type: "SAVE_RESOURCE_DRAFT";
            resource: {
                kind: components["schemas"]["AgentConfigurableResourceKind"];
                key: components["schemas"]["Key"];
                name: string;
                content: components["schemas"]["ResourceDocumentV1"];
            };
            resourceId?: components["schemas"]["Id"];
            revision?: number;
        };
        DurationMs: number;
        /**
         * @description Literal diagnostic/evidence text; retain invalid expressions verbatim and never evaluate or
         * interpolate it.
         */
        DiagnosticText: string;
        StepFinishedPayloadV1: {
            /**
             * @enum {string}
             */
            status: "PASSED" | "FAILED" | "ERROR" | "SKIPPED" | "CANCELLED";
            durationMs: components["schemas"]["DurationMs"];
            errorCode?: components["schemas"]["Key"];
            message?: components["schemas"]["DiagnosticText"];
            blockedByStepId?: components["schemas"]["Key"];
            blockedByAssertionId?: components["schemas"]["Key"];
        };
        ActualValueV1: {
            /**
             * @constant
             */
            present: false;
        } | {
            /**
             * @constant
             */
            present: true;
            value: components["schemas"]["JsonValue"];
        };
        AssertionResultPayloadV1: {
            sample?: components["schemas"]["HttpDatasetSample"];
            /**
             * @enum {string}
             */
            status: "PASSED" | "FAILED" | "WARN" | "SKIPPED" | "ERROR";
            /**
             * @enum {string}
             */
            severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
            expectedSource: string;
            expected: components["schemas"]["JsonValue"];
            actual: components["schemas"]["ActualValueV1"];
            durationMs: components["schemas"]["DurationMs"];
            errorCode?: components["schemas"]["Key"];
            blockedByStepId?: components["schemas"]["Key"];
            blockedByAssertionId?: components["schemas"]["Key"];
        };
        ObserverResultPayloadV1: {
            observerId: components["schemas"]["Key"];
            matchedCount: number;
            /**
             * @enum {string}
             */
            windowMode: "FIXED" | "UNTIL_ACTION_SETTLED";
            durationMs: components["schemas"]["DurationMs"];
            ambiguous: boolean;
            requests: {
                requestId: string;
                method: components["schemas"]["HttpMethod"];
                path: components["schemas"]["Path"];
                status?: number;
            }[];
        };
        /**
         * @enum {string}
         */
        ArtifactSensitivity: "REDACTED" | "CREDENTIAL_RESTRICTED";
        EvidenceFileEntryV1: {
            path: components["schemas"]["FilePath"];
            sha256: components["schemas"]["Sha256"];
            sizeBytes: number;
            sensitivity: components["schemas"]["ArtifactSensitivity"];
        };
        /**
         * @description Bounded engine codes accepted in protected execution events.
         * @enum {string}
         */
        ProtectedExecutionErrorCode: "ACTION_FAILED" | "AMBIGUOUS_EVENT" | "AMBIGUOUS_REQUEST" | "ASSERTION_FAILED"
            | "AUTHENTICATED_REQUEST_ABORT_FAILED" | "AUTHENTICATION_FAILED" | "AUTH_ADAPTER_HASH_MISMATCH"
            | "AUTH_ADAPTER_REQUIRED" | "AUTH_CLEANUP_FAILED" | "AUTH_PROVIDER_REQUIRED" | "BEFORE_ASSERTION_FAILED"
            | "BINDING_TYPE_MISMATCH" | "BLOCKED" | "BUSINESS_TIMEOUT" | "CANCELLED" | "CATALOG_REQUIRED"
            | "CATALOG_SCOPE_CYCLE" | "CHILD_STEP_FAILED" | "CLEANUP_FAILED" | "CLEANUP_RESPONSE_INVALID"
            | "COMPILED_CHILDREN_REQUIRED" | "CONTEXT_CLOSE_FAILED" | "COOKIE_ORIGIN_NOT_ALLOWED"
            | "CREDENTIAL_EVIDENCE_FORBIDDEN" | "CREDENTIAL_PROVIDER_REQUIRED" | "CREDENTIAL_SHAPE_INVALID"
            | "DATASET_BUSY" | "DATASET_CONNECTION_UNAVAILABLE" | "DATASET_PAGINATION_INCOMPLETE"
            | "DATASET_REQUEST_TIMEOUT" | "DATASET_RESPONSE_INVALID" | "DATASET_RESPONSE_LIMIT"
            | "DATASET_TRANSPORT_FAILED" | "DATASET_UPSTREAM_REJECTED" | "DATASET_NOT_ASSIGNED" | "STALE_FENCE"
            | "LEASE_EXPIRED" | "REQUESTER_REVOKED" | "DATASET_TRANSFER_LIMIT" | "DATASET_BINDINGS_MISMATCH"
            | "DATASET_EXPECTED_TYPE" | "DATASET_FIELD_MISSING" | "DATASET_KEY_TYPE" | "DATASET_PROVIDER_REQUIRED"
            | "DATASET_READ_ERROR" | "DATASET_RESOLVER_REQUIRED" | "DATASET_RESULT_LIMIT" | "DATASET_ROW_MISSING"
            | "DATASET_TREE_CYCLE" | "DATASET_TREE_REQUIRED" | "DATASET_VERSION_MISSING" | "DIALOG_MISMATCH"
            | "DOWNLOAD_FAILED" | "DOWNLOAD_PROVIDER_REQUIRED" | "DUPLICATE_LOCAL_CREDENTIAL" | "DUPLICATE_PAGE_KEY"
            | "EVENT_TIMEOUT" | "EXECUTION_CONTEXT_MISMATCH" | "EXECUTION_CONTEXT_PROVIDER_REQUIRED"
            | "EXECUTION_ERROR" | "EXTRACTION_MISSING" | "EXTRACTION_TYPE_MISMATCH" | "FILE_PROVIDER_REQUIRED"
            | "FIXTURE_CONFLICT" | "FIXTURE_IDENTITY_REQUIRED" | "FIXTURE_INPUT_INVALID" | "FIXTURE_OUTPUT_INVALID"
            | "FIXTURE_PROVIDER_REQUIRED" | "FIXTURE_REQUEST_FAILED" | "FIXTURE_REQUIRED" | "FIXTURE_RESPONSE_INVALID"
            | "IDENTITY_NOT_ALLOWED" | "INVALID_EXECUTION_CONTEXT" | "INVALID_OBSERVER" | "INVALID_PATH"
            | "INVALID_REDIRECT" | "LOCAL_CREDENTIAL_REQUIRED" | "NETWORK_TIMEOUT" | "OBSERVER_DISPOSED"
            | "OBSERVER_WINDOW_REQUIRED" | "ORIGIN_NOT_ALLOWED" | "PAGE_CLEANUP_FAILED" | "PAGE_CLEANUP_UNAVAILABLE"
            | "PAGE_PREPARE_FAILED" | "PERSISTENCE_CHECKPOINT_FAILED" | "READ_ONLY_QUERY_REQUIRED"
            | "REDACTION_PROVIDER_REQUIRED" | "REDIRECT_LIMIT" | "REQUEST_COUNT_MISMATCH"
            | "RESPONSE_ASSERTION_FAILED" | "ROLE_NOT_FOUND" | "SECRET_VERSION_MISMATCH" | "SSO_AUTHENTICATION_FAILED"
            | "SSO_CHALLENGE_REQUIRED" | "SSO_FLOW_INVALID" | "SSO_ORIGIN_NOT_ALLOWED" | "SSO_SCOPE_UNAVAILABLE"
            | "SOURCE_UNAVAILABLE" | "TARGET_NOT_FOUND" | "UNEXPECTED_DIALOG" | "UNKNOWN_DATASET_ALIAS"
            | "UNKNOWN_DATASET_FIELD" | "UNKNOWN_PAGE_KEY" | "UNKNOWN_TARGET" | "VERIQ_BROWSER_CONNECTION_FAILED"
            | "VERIQ_BROWSER_GUARD_RESTORE_CONFLICT" | "VERIQ_BROWSER_GUARD_RESTORE_FAILED"
            | "WRITE_REDIRECT_FORBIDDEN";
        BrowserSsoResultV1: {
            /**
             * @enum {unknown}
             */
            stage: "ENTRY" | "IDP" | "CALLBACK" | "IDENTITY";
            /**
             * @enum {unknown}
             */
            outcome: "PASSED" | "FAILED" | "CANCELLED";
            durationMs: number;
            errorCode?: components["schemas"]["ProtectedExecutionErrorCode"];
        };
        BrowserSsoPath: string & components["schemas"]["Path"];
        /**
         * Format: uri
         */
        BrowserSsoOrigin: string;
        BrowserSsoLabel: string & components["schemas"]["SafeString"];
        BrowserSsoAuthConfigV1: {
            /**
             * @constant
             */
            kind: "BROWSER_SSO";
            entryPath: components["schemas"]["BrowserSsoPath"];
            idpOrigin: components["schemas"]["BrowserSsoOrigin"];
            idpLoginPath: components["schemas"]["BrowserSsoPath"];
            idpSubmitPath: components["schemas"]["BrowserSsoPath"];
            callbackPath: components["schemas"]["BrowserSsoPath"];
            identityPath: components["schemas"]["Path"];
            identityPointer: components["schemas"]["Pointer"];
            usernameLabel: components["schemas"]["BrowserSsoLabel"];
            passwordLabel: components["schemas"]["BrowserSsoLabel"];
            submitName: components["schemas"]["BrowserSsoLabel"];
        };
        AuthAdapterConfigV1: {
            /**
             * @constant
             */
            kind: "HTTP_BEARER";
            identityPath: components["schemas"]["Path"];
            identityPointer: string;
        } | {
            /**
             * @constant
             */
            kind: "HTTP_SESSION";
            loginPath: components["schemas"]["Path"];
            identityPath: components["schemas"]["Path"];
            identityPointer: string;
        } | components["schemas"]["BrowserSsoAuthConfigV1"];
        IssuerKeyV1: {
            keyId: components["schemas"]["Key"];
            /**
             * @constant
             */
            algorithm: "Ed25519";
            publicKey: string;
            fingerprint: components["schemas"]["Sha256"];
            revoked: boolean;
        };
        ValidationTargetV1: {
            resourceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            revision: number;
        };
        AuthAdapterVersionV1: {
            workspaceId: components["schemas"]["Id"];
            versionId: components["schemas"]["Id"];
            contentHash: components["schemas"]["Sha256"];
            configuration: components["schemas"]["AuthAdapterConfigV1"];
        };
        CaseEntrypointV1: {
            caseVersionId: components["schemas"]["Id"];
            path: components["schemas"]["FilePath"];
        };
        OfflineExecutionChoicesV1: {
            browsers: components["schemas"]["Browser"][];
        };
        BundleSelectionV1: ({
            caseVersionIds?: components["schemas"]["Id"][];
            suiteVersionId?: components["schemas"]["Id"];
            environmentVersionId: components["schemas"]["Id"];
            /**
             * @enum {string}
             */
            validationStatus: "VALIDATED" | "UNVALIDATED_DEBUG";
            draftValidationJobId?: components["schemas"]["Id"];
        } & unknown) & ({
            caseVersionIds: unknown;
        } | {
            suiteVersionId: unknown;
        } | {
            draftValidationJobId: unknown;
        });
        TestCompletionManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            jobManifestSha256: components["schemas"]["Sha256"];
            businessOutcome: components["schemas"]["AttemptOutcome"];
            cleanupStatus: components["schemas"]["CleanupStatus"];
            evidence: components["schemas"]["EvidenceFileEntryV1"][];
            requiredEvidence: components["schemas"]["Sha256"][];
            /**
             * @constant
             */
            processStopped: true;
            /**
             * @constant
             */
            kind: "TEST";
            caseVersionId: components["schemas"]["Id"];
            expectedPlansSha256: components["schemas"]["Sha256"];
            /**
             * @description Actual business request observation through Context closure. Missing means UNKNOWN; not
             * sufficient without approved expected metadata.
             * @enum {string}
             */
            retrySafety?: "READ_ONLY_OBSERVED" | "WRITE_POSSIBLE" | "UNKNOWN";
            processStopScope?: components["schemas"]["ProcessStopScope"];
        };
        ValidateSuccessCompletionManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            jobManifestSha256: components["schemas"]["Sha256"];
            /**
             * @constant
             */
            businessOutcome: "PASSED";
            cleanupStatus: components["schemas"]["CleanupStatus"];
            evidence: components["schemas"]["EvidenceFileEntryV1"][];
            requiredEvidence: components["schemas"]["Sha256"][];
            /**
             * @constant
             */
            processStopped: true;
            /**
             * @constant
             */
            kind: "VALIDATE";
            compiledBundleSha256: components["schemas"]["Sha256"];
            engineInventorySha256: components["schemas"]["Sha256"];
            processStopScope?: components["schemas"]["ProcessStopScope"];
        };
        ValidateFailureCompletionManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            jobManifestSha256: components["schemas"]["Sha256"];
            /**
             * @constant
             */
            businessOutcome: "ERROR";
            cleanupStatus: components["schemas"]["CleanupStatus"];
            evidence: components["schemas"]["EvidenceFileEntryV1"][];
            requiredEvidence: components["schemas"]["Sha256"][];
            /**
             * @constant
             */
            processStopped: true;
            /**
             * @constant
             */
            kind: "VALIDATE";
            engineInventorySha256: components["schemas"]["Sha256"];
            failureCode: string;
            diagnostics?: components["schemas"]["CompilerDiagnosticV1"][];
            processStopScope?: components["schemas"]["ProcessStopScope"];
        };
        ValidateCompletionManifestV1: components["schemas"]["ValidateSuccessCompletionManifestV1"]
            | components["schemas"]["ValidateFailureCompletionManifestV1"];
        CleanupCompletionManifestV1: {
            /**
             * @constant
             */
            schemaVersion: "1.0";
            attemptId: components["schemas"]["Id"];
            jobManifestSha256: components["schemas"]["Sha256"];
            businessOutcome: components["schemas"]["AttemptOutcome"];
            cleanupStatus: components["schemas"]["CleanupStatus"];
            evidence: components["schemas"]["EvidenceFileEntryV1"][];
            requiredEvidence: components["schemas"]["Sha256"][];
            /**
             * @constant
             */
            processStopped: true;
            /**
             * @constant
             */
            kind: "CLEANUP";
            fixtureVersionId: components["schemas"]["Id"];
            namespace: components["schemas"]["Key"];
            processStopScope?: components["schemas"]["ProcessStopScope"];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    liveness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    readiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Database readiness check failed; connection details are withheld.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthDTOEnvelope"];
                };
            };
        };
    };
    buildInfo: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BuildInfoDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Development server has no published frontend build.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    headBuildInfo: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Build information available.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description Build information unavailable.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    session: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    logout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    requestPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmailRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    confirmPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResetPasswordRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    acceptInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InvitationAcceptRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listWorkspaces: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                archived?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    archiveWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    renameWorkspace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WorkspaceRename"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["WorkspaceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listMembers: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateMember: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                userId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MemberWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MemberDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    removeMember: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                userId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listInvitations: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InvitationSummaryDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    inviteMember: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["InviteRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["InviteDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listResources: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                kind?: components["schemas"]["ResourceKind"];
                status?: "DRAFT" | "PUBLISHED" | "ARCHIVED";
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResourceCreate"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listDatasetCopySources: {
        parameters: {
            query: {
                cursor?: string;
                limit?: number;
                sourceWorkspaceId: components["schemas"]["Id"];
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DatasetCopySourcePageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    copyDataset: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DatasetCopyRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResourceUpdate"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DraftDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DraftWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DraftDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    previewHttpDataset: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HttpDatasetPreviewRequest"];
            };
        };
        responses: {
            /**
             * @description Masked preview
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HttpDatasetPreviewEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    validateResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ValidationRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    publishResource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PublishRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceVersionDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listVersions: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceVersionDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getVersion: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
                versionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceVersionDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listDependents: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResourceDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getAgentSettings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSettingsDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateAgentSettings: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentSettingsWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSettingsDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listAgentSessions: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                archived?: boolean;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSessionDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createAgentSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentSessionCreate"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSessionDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getAgentSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                sessionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSessionDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    archiveAgentSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                sessionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    renameAgentSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                sessionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentSessionRename"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentSessionDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listAgentTurns: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                sessionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTurnDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    submitAgentTurn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                sessionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentTurnSubmit"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTurnDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    streamAgentTurn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                sessionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentTurnSubmit"];
            };
        };
        responses: {
            /**
             * @description Live conversation events and the resulting turn.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            /**
             * @description Invalid request.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description An employee session is required.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The request failed authentication or CSRF validation.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The request exceeded the conversation body limit.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The request must contain application/json.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    confirmAgentTurn: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                sessionId: components["schemas"]["Id"];
                turnId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTurnDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listExecutionPlans: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPlanDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createExecutionPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionPlanWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPlanDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getExecutionPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                planId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPlanDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateExecutionPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                planId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionPlanWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExecutionPlanDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    deleteExecutionPlan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                planId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ExecutionPlanArchive"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listProviders: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderDTOPageEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProviderWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                providerId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                providerId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProviderWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProviderDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    deleteProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                providerId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listServiceAccounts: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceAccountDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createServiceAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ServiceAccountCreate"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceAccountDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    triggerExecutionPlan: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Scoped to authenticated Workspace and operation. Same key/different payload returns 409.
                 */
                "Idempotency-Key": string;
            };
            path: {
                workspaceId: components["schemas"]["Id"];
                planId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TriggerRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TriggerReceiptEnvelope"];
                };
            };
            /**
             * @description Success.
             */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TriggerReceiptEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listRuns: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createRun: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Scoped to authenticated Workspace and operation. Same key/different payload returns 409.
                 */
                "Idempotency-Key": string;
            };
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RunCreate"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    cancelRun: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CancelRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getRunReport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RunReportDTOEnvelope"];
                };
            };
            /**
             * @description Error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getCIJUnit: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/xml": string;
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Report metadata has expired under retention; existing employee/service-plan authorization
             * still applies.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                jobId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["JobDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listRuntimes: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getRuntime: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runtimeId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateRuntimeGrants: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runtimeId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RuntimeGrantWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateRuntimeTrust: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runtimeId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RuntimeTrustWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeRuntime: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runtimeId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    requestEnrollment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnrollmentRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnrollmentDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    approveEnrollment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                enrollmentId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnrollmentApprove"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    pollEnrollment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnrollmentPoll"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceCredentialsDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listBundles: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BundleDTOPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getBundle: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                bundleId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BundleDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    testProvider: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                providerId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AiConnectionRequest"];
            };
        };
        responses: {
            /**
             * @description Recorded bounded connection generation
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerationDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listGenerations: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerationDTOPageEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    generateDraft: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GenerationRequest"];
            };
        };
        responses: {
            /**
             * @description Recorded generation, completed or idempotent replay of current state
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerationDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getGeneration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                generationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerationDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    reviewGeneration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                generationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GenerationReview"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerationDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getWorkspaceAudit: {
        parameters: {
            query?: {
                after?: components["schemas"]["Id"];
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReportAuditDTOEnvelope"];
                };
            };
            /**
             * @description Error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listServiceTokens: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                serviceAccountId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceTokenPageEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    issueServiceToken: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                serviceAccountId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ServiceTokenIssue"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceTokenDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    claimJob: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ClaimRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ClaimDTOEnvelope"];
                };
            };
            /**
             * @description No eligible job available.
             */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    heartbeat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HeartbeatRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HeartbeatDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    appendEvents: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EventBatchRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EventBatchDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    finishAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FinishRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FinishDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    reconcileAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReconcileRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReconcileDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    fetchHttpDataset: {
        parameters: {
            query?: never;
            header: {
                "X-VeriQ-Lease-Token": string;
                "X-VeriQ-Fencing-Token": number;
            };
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["HttpDatasetSelection"];
            };
        };
        responses: {
            /**
             * @description Complete mapped sample
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HttpDatasetResponse"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            504: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    fetchStaticDataset: {
        parameters: {
            query?: never;
            header: {
                "X-VeriQ-Lease-Token": string;
                "X-VeriQ-Fencing-Token": number;
            };
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StaticDatasetSelection"];
            };
        };
        responses: {
            /**
             * @description Canonical UTF-8 JSON bytes
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    resolveCredentials: {
        parameters: {
            query?: never;
            header: {
                "X-VeriQ-Lease-Token": string;
                "X-VeriQ-Fencing-Token": number;
            };
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialResolveRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialResolveDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createArtifactUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ArtifactUploadRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ArtifactUploadDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    maintenanceExpireLeases: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Scoped to authenticated Workspace and operation. Same key/different payload returns 409.
                 */
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    maintenanceCleanupFixtures: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Scoped to authenticated Workspace and operation. Same key/different payload returns 409.
                 */
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    expireArtifacts: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Scoped to authenticated Workspace and operation. Same key/different payload returns 409.
                 */
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    maintenanceReconcileCapacity: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Scoped to authenticated Workspace and operation. Same key/different payload returns 409.
                 */
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getValidationReceipt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                jobId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ValidationReceiptDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    downloadAttemptContent: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Current lease proof; secret, redact from all logs.
                 */
                "X-VeriQ-Lease-Token": string;
                /**
                 * @description Current monotonically increasing attempt fencing token.
                 */
                "X-VeriQ-Fencing-Token": number;
            };
            path: {
                workspaceId: components["schemas"]["Id"];
                attemptId: components["schemas"]["Id"];
                sha256: components["schemas"]["Sha256"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Exact immutable bytes whose SHA-256 equals the sha256 path parameter. No envelope or server
             * reserialization.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SetupDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    initializeInstallation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetupRequest"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listNotifications: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                unread?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationInboxDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    markAllNotificationsRead: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NotificationReadAllRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationReadAllDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    acknowledgeNotificationAgentReply: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["NotificationAgentSeenRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationAgentSeenDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    subscribeNotificationInbox: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /**
             * @description Inbox version changes as SSE events.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            /**
             * @description Stable JSON error.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getNotification: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                notificationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    markNotificationRead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                notificationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    acceptNotificationInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                notificationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationAcceptDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error.
             */
            415: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getAccount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUserDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    changePassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChangePasswordRequest"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listAccountSessions: {
        parameters: {
            query?: {
                /**
                 * @description Maximum page size; rejected outside 1–100. Default 25.
                 */
                limit?: number;
                /**
                 * @description Opaque continuation cursor, expires after 24 hours and is bound to the caller, list and
                 * active filters.
                 */
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AccountSessionsDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeAccountSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeAccountSession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sessionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description The target session was revoked.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description SESSION_NOT_FOUND for an unknown, expired, revoked or foreign session.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description CANNOT_REVOKE_CURRENT_SESSION if the target is the requesting session.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listGlobalUsers: {
        parameters: {
            query?: {
                /**
                 * @description Maximum page size; rejected outside 1–100. Default 25.
                 */
                limit?: number;
                /**
                 * @description Opaque continuation cursor, expires after 24 hours and is bound to the caller, list and
                 * active filters.
                 */
                cursor?: string;
                /**
                 * @description Literal substring of email or display name; wildcard characters are literal.
                 */
                q?: string;
                /**
                 * @description Filter by disabled status. Omit to include both.
                 */
                disabled?: boolean;
                /**
                 * @description Filter by global administrator capability. Omit to include both.
                 */
                systemAdmin?: boolean;
                /**
                 * @description Join workspace membership so each user carries role and isMember.
                 */
                workspaceId?: components["schemas"]["Id"];
                /**
                 * @description Comma-separated workspace roles to include. Ignored without workspaceId.
                 */
                role?: string;
                /**
                 * @description Filter by workspace membership. Ignored without workspaceId.
                 */
                membership?: "member" | "non-member";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUsersDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createGlobalUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUserRequest"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUserDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateGlobalUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                userId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateUserRequest"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUserDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    issueUserResetLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                userId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResetLinkDTOEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeUserSessions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                userId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["Empty"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Request failed
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getLiveness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Healthy
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LivenessDTOEnvelope"];
                };
            };
            /**
             * @description Unavailable
             */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getReadiness: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Healthy
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReadinessDTOEnvelope"];
                };
            };
            /**
             * @description Unavailable
             */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                invitationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    previewResourceValidation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ValidationPreviewDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listCredentials: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialListDTOEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialCreate"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialDTOEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    rotateCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
                secretRef: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CredentialRotate"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialDTOEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeCredential: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
                secretRef: string;
                versionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CredentialDTOEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    listAuthAdapters: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthAdapterListDTOEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    createAuthAdapter: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AuthAdapterCreate"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthAdapterDTOEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeAuthAdapter: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: string;
                versionId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuthAdapterDTOEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    inspectEnrollment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EnrollmentInspect"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnrollmentPreviewEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getDeviceRuntime: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    rotateDeviceToken: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeviceRotationRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceCredentialsDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    logoutDevice: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    enrollServiceRuntime: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ServiceEnrollmentRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceCredentialsDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    disableServiceAccount: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                serviceAccountId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ServiceAccountDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    revokeServiceToken: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                serviceAccountId: components["schemas"]["Id"];
                tokenId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EmptyObject"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EmptyEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    updateRuntimeCredentialDelivery: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runtimeId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RuntimeCredentialDeliveryWrite"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RuntimeDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    activateAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LeaseProofRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActivationDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    auditReconcileAttempt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                attemptId: components["schemas"]["Id"];
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AdminReconcileRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReconcileDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    uploadArtifactChunk: {
        parameters: {
            query: {
                offset: number;
            };
            header: {
                "X-VeriQ-Lease-Token": string;
                "X-VeriQ-Fencing-Token": number;
            };
            path: {
                attemptId: components["schemas"]["Id"];
                uploadId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/octet-stream": string;
            };
        };
        responses: {
            /**
             * @description Idempotent contiguous chunk accepted. Verify receivedBytes before sending the next offset.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadChunkDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getPublishedCompiledSource: {
        parameters: {
            query?: {
                /**
                 * @description An allowlisted descriptor TypeScript member path; never a filesystem path.
                 */
                path?: string;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                resourceId: components["schemas"]["Id"];
                versionId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CompiledSourceDTOEnvelope"];
                    "text/plain": string;
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    streamRunReport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReportStreamRequest"];
            };
        };
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": string;
                };
            };
            /**
             * @description Error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getAttemptHistory: {
        parameters: {
            query?: {
                after?: number;
            };
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReportHistoryDTOEnvelope"];
                };
            };
            /**
             * @description Error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getAttemptArtifacts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReportArtifactsDTOEnvelope"];
                };
            };
            /**
             * @description Error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    downloadAttemptArtifact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                attemptId: components["schemas"]["Id"];
                artifactId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /**
             * @description Error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getReportDisplay: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runId: components["schemas"]["Id"];
                attemptId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReportDisplayDTOEnvelope"];
                };
            };
            /**
             * @description Error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    previewAiContext: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GenerationRequest"];
            };
        };
        responses: {
            /**
             * @description Redacted context and conservative estimate
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AiContextDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    cancelGeneration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                generationId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerationDTOEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description The retained report, bundle or AI payload has expired. This is a domain result and does not
             * revoke the employee session.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Current authorization, bounded input, conflict or budget error
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getIssuerTrust: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IssuerTrustEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getCIReport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
                runId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CIReportEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Report metadata has expired under retention; existing employee/service-plan authorization
             * still applies.
             */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    maintenanceExpireLifecycle: {
        parameters: {
            query?: never;
            header: {
                /**
                 * @description Scoped to authenticated Workspace and operation. Same key/different payload returns 409.
                 */
                "Idempotency-Key": string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MaintenanceRequest"];
            };
        };
        responses: {
            /**
             * @description Success.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MaintenanceDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getWorkspaceOperationsMetrics: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                workspaceId: components["schemas"]["Id"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Workspace operational metrics.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OperationsMetricsDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description A bounded dependency observation timed out or is unavailable.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
    getSampleWorkspacePackage: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /**
             * @description Bundled sample manifest, resources and source hashes.
             */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SampleWorkspacePackageDTOEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Stable JSON error; code is a machine-readable domain code.
             */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
            /**
             * @description Bundled example assets are missing or inconsistent.
             */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorEnvelope"];
                };
            };
        };
    };
}
