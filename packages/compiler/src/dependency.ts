import { createHash } from "node:crypto";
import type { JsonValue, ValueType } from "@veriq/contracts";
export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}
export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
export const pointerKey = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");
export const wireId = (sourcePath: string): string =>
  `v_${sha256(new TextEncoder().encode(sourcePath))}`;
export {
  valueType,
  accepts,
  resolvePointer,
  resolveBinding,
} from "@veriq/contracts";
export type { Presence } from "@veriq/contracts";
