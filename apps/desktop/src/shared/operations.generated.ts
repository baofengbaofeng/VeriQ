/** 由 generate-operations.mjs 根据明确的桌面白名单和 OpenAPI 自动生成，业务请求类型只允许固定操作与契约正文；请修改生成器并重新生成，禁止直接扩张宿主权限。 */
import type { PlatformComponents } from "@veriq/contracts";
type S = PlatformComponents["schemas"];
export type CloudOperation =
    | { operation: "login"; data: S["LoginRequest"] }
    | { operation: "session" }
    | { operation: "logout"; data: S["Empty"] }
    | { operation: "listWorkspaces"; query?: Record<string, string | number | boolean> }
    | { operation: "getWorkspace"; params: { workspaceId: string } }
    | {
          operation: "listResources";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | { operation: "createResource"; params: { workspaceId: string }; data: S["ResourceCreate"] }
    | { operation: "getResource"; params: { workspaceId: string; resourceId: string } }
    | {
          operation: "updateResource";
          params: { workspaceId: string; resourceId: string };
          data: S["ResourceUpdate"];
      }
    | { operation: "getDraft"; params: { workspaceId: string; resourceId: string } }
    | {
          operation: "updateDraft";
          params: { workspaceId: string; resourceId: string };
          data: S["DraftWrite"];
      }
    | {
          operation: "validateResource";
          params: { workspaceId: string; resourceId: string };
          data: S["ValidationRequest"];
      }
    | {
          operation: "publishResource";
          params: { workspaceId: string; resourceId: string };
          data: S["PublishRequest"];
      }
    | {
          operation: "listVersions";
          params: { workspaceId: string; resourceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | {
          operation: "getVersion";
          params: { workspaceId: string; resourceId: string; versionId: string };
      }
    | {
          operation: "listDependents";
          params: { workspaceId: string; resourceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | {
          operation: "listProviders";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | { operation: "createProvider"; params: { workspaceId: string }; data: S["ProviderWrite"] }
    | { operation: "getProvider"; params: { workspaceId: string; providerId: string } }
    | {
          operation: "updateProvider";
          params: { workspaceId: string; providerId: string };
          data: S["ProviderWrite"];
      }
    | { operation: "deleteProvider"; params: { workspaceId: string; providerId: string } }
    | {
          operation: "listRuns";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | {
          operation: "createRun";
          params: { workspaceId: string };
          data: S["RunCreate"];
          idempotencyKey: string;
      }
    | { operation: "getRun"; params: { workspaceId: string; runId: string } }
    | {
          operation: "cancelRun";
          params: { workspaceId: string; runId: string };
          data: S["CancelRequest"];
      }
    | {
          operation: "rerun";
          params: { workspaceId: string; runId: string };
          data: S["TriggerRequest"];
          idempotencyKey: string;
      }
    | { operation: "getRunReport"; params: { workspaceId: string; runId: string } }
    | { operation: "getJob"; params: { workspaceId: string; jobId: string } }
    | {
          operation: "listRuntimes";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | { operation: "getRuntime"; params: { workspaceId: string; runtimeId: string } }
    | {
          operation: "updateRuntimeGrants";
          params: { workspaceId: string; runtimeId: string };
          data: S["RuntimeGrantWrite"];
      }
    | {
          operation: "updateRuntimeTrust";
          params: { workspaceId: string; runtimeId: string };
          data: S["RuntimeTrustWrite"];
      }
    | { operation: "revokeRuntime"; params: { workspaceId: string; runtimeId: string } }
    | {
          operation: "approveEnrollment";
          params: { enrollmentId: string };
          data: S["EnrollmentApprove"];
      }
    | {
          operation: "createBundle";
          params: { workspaceId: string };
          data: S["BundleCreate"];
          idempotencyKey: string;
      }
    | {
          operation: "listBundles";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | { operation: "getBundle"; params: { workspaceId: string; bundleId: string } }
    | { operation: "getBundleManifest"; params: { workspaceId: string; bundleId: string } }
    | {
          operation: "testProvider";
          params: { workspaceId: string; providerId: string };
          data: S["AiConnectionRequest"];
      }
    | { operation: "generateDraft"; params: { workspaceId: string }; data: S["GenerationRequest"] }
    | {
          operation: "listGenerations";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | { operation: "getGeneration"; params: { workspaceId: string; generationId: string } }
    | {
          operation: "reviewGeneration";
          params: { workspaceId: string; generationId: string };
          data: S["GenerationReview"];
      }
    | {
          operation: "getWorkspaceAudit";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | { operation: "getValidationReceipt"; params: { workspaceId: string; jobId: string } }
    | { operation: "getSetup" }
    | { operation: "getAccount" }
    | {
          operation: "previewResourceValidation";
          params: { workspaceId: string; resourceId: string };
      }
    | {
          operation: "listCredentials";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | {
          operation: "createCredential";
          params: { workspaceId: string };
          data: S["CredentialCreate"];
      }
    | {
          operation: "rotateCredential";
          params: { workspaceId: string; secretRef: string };
          data: S["CredentialRotate"];
      }
    | {
          operation: "revokeCredential";
          params: { workspaceId: string; secretRef: string; versionId: string };
          data: S["EmptyObject"];
      }
    | {
          operation: "listAuthAdapters";
          params: { workspaceId: string };
          query?: Record<string, string | number | boolean>;
      }
    | {
          operation: "createAuthAdapter";
          params: { workspaceId: string };
          data: S["AuthAdapterCreate"];
      }
    | {
          operation: "revokeAuthAdapter";
          params: { workspaceId: string; versionId: string };
          data: S["EmptyObject"];
      }
    | { operation: "inspectEnrollment"; data: S["EnrollmentInspect"] }
    | {
          operation: "updateRuntimeCredentialDelivery";
          params: { workspaceId: string; runtimeId: string };
          data: S["RuntimeCredentialDeliveryWrite"];
      }
    | {
          operation: "getPublishedCompiledSource";
          params: { workspaceId: string; resourceId: string; versionId: string };
          query?: Record<string, string | number | boolean>;
      }
    | {
          operation: "streamRunReport";
          params: { workspaceId: string; runId: string };
          data: S["ReportStreamRequest"];
      }
    | {
          operation: "getAttemptHistory";
          params: { workspaceId: string; attemptId: string };
          query?: Record<string, string | number | boolean>;
      }
    | { operation: "getAttemptArtifacts"; params: { workspaceId: string; attemptId: string } }
    | {
          operation: "downloadAttemptArtifact";
          params: { workspaceId: string; attemptId: string; artifactId: string };
      }
    | {
          operation: "getReportDisplay";
          params: { workspaceId: string; runId: string; attemptId: string };
      }
    | {
          operation: "previewAiContext";
          params: { workspaceId: string };
          data: S["GenerationRequest"];
      }
    | { operation: "cancelGeneration"; params: { workspaceId: string; generationId: string } };
