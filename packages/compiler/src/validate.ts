import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  assetSourceBytes,
  canonicalBytes,
  validateSchema,
  type AssetSnapshotV1,
  type AssetVersionV1,
  type AssertionV1,
  type StepV1,
  type ValueType,
  type CaseDslV1,
  type ParameterTypes,
  type JsonValue,
} from "@veriq/contracts";
import {
  accepts,
  pointerKey,
  sha256,
  valueType,
  wireId,
  resolvePointer,
  type ValidationIssue,
} from "./dependency.js";
export const MAX_EXPANDED_ASSERTIONS = 5000;
export interface CompiledAssertion {
  assertion: Exclude<
    AssertionV1,
    {
      type: "template";
    }
  >;
  sourcePath: string;
  parameters: Record<string, JsonValue>[];
}
export interface CompiledStep {
  step: StepV1;
  sourcePath: string;
  before: CompiledAssertion[];
  responseAssertions: CompiledAssertion[];
  after: CompiledAssertion[];
  children?: CompiledStep[];
}
export interface CompiledCase {
  caseVersionId: string;
  document: CaseDslV1;
  steps: CompiledStep[];
  persistenceCheckpointStepId?: string;
}
interface SymbolType {
  type: ValueType;
  alternatives?: ValueType[];
  optional?: boolean;
  properties?: Map<string, SymbolType>;
}
interface Scope {
  data: Map<string, SymbolType>;
  vars: Map<string, SymbolType>;
  catalog?: Set<string>;
  locatorBindings?: Map<string, unknown[]>;
  library?: boolean;
  localDefinitions?: Set<string>;
  externalObservers?: boolean;
  assertionBudget?: {
    count: number;
  };
}
export interface Analysis {
  issues: ValidationIssue[];
  cases: CompiledCase[];
}
export function analyze(snapshot: AssetSnapshotV1): Analysis {
  const issues: ValidationIssue[] = validateSchema("AssetSnapshotV1", snapshot);
  const cases: CompiledCase[] = [];
  const jsonSchemas = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(jsonSchemas);
  const fail = (code: string, path: string, message = code) => {
    issues.push({ code, path, message });
  };
  if (issues.length) return { issues, cases };
  try {
    if (sha256(assetSourceBytes(snapshot)) !== snapshot.sourceHash)
      fail("SOURCE_HASH_MISMATCH", "/sourceHash");
  } catch {
    fail("INVALID_JSON", "");
    return { issues, cases };
  }
  const assets = new Map<string, AssetVersionV1>();
  const edges = new Map<string, Set<string>>();
  const paths = new Map<string, string>();
  for (const [i, a] of snapshot.assets.entries()) {
    const p = `/assets/${i}`;
    paths.set(a.versionId, p);
    if (assets.has(a.versionId)) fail("DUPLICATE_VERSION", p);
    assets.set(a.versionId, a);
    edges.set(a.versionId, new Set());
    if (
      sha256(canonicalBytes({ kind: a.kind, document: a.document })) !==
      a.sha256
    )
      fail("DOCUMENT_HASH_MISMATCH", p + "/sha256");
  }
  function ref(
    owner: string,
    id: string,
    kind: AssetVersionV1["kind"],
    p: string,
  ): AssetVersionV1 | undefined {
    edges.get(owner)?.add(id);
    const found = assets.get(id);
    if (!found) fail("MISSING_REFERENCE", p, id);
    else if (found.kind !== kind)
      fail("REFERENCE_KIND_MISMATCH", p, `Expected ${kind}`);
    else return found;
  }
  const unique = (values: string[], p: string, code = "DUPLICATE_ID") => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) fail(code, p, v);
      seen.add(v);
    }
  };
  unique(
    snapshot.entryCaseVersionIds,
    "/entryCaseVersionIds",
    "DUPLICATE_ENTRY_CASE",
  );
  for (const id of snapshot.entryCaseVersionIds)
    if (assets.get(id)?.kind !== "CASE")
      fail("INVALID_ENTRY_CASE", "/entryCaseVersionIds", id);
  if (snapshot.validationTarget) {
    const t = snapshot.validationTarget;
    const a = assets.get(t.versionId);
    if (
      !a ||
      a.resourceId !== t.resourceId ||
      (a.kind === "CASE" &&
        (snapshot.entryCaseVersionIds.length !== 1 ||
          snapshot.entryCaseVersionIds[0] !== a.versionId)) ||
      (a.kind === "SUITE" &&
        (new Set(a.document.cases.map((c) => c.versionId)).size !==
          snapshot.entryCaseVersionIds.length ||
          a.document.cases.some(
            (c) => !snapshot.entryCaseVersionIds.includes(c.versionId),
          ))) ||
      (a.kind !== "CASE" &&
        a.kind !== "SUITE" &&
        snapshot.entryCaseVersionIds.length !== 0)
    )
      fail("INVALID_VALIDATION_TARGET", "/validationTarget");
  }
  function localDefinitions(
    list: StepV1[],
    seen = new Set<string>(),
  ): Set<string> {
    const names = new Set(
      list.flatMap((step) => (step.extract ?? []).map((e) => e.to)),
    );
    if (seen.size >= 5) return names;
    for (const step of list)
      if (step.action === "callFlow" && !seen.has(step.versionId)) {
        const flow = assets.get(step.versionId);
        if (flow?.kind === "FLOW")
          for (const name of localDefinitions(
            flow.document.steps,
            new Set([...seen, step.versionId]),
          ))
            names.add(name);
      }
    return names;
  }
  function sym(type: ValueType): SymbolType {
    return { type };
  }
  function schemaSymbol(
    schema: unknown,
    root: unknown = schema,
    seen = new Set<string>(),
  ): SymbolType | undefined {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
    const s = schema as Record<string, unknown>;
    if (
      typeof s.$ref === "string" &&
      s.$ref.startsWith("#/") &&
      !seen.has(s.$ref)
    ) {
      const resolved = resolvePointer(root as JsonValue, s.$ref.slice(1));
      if (resolved.present)
        return schemaSymbol(resolved.value, root, new Set([...seen, s.$ref]));
    }
    const types = [
      "string",
      "number",
      "integer",
      "boolean",
      "object",
      "array",
      "null",
    ];
    const declared = Array.isArray(s.type)
      ? s.type
      : typeof s.type === "string"
        ? [s.type]
        : types;
    if (
      !declared.length ||
      declared.some((t) => typeof t !== "string" || !types.includes(t))
    )
      return;
    const out: SymbolType = {
      type: declared[0] as ValueType,
      ...(declared.length > 1 ? { alternatives: declared as ValueType[] } : {}),
    };
    if (
      s.type === "object" &&
      s.properties &&
      typeof s.properties === "object"
    ) {
      out.properties = new Map();
      for (const [k, v] of Object.entries(s.properties)) {
        const child = schemaSymbol(v, root, seen);
        if (child) {
          child.optional =
            !Array.isArray(s.required) || !s.required.includes(k);
          out.properties.set(k, child);
        }
      }
    }
    return out;
  }
  function dataSymbol(values: JsonValue[]): SymbolType {
    const types = [...new Set(values.map(valueType))];
    const result: SymbolType = {
      type: types[0] ?? "null",
      ...(types.length > 1 ? { alternatives: types } : {}),
    };
    if (
      values.every(
        (v) => v !== null && typeof v === "object" && !Array.isArray(v),
      )
    ) {
      const objects = values as Record<string, JsonValue>[];
      result.properties = new Map();
      for (const key of new Set(objects.flatMap(Object.keys))) {
        const present = objects.filter((v) => Object.hasOwn(v, key));
        const child = dataSymbol(present.map((v) => v[key]!));
        child.optional = present.length !== objects.length;
        result.properties.set(key, child);
      }
    }
    return result;
  }
  function binding(
    v: unknown,
    scope: Scope,
    p: string,
    expected?: ValueType,
  ): SymbolType | undefined {
    if (typeof v === "string") {
      const matches = [
        ...v.matchAll(
          /\{\{(data|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}\}/gu,
        ),
      ];
      let full: SymbolType | undefined;
      for (const m of matches) {
        const keys = m[2]!.split(".");
        let found = scope[m[1] as "data" | "vars"].get(keys.shift()!);
        let optional = found?.optional ?? false;
        for (const k of keys) {
          found = found?.properties?.get(k);
          optional ||= found?.optional ?? false;
        }
        if (!found) {
          if (
            !scope.library ||
            (m[1] === "vars" &&
              scope.localDefinitions?.has(m[2]!.split(".")[0]!))
          )
            fail(
              m[1] === "vars"
                ? "VARIABLE_USED_BEFORE_DEFINED"
                : "UNKNOWN_DATA_BINDING",
              p,
              m[0],
            );
          continue;
        }
        if (optional) fail("POSSIBLY_MISSING_VARIABLE", p, m[0]);
        if (m[0] === v) full = found;
        else if (
          (found.alternatives ?? [found.type]).some((t) =>
            ["object", "array", "null"].includes(t),
          )
        )
          fail("BINDING_TYPE_MISMATCH", p);
      }
      const result = full ?? sym("string");
      if (
        expected &&
        !(result.alternatives ?? [result.type]).every((t) =>
          accepts(expected, t),
        )
      )
        fail(
          "BINDING_TYPE_MISMATCH",
          p,
          `Expected ${expected}, got ${result.type}`,
        );
      return result;
    }
    if (Array.isArray(v)) v.forEach((x, i) => binding(x, scope, `${p}/${i}`));
    const result = sym(valueType(v));
    if (v && typeof v === "object" && !Array.isArray(v)) {
      result.properties = new Map();
      for (const [k, x] of Object.entries(v)) {
        const child = binding(x, scope, `${p}/${pointerKey(k)}`);
        if (child) result.properties.set(k, child);
      }
    }
    if (
      expected &&
      !(result.alternatives ?? [result.type]).every((t) => accepts(expected, t))
    )
      fail("BINDING_TYPE_MISMATCH", p);
    return result;
  }
  function params(
    declared: ParameterTypes | undefined,
    supplied: Record<string, JsonValue> | undefined,
    scope: Scope,
    p: string,
  ): Scope {
    const data = new Map(scope.data);
    for (const [key, type] of Object.entries(declared ?? {})) {
      if (!Object.hasOwn(supplied ?? {}, key))
        fail("MISSING_PARAMETER", p, key);
      else {
        const found = binding(
          supplied![key],
          scope,
          p + "/" + pointerKey(key),
          type,
        );
        data.set(key, found ?? sym(type));
      }
    }
    for (const key of Object.keys(supplied ?? {}))
      if (!Object.hasOwn(declared ?? {}, key))
        fail("UNKNOWN_PARAMETER", p, key);
    return { ...scope, data };
  }
  function checkJsonSchema(schema: unknown, path: string): void {
    try {
      jsonSchemas.compile(schema as object);
    } catch (error) {
      fail("INVALID_JSON_SCHEMA", path, String(error));
    }
  }
  function target(key: string, scope: Scope, p: string): void {
    if (scope.catalog && !scope.catalog.has(key)) fail("UNKNOWN_ELEMENT", p);
    for (const v of scope.locatorBindings?.get(key) ?? [])
      binding(v, scope, p, "string");
  }
  function source(source: string, observers: Set<string>, p: string) {
    if (
      source !== "page" &&
      !observers.has(source.slice(source.indexOf(":") + 1))
    )
      fail("UNKNOWN_OBSERVER", p, source);
  }
  function assertions(
    list: AssertionV1[],
    owner: string,
    scope: Scope,
    observers: Set<string>,
    p: string,
    stack: string[] = [],
    bindings: Record<string, JsonValue>[] = [],
  ): CompiledAssertion[] {
    scope = {
      ...scope,
      assertionBudget: scope.assertionBudget ?? { count: 0 },
    };
    unique(
      list.map((a) => a.id),
      p,
    );
    const result: CompiledAssertion[] = [];
    for (const [i, a] of list.entries()) {
      const path = `${p}/${i}`;
      if (scope.assertionBudget!.count++ >= MAX_EXPANDED_ASSERTIONS) {
        if (scope.assertionBudget!.count === MAX_EXPANDED_ASSERTIONS + 1)
          fail(
            "EXPANDED_ASSERTION_LIMIT",
            path,
            `At most ${MAX_EXPANDED_ASSERTIONS} expanded assertion nodes per case/library`,
          );
        break;
      }
      if (a.type === "template") {
        const t = ref(
          owner,
          a.versionId,
          "ASSERTION_TEMPLATE",
          path + "/versionId",
        );
        if (stack.includes(a.versionId)) {
          fail("TEMPLATE_CYCLE", path);
          continue;
        }
        if (stack.length >= 5) {
          fail("TEMPLATE_DEPTH_LIMIT", path);
          continue;
        }
        if (t?.kind === "ASSERTION_TEMPLATE")
          result.push(
            ...assertions(
              t.document.assertions,
              t.versionId,
              params(t.document.parameters, a.parameters, scope, path),
              observers,
              path + "/template",
              [...stack, a.versionId],
              [...bindings, a.parameters ?? {}],
            ).map((x) => ({
              ...x,
              assertion: {
                ...x.assertion,
                severity: a.severity === "WARN" ? "WARN" : x.assertion.severity,
              },
            })),
          );
        continue;
      }
      if ("source" in a && !scope.externalObservers)
        source(a.source, observers, path + "/source");
      if ("target" in a) target(a.target, scope, path + "/target");
      if (a.type === "responseSchema")
        checkJsonSchema(a.expected, path + "/expected");
      if ("expected" in a && a.type !== "responseSchema")
        binding(
          a.expected,
          scope,
          path + "/expected",
          (a.type === "ui" &&
            ["textEquals", "textContains", "valueEquals"].includes(
              a.operator,
            )) ||
            a.type === "url"
            ? "string"
            : undefined,
        );
      if (a.type === "eventually") binding(a.query, scope, path + "/query");
      result.push({
        assertion: { ...a, id: wireId(path) },
        sourcePath: path,
        parameters: bindings,
      });
    }
    return result;
  }
  function steps(
    list: StepV1[],
    owner: string,
    scope: Scope,
    p: string,
    stack: string[],
    budget: {
      count: number;
    },
    write: boolean,
  ): CompiledStep[] {
    scope = {
      ...scope,
      assertionBudget: scope.assertionBudget ?? { count: 0 },
    };
    unique(
      list.map((s) => s.id),
      p,
    );
    const out: CompiledStep[] = [];
    for (const [i, s] of list.entries()) {
      const path = `${p}/${i}`;
      if (++budget.count > 500) {
        fail(
          "EXPANDED_STEP_LIMIT",
          path,
          `Expanded step count ${budget.count} exceeds 500 including callFlow boundaries`,
        );
        break;
      }
      const obs = new Set((s.observers ?? []).map((o) => o.id));
      unique([...(s.observers ?? []).map((o) => o.id)], path + "/observers");
      const before = assertions(
        s.beforeAssertions ?? [],
        owner,
        scope,
        new Set(),
        path + "/beforeAssertions",
      );
      if ("target" in s) target(s.target, scope, path + "/target");
      for (const k of ["path", "value", "body", "query", "headers"] as const)
        if (k in s)
          binding(
            (s as unknown as Record<string, unknown>)[k],
            scope,
            path + "/" + k,
            k === "value" &&
              (s.action === "fill" ||
                s.action === "press" ||
                (s.action === "selectOption" && typeof s.value === "string"))
              ? "string"
              : undefined,
          );
      if (s.action === "selectOption" && Array.isArray(s.value))
        s.value.forEach((v, i) =>
          binding(v, scope, path + "/value/" + i, "string"),
        );
      for (const o of s.observers ?? [])
        for (const k of ["path", "bodyMatch", "queryMatch"] as const)
          if (k in o)
            binding(o[k], scope, path + "/observers/" + o.id + "/" + k);
      let children: CompiledStep[] | undefined;
      if (s.action === "callFlow") {
        const f = ref(owner, s.versionId, "FLOW", path + "/versionId");
        if (stack.includes(s.versionId)) fail("FLOW_CYCLE", path);
        else if (stack.length >= 5) fail("FLOW_DEPTH_LIMIT", path);
        else if (f?.kind === "FLOW")
          children = steps(
            f.document.steps,
            f.versionId,
            params(
              f.document.parameters,
              s.parameters,
              scope,
              path + "/parameters",
            ),
            path + "/flow",
            [...stack, s.versionId],
            budget,
            write,
          );
      }
      for (const [j, e] of (s.extract ?? []).entries()) {
        source(e.source, obs, path + "/extract/" + j);
        if (scope.vars.has(e.to))
          fail("DUPLICATE_VARIABLE", path + "/extract/" + j, e.to);
        scope.vars.set(e.to, { type: e.valueType, optional: !e.required });
      }
      const after = assertions(
        s.afterAssertions ?? [],
        owner,
        scope,
        obs,
        path + "/afterAssertions",
      );
      if (
        write &&
        s.critical &&
        !after.some(
          (a) =>
            a.assertion.type === "responseField" &&
            ["equals", "in", "contains"].includes(a.assertion.operator) &&
            a.assertion.severity !== "WARN",
        )
      )
        fail("MISSING_BUSINESS_ASSERTION", path);
      const extracts = new Set((s.extract ?? []).map((e) => e.to));
      const usesExtract = (value: unknown): boolean =>
        typeof value === "string"
          ? [...value.matchAll(/\{\{vars\.([A-Za-z_][A-Za-z0-9_]*)/gu)].some(
              (m) => extracts.has(m[1]!),
            )
          : Array.isArray(value)
            ? value.some(usesExtract)
            : !!value &&
              typeof value === "object" &&
              Object.values(value).some(usesExtract);
      const dependent = (a: CompiledAssertion): boolean =>
        usesExtract(a.parameters) ||
        (a.assertion.type !== "responseSchema" &&
          "expected" in a.assertion &&
          usesExtract(a.assertion.expected)) ||
        (a.assertion.type === "eventually" && usesExtract(a.assertion.query));
      const {
        beforeAssertions: _before,
        afterAssertions: _after,
        ...action
      } = s;
      out.push({
        step: { ...action, id: wireId(path) },
        sourcePath: path,
        before,
        responseAssertions: after.filter((a) => !dependent(a)),
        after: after.filter(dependent),
        ...(children ? { children } : {}),
      });
    }
    return out;
  }
  for (const a of snapshot.assets) {
    const p = paths.get(a.versionId)! + "/document";
    if (a.kind === "CASE") {
      const d = a.document;
      const c = ref(
        a.versionId,
        d.catalogVersionId,
        "ELEMENT_CATALOG",
        p + "/catalogVersionId",
      );
      const scope: Scope = {
        data: new Map(),
        vars: new Map(),
        ...(c?.kind === "ELEMENT_CATALOG"
          ? { catalog: new Set(c.document.elements.map((e) => e.key)) }
          : {}),
      };
      if (c?.kind === "ELEMENT_CATALOG") {
        scope.locatorBindings = new Map();
        const elements = new Map(c.document.elements.map((e) => [e.key, e]));
        for (const e of c.document.elements) {
          const values: unknown[] = [];
          const seen = new Set<string>();
          let current: typeof e | undefined = e;
          while (current && !seen.has(current.key)) {
            seen.add(current.key);
            if (current.recordKey) values.push(current.recordKey);
            if (current.locator.by === "role" && current.locator.name)
              values.push(current.locator.name);
            current = current.scope ? elements.get(current.scope) : undefined;
          }
          scope.locatorBindings.set(e.key, values);
        }
      }
      if (d.datasetVersionId) {
        const ds = ref(
          a.versionId,
          d.datasetVersionId,
          "DATASET",
          p + "/datasetVersionId",
        );
        if (ds?.kind === "DATASET")
          for (const [k, v] of Object.entries(ds.document.columns))
            scope.data.set(k, {
              ...dataSymbol(
                ds.document.rows
                  .filter((row) => Object.hasOwn(row.values, k))
                  .map((row) => row.values[k]!),
              ),
              type: v,
            });
      }
      if (d.fixtureVersionId) {
        const f = ref(
          a.versionId,
          d.fixtureVersionId,
          "FIXTURE",
          p + "/fixtureVersionId",
        );
        if (f?.kind === "FIXTURE") {
          const declared = schemaSymbol(f.document.outputSchema);
          if (!declared || declared.type !== "object" || declared.alternatives)
            fail("FIXTURE_OUTPUT_DECLARATIONS_REQUIRED", p);
          else scope.vars = new Map(declared.properties ?? []);
        }
      }
      const expanded = steps(
        d.steps,
        a.versionId,
        scope,
        p + "/steps",
        [],
        { count: 0 },
        d.kind === "WRITE",
      );
      if (d.kind === "WRITE") {
        const index = d.steps.findIndex(
          (s) => s.id === d.persistenceCheckpointStepId,
        );
        const checkpoint = expanded[index];
        const critical = (s: CompiledStep): boolean =>
          !!s.step.critical || !!s.children?.some(critical);
        const lastWrite = expanded.reduce(
          (last, s, i) => (critical(s) ? i : last),
          -1,
        );
        const observed =
          checkpoint &&
          [...checkpoint.responseAssertions, ...checkpoint.after].some(
            (x) =>
              x.assertion.severity !== "WARN" &&
              (x.assertion.type === "eventually" ||
                (["reload", "goto"].includes(checkpoint.step.action) &&
                  x.assertion.type === "ui") ||
                (checkpoint.step.action === "apiRequest" &&
                  checkpoint.step.method === "GET" &&
                  x.assertion.type === "responseField")),
          );
        if (
          index < 0 ||
          index < lastWrite ||
          (index === lastWrite &&
            !(
              checkpoint &&
              [...checkpoint.responseAssertions, ...checkpoint.after].some(
                (x) =>
                  x.assertion.type === "eventually" &&
                  x.assertion.severity !== "WARN",
              )
            )) ||
          !observed
        )
          fail(
            "MISSING_PERSISTENCE_CHECKPOINT",
            p + "/persistenceCheckpointStepId",
          );
      }
      const checkpoint = expanded.find(
        (_, i) => d.steps[i]!.id === d.persistenceCheckpointStepId,
      );
      cases.push({
        caseVersionId: a.versionId,
        document: d,
        steps: expanded,
        ...(checkpoint
          ? { persistenceCheckpointStepId: checkpoint.step.id }
          : {}),
      });
    } else if (a.kind === "DATASET") {
      unique(
        a.document.rows.map((r) => r.key),
        p + "/rows",
      );
      for (const [i, row] of a.document.rows.entries()) {
        for (const [k, type] of Object.entries(a.document.columns))
          if (
            !Object.hasOwn(row.values, k) ||
            !accepts(type, valueType(row.values[k]))
          )
            fail(
              "DATA_TYPE_MISMATCH",
              `${p}/rows/${i}/values/${pointerKey(k)}`,
            );
        for (const k of Object.keys(row.values))
          if (!Object.hasOwn(a.document.columns, k))
            fail(
              "UNKNOWN_DATA_COLUMN",
              `${p}/rows/${i}/values/${pointerKey(k)}`,
            );
      }
    } else if (a.kind === "ELEMENT_CATALOG") {
      const entries = new Map(a.document.elements.map((e) => [e.key, e]));
      unique(
        a.document.elements.map((e) => e.key),
        p + "/elements",
      );
      for (const e of a.document.elements) {
        const seen = new Set<string>();
        let cursor: typeof e | undefined = e;
        while (cursor?.scope) {
          if (seen.has(cursor.key)) {
            fail("CATALOG_SCOPE_CYCLE", p);
            break;
          }
          seen.add(cursor.key);
          if (!entries.has(cursor.scope))
            fail("UNKNOWN_ELEMENT", p, cursor.scope);
          cursor = entries.get(cursor.scope);
        }
      }
    } else if (a.kind === "FLOW") {
      const scope: Scope = {
        data: new Map(
          Object.entries(a.document.parameters ?? {}).map(([k, v]) => [
            k,
            sym(v),
          ]),
        ),
        vars: new Map(),
        library: true,
        localDefinitions: localDefinitions(
          a.document.steps,
          new Set([a.versionId]),
        ),
      };
      steps(
        a.document.steps,
        a.versionId,
        scope,
        p + "/steps",
        [a.versionId],
        { count: 0 },
        false,
      );
    } else if (a.kind === "ASSERTION_TEMPLATE") {
      assertions(
        a.document.assertions,
        a.versionId,
        {
          data: new Map(
            Object.entries(a.document.parameters ?? {}).map(([k, v]) => [
              k,
              sym(v),
            ]),
          ),
          vars: new Map(),
          library: true,
          externalObservers: true,
        },
        new Set(
          a.document.assertions.flatMap((x) =>
            "source" in x ? [x.source.slice(x.source.indexOf(":") + 1)] : [],
          ),
        ),
        p + "/assertions",
        [a.versionId],
      );
    } else if (a.kind === "SUITE") {
      for (const c of a.document.cases) {
        ref(a.versionId, c.versionId, "CASE", p + "/cases");
        if (c.datasetVersionId)
          ref(a.versionId, c.datasetVersionId, "DATASET", p + "/cases");
      }
    } else if (a.kind === "ENVIRONMENT") {
      unique(
        a.document.roles.map((r) => r.roleKey),
        p + "/roles",
      );
      const allowed = new Set(a.document.allowedOrigins);
      for (const origin of allowed)
        if (new URL(origin).origin !== origin)
          fail("INVALID_ALLOWED_ORIGIN", p + "/allowedOrigins");
      for (const base of [
        a.document.baseURL,
        a.document.apiBaseURL,
        a.document.fixtureBaseURL,
      ].filter((v): v is string => !!v))
        if (!allowed.has(new URL(base).origin)) fail("UNAUTHORIZED_ORIGIN", p);
      try {
        new Intl.DateTimeFormat(a.document.locale, {
          timeZone: a.document.timezone,
        });
      } catch {
        fail("INVALID_LOCALE_TIMEZONE", p);
      }
    } else if (a.kind === "FIXTURE") {
      for (const [key, s] of [
        ["inputSchema", a.document.inputSchema],
        ["outputSchema", a.document.outputSchema],
      ] as const) {
        checkJsonSchema(s, p + "/" + key);
        if (!schemaSymbol(s))
          fail("FIXTURE_SCHEMA_TYPE_REQUIRED", p + "/" + key);
      }
    }
  }
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const dep of edges.get(id) ?? []) visit(dep);
  };
  for (const id of snapshot.validationTarget
    ? [snapshot.validationTarget.versionId]
    : snapshot.entryCaseVersionIds)
    visit(id);
  if (!snapshot.validationTarget) {
    const roots = snapshot.assets.filter(
      (a) =>
        a.kind === "SUITE" &&
        new Set(a.document.cases.map((c) => c.versionId)).size ===
          snapshot.entryCaseVersionIds.length &&
        a.document.cases.every((c) =>
          snapshot.entryCaseVersionIds.includes(c.versionId),
        ),
    );
    if (roots.length > 1) fail("AMBIGUOUS_SUITE_ROOT", "/assets");
    else if (roots[0]) visit(roots[0].versionId);
  }
  for (const a of snapshot.assets)
    if (!reachable.has(a.versionId))
      fail("UNREACHABLE_ASSET", paths.get(a.versionId)!);
  return { issues, cases };
}
export function validate(snapshot: AssetSnapshotV1): ValidationIssue[] {
  return analyze(snapshot).issues;
}
