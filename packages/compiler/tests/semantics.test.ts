import { it, expect } from "vitest";
import type { StepV1, AssertionV1, AssetSnapshotV1 } from "@veriq/contracts";
import {
  validate,
  analyze,
  resolveBinding,
  resolvePointer,
} from "../src/index.js";
import { id, asset, snapshot, rehash } from "./helpers.js";
const codes = (s: AssetSnapshotV1) => validate(s).map((x) => x.code);
const flow = (
  n: number,
  steps: StepV1[],
  parameters?: Record<string, string>,
) =>
  asset(n, "FLOW", {
    schemaVersion: "1.0",
    steps,
    ...(parameters ? { parameters } : {}),
  });
const business: AssertionV1 = {
  id: "business",
  type: "responseField",
  source: "response:save",
  pointer: "/code",
  operator: "equals",
  expected: 0,
  severity: "BLOCK",
  expectedSource: "API",
};
const fixture = (schema: unknown) =>
  asset(3, "FIXTURE", {
    schemaVersion: "1.0",
    prepare: { method: "POST", path: "/prepare" },
    query: { method: "GET", path: "/query" },
    cleanup: { method: "DELETE", path: "/cleanup" },
    inputSchema: { type: "object" },
    outputSchema: schema,
    ttlSeconds: 3600,
  });
