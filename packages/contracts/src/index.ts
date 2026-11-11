import canonicalizeModule from "canonicalize";
// canonicalize 2.x ships an ESM default declaration for its CommonJS export.
const canonicalize = canonicalizeModule as unknown as (value: unknown) => string | undefined;
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/platform-v1.schema.json" with { type: "json" };

export type * from "./types.generated.js";
export type { paths as PlatformPaths, components as PlatformComponents } from "./api.generated.js";

export interface ValidationIssue {
  path: string;
  code: "SCHEMA_VIOLATION" | "INVALID_JSON";
  message: string;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats.default(ajv);
ajv.addSchema(schema);

function portableJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length) return false;
    if (Array.isArray(value)) return Array.from(value).every(item => portableJson(item, ancestors));
    return Object.values(value).every(item => portableJson(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

/** No coercion, defaults, field removal, or semantic reference resolution. */
export function validateSchema(schemaName: string, value: unknown): ValidationIssue[] {
  if (!Object.hasOwn(schema.$defs, schemaName)) throw new Error(`Unknown contract schema: ${schemaName}`);
  if (!portableJson(value)) return [{path:"", code:"INVALID_JSON", message:"Expected finite, portable JSON values"}];
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${schemaName}`)!;
  if (validate(value)) return [];
  return (validate.errors ?? []).map(error => ({path:error.instancePath, code:"SCHEMA_VIOLATION", message:error.message ?? error.keyword}));
}

export function validateCaseSchema(value: unknown): ValidationIssue[] {
  return validateSchema("CaseDslV1", value);
}

export function serializeContract(schemaName: string, value: unknown): string {
  const issues = validateSchema(schemaName, value);
  if (issues.length) throw new Error(JSON.stringify(issues));
  return JSON.stringify(value);
}

export function parseContract(schemaName: string, text: string): unknown {
  const value: unknown = JSON.parse(text);
  const issues = validateSchema(schemaName, value);
  if (issues.length) throw new Error(JSON.stringify(issues));
  return value;
}

/** RFC8785/JCS bytes; this does not replace exact-byte manifest signing. */
export function canonicalBytes(value: unknown): Uint8Array {
  if (!portableJson(value)) throw new Error('Expected portable JSON');
  const result = canonicalize(value);
  if (result === undefined) throw new Error('Expected JSON');
  // JCS rejects lone surrogates; JSON.stringify otherwise silently escapes them.
  function unicode(v: unknown): void {
    if (typeof v === 'string' && /[\uD800-\uDFFF]/u.test(v)) throw new Error('Invalid Unicode');
    if (Array.isArray(v)) v.forEach(unicode);
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) { unicode(k); unicode(x); }
  }
  unicode(value);
  return new TextEncoder().encode(result);
}

/** Exact source projection shared with Python; digest with the caller's SHA-256 API.
 * Input assets and entry IDs use the producer's frozen order (server sorts by UUID).
 * Validation target, receipt/job IDs and the claimed sourceHash are excluded.
 */
export function assetSourceBytes(snapshot: Record<string, unknown>): Uint8Array {
  return canonicalBytes(Object.fromEntries(
    ['schemaVersion', 'workspaceId', 'engineVersion', 'entryCaseVersionIds', 'assets', ...(Object.hasOwn(snapshot, 'authAdapters') ? ['authAdapters'] : [])]
      .map(key => [key, key === "authAdapters" ? [...snapshot[key] as {versionId:string}[]].sort((a,b)=>a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0) : snapshot[key]]),
  ));
}

export * from "./bindings.js";
export type * from "./compiled.js";
