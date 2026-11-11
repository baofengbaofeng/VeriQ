import { it, expect } from "vitest";
import { validateSchema } from "@veriq/contracts";
import { analyze } from "../../compiler/src/index.js";
import { snapshot } from "../../compiler/tests/helpers.js";
it.each([
  {
    id: "dialog",
    kind: "dialog",
    dialogType: "prompt",
    message: "Name?",
    handling: "accept",
    promptText: "{{data.name}}",
  },
  { id: "popup", kind: "newPage", pageKey: "detail" },
  { id: "download", kind: "download" },
])("accepts canonical event $kind", (value) =>
  expect(validateSchema("ObserverV1", value)).toEqual([]),
);
it.each([
  {
    id: "dialog",
    kind: "dialog",
    dialogType: "alert",
    message: "Name?",
    handling: "accept",
    promptText: "bad",
  },
  {
    id: "dialog",
    kind: "dialog",
    dialogType: "prompt",
    message: "Name?",
    handling: "dismiss",
    promptText: "bad",
  },
  { id: "download", kind: "download", path: "../../escape" },
])("rejects incoherent event $kind", (value) =>
  expect(validateSchema("ObserverV1", value).length).toBeGreaterThan(0),
);
it("compiles ordered explicit page selection while rejecting use before capture and duplicate keys", () => {
  const capture = {
    id: "popup",
    action: "click",
    target: "name",
    observers: [{ id: "popup", kind: "newPage", pageKey: "detail" }],
  };
  const use = { id: "use", action: "goto", path: "/", pageKey: "detail" };
  expect(analyze(snapshot([capture, use] as never)).issues).toEqual([]);
  expect(
    analyze(snapshot([use, capture] as never)).issues.some(
      (x) => x.code === "UNKNOWN_PAGE_KEY",
    ),
  ).toBe(true);
  expect(
    analyze(
      snapshot([capture, { ...capture, id: "duplicate" }] as never),
    ).issues.some((x) => x.code === "DUPLICATE_PAGE_KEY"),
  ).toBe(true);
});
it("rejects event observers as response/assertion and extraction sources", () => {
  const event = { id: "popup", kind: "newPage", pageKey: "detail" };
  const response = {
    id: "status",
    type: "httpStatus",
    source: "response:popup",
    operator: "equals",
    expected: 200,
    severity: "BLOCK",
    expectedSource: "REQ",
  };
  for (const fields of [
    { afterAssertions: [response] },
    {
      extract: [
        {
          source: "response:popup",
          pointer: "/id",
          to: "id",
          valueType: "string",
          required: true,
        },
      ],
    },
  ])
    expect(
      analyze(
        snapshot([
          {
            id: "open",
            action: "click",
            target: "name",
            observers: [event],
            ...fields,
          },
        ] as never),
      ).issues.some((x) => x.code === "UNKNOWN_OBSERVER"),
    ).toBe(true);
});
it("scopes flow page declarations locally while wrapper page declarations are visible to children and later caller steps", async () => {
  const { asset, id } = await import("../../compiler/tests/helpers.js");
  const flow = asset(3, "FLOW", {
    schemaVersion: "1.0",
    parameters: {},
    steps: [
      {
        id: "use",
        action: "fill",
        target: "name",
        value: "child",
        pageKey: "wrapper",
      },
      {
        id: "open",
        action: "click",
        target: "name",
        observers: [{ id: "local", kind: "newPage", pageKey: "local" }],
      },
      { id: "localUse", action: "goto", path: "/", pageKey: "local" },
    ],
  });
  const wrapper = {
    id: "flow",
    action: "callFlow",
    versionId: id(3),
    observers: [{ id: "wrapper", kind: "newPage", pageKey: "wrapper" }],
  };
  expect(
    analyze(
      snapshot(
        [
          wrapper,
          { id: "use", action: "goto", path: "/", pageKey: "wrapper" },
        ] as never,
        [flow],
      ),
    ).issues,
  ).toEqual([]);
  expect(
    analyze(
      snapshot(
        [
          wrapper,
          { id: "use", action: "goto", path: "/", pageKey: "local" },
        ] as never,
        [flow],
      ),
    ).issues.some((x) => x.code === "UNKNOWN_PAGE_KEY"),
  ).toBe(true);
});
