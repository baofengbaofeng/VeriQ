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