it("supports fixture output declarations and nested property types", () =>
  expect(
    validate(
      snapshot(
        [
          {
            id: "fill",
            action: "fill",
            target: "name",
            value: "{{vars.employee.name}}",
          },
        ],
        [
          fixture({
            type: "object",
            properties: {
              employee: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
            required: ["employee"],
          }),
        ],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toEqual([]));
it("rejects invalid fixture JSON Schema using Ajv", () =>
  expect(
    codes(
      snapshot(
        undefined,
        [fixture({ type: "object", properties: { x: { type: "nonsense" } } })],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toContain("INVALID_JSON_SCHEMA"));
it("rejects remote schema references without fetching them", () =>
  expect(
    codes(
      snapshot(
        undefined,
        [
          fixture({
            type: "object",
            properties: { x: { $ref: "https://evil.test/schema" } },
          }),
        ],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toContain("INVALID_JSON_SCHEMA"));
it("checks type compatibility in nested scoped flow parameters", () => {
  const f = flow(
    3,
    [{ id: "fill", action: "fill", target: "name", value: "{{data.name}}" }],
    { name: "string" },
  );
  expect(
    validate(
      snapshot(
        [
          {
            id: "call",
            action: "callFlow",
            versionId: id(3),
            parameters: { name: "A" },
          },
        ],
        [f],
      ),
    ),
  ).toEqual([]);
  expect(
    codes(
      snapshot(
        [
          {
            id: "call",
            action: "callFlow",
            versionId: id(3),
            parameters: { name: 1 },
          },
        ],
        [f],
      ),
    ),
  ).toContain("BINDING_TYPE_MISMATCH");
});
it("rejects missing and unknown flow parameters", () => {
  const f = flow(3, [{ id: "reload", action: "reload" }], { name: "string" });
  expect(
    codes(
      snapshot(
        [
          {
            id: "call",
            action: "callFlow",
            versionId: id(3),
            parameters: { other: "A" },
          },
        ],
        [f],
      ),
    ),
  ).toEqual(expect.arrayContaining(["MISSING_PARAMETER", "UNKNOWN_PARAMETER"]));
});
it("preserves callFlow wrapper listeners, assertions, extraction, children and bounded IDs", () => {
  const s = snapshot(
    [
      {
        id: "x".repeat(160),
        action: "callFlow",
        versionId: id(3),
        observers: [{ id: "save", method: "POST", path: "/save" }],
        afterAssertions: [business],
        extract: [
          {
            source: "response:save",
            pointer: "/id",
            to: "id",
            required: true,
            valueType: "string",
          },
        ],
      },
    ],
    [
      flow(3, [
        { id: "y".repeat(160), action: "reload" },
        { id: "z".repeat(160), action: "click", target: "name" },
      ]),
    ],
  );
  const a = analyze(s);
  expect(a.issues).toEqual([]);
  const wrapper = a.cases[0]!.steps[0]!;
  expect(wrapper.step.observers).toHaveLength(1);
  expect(wrapper.step.extract).toHaveLength(1);
  expect(wrapper.responseAssertions).toHaveLength(1);
  expect(wrapper.children).toHaveLength(2);
  expect(wrapper.children![0]!.step.id.length).toBeLessThanOrEqual(160);
  expect(wrapper.sourcePath).toContain("/steps/0");
});
it("accepts five flow levels and rejects six", () => {
  const build = (depth: number) =>
    snapshot(
      [{ id: "call", action: "callFlow", versionId: id(3) }],
      Array.from({ length: depth }, (_, i) =>
        flow(
          i + 3,
          i === depth - 1
            ? [{ id: "leaf", action: "reload" }]
            : [{ id: "call", action: "callFlow", versionId: id(i + 4) }],
        ),
      ),
    );
  expect(validate(build(5))).toEqual([]);
  expect(codes(build(6))).toContain("FLOW_DEPTH_LIMIT");
});
it("bounds expanded steps at 500", () => {
  const leaves = Array.from(
    { length: 250 },
    (_, i) => ({ id: "s" + i, action: "reload" }) as StepV1,
  );
  expect(
    codes(
      snapshot(
        [
          { id: "a", action: "callFlow", versionId: id(3) },
          { id: "b", action: "callFlow", versionId: id(3) },
        ],
        [flow(3, leaves)],
      ),
    ),
  ).toContain("EXPANDED_STEP_LIMIT");
});
it("expands pinned templates and detects cycles", () => {
  const t = asset(4, "ASSERTION_TEMPLATE", {
    schemaVersion: "1.0",
    parameters: { code: "integer" },
    assertions: [{ ...business, expected: "{{data.code}}" }],
  });
  const call: AssertionV1 = {
    id: "tpl",
    type: "template",
    versionId: id(4),
    parameters: { code: 0 },
    severity: "BLOCK",
    expectedSource: "API",
  };
  const s = snapshot(
    [
      {
        id: "save",
        action: "reload",
        observers: [{ id: "save", method: "POST", path: "/" }],
        afterAssertions: [call],
      },
    ],
    [t],
  );
  expect(validate(s)).toEqual([]);
  const a = analyze(s);
  expect(a.cases[0]!.steps[0]!.responseAssertions[0]!.parameters).toEqual([
    { code: 0 },
  ]);
  const cycle = asset(4, "ASSERTION_TEMPLATE", {
    schemaVersion: "1.0",
    assertions: [call],
    parameters: { code: "integer" },
  });
  expect(
    codes(
      snapshot(
        [{ id: "save", action: "reload", afterAssertions: [call] }],
        [cycle],
      ),
    ),
  ).toContain("TEMPLATE_CYCLE");
});
it("requires business assertions, rejects WARN downgrade, and validates later persistence", () => {
  const steps: StepV1[] = [
    {
      id: "save",
      action: "click",
      target: "name",
      critical: true,
      observers: [{ id: "save", method: "POST", path: "/" }],
      afterAssertions: [business],
    },
    {
      id: "persist",
      action: "reload",
      afterAssertions: [
        {
          id: "visible",
          type: "ui",
          target: "name",
          operator: "textEquals",
          expected: "A",
          severity: "BLOCK",
          expectedSource: "REQ",
        },
      ],
    },
  ];
  expect(
    validate(
      snapshot(steps, [], {
        kind: "WRITE",
        persistenceCheckpointStepId: "persist",
      }),
    ),
  ).toEqual([]);
  steps[0]!.afterAssertions![0] = { ...business, severity: "WARN" };
  expect(
    codes(
      snapshot(steps, [], {
        kind: "WRITE",
        persistenceCheckpointStepId: "persist",
      }),
    ),
  ).toContain("MISSING_BUSINESS_ASSERTION");
});
it("checks catalog scope cycles and binding uses", () => {
  const s = snapshot([{ id: "click", action: "click", target: "name" }]);
  s.assets[1] = asset(2, "ELEMENT_CATALOG", {
    schemaVersion: "1.0",
    elements: [
      {
        key: "name",
        scope: "name",
        locator: { by: "role", role: "button", name: "{{vars.missing}}" },
      },
    ],
  });
  expect(codes(rehash(s))).toEqual(
    expect.arrayContaining([
      "CATALOG_SCOPE_CYCLE",
      "VARIABLE_USED_BEFORE_DEFINED",
    ]),
  );
});
it("validates standalone environment origins and repeated roles without resolving credentials", () => {
  const s = snapshot();
  s.assets = [
    asset(8, "ENVIRONMENT", {
      schemaVersion: "1.0",
      baseURL: "https://one.test",
      apiBaseURL: "https://two.test",
      allowedOrigins: ["https://one.test"],
      locale: "en-US",
      timezone: "UTC",
      roles: [
        {
          roleKey: "reader",
          secretRef: "ref",
          secretVersionId: id(90),
          authAdapterVersionId: id(91),
        },
      ],
    }),
  ];
  s.entryCaseVersionIds = [];
  s.validationTarget = {
    resourceId: s.assets[0].resourceId,
    versionId: id(8),
    revision: 1,
  };
  expect(codes(rehash(s))).toContain("UNAUTHORIZED_ORIGIN");
});
it("validates standalone suite closure", () => {
  const s = snapshot();
  s.assets.push(
    asset(8, "SUITE", { schemaVersion: "1.0", cases: [{ versionId: id(1) }] }),
  );
  s.validationTarget = {
    resourceId: s.assets[2]!.resourceId,
    versionId: id(8),
    revision: 1,
  };
  expect(validate(rehash(s))).toEqual([]);
});
it("never interprets literal JSON Schema or dataset data as bindings", () => {
  const d = asset(3, "DATASET", {
    schemaVersion: "1.0",
    columns: { name: "string" },
    rows: [{ key: "a", values: { name: "{{evil()}}" } }],
  });
  expect(
    validate(
      snapshot(
        [
          {
            id: "fill",
            action: "fill",
            target: "name",
            value: "{{data.name}}",
          },
        ],
        [d],
        { datasetVersionId: id(3) },
      ),
    ),
  ).toEqual([]);
});
it("checks unsafe interpolation and missing pointers without prototype access", () => {
  expect(() => resolveBinding("{{evil()}}", { data: {}, vars: {} })).toThrow(
    "UNSAFE_EXPRESSION",
  );
  expect(resolvePointer([1], "/01")).toEqual({ present: false });
  expect(() => resolvePointer({}, "/~2")).toThrow("INVALID_POINTER");
  expect(resolveBinding("x{{data.n}}", { data: { n: 4 }, vars: {} })).toBe(
    "x4",
  );
  expect(() =>
    resolveBinding("x{{data.n}}", { data: { n: [] }, vars: {} }),
  ).toThrow("BINDING_TYPE_MISMATCH");
});
it("rejects nested bindings beneath an optional fixture object", () =>
  expect(
    codes(
      snapshot(
        [
          {
            id: "fill",
            action: "fill",
            target: "name",
            value: "{{vars.employee.name}}",
          },
        ],
        [
          fixture({
            type: "object",
            properties: {
              employee: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
          }),
        ],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toContain("POSSIBLY_MISSING_VARIABLE"));
it("rejects type-changing selectOption and locator bindings", () => {
  const f = fixture({
    type: "object",
    properties: { n: { type: "integer" } },
    required: ["n"],
  });
  expect(
    codes(
      snapshot(
        [
          {
            id: "select",
            action: "selectOption",
            target: "name",
            value: "{{vars.n}}",
          },
        ],
        [f],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toContain("BINDING_TYPE_MISMATCH");
  const s = snapshot([{ id: "click", action: "click", target: "name" }], [f], {
    fixtureVersionId: id(3),
  });
  s.assets[1] = asset(2, "ELEMENT_CATALOG", {
    schemaVersion: "1.0",
    elements: [
      {
        key: "name",
        locator: { by: "role", role: "button", name: "{{vars.n}}" },
      },
    ],
  });
  expect(codes(rehash(s))).toContain("BINDING_TYPE_MISMATCH");
});
it("accepts persistence via a same-step read-only eventual query and maps checkpoint wire ID", () => {
  const s = snapshot(
    [
      {
        id: "save",
        action: "click",
        target: "name",
        critical: true,
        observers: [{ id: "save", method: "POST", path: "/" }],
        afterAssertions: [
          business,
          {
            id: "persist",
            type: "eventually",
            query: { method: "GET", path: "/read" },
            pointer: "/code",
            operator: "equals",
            expected: 0,
            severity: "BLOCK",
            expectedSource: "API",
          },
        ],
      },
    ],
    [],
    { kind: "WRITE", persistenceCheckpointStepId: "save" },
  );
  const a = analyze(s);
  expect(a.issues).toEqual([]);
  expect(a.cases[0]!.persistenceCheckpointStepId).toBe(
    a.cases[0]!.steps[0]!.step.id,
  );
});
it("checks critical writes inside a flow when ordering the persistence checkpoint", () => {
  const s = snapshot(
    [
      {
        id: "checkpoint",
        action: "reload",
        afterAssertions: [
          {
            id: "seen",
            type: "ui",
            target: "name",
            operator: "textEquals",
            expected: "A",
            severity: "BLOCK",
            expectedSource: "REQ",
          },
        ],
      },
      { id: "later", action: "callFlow", versionId: id(3) },
    ],
    [
      flow(3, [
        {
          id: "save",
          action: "click",
          target: "name",
          critical: true,
          observers: [{ id: "save", method: "POST", path: "/" }],
          afterAssertions: [business],
        },
      ]),
    ],
    { kind: "WRITE", persistenceCheckpointStepId: "checkpoint" },
  );
  expect(codes(s)).toContain("MISSING_PERSISTENCE_CHECKPOINT");
});
it("accepts JSON Schema unions for unconstrained expected JSON but rejects ambiguous fill types", () => {
  const f = fixture({
    type: "object",
    properties: { value: { type: ["string", "null"] } },
    required: ["value"],
  });
  expect(
    validate(
      snapshot(
        [
          {
            id: "read",
            action: "reload",
            observers: [{ id: "save", method: "GET", path: "/" }],
            afterAssertions: [{ ...business, expected: "{{vars.value}}" }],
          },
        ],
        [f],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toEqual([]);
  expect(
    codes(
      snapshot(
        [
          {
            id: "fill",
            action: "fill",
            target: "name",
            value: "{{vars.value}}",
          },
        ],
        [f],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toContain("BINDING_TYPE_MISMATCH");
});
it("accepts the server SUITE validation selection and rejects empty or extraneous CASE roots", () => {
  const s = snapshot();
  s.assets.push(
    asset(8, "SUITE", { schemaVersion: "1.0", cases: [{ versionId: id(1) }] }),
  );
  s.validationTarget = {
    resourceId: s.assets[2]!.resourceId,
    versionId: id(8),
    revision: 1,
  };
  expect(validate(rehash(s))).toEqual([]);
  s.entryCaseVersionIds = [];
  expect(codes(rehash(s))).toContain("INVALID_VALIDATION_TARGET");
  s.entryCaseVersionIds = [id(1), id(50)];
  expect(codes(rehash(s))).toContain("INVALID_VALIDATION_TARGET");
});
it("bounds repeated template DAG expansion without throwing", () => {
  const leaf = asset(7, "ASSERTION_TEMPLATE", {
    schemaVersion: "1.0",
    assertions: [
      {
        id: "leaf",
        type: "ui",
        target: "name",
        operator: "visible",
        expected: true,
        severity: "BLOCK",
        expectedSource: "REQ",
      },
    ],
  });
  const templates = [leaf];
  for (let n = 6; n >= 4; n--)
    templates.push(
      asset(n, "ASSERTION_TEMPLATE", {
        schemaVersion: "1.0",
        assertions: Array.from({ length: 20 }, (_, i) => ({
          id: "t" + i,
          type: "template",
          versionId: id(n + 1),
          severity: "BLOCK",
          expectedSource: "REQ",
        })),
      }),
    );
  const s = snapshot(
    [
      {
        id: "check",
        action: "reload",
        afterAssertions: [
          {
            id: "root",
            type: "template",
            versionId: id(4),
            severity: "BLOCK",
            expectedSource: "REQ",
          },
        ],
      },
    ],
    templates,
  );
  expect(codes(s)).toContain("EXPANDED_ASSERTION_LIMIT");
});
it("separates response validation from extraction-dependent assertions in the typed plan", () => {
  const s = snapshot([
    {
      id: "read",
      action: "reload",
      observers: [{ id: "save", method: "GET", path: "/" }],
      extract: [
        {
          source: "response:save",
          pointer: "/id",
          to: "id",
          valueType: "string",
          required: true,
        },
      ],
      afterAssertions: [
        business,
        {
          id: "same",
          type: "responseField",
          source: "response:save",
          pointer: "/id",
          operator: "equals",
          expected: "{{vars.id}}",
          severity: "BLOCK",
          expectedSource: "REQ",
        },
      ],
    },
  ]);
  const step = analyze(s).cases[0]!.steps[0]!;
  expect(step.responseAssertions).toHaveLength(1);
  expect(step.after).toHaveLength(1);
  expect(step.after[0]!.assertion.id).not.toBe(
    step.responseAssertions[0]!.assertion.id,
  );
});
it("matches the server deduplicated CASE selection for suite variants", () => {
  const s = snapshot();
  s.assets.push(
    asset(8, "SUITE", {
      schemaVersion: "1.0",
      cases: [
        { versionId: id(1), browsers: ["chromium"] },
        { versionId: id(1), browsers: ["firefox"] },
      ],
    }),
  );
  s.validationTarget = {
    resourceId: s.assets[2]!.resourceId,
    versionId: id(8),
    revision: 1,
  };
  expect(validate(rehash(s))).toEqual([]);
});
it("resolves local fixture schema references for type flow", () => {
  const f = fixture({
    type: "object",
    properties: { name: { $ref: "#/$defs/name" } },
    required: ["name"],
    $defs: { name: { type: "string" } },
  });
  expect(
    validate(
      snapshot(
        [
          {
            id: "fill",
            action: "fill",
            target: "name",
            value: "{{vars.name}}",
          },
        ],
        [f],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toEqual([]);
});
it("types nested dataset object bindings across every frozen row", () => {
  const d = asset(3, "DATASET", {
    schemaVersion: "1.0",
    columns: { employee: "object" },
    rows: [
      { key: "a", values: { employee: { name: "A" } } },
      { key: "b", values: { employee: { name: "B" } } },
    ],
  });
  expect(
    validate(
      snapshot(
        [
          {
            id: "fill",
            action: "fill",
            target: "name",
            value: "{{data.employee.name}}",
          },
        ],
        [d],
        { datasetVersionId: id(3) },
      ),
    ),
  ).toEqual([]);
});
it("preserves nested literal parameter types through a flow call", () => {
  const f = flow(
    3,
    [
      {
        id: "fill",
        action: "fill",
        target: "name",
        value: "{{data.employee.name}}",
      },
    ],
    { employee: "object" },
  );
  expect(
    validate(
      snapshot(
        [
          {
            id: "call",
            action: "callFlow",
            versionId: id(3),
            parameters: { employee: { name: "A" } },
          },
        ],
        [f],
      ),
    ),
  ).toEqual([]);
});
it("validates nested template observer requirements in the concrete case rather than rejecting the standalone library", () => {
  const leaf = asset(5, "ASSERTION_TEMPLATE", {
    schemaVersion: "1.0",
    assertions: [business],
  });
  const outer = asset(4, "ASSERTION_TEMPLATE", {
    schemaVersion: "1.0",
    assertions: [
      {
        id: "inner",
        type: "template",
        versionId: id(5),
        severity: "BLOCK",
        expectedSource: "API",
      },
    ],
  });
  const s = snapshot(
    [
      {
        id: "read",
        action: "reload",
        observers: [{ id: "save", method: "GET", path: "/" }],
        afterAssertions: [
          {
            id: "outer",
            type: "template",
            versionId: id(4),
            severity: "BLOCK",
            expectedSource: "API",
          },
        ],
      },
    ],
    [outer, leaf],
  );
  expect(validate(s)).toEqual([]);
});
it("accepts exactly500 retained steps and reports the501st including call boundaries", () => {
  const make = (count: number) =>
    snapshot(
      [{ id: "call", action: "callFlow", versionId: id(3) }],
      [
        flow(
          3,
          Array.from({ length: count }, (_, i) => ({
            id: "s" + i,
            action: "reload",
          })),
        ),
      ],
    );
  expect(validate(make(499))).toEqual([]);
  const issue = validate(make(500)).find(
    (i) => i.code === "EXPANDED_STEP_LIMIT",
  );
  expect(issue?.message).toContain("501");
});
it("accepts a declared empty fixture output object when no output variable is used", () =>
  expect(
    validate(
      snapshot(
        undefined,
        [fixture({ type: "object", additionalProperties: false })],
        { fixtureVersionId: id(3) },
      ),
    ),
  ).toEqual([]));
it("rejects standalone flow use before a local extraction while allowing declared caller context requirements", () => {
  const s = snapshot();
  s.assets = [
    flow(3, [
      { id: "fill", action: "fill", target: "name", value: "{{vars.local}}" },
      {
        id: "read",
        action: "reload",
        observers: [{ id: "save", method: "GET", path: "/" }],
        extract: [
          {
            source: "response:save",
            pointer: "/id",
            to: "local",
            valueType: "string",
            required: true,
          },
        ],
      },
    ]),
  ];
  s.entryCaseVersionIds = [];
  s.validationTarget = {
    resourceId: s.assets[0].resourceId,
    versionId: id(3),
    revision: 1,
  };
  expect(codes(rehash(s))).toContain("VARIABLE_USED_BEFORE_DEFINED");
});

function suiteRoot(
  s: AssetSnapshotV1,
  variants: { versionId: string; datasetVersionId?: string }[],
): AssetSnapshotV1 {
  const root = asset(80, "SUITE", { schemaVersion: "1.0", cases: variants });
  s.assets.push(root);
  s.validationTarget = {
    resourceId: root.resourceId,
    versionId: root.versionId,
    revision: 1,
  };
  return rehash(s);
}
const namedDataset = (n: number, type: string, values: unknown[]) =>
  asset(n, "DATASET", {
    schemaVersion: "1.0",
    columns: { name: type },
    rows: values.map((name, i) => ({ key: "row" + i, values: { name } })),
  });
const fillName: StepV1 = {
  id: "fill",
  action: "fill",
  target: "name",
  value: "{{data.name}}",
};
it("I1 rejects an incompatible suite dataset override even when the CASE default is valid", () => {
  const s = suiteRoot(
    snapshot(
      [fillName],
      [namedDataset(3, "string", ["A"]), namedDataset(4, "integer", [42])],
      { datasetVersionId: id(3) },
    ),
    [{ versionId: id(1), datasetVersionId: id(4) }],
  );
  expect(codes(s)).toContain("BINDING_TYPE_MISMATCH");
});
it("I1 validates every effective dataset variant, independently of variant ordering", () => {
  for (const datasetIds of [
    [3, 4],
    [4, 3],
  ]) {
    const s = suiteRoot(
      snapshot(
        [fillName],
        [namedDataset(3, "string", ["A"]), namedDataset(4, "integer", [42])],
        { datasetVersionId: id(3) },
      ),
      datasetIds.map((n) => ({ versionId: id(1), datasetVersionId: id(n) })),
    );
    expect(codes(s)).toContain("BINDING_TYPE_MISMATCH");
  }
});
it("I1 accepts suite-only datasets without weakening standalone CASE binding checks", () => {
  const s = snapshot([fillName], [namedDataset(3, "string", ["A"])]);
  expect(codes(s)).toContain("UNKNOWN_DATA_BINDING");
  const suite = suiteRoot(s, [{ versionId: id(1), datasetVersionId: id(3) }]);
  expect(validate(suite)).toEqual([]);
  expect(analyze(suite).cases).toHaveLength(1);
  const standalone = structuredClone(suite);
  standalone.validationTarget = {
    resourceId: standalone.assets[0].resourceId,
    versionId: id(1),
    revision: 1,
  };
  expect(codes(rehash(standalone))).toContain("UNKNOWN_DATA_BINDING");
});
it("I1 checks nested override properties and missing values across every row", () => {
  const nested: StepV1 = { ...fillName, value: "{{data.name.first}}" };
  const good = namedDataset(3, "object", [{ first: "A" }]);
  for (const [rows, error] of [
    [[{ first: 42 }], "BINDING_TYPE_MISMATCH"],
    [[{ first: "A" }, {}], "POSSIBLY_MISSING_VARIABLE"],
  ] as const) {
    const override = namedDataset(4, "object", [...rows]);
    expect(
      codes(
        suiteRoot(
          snapshot([nested], [good, override], { datasetVersionId: id(3) }),
          [{ versionId: id(1), datasetVersionId: id(4) }],
        ),
      ),
    ).toContain(error);
  }
});
it("I1 applies suite datasets to catalog, flow parameter and template parameter requirements", () => {
  const data = [
    namedDataset(3, "string", ["A"]),
    namedDataset(4, "integer", [42]),
  ];
  const variants = [{ versionId: id(1), datasetVersionId: id(4) }];
  const locator = snapshot(
    [{ id: "click", action: "click", target: "name" }],
    data,
    { datasetVersionId: id(3) },
  );
  locator.assets[1] = asset(2, "ELEMENT_CATALOG", {
    schemaVersion: "1.0",
    elements: [
      {
        key: "name",
        locator: { by: "role", role: "button", name: "{{data.name}}" },
      },
    ],
  });
  expect(codes(suiteRoot(locator, variants))).toContain(
    "BINDING_TYPE_MISMATCH",
  );
  const f = flow(
    5,
    [{ id: "fill", action: "fill", target: "name", value: "{{data.input}}" }],
    { input: "string" },
  );
  expect(
    codes(
      suiteRoot(
        snapshot(
          [
            {
              id: "call",
              action: "callFlow",
              versionId: id(5),
              parameters: { input: "{{data.name}}" },
            },
          ],
          [...data, f],
          { datasetVersionId: id(3) },
        ),
        variants,
      ),
    ),
  ).toContain("BINDING_TYPE_MISMATCH");
  const template = asset(6, "ASSERTION_TEMPLATE", {
    schemaVersion: "1.0",
    parameters: { input: "string" },
    assertions: [
      {
        id: "text",
        type: "ui",
        target: "name",
        operator: "textEquals",
        expected: "{{data.input}}",
        severity: "BLOCK",
        expectedSource: "REQ",
      },
    ],
  });
  expect(
    codes(
      suiteRoot(
        snapshot(
          [
            {
              id: "check",
              action: "reload",
              afterAssertions: [
                {
                  id: "template",
                  type: "template",
                  versionId: id(6),
                  parameters: { input: "{{data.name}}" },
                  severity: "BLOCK",
                  expectedSource: "REQ",
                },
              ],
            },
          ],
          [...data, template],
          { datasetVersionId: id(3) },
        ),
        variants,
      ),
    ),
  ).toContain("BINDING_TYPE_MISMATCH");
});

it.each(["recordKey", "roleName", "ancestor"] as const)(
  "I2 schedules a UI assertion after extraction when its %s depends on the new value",
  (kind) => {
    const observed: StepV1 = {
      id: "read",
      action: "reload",
      observers: [{ id: "read", method: "GET", path: "/" }],
      extract: [
        {
          source: "response:read",
          pointer: "/id",
          to: "id",
          valueType: "string",
          required: true,
        },
      ],
      afterAssertions: [
        {
          id: "status",
          type: "httpStatus",
          source: "response:read",
          operator: "equals",
          expected: 200,
          severity: "BLOCK",
          expectedSource: "API",
        },
        {
          id: "schema",
          type: "responseSchema",
          source: "response:read",
          operator: "matchesSchema",
          expected: { type: "object", description: "{{vars.id}}" },
          severity: "BLOCK",
          expectedSource: "API",
        },
        {
          id: "visible",
          type: "ui",
          target: "name",
          operator: "visible",
          expected: true,
          severity: "BLOCK",
          expectedSource: "REQ",
        },
      ],
    };
    const s = snapshot([observed]);
    s.assets[1] = asset(2, "ELEMENT_CATALOG", {
      schemaVersion: "1.0",
      elements:
        kind === "ancestor"
          ? [
              {
                key: "row",
                locator: { by: "testId", value: "row" },
                recordKey: "{{vars.id}}",
              },
              {
                key: "name",
                scope: "row",
                locator: { by: "testId", value: "name" },
              },
            ]
          : [
              {
                key: "name",
                locator:
                  kind === "roleName"
                    ? { by: "role", role: "button", name: "{{vars.id}}" }
                    : { by: "testId", value: "name" },
                ...(kind === "recordKey" ? { recordKey: "{{vars.id}}" } : {}),
              },
            ],
    });
    const result = analyze(rehash(s));
    expect(result.issues).toEqual([]);
    expect(
      result.cases[0]!.steps[0]!.responseAssertions.map(
        (a) => a.assertion.type,
      ),
    ).toEqual(["httpStatus", "responseSchema"]);
    expect(
      result.cases[0]!.steps[0]!.after.map((a) => a.assertion.type),
    ).toEqual(["ui"]);
  },
);
it("I2 includes template parameter scopes in a locator extraction dependency", () => {
  const template = asset(6, "ASSERTION_TEMPLATE", {
    schemaVersion: "1.0",
    parameters: { row: "string" },
    assertions: [
      {
        id: "visible",
        type: "ui",
        target: "name",
        operator: "visible",
        expected: true,
        severity: "BLOCK",
        expectedSource: "REQ",
      },
    ],
  });
  const s = snapshot(
    [
      {
        id: "read",
        action: "reload",
        observers: [{ id: "read", method: "GET", path: "/" }],
        extract: [
          {
            source: "response:read",
            pointer: "/id",
            to: "id",
            valueType: "string",
            required: true,
          },
        ],
        afterAssertions: [
          {
            id: "use",
            type: "template",
            versionId: id(6),
            parameters: { row: "{{vars.id}}" },
            severity: "BLOCK",
            expectedSource: "REQ",
          },
        ],
      },
    ],
    [template],
  );
  s.assets[1] = asset(2, "ELEMENT_CATALOG", {
    schemaVersion: "1.0",
    elements: [
      {
        key: "name",
        recordKey: "{{data.row}}",
        locator: { by: "testId", value: "name" },
      },
    ],
  });
  const result = analyze(rehash(s));
  expect(result.issues).toEqual([]);
  expect(result.cases[0]!.steps[0]!.responseAssertions).toEqual([]);
  expect(result.cases[0]!.steps[0]!.after).toHaveLength(1);
});
it.each([
  ["integer", 42],
  ["object", { a: 1 }],
  ["array", [1]],
] as const)("I4 rejects a full-placeholder %s HTTP header", (type, value) => {
  const s = snapshot(
    [
      {
        id: "request",
        action: "apiRequest",
        method: "GET",
        path: "/",
        headers: { "X-Test": "{{data.name}}" },
      },
    ],
    [namedDataset(3, type, [value])],
    { datasetVersionId: id(3) },
  );
  expect(codes(s)).toContain("BINDING_TYPE_MISMATCH");
});
it.each([
  ["integer", 42],
  ["boolean", true],
  ["string", "text"],
] as const)(
  "I4 accepts embedded %s HTTP header interpolation",
  (type, value) => {
    const s = snapshot(
      [
        {
          id: "request",
          action: "apiRequest",
          method: "GET",
          path: "/",
          headers: { "X-Test": "prefix-{{data.name}}" },
        },
      ],
      [namedDataset(3, type, [value])],
      { datasetVersionId: id(3) },
    );
    expect(validate(s)).toEqual([]);
  },
);
it("I4 enforces string headers inside a pinned flow", () => {
  const f = flow(
    3,
    [
      {
        id: "request",
        action: "apiRequest",
        method: "GET",
        path: "/",
        headers: { "X-Test": "{{data.value}}" },
      },
    ],
    { value: "integer" },
  );
  expect(
    codes(
      snapshot(
        [
          {
            id: "call",
            action: "callFlow",
            versionId: id(3),
            parameters: { value: 42 },
          },
        ],
        [f],
      ),
    ),
  ).toContain("BINDING_TYPE_MISMATCH");
});
it("I4 leaves business JSON fields named headers as JSON rather than treating them as HTTP headers", () => {
  const s = snapshot(
    [
      {
        id: "request",
        action: "apiRequest",
        method: "POST",
        path: "/",
        body: { headers: { value: "{{data.name}}" } },
      },
    ],
    [namedDataset(3, "integer", [42])],
    { datasetVersionId: id(3) },
  );
  expect(validate(s)).toEqual([]);
});
