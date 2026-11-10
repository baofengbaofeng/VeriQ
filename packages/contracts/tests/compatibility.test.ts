import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { validateCaseSchema, validateSchema, serializeContract, parseContract } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/compatibility.json", import.meta.url), "utf8")) as {name: string; schema: string; value: unknown; valid: boolean}[];

describe("shared schema behavior", () => {
  test.each(fixtures)("$name", ({schema, value, valid}) => {
    expect(validateSchema(schema, value).length === 0).toBe(valid);
  });
  test("CaseDslV1 public validation interface", () => {
    expect(validateCaseSchema(fixtures[0]!.value)).toEqual([]);
    expect(validateCaseSchema(fixtures.find(x => x.name === "unknown-action")!.value).length).toBeGreaterThan(0);
  });
  test("Python and Node validate the same samples", () => {
    const python = execFileSync(root + "apps/srv/.venv/bin/python", [root + "apps/srv/tests/contracts/validation_results.py"], {cwd: root, encoding: "utf8"});
    expect(fixtures.map(x => ({name:x.name, valid:validateSchema(x.schema, x.value).length === 0}))).toEqual(JSON.parse(python));
  });
  test.each([NaN, Infinity, {n:-Infinity}, {n:2**53}, undefined, {x:undefined}, 1n, new Date(), {x:()=>1}])("rejects nonportable JSON sample %#", value => {
    expect(validateSchema("JsonValue", value).length).toBeGreaterThan(0);
  });
  test("serialization validates both directions", () => {
    expect(parseContract("CaseDslV1", serializeContract("CaseDslV1", fixtures[0]!.value))).toEqual(fixtures[0]!.value);
    expect(() => serializeContract("CaseDslV1", {})).toThrow();
    expect(() => parseContract("CaseDslV1", '{"number":NaN}')).toThrow();
  });
  test("literal evidence round-trips while unsafe interpolated DSL is rejected", () => {
    const actual = {present:true,value:{text:"{{customer.name}}"}};
    expect(parseContract("ActualValueV1", serializeContract("ActualValueV1", actual))).toEqual(actual);
    expect(validateSchema("StepV1",{id:"fill",action:"fill",target:"input",value:"{{evil()}}"})).not.toEqual([]);
  });
  test("URL-parser origin escapes are rejected before resolution", () => {
    const base = "https://app.example";
    for (const path of ["/\\outside.example/path", "/\t/outside.example"]) {
      expect(new URL(path,base).origin).toBe("https://outside.example");
      expect(validateSchema("Path",path)).not.toEqual([]);
    }
    expect(validateSchema("Path","/orders/123?state=open")).toEqual([]);
    expect(new URL("/orders/123?state=open",base).origin).toBe(base);
  });
});
