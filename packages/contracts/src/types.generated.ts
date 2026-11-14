/* Generated from schemas/platform-v1.schema.json. Run pnpm contracts:generate. */

/**
 * Hyphenated 8-4-4-4-12 hexadecimal UUID, case-insensitive; no URN, braces or surrounding whitespace.
 *
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Id".
 */
export type Id = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Sha256".
 */
export type Sha256 = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Key".
 */
export type Key = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Version".
 */
export type Version = string;
/**
 * Interpolated DSL string. Only {{data.identifier}} and {{vars.identifier}} dotted bindings are supported; arbitrary executable expressions are rejected. Never use for inert evidence or diagnostics.
 *
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "SafeString".
 */
export type SafeString = string;
/**
 * Inert portable JSON. Strings are literal, including arbitrary braces and invalid DSL expressions; consumers must never evaluate or recursively interpolate this type.
 *
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "JsonValue".
 */
export type JsonValue =
  | null
  | boolean
  | string
  | number
  | JsonValue[]
  | {
      [k: string]: JsonValue;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ValueType".
 */
export type ValueType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Timeout".
 */
export type Timeout = number;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Pointer".
 */
export type Pointer = string;
export type Path = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "HttpUrl".
 */
export type HttpUrl = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "SourceRef".
 */
export type SourceRef = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ResponseRef".
 */
export type ResponseRef = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "RequestRef".
 */
export type RequestRef = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "HttpMethod".
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Browser".
 */
export type Browser = "chromium" | "firefox" | "webkit";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ResourceKind".
 */
export type ResourceKind =
  "CASE" | "ELEMENT_CATALOG" | "ASSERTION_TEMPLATE" | "DATASET" | "FLOW" | "FIXTURE" | "SUITE" | "ENVIRONMENT";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Outcome".
 */
export type Outcome = "PASSED" | "FAILED" | "ERROR" | "UNSTABLE" | "CANCELLED" | "INCOMPLETE" | "SKIPPED";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AttemptOutcome".
 */
export type AttemptOutcome = "PASSED" | "FAILED" | "ERROR" | "CANCELLED" | "INCOMPLETE" | "SKIPPED";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CleanupStatus".
 */
export type CleanupStatus = "NOT_REQUIRED" | "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "TrustStatus".
 */
export type TrustStatus = "MANAGED" | "USER_REGISTERED" | "REVOKED";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "RunSource".
 */
export type RunSource = "MANAGED_CLOUD" | "CONNECTED_LOCAL" | "OFFLINE_IMPORT";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FilePath".
 */
export type FilePath = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ObserverWindow".
 */
export type ObserverWindow =
  | {
      mode: "UNTIL_ACTION_SETTLED";
      quietMs?: number;
    }
  | {
      mode: "FIXED";
      durationMs: Timeout;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ObserverV1".
 */
export type ObserverV1 = NetworkObserverV1 | DialogObserverV1 | NewPageObserverV1 | DownloadObserverV1;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "NetworkObserverV1".
 */
export type NetworkObserverV1 = {
  [k: string]: unknown;
} & {
  id: Key;
  method: HttpMethod;
  /**
   * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
   *
   * This interface was referenced by `ContractDefinitions`'s JSON-Schema
   * via the `definition` "Path".
   */
  path: SafeString & Path;
  queryMatch?: BindingJsonObject;
  bodyMatch?: BindingJsonObject;
  timeoutMs?: Timeout;
  window?: ObserverWindow;
  expectedCount?: number;
  retryPolicy?: "FORBID" | "ALLOW_MATCHING_RETRIES";
};
/**
 * JSON used only in interpolated DSL fields, recursively restricted to SafeString bindings.
 *
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "BindingJsonValue".
 */
export type BindingJsonValue =
  | null
  | boolean
  | SafeString
  | number
  | BindingJsonValue[]
  | {
      [k: string]: BindingJsonValue;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DialogObserverV1".
 */
export type DialogObserverV1 = {
  [k: string]: unknown;
} & {
  id: Key;
  timeoutMs?: Timeout;
  kind: "dialog";
  dialogType: "alert" | "beforeunload" | "confirm" | "prompt";
  message: SafeString;
  handling: "accept" | "dismiss";
  promptText?: SafeString;
};
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AssertionV1".
 */
export type AssertionV1 =
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "ui";
      target: Key;
      operator: "visible" | "enabled" | "checked" | "attached" | "editable";
      expected: boolean;
      pageKey?: Key;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "ui";
      target: Key;
      operator: "textEquals" | "textContains" | "valueEquals";
      expected: SafeString;
      pageKey?: Key;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "ui";
      target: Key;
      operator: "countEquals";
      expected: number;
      pageKey?: Key;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "url";
      source: "page";
      operator: "equals" | "contains";
      expected: SafeString;
      pageKey?: Key;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "httpStatus";
      source: ResponseRef;
      operator: "equals";
      expected: number;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "request";
      source: RequestRef;
      operator: "methodEquals";
      expected: HttpMethod;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "request";
      source: RequestRef;
      operator: "pathEquals";
      /**
       * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
       *
       * This interface was referenced by `ContractDefinitions`'s JSON-Schema
       * via the `definition` "Path".
       */
      expected: SafeString & Path;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "responseSchema";
      source: ResponseRef;
      operator: "matchesSchema";
      expected: JsonSchema;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "duration";
      source: SourceRef;
      operator: "lessThanOrEqual";
      expected: number;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "requestCount";
      source: RequestRef;
      operator: "equals";
      expected: number;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "eventually";
      query: {
        method: "GET";
        /**
         * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
         *
         * This interface was referenced by `ContractDefinitions`'s JSON-Schema
         * via the `definition` "Path".
         */
        path: SafeString & Path;
        query?: BindingJsonObject;
      };
      pointer: Pointer;
      operator: "equals";
      expected: BindingJsonValue;
      intervalMs?: number;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "template";
      versionId: Id;
      parameters?: BindingJsonObject;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "responseField";
      source: ResponseRef;
      pointer: Pointer;
      operator: "equals" | "notEquals";
      expected: BindingJsonValue;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "responseField";
      source: ResponseRef;
      pointer: Pointer;
      operator: "contains";
      expected: SafeString | BindingJsonValue[];
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "responseField";
      source: ResponseRef;
      pointer: Pointer;
      operator: "in";
      /**
       * @minItems 1
       */
      expected: [BindingJsonValue, ...BindingJsonValue[]];
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "responseField";
      source: ResponseRef;
      pointer: Pointer;
      operator: "exists";
      expected: boolean;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "requestField";
      source: RequestRef;
      pointer: Pointer;
      operator: "equals" | "notEquals";
      expected: BindingJsonValue;
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "requestField";
      source: RequestRef;
      pointer: Pointer;
      operator: "contains";
      expected: SafeString | BindingJsonValue[];
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "requestField";
      source: RequestRef;
      pointer: Pointer;
      operator: "in";
      /**
       * @minItems 1
       */
      expected: [BindingJsonValue, ...BindingJsonValue[]];
    }
  | {
      id: Key;
      severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      expectedSource: string;
      timeoutMs?: Timeout;
      type: "requestField";
      source: RequestRef;
      pointer: Pointer;
      operator: "exists";
      expected: boolean;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "StepV1".
 */
export type StepV1 =
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "goto";
      /**
       * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
       *
       * This interface was referenced by `ContractDefinitions`'s JSON-Schema
       * via the `definition` "Path".
       */
      path: SafeString & Path;
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "click";
      target: Key;
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "check";
      target: Key;
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "uncheck";
      target: Key;
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "fill";
      target: Key;
      value: SafeString;
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "press";
      target: Key;
      /**
       * Interpolated DSL string. Only {{data.identifier}} and {{vars.identifier}} dotted bindings are supported; arbitrary executable expressions are rejected. Never use for inert evidence or diagnostics.
       */
      value: string;
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "selectOption";
      target: Key;
      value: SafeString | [SafeString, ...SafeString[]];
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "upload";
      target: Key;
      /**
       * @minItems 1
       */
      value: [FilePath, ...FilePath[]];
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "reload";
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "apiRequest";
      method: HttpMethod;
      /**
       * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
       *
       * This interface was referenced by `ContractDefinitions`'s JSON-Schema
       * via the `definition` "Path".
       */
      path: SafeString & Path;
      query?: BindingJsonObject;
      body?: BindingJsonValue;
      headers?: {
        [k: string]: SafeString;
      };
      pageKey?: Key;
    }
  | {
      id: Key;
      critical?: boolean;
      /**
       * @minItems 0
       */
      beforeAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      observers?: ObserverV1[];
      /**
       * @minItems 0
       */
      afterAssertions?: AssertionV1[];
      /**
       * @minItems 0
       */
      extract?: ExtractionV1[];
      timeoutMs?: Timeout;
      failurePolicy?: "STOP_CASE" | "CONTINUE";
      action: "callFlow";
      versionId: Id;
      parameters?: BindingJsonObject;
      pageKey?: Key;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "LocatorV1".
 */
export type LocatorV1 =
  | {
      by: "testId";
      value: Key;
    }
  | {
      by: "role";
      role: string;
      name?: SafeString;
      exact?: boolean;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ResourceDocumentV1".
 */
export type ResourceDocumentV1 =
  | {
      kind: "CASE";
      document: CaseDslV1;
    }
  | {
      kind: "ELEMENT_CATALOG";
      document: ElementCatalogV1;
    }
  | {
      kind: "ASSERTION_TEMPLATE";
      document: AssertionTemplateV1;
    }
  | {
      kind: "DATASET";
      document: DatasetV1;
    }
  | {
      kind: "FLOW";
      document: FlowV1;
    }
  | {
      kind: "FIXTURE";
      document: FixtureV1;
    }
  | {
      kind: "SUITE";
      document: SuiteV1;
    }
  | {
      kind: "ENVIRONMENT";
      document: EnvironmentV1;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AssetVersionV1".
 */
export type AssetVersionV1 =
  | {
      resourceId: Id;
      versionId: Id;
      kind: "CASE";
      sha256: Sha256;
      document: CaseDslV1;
    }
  | {
      resourceId: Id;
      versionId: Id;
      kind: "ELEMENT_CATALOG";
      sha256: Sha256;
      document: ElementCatalogV1;
    }
  | {
      resourceId: Id;
      versionId: Id;
      kind: "ASSERTION_TEMPLATE";
      sha256: Sha256;
      document: AssertionTemplateV1;
    }
  | {
      resourceId: Id;
      versionId: Id;
      kind: "DATASET";
      sha256: Sha256;
      document: DatasetV1;
    }
  | {
      resourceId: Id;
      versionId: Id;
      kind: "FLOW";
      sha256: Sha256;
      document: FlowV1;
    }
  | {
      resourceId: Id;
      versionId: Id;
      kind: "FIXTURE";
      sha256: Sha256;
      document: FixtureV1;
    }
  | {
      resourceId: Id;
      versionId: Id;
      kind: "SUITE";
      sha256: Sha256;
      document: SuiteV1;
    }
  | {
      resourceId: Id;
      versionId: Id;
      kind: "ENVIRONMENT";
      sha256: Sha256;
      document: EnvironmentV1;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AssetSnapshotV1".
 */
export type AssetSnapshotV1 = {
  [k: string]: unknown;
} & {
  schemaVersion: "1.0";
  workspaceId: Id;
  sourceHash: Sha256;
  engineVersion: Version;
  /**
   * @minItems 0
   */
  entryCaseVersionIds: Id[];
  /**
   * @minItems 1
   */
  assets: [AssetVersionV1, ...AssetVersionV1[]];
  validationTarget?: ValidationTargetV1;
  /**
   * @maxItems 100
   */
  authAdapters?: AuthAdapterVersionV1[];
};
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AuthAdapterConfigV1".
 */
export type AuthAdapterConfigV1 =
  | {
      kind: "HTTP_BEARER";
      /**
       * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
       *
       * This interface was referenced by `ContractDefinitions`'s JSON-Schema
       * via the `definition` "Path".
       */
      identityPath: SafeString & Path;
      identityPointer: string;
    }
  | {
      kind: "HTTP_SESSION";
      /**
       * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
       *
       * This interface was referenced by `ContractDefinitions`'s JSON-Schema
       * via the `definition` "Path".
       */
      loginPath: SafeString & Path;
      /**
       * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
       *
       * This interface was referenced by `ContractDefinitions`'s JSON-Schema
       * via the `definition` "Path".
       */
      identityPath: SafeString & Path;
      identityPointer: string;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CompiledAssetBundle".
 */
export type CompiledAssetBundle = {
  [k: string]: unknown;
} & {
  schemaVersion: "1.0";
  sourceHash: Sha256;
  engineVersion: Version;
  compilerVersion: Version;
  runnerSdkVersion: Version;
  /**
   * @minItems 0
   */
  entrypoints: CaseEntrypointV1[];
  /**
   * @minItems 1
   */
  files: [FileEntry, ...FileEntry[]];
  /**
   * @minItems 1
   */
  dependencies: [DependencyVersion, ...DependencyVersion[]];
  validationOnly?: boolean;
};
/**
 * VeriQ Runtime能力合同仅允许linux/x64、win32/x64、darwin/x64及darwin/arm64；Mac目标最低系统为macOS14，但合同接受不代表设备通过原生执行、进程监督、凭据或安装验收。
 *
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "RuntimeCapabilitiesV1".
 */
export type RuntimeCapabilitiesV1 = {
  engineVersion: Version;
  os: "linux" | "win32" | "darwin";
  arch: "x64" | "arm64";
  /**
   * @minItems 0
   */
  browsers: Browser[];
  /**
   * @minItems 1
   */
  jobKinds?: ["TEST" | "VALIDATE" | "CLEANUP", ...("TEST" | "VALIDATE" | "CLEANUP")[]];
} & RuntimeCapabilitiesV11;
export type RuntimeCapabilitiesV11 =
  | {
      os: "linux";
      arch: "x64";
    }
  | {
      os: "win32";
      arch: "x64";
    }
  | {
      os: "darwin";
      arch: "x64";
    }
  | {
      os: "darwin";
      arch: "arm64";
    };
/**
 * Supported RFC3339 profile: real Gregorian date, year 0001-9999, T/t separator, seconds 00-59, optional fractional seconds, mandatory Z/z or numeric offset (00-23:00-59). No leap seconds, spaces or surrounding whitespace. Emit UTC uppercase T/Z for server timestamps.
 *
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "Timestamp".
 */
export type Timestamp = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "JobManifestV1".
 */
export type JobManifestV1 = TestJobManifestV1 | ValidateJobManifestV1 | CleanupJobManifestV1;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ExecutionEventV1".
 */
export type ExecutionEventV1 =
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId?: Key;
      assertionId?: Key;
      type: "ATTEMPT_STARTED";
      payload: {
        engineVersion: Version;
        sourceHash: Sha256;
      };
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId?: Key;
      assertionId?: Key;
      type: "PHASE_CHANGED";
      payload: {
        phase: "LEASED" | "PREPARING" | "RUNNING" | "CLEANING" | "FINALIZING" | "FINISHED";
      };
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId: Key;
      assertionId?: Key;
      type: "STEP_STARTED";
      payload: {};
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId: Key;
      assertionId?: Key;
      type: "STEP_FINISHED";
      payload: StepFinishedPayloadV1;
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId: Key;
      assertionId: Key;
      type: "ASSERTION_RESULT";
      payload: AssertionResultPayloadV1;
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId: Key;
      assertionId?: Key;
      type: "OBSERVER_RESULT";
      payload: ObserverResultPayloadV1;
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId: Key;
      assertionId?: Key;
      type: "VARIABLE_EXTRACTED";
      payload: {
        name: Key;
        valueType: ValueType;
      };
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId?: Key;
      assertionId?: Key;
      type: "LOG";
      payload: {
        level: "DEBUG" | "INFO" | "WARN" | "ERROR";
        message: DiagnosticText;
      };
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId?: Key;
      assertionId?: Key;
      type: "CLEANUP_RESULT";
      payload: {
        cleanupStatus: CleanupStatus;
        errorCode?: Key;
      };
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId?: Key;
      assertionId?: Key;
      type: "ARTIFACT_CREATED";
      payload: {
        artifactId: Id;
        file: EvidenceFileEntryV1;
        kind: "SCREENSHOT" | "TRACE" | "HTML" | "JUNIT" | "LOG" | "SOURCE" | "MANIFEST" | "DOWNLOAD";
      };
    }
  | {
      schemaVersion: "1.0";
      attemptId: Id;
      sequence: number;
      timestamp: Timestamp;
      stepId?: Key;
      assertionId?: Key;
      type: "ATTEMPT_FINISHED";
      payload: {
        outcome: AttemptOutcome;
        cleanupStatus: CleanupStatus;
      };
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DurationMs".
 */
export type DurationMs = number;
/**
 * Literal diagnostic/evidence text; retain invalid expressions verbatim and never evaluate or interpolate it.
 *
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DiagnosticText".
 */
export type DiagnosticText = string;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ActualValueV1".
 */
export type ActualValueV1 =
  | {
      present: false;
    }
  | {
      present: true;
      value: JsonValue;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ArtifactSensitivity".
 */
export type ArtifactSensitivity = "REDACTED" | "CREDENTIAL_RESTRICTED";
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ValidateCompletionManifestV1".
 */
export type ValidateCompletionManifestV1 = ValidateSuccessCompletionManifestV1 | ValidateFailureCompletionManifestV1;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CompletionManifestV1".
 */
export type CompletionManifestV1 =
  TestCompletionManifestV1 | ValidateCompletionManifestV1 | CleanupCompletionManifestV1;
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DeviceRotationRequest".
 */
export type DeviceRotationRequest =
  | {}
  | {
      clientRequestId: Id;
      replacementToken: string;
    };
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "BundleSelectionV1".
 */
export type BundleSelectionV1 = {
  [k: string]: unknown;
} & {
  /**
   * @minItems 1
   * @maxItems 100
   */
  caseVersionIds?: [Id, ...Id[]];
  suiteVersionId?: Id;
  environmentVersionId: Id;
  validationStatus: "VALIDATED" | "UNVALIDATED_DEBUG";
  draftValidationJobId?: Id;
} & BundleSelectionV11;
export type BundleSelectionV11 =
  | {
      caseVersionIds: unknown;
    }
  | {
      suiteVersionId: unknown;
    }
  | {
      draftValidationJobId: unknown;
    };

export interface ContractDefinitions {
  Id?: Id;
  Sha256?: Sha256;
  Key?: Key;
  Version?: Version;
  SafeString?: SafeString;
  JsonValue?: JsonValue;
  JsonObject?: JsonObject;
  JsonSchema?: JsonSchema;
  ValueType?: ValueType;
  ParameterTypes?: ParameterTypes;
  Timeout?: Timeout;
  Pointer?: Pointer;
  /**
   * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
   *
   * This interface was referenced by `ContractDefinitions`'s JSON-Schema
   * via the `definition` "Path".
   */
  Path?: SafeString & Path;
  HttpUrl?: HttpUrl;
  SourceRef?: SourceRef;
  ResponseRef?: ResponseRef;
  RequestRef?: RequestRef;
  HttpMethod?: HttpMethod;
  Browser?: Browser;
  ResourceKind?: ResourceKind;
  Outcome?: Outcome;
  AttemptOutcome?: AttemptOutcome;
  CleanupStatus?: CleanupStatus;
  TrustStatus?: TrustStatus;
  RunSource?: RunSource;
  FilePath?: FilePath;
  FileEntry?: FileEntry;
  DependencyVersion?: DependencyVersion;
  ObserverWindow?: ObserverWindow;
  ObserverV1?: ObserverV1;
  ExtractionV1?: ExtractionV1;
  AssertionV1?: AssertionV1;
  StepV1?: StepV1;
  CaseDslV1?: CaseDslV1;
  LocatorV1?: LocatorV1;
  CatalogElementV1?: CatalogElementV1;
  ElementCatalogV1?: ElementCatalogV1;
  AssertionTemplateV1?: AssertionTemplateV1;
  DataRowV1?: DataRowV1;
  DatasetV1?: DatasetV1;
  FlowV1?: FlowV1;
  FixtureEndpointV1?: FixtureEndpointV1;
  FixtureV1?: FixtureV1;
  SuiteV1?: SuiteV1;
  EnvironmentRoleV1?: EnvironmentRoleV1;
  EnvironmentV1?: EnvironmentV1;
  ResourceDocumentV1?: ResourceDocumentV1;
  AssetVersionV1?: AssetVersionV1;
  AssetSnapshotV1?: AssetSnapshotV1;
  ExecutionSnapshotV1?: ExecutionSnapshotV1;
  CompiledAssetBundle?: CompiledAssetBundle;
  RuntimeCapabilitiesV1?: RuntimeCapabilitiesV1;
  ClaimRequest?: ClaimRequest;
  ClaimDTO?: ClaimDTO;
  TestJobManifestV1?: TestJobManifestV1;
  ValidateJobManifestV1?: ValidateJobManifestV1;
  CleanupJobManifestV1?: CleanupJobManifestV1;
  JobManifestV1?: JobManifestV1;
  ExecutionEventV1?: ExecutionEventV1;
  BundleManifestV1?: BundleManifestV1;
  OfflineAttemptV1?: OfflineAttemptV1;
  OfflineResultV1?: OfflineResultV1;
  ValidationIssue?: ValidationIssue;
  HeartbeatRequest?: HeartbeatRequest;
  HeartbeatDTO?: HeartbeatDTO;
  EventBatchRequest?: EventBatchRequest;
  EventBatchDTO?: EventBatchDTO;
  FinishRequest?: FinishRequest;
  FinishDTO?: FinishDTO;
  DurationMs?: DurationMs;
  ActualValueV1?: ActualValueV1;
  StepFinishedPayloadV1?: StepFinishedPayloadV1;
  AssertionResultPayloadV1?: AssertionResultPayloadV1;
  ObserverResultPayloadV1?: ObserverResultPayloadV1;
  Timestamp?: Timestamp;
  BindingJsonValue?: BindingJsonValue;
  BindingJsonObject?: BindingJsonObject;
  DiagnosticText?: DiagnosticText;
  ValidationTargetV1?: ValidationTargetV1;
  CaseEntrypointV1?: CaseEntrypointV1;
  NetworkObserverV1?: NetworkObserverV1;
  DialogObserverV1?: DialogObserverV1;
  NewPageObserverV1?: NewPageObserverV1;
  DownloadObserverV1?: DownloadObserverV1;
  AuthAdapterConfigV1?: AuthAdapterConfigV1;
  AuthAdapterVersionV1?: AuthAdapterVersionV1;
  FixtureIdentityV1?: FixtureIdentityV1;
  ArtifactSensitivity?: ArtifactSensitivity;
  EvidenceFileEntryV1?: EvidenceFileEntryV1;
  RuntimeDTO?: RuntimeDTO;
  EnrollmentDTO?: EnrollmentDTO;
  EnrollmentPreview?: EnrollmentPreview;
  DeviceCredentialsDTO?: DeviceCredentialsDTO;
  LeaseProofRequest?: LeaseProofRequest;
  ExpectedPlansV1?: ExpectedPlansV1;
  ApprovedEngineInventoryV1?: ApprovedEngineInventoryV1;
  TestCompletionManifestV1?: TestCompletionManifestV1;
  ValidateCompletionManifestV1?: ValidateCompletionManifestV1;
  CleanupCompletionManifestV1?: CleanupCompletionManifestV1;
  CompletionManifestV1?: CompletionManifestV1;
  ValidateSuccessCompletionManifestV1?: ValidateSuccessCompletionManifestV1;
  ValidateFailureCompletionManifestV1?: ValidateFailureCompletionManifestV1;
  DeviceRotationRequest?: DeviceRotationRequest;
  CompilerDiagnosticV1?: CompilerDiagnosticV1;
  ReportDisplayV1?: ReportDisplayV1;
  ResourceDTO?: ResourceDTO;
  ResourceVersionDTO?: ResourceVersionDTO;
  IssuerKeyV1?: IssuerKeyV1;
  IssuerTrustV1?: IssuerTrustV1;
  BundleResourcesV1?: BundleResourcesV1;
  BundleSelectionV1?: BundleSelectionV1;
  OfflineArtifactV1?: OfflineArtifactV1;
  OfflineExecutionChoicesV1?: OfflineExecutionChoicesV1;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "JsonObject".
 */
export interface JsonObject {
  [k: string]: JsonValue;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "JsonSchema".
 */
export interface JsonSchema {
  [k: string]: JsonValue;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ParameterTypes".
 */
export interface ParameterTypes {
  [k: string]: ValueType;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FileEntry".
 */
export interface FileEntry {
  path: FilePath;
  sha256: Sha256;
  sizeBytes: number;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DependencyVersion".
 */
export interface DependencyVersion {
  name: string;
  version: Version;
  integrity: string;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "BindingJsonObject".
 */
export interface BindingJsonObject {
  [k: string]: BindingJsonValue;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "NewPageObserverV1".
 */
export interface NewPageObserverV1 {
  id: Key;
  timeoutMs?: Timeout;
  kind: "newPage";
  pageKey: Key;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DownloadObserverV1".
 */
export interface DownloadObserverV1 {
  id: Key;
  timeoutMs?: Timeout;
  kind: "download";
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ExtractionV1".
 */
export interface ExtractionV1 {
  source: SourceRef;
  pointer: Pointer;
  to: Key;
  valueType: ValueType;
  required: boolean;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CaseDslV1".
 */
export interface CaseDslV1 {
  schemaVersion: "1.0";
  caseKey: Key;
  title: string;
  kind: "READ" | "WRITE";
  roleKey: Key;
  catalogVersionId: Id;
  fixtureVersionId?: Id;
  datasetVersionId?: Id;
  persistenceCheckpointStepId?: Key;
  /**
   * @minItems 1
   * @maxItems 500
   */
  steps: [StepV1, ...StepV1[]];
  fixtureInput?: BindingJsonObject;
  initialVariables?: ParameterTypes;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CatalogElementV1".
 */
export interface CatalogElementV1 {
  key: Key;
  locator: LocatorV1;
  scope?: Key;
  recordKey?: SafeString;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ElementCatalogV1".
 */
export interface ElementCatalogV1 {
  schemaVersion: "1.0";
  /**
   * @minItems 1
   */
  elements: [CatalogElementV1, ...CatalogElementV1[]];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AssertionTemplateV1".
 */
export interface AssertionTemplateV1 {
  schemaVersion: "1.0";
  parameters?: ParameterTypes;
  /**
   * @minItems 1
   */
  assertions: [AssertionV1, ...AssertionV1[]];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DataRowV1".
 */
export interface DataRowV1 {
  key: Key;
  values: JsonObject;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DatasetV1".
 */
export interface DatasetV1 {
  schemaVersion: "1.0";
  columns: ParameterTypes;
  /**
   * @minItems 1
   */
  rows: [DataRowV1, ...DataRowV1[]];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FlowV1".
 */
export interface FlowV1 {
  schemaVersion: "1.0";
  parameters?: ParameterTypes;
  /**
   * @minItems 1
   * @maxItems 500
   */
  steps: [StepV1, ...StepV1[]];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FixtureEndpointV1".
 */
export interface FixtureEndpointV1 {
  method: "POST" | "DELETE";
  /**
   * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
   *
   * This interface was referenced by `ContractDefinitions`'s JSON-Schema
   * via the `definition` "Path".
   */
  path: SafeString & Path;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FixtureV1".
 */
export interface FixtureV1 {
  schemaVersion: "1.0";
  prepare: {
    method: "POST";
    /**
     * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
     *
     * This interface was referenced by `ContractDefinitions`'s JSON-Schema
     * via the `definition` "Path".
     */
    path: SafeString & Path;
  };
  query: {
    method: "GET";
    /**
     * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
     *
     * This interface was referenced by `ContractDefinitions`'s JSON-Schema
     * via the `definition` "Path".
     */
    path: SafeString & Path;
  };
  cleanup: FixtureEndpointV1;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  ttlSeconds: number;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "SuiteV1".
 */
export interface SuiteV1 {
  schemaVersion: "1.0";
  /**
   * @minItems 1
   */
  cases: [
    {
      versionId: Id;
      datasetVersionId?: Id;
      /**
       * @minItems 1
       */
      roleKeys?: [Key, ...Key[]];
      /**
       * @minItems 1
       */
      browsers?: [Browser, ...Browser[]];
    },
    ...{
      versionId: Id;
      datasetVersionId?: Id;
      /**
       * @minItems 1
       */
      roleKeys?: [Key, ...Key[]];
      /**
       * @minItems 1
       */
      browsers?: [Browser, ...Browser[]];
    }[]
  ];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "EnvironmentRoleV1".
 */
export interface EnvironmentRoleV1 {
  roleKey: Key;
  authAdapterVersionId: Id;
  secretRef: Key;
  secretVersionId: Id;
  /**
   * @minItems 0
   */
  allowedIdentityIds?: string[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "EnvironmentV1".
 */
export interface EnvironmentV1 {
  schemaVersion: "1.0";
  baseURL: HttpUrl;
  apiBaseURL: HttpUrl;
  fixtureBaseURL?: HttpUrl;
  /**
   * @minItems 1
   */
  allowedOrigins: [HttpUrl, ...HttpUrl[]];
  locale: string;
  timezone: string;
  /**
   * @minItems 1
   */
  roles: [EnvironmentRoleV1, ...EnvironmentRoleV1[]];
  buildSha?: string;
  fixtureIdentity?: FixtureIdentityV1;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FixtureIdentityV1".
 */
export interface FixtureIdentityV1 {
  authAdapterVersionId: Id;
  secretRef: Key;
  secretVersionId: Id;
  /**
   * @minItems 0
   */
  allowedIdentityIds?: string[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ValidationTargetV1".
 */
export interface ValidationTargetV1 {
  resourceId: Id;
  versionId: Id;
  revision: number;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AuthAdapterVersionV1".
 */
export interface AuthAdapterVersionV1 {
  workspaceId: Id;
  versionId: Id;
  contentHash: Sha256;
  configuration: AuthAdapterConfigV1;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ExecutionSnapshotV1".
 */
export interface ExecutionSnapshotV1 {
  schemaVersion: "1.0";
  workspaceId: Id;
  runId: Id;
  caseExecutionId: Id;
  assetSourceHash: Sha256;
  environmentVersionId: Id;
  environment: EnvironmentV1;
  roleKey: Key;
  browser: Browser;
  dataRow?: DataRowV1;
  variables: JsonObject;
  /**
   * @minItems 0
   */
  secretVersions: {
    secretRef: Key;
    versionId: Id;
  }[];
  namespace: Key;
  attemptNo: number;
  caseVersionId: Id;
  /**
   * @maxItems 100
   */
  authAdapters?: AuthAdapterVersionV1[];
  datasetVersionId?: Id;
  suiteEntryIndex?: number;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CaseEntrypointV1".
 */
export interface CaseEntrypointV1 {
  caseVersionId: Id;
  path: FilePath;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ClaimRequest".
 */
export interface ClaimRequest {
  runnerId: Id;
  clientRequestId: Id;
  availableSlots: number;
  capabilities: RuntimeCapabilitiesV1;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ClaimDTO".
 */
export interface ClaimDTO {
  jobId: Id;
  jobKind: "TEST" | "VALIDATE" | "CLEANUP";
  attemptId: Id;
  leaseToken: string;
  fencingToken: number;
  expiresAt: Timestamp;
  snapshotUrl: HttpUrl;
  snapshotSha256: Sha256;
  serverTime: Timestamp;
  leaseDurationMs: number;
  activationRequired: true;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "TestJobManifestV1".
 */
export interface TestJobManifestV1 {
  schemaVersion: "1.0";
  workspaceId: Id;
  jobId: Id;
  snapshotSha256: Sha256;
  engineVersion: Version;
  kind: "TEST";
  caseExecutionId: Id;
  compiledBundleSha256: Sha256;
  executionSnapshotSha256: Sha256;
  caseVersionId: Id;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ValidateJobManifestV1".
 */
export interface ValidateJobManifestV1 {
  schemaVersion: "1.0";
  workspaceId: Id;
  jobId: Id;
  snapshotSha256: Sha256;
  engineVersion: Version;
  kind: "VALIDATE";
  resourceId: Id;
  revision: number;
  sourceHash: Sha256;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CleanupJobManifestV1".
 */
export interface CleanupJobManifestV1 {
  schemaVersion: "1.0";
  workspaceId: Id;
  jobId: Id;
  snapshotSha256: Sha256;
  engineVersion: Version;
  kind: "CLEANUP";
  maintenanceId: Id;
  fixtureVersionId: Id;
  namespace: Key;
  cleanupRef: string;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "StepFinishedPayloadV1".
 */
export interface StepFinishedPayloadV1 {
  status: "PASSED" | "FAILED" | "ERROR" | "SKIPPED" | "CANCELLED";
  durationMs: DurationMs;
  errorCode?: Key;
  message?: DiagnosticText;
  blockedByStepId?: Key;
  blockedByAssertionId?: Key;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "AssertionResultPayloadV1".
 */
export interface AssertionResultPayloadV1 {
  status: "PASSED" | "FAILED" | "WARN" | "SKIPPED";
  severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
  expectedSource: string;
  expected: JsonValue;
  actual: ActualValueV1;
  durationMs: DurationMs;
  errorCode?: Key;
  blockedByStepId?: Key;
  blockedByAssertionId?: Key;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ObserverResultPayloadV1".
 */
export interface ObserverResultPayloadV1 {
  observerId: Key;
  matchedCount: number;
  windowMode: "FIXED" | "UNTIL_ACTION_SETTLED";
  durationMs: DurationMs;
  ambiguous: boolean;
  requests: {
    requestId: string;
    method: HttpMethod;
    /**
     * Origin-relative literal path: starts with exactly one slash; no backslash or C0/DEL controls. After DSL substitution the SDK must recheck the path and WHATWG-resolved origin against the frozen authorized base/allowedOrigins before any request/navigation, and enforce policy on redirects.
     *
     * This interface was referenced by `ContractDefinitions`'s JSON-Schema
     * via the `definition` "Path".
     */
    path: SafeString & Path;
    status?: number;
  }[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "EvidenceFileEntryV1".
 */
export interface EvidenceFileEntryV1 {
  path: FilePath;
  sha256: Sha256;
  sizeBytes: number;
  sensitivity: ArtifactSensitivity;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "BundleManifestV1".
 */
export interface BundleManifestV1 {
  schemaVersion: "1.0";
  bundleId: Id;
  workspaceId: Id;
  issuerId: Key;
  keyId: Key;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  sourceHash: Sha256;
  snapshotSha256: Sha256;
  engineVersion: Version;
  validationStatus: "VALIDATED" | "UNVALIDATED_DEBUG";
  /**
   * @minItems 1
   * @maxItems 4094
   */
  files: [FileEntry, ...FileEntry[]];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "OfflineAttemptV1".
 */
export interface OfflineAttemptV1 {
  attemptId: Id;
  caseVersionId: Id;
  attemptNo: number;
  outcome: AttemptOutcome;
  cleanupStatus: CleanupStatus;
  lastSequence: number;
  /**
   * @minItems 0
   * @maxItems 10000
   */
  events: ExecutionEventV1[];
  /**
   * @minItems 0
   * @maxItems 100
   */
  artifacts: OfflineArtifactV1[];
  execution?: ExecutionSnapshotV1;
  processStopped?: boolean;
  retrySafety?: "READ_ONLY_OBSERVED" | "WRITE_POSSIBLE" | "UNKNOWN";
  sourceKind?: "PUBLISHED" | "DRAFT_DEBUG";
  variantKey?: Sha256;
  failureCode?: string;
  /**
   * @maxItems 100
   */
  diagnostics?: {
    code: string;
    path: string;
    pathStatus: "EXACT" | "REDACTED";
    message: string;
  }[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "OfflineArtifactV1".
 */
export interface OfflineArtifactV1 {
  path: FilePath;
  sha256: Sha256;
  sizeBytes: number;
  sensitivity: ArtifactSensitivity;
  kind?: "TRACE" | "DOWNLOAD" | "LOG" | "SOURCE" | "MANIFEST" | "HTML" | "JUNIT" | "SCREENSHOT";
  artifactId?: Id;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "OfflineResultV1".
 */
export interface OfflineResultV1 {
  schemaVersion: "1.0";
  workspaceId: Id;
  bundleId: Id;
  localRunId: Id;
  deviceId: Id;
  source: "OFFLINE_IMPORT";
  trustStatus: TrustStatus;
  dirty: boolean;
  revocationStatus: "CURRENT" | "UNKNOWN" | "REVOKED";
  manifestSha256: Sha256;
  startedAt: Timestamp;
  finishedAt: Timestamp;
  outcome: Outcome;
  actualEnvironment: EnvironmentV1;
  /**
   * @minItems 1
   * @maxItems 2000
   */
  attempts: [OfflineAttemptV1, ...OfflineAttemptV1[]];
  executionChoices?: OfflineExecutionChoicesV1;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "OfflineExecutionChoicesV1".
 */
export interface OfflineExecutionChoicesV1 {
  /**
   * @minItems 1
   * @maxItems 3
   */
  browsers: [Browser] | [Browser, Browser] | [Browser, Browser, Browser];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ValidationIssue".
 */
export interface ValidationIssue {
  path: string;
  code: "SCHEMA_VIOLATION" | "INVALID_JSON";
  message: string;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "HeartbeatRequest".
 */
export interface HeartbeatRequest {
  leaseToken: string;
  fencingToken: number;
  progress: {
    phase: "LEASED" | "PREPARING" | "RUNNING" | "CLEANING" | "FINALIZING";
    stepId?: Key;
    completedSteps?: number;
  };
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "HeartbeatDTO".
 */
export interface HeartbeatDTO {
  leaseExpiresAt: Timestamp;
  cancelRequested: boolean;
  serverTime: Timestamp;
  leaseDurationMs: number;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "EventBatchRequest".
 */
export interface EventBatchRequest {
  leaseToken: string;
  fencingToken: number;
  /**
   * @minItems 1
   */
  events: [ExecutionEventV1, ...ExecutionEventV1[]];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "EventBatchDTO".
 */
export interface EventBatchDTO {
  acceptedThrough: number;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FinishRequest".
 */
export interface FinishRequest {
  leaseToken: string;
  fencingToken: number;
  kind: "TEST" | "VALIDATE" | "CLEANUP";
  outcome: AttemptOutcome;
  manifestSha256: Sha256;
  lastSequence: number;
  cleanupStatus: CleanupStatus;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "FinishDTO".
 */
export interface FinishDTO {
  attemptId: Id;
  accepted: true;
  outcome: AttemptOutcome;
  manifestSha256: Sha256;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "RuntimeDTO".
 */
export interface RuntimeDTO {
  id: Id;
  ownerId: Id;
  name: string;
  location: "MANAGED_CLOUD" | "CONNECTED_LOCAL";
  trustStatus: TrustStatus;
  status: "PENDING" | "ONLINE" | "OFFLINE" | "REVOKED";
  capabilities: RuntimeCapabilitiesV1;
  lastSeenAt?: Timestamp;
  workspaceId: Id;
  ownerType: "USER" | "SERVICE_ACCOUNT";
  capabilitiesSource: "DEVICE_REPORTED";
  sharedWithWorkspace: boolean;
  sharedWithUserIds: Id[];
  allowCredentialDelivery: boolean;
  canManage: boolean;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "EnrollmentDTO".
 */
export interface EnrollmentDTO {
  id: Id;
  deviceCode: string;
  userCode: string;
  verificationUrl: HttpUrl;
  expiresAt: Timestamp;
  intervalSeconds: 5;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "EnrollmentPreview".
 */
export interface EnrollmentPreview {
  id: Id;
  name: string;
  capabilities: RuntimeCapabilitiesV1;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "DeviceCredentialsDTO".
 */
export interface DeviceCredentialsDTO {
  runnerId: Id;
  deviceToken: string;
  expiresAt: Timestamp;
  issuerId?: Key;
  trustedKeys?: {
    keyId: Key;
    algorithm: "Ed25519";
    publicKey: string;
    fingerprint: Sha256;
  }[];
  workspaceId: Id;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "LeaseProofRequest".
 */
export interface LeaseProofRequest {
  leaseToken: string;
  fencingToken: number;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ExpectedPlansV1".
 */
export interface ExpectedPlansV1 {
  schemaVersion: "1.0";
  /**
   * @maxItems 1000
   */
  cases: {
    caseVersionId: Id;
    persistenceCheckpointStepId?: Key;
    /**
     * @maxItems 500
     */
    steps: {
      id: Key;
      order: number;
      parentId?: Key;
      failurePolicy: "STOP" | "CONTINUE" | "BLOCK";
      /**
       * @maxItems 5000
       */
      assertions: {
        id: Key;
        severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
        stage: "BEFORE" | "RESPONSE" | "AFTER" | "FINALIZE";
      }[];
      /**
       * @maxItems 1000
       */
      observers: Key[];
    }[];
    /**
     * @minItems 1
     */
    requiredEvidenceKinds: ["TRACE" | "SCREENSHOT", ...("TRACE" | "SCREENSHOT")[]];
    /**
     * Compiler-derived known write potential. Missing legacy metadata is UNKNOWN for retry safety.
     */
    hasPotentialWrites?: boolean;
  }[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ApprovedEngineInventoryV1".
 */
export interface ApprovedEngineInventoryV1 {
  schemaVersion: "1.0";
  /**
   * @maxItems 100
   */
  engines: {
    engineVersion: Version;
    compilerVersion: Version;
    runnerSdkVersion: Version;
    /**
     * @maxItems 1000
     */
    files: FileEntry[];
    /**
     * @maxItems 1000
     */
    dependencies: DependencyVersion[];
  }[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "TestCompletionManifestV1".
 */
export interface TestCompletionManifestV1 {
  schemaVersion: "1.0";
  attemptId: Id;
  jobManifestSha256: Sha256;
  businessOutcome: AttemptOutcome;
  cleanupStatus: CleanupStatus;
  /**
   * @maxItems 1000
   */
  evidence: EvidenceFileEntryV1[];
  /**
   * @maxItems 1000
   */
  requiredEvidence: Sha256[];
  processStopped: true;
  kind: "TEST";
  caseVersionId: Id;
  expectedPlansSha256: Sha256;
  /**
   * Actual business request observation through Context closure. Missing means UNKNOWN; not sufficient without approved expected metadata.
   */
  retrySafety?: "READ_ONLY_OBSERVED" | "WRITE_POSSIBLE" | "UNKNOWN";
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ValidateSuccessCompletionManifestV1".
 */
export interface ValidateSuccessCompletionManifestV1 {
  schemaVersion: "1.0";
  attemptId: Id;
  jobManifestSha256: Sha256;
  businessOutcome: "PASSED";
  cleanupStatus: CleanupStatus;
  /**
   * @maxItems 1000
   */
  evidence: EvidenceFileEntryV1[];
  /**
   * @maxItems 1000
   */
  requiredEvidence: Sha256[];
  processStopped: true;
  kind: "VALIDATE";
  compiledBundleSha256: Sha256;
  engineInventorySha256: Sha256;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ValidateFailureCompletionManifestV1".
 */
export interface ValidateFailureCompletionManifestV1 {
  schemaVersion: "1.0";
  attemptId: Id;
  jobManifestSha256: Sha256;
  businessOutcome: "ERROR";
  cleanupStatus: CleanupStatus;
  /**
   * @minItems 1
   * @maxItems 1000
   */
  evidence: [EvidenceFileEntryV1, ...EvidenceFileEntryV1[]];
  /**
   * @minItems 1
   * @maxItems 1000
   */
  requiredEvidence: [Sha256, ...Sha256[]];
  processStopped: true;
  kind: "VALIDATE";
  engineInventorySha256: Sha256;
  failureCode: string;
  /**
   * @maxItems 100
   */
  diagnostics?: CompilerDiagnosticV1[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CompilerDiagnosticV1".
 */
export interface CompilerDiagnosticV1 {
  code: string;
  path: string;
  pathStatus: "EXACT" | "REDACTED";
  message: string;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "CleanupCompletionManifestV1".
 */
export interface CleanupCompletionManifestV1 {
  schemaVersion: "1.0";
  attemptId: Id;
  jobManifestSha256: Sha256;
  businessOutcome: AttemptOutcome;
  cleanupStatus: CleanupStatus;
  /**
   * @maxItems 1000
   */
  evidence: EvidenceFileEntryV1[];
  /**
   * @maxItems 1000
   */
  requiredEvidence: Sha256[];
  processStopped: true;
  kind: "CLEANUP";
  fixtureVersionId: Id;
  namespace: Key;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ReportDisplayV1".
 */
export interface ReportDisplayV1 {
  schemaVersion: "1.0";
  /**
   * @maxItems 1000
   */
  cases: {
    caseVersionId: Id;
    caseKey: Key;
    title: string;
    /**
     * @maxItems 500
     */
    steps: {
      id: Key;
      sourceId: Key;
      sourcePath: string;
      action: string;
      order: number;
      parentId?: Key;
      /**
       * @maxItems 5000
       */
      assertions: {
        id: Key;
        sourceId: Key;
        sourcePath: string;
        type: string;
        operator?: string;
        expectedSource: string;
        severity: "BLOCK" | "CONTINUE_FAIL" | "WARN";
      }[];
      /**
       * @maxItems 1000
       */
      observers: {
        id: Key;
        kind: string;
        method?: string;
        path?: string;
      }[];
    }[];
  }[];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ResourceDTO".
 */
export interface ResourceDTO {
  id: Id;
  workspaceId: Id;
  kind: ResourceKind;
  key: string;
  name: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  latestVersionId?: Id;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "ResourceVersionDTO".
 */
export interface ResourceVersionDTO {
  id: Id;
  resourceId: Id;
  workspaceId: Id;
  versionNo: number;
  schemaVersion: "1.0";
  sha256: Sha256;
  content: ResourceDocumentV1;
  publishedAt: Timestamp;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "IssuerKeyV1".
 */
export interface IssuerKeyV1 {
  keyId: Key;
  algorithm: "Ed25519";
  publicKey: string;
  fingerprint: Sha256;
  revoked: boolean;
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "IssuerTrustV1".
 */
export interface IssuerTrustV1 {
  issuerId: Key;
  revision: number;
  /**
   * @minItems 1
   * @maxItems 100
   */
  keys: [IssuerKeyV1, ...IssuerKeyV1[]];
}
/**
 * This interface was referenced by `ContractDefinitions`'s JSON-Schema
 * via the `definition` "BundleResourcesV1".
 */
export interface BundleResourcesV1 {
  /**
   * @maxItems 1000
   */
  resources: ResourceDTO[];
  /**
   * @maxItems 1000
   */
  versions: ResourceVersionDTO[];
}

export type SnapshotV1 = AssetSnapshotV1;
