import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";
import platform from "../schemas/platform-v1.schema.json" with { type: "json" };

const api = JSON.parse(readFileSync(new URL("../openapi/platform.yaml", import.meta.url), "utf8"));
const ajv = new Ajv2020({strict:true, allErrors:true});
addFormats.default(ajv);
ajv.addSchema(platform);
const apiId = "https://veriq.dev/openapi/platform.yaml";
// OpenAPI components are containers, not JSON Schema keywords. Preserve schemas
// while rebasing only local component references into a JSON Schema $defs root.
const definitions = JSON.parse(JSON.stringify(api.components.schemas, (key,value:unknown) =>
  key === "$ref" && typeof value === "string" ? value.replace(/^#\/components\/schemas\//, "#/$defs/") : value));
ajv.addSchema({$id:apiId, $defs:definitions});
const validate = (name:string, value:unknown) => ajv.getSchema(`${apiId}#/$defs/${name}`)!(value);
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/compatibility.json", import.meta.url), "utf8"));

test("every API component compiles with strict JSON Schema validation", () => {
  for (const name of Object.keys(definitions)) expect(ajv.getSchema(`${apiId}#/$defs/${name}`)).toBeTypeOf("function");
});

test("draft updates require revision and typed resource documents", () => {
  const content = fixtures.find((x:{name:string}) => x.name === "asset-CASE").value;
  expect(validate("DraftWrite", {revision:1,content})).toBe(true);
  expect(validate("DraftWrite", {content})).toBe(false);
  expect(validate("DraftWrite", {revision:0,content})).toBe(false);
  expect(validate("DraftWrite", {revision:1,content:{kind:"CASE",document:{steps:[]}}})).toBe(false);
});

test("success and error envelopes are strict and carry request correlation", () => {
  const claim = fixtures.find((x:{name:string}) => x.name === "claim-dto").value;
  expect(validate("ClaimDTOEnvelope", {requestId:"request-1",data:claim})).toBe(true);
  expect(validate("ClaimDTOEnvelope", {data:claim})).toBe(false);
  expect(validate("ClaimDTOEnvelope", {requestId:"request-1",data:claim,extra:true})).toBe(false);
  expect(validate("ErrorEnvelope", {requestId:"request-1",code:"FORBIDDEN",message:"Not authorized",details:{}})).toBe(true);
  expect(validate("ErrorEnvelope", {requestId:"request-1",code:403,message:"Not authorized",details:{}})).toBe(false);
});

test("member roles and Runtime trust updates use explicit allowed values", () => {
  expect(validate("MemberWrite", {role:"EXECUTOR",status:"ACTIVE"})).toBe(true);
  expect(validate("MemberWrite", {role:"SUPERUSER",status:"ACTIVE"})).toBe(false);
  expect(validate("RuntimeTrustWrite", {trustStatus:"MANAGED",allowCredentialDelivery:false})).toBe(true);
  expect(validate("RuntimeTrustWrite", {trustStatus:"MANAGED_CLOUD",allowCredentialDelivery:true})).toBe(false);
});

test("maintenance batches report continuation explicitly", () => {
  const value = {id:"11111111-1111-4111-8111-111111111111",status:"FINISHED",processedCount:3,hasMore:false};
  expect(validate("MaintenanceDTO",value)).toBe(true);
  const {hasMore:_,...incomplete} = value;
  expect(validate("MaintenanceDTO",incomplete)).toBe(false);
});
