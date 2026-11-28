import assert from "node:assert/strict";
import { test } from "node:test";
import { validateCaseSchema, type ElementCatalogV1 } from "@veriq/contracts";
import {
    applyRecordingEvent,
    buildCaseDraft,
    confirmTarget,
    copyRecordingDraft,
    listRecordingDrafts,
    newRecordingDraft,
    storeRecordingDraft,
} from "../src/renderer/recording/draft-model";

const firstVersion = "6091645d-c261-4042-bad0-2229628e9078";
const secondVersion = "7297ef3b-b010-442c-8aab-6aef90f50e16";
const locator = { by: "veriqId", value: "submit" } as const;
const document: ElementCatalogV1 = {
    schemaVersion: "1.0",
    elements: [{ key: "submitButton", locator: { by: "role", role: "button", name: "Submit", exact: true } }],
};

test("an ambiguous recorded locator remains editable and a catalog revision requires reconfirmation", () => {
    const draft = {
        ...newRecordingDraft(),
        title: "Submit",
        roleKey: "operator",
        catalogVersionId: firstVersion,
    };
    const captured = applyRecordingEvent(draft, {
        sessionId: "session",
        navigation: 1,
        id: "click_1",
        type: "click",
        candidates: [{ locator, matches: 2 }],
    });
    assert.equal(captured.steps.length, 1);
    assert.equal(
        buildCaseDraft(captured, { versionId: firstVersion, document }, validateCaseSchema).content,
        undefined,
    );
    assert.equal(
        buildCaseDraft(captured, { versionId: firstVersion, document }, validateCaseSchema).diagnostics[0]?.code,
        "AMBIGUOUS_LOCATOR",
    );
    const confirmed = confirmTarget(captured, "step_click_1", firstVersion, "submitButton");
    assert.equal(
        buildCaseDraft(confirmed, { versionId: firstVersion, document }, validateCaseSchema).content?.document.steps[0]
            ?.action,
        "click",
    );
    const switched = { ...confirmed, catalogVersionId: secondVersion };
    assert.equal(
        buildCaseDraft(switched, { versionId: secondVersion, document }, validateCaseSchema).diagnostics[0]?.code,
        "CATALOG_CHANGED",
    );
    const restored = confirmTarget(switched, "step_click_1", secondVersion, "submitButton");
    assert.equal(
        buildCaseDraft(restored, { versionId: secondVersion, document }, validateCaseSchema).content?.document
            .catalogVersionId,
        secondVersion,
    );
});

test("navigation after a recorded click does not add a duplicate execution action", () => {
    const draft = newRecordingDraft();
    const click = {
        sessionId: "session",
        navigation: 1,
        id: "click_1",
        type: "click",
        candidates: [{ locator, matches: 1 }],
    } as const;
    const recorded = applyRecordingEvent(draft, { ...click, candidates: [...click.candidates] });
    const next = applyRecordingEvent(recorded, {
        sessionId: "session",
        navigation: 2,
        id: "nav_2",
        type: "navigation",
        path: "/done",
    });
    assert.equal(next, recorded);
    assert.equal(next.steps.length, 1);
});

test("the ordered preparation and cleanup phases export using the existing Step schema", () => {
    const makeStep = (id: string) => ({ step: { id, action: "goto", path: "/" } }) as const;
    const draft = {
        ...newRecordingDraft(),
        title: "Trial case",
        roleKey: "operator",
        catalogVersionId: firstVersion,
        prepare: [makeStep("prepare")],
        steps: [makeStep("action"), { ...makeStep("disabled"), disabled: true }],
        SUCCESS: [makeStep("success")],
        FAILURE: [makeStep("failure")],
        CANCELLED: [makeStep("cancel")],
    };
    const result = buildCaseDraft(draft, { versionId: firstVersion, document }, validateCaseSchema);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
        result.content?.document.steps.map(({ id }) => id),
        ["action"],
    );
    assert.deepEqual(
        result.content?.document.lifecycle?.prepare?.map(({ id }) => id),
        ["prepare"],
    );
    assert.deepEqual(
        result.content?.document.lifecycle?.cleanup?.map(({ on, steps }) => [on, steps[0]?.id]),
        [
            ["SUCCESS", "success"],
            ["FAILURE", "failure"],
            ["CANCELLED", "cancel"],
        ],
    );
});

test("a standalone toolbar navigation becomes one goto action", () => {
    const draft = newRecordingDraft();
    const event = {
        sessionId: "session",
        navigation: 2,
        id: "nav_2",
        type: "navigation",
        path: "/settings",
        cause: "explicit",
    } as const;
    const recorded = applyRecordingEvent(draft, event);
    assert.deepEqual(
        recorded.steps.map(({ step }) => step),
        [{ id: "step_nav_2", action: "goto", path: "/settings" }],
    );
    assert.equal(applyRecordingEvent(recorded, event), recorded);
});

test("local draft recovery is isolated by origin, account and workspace", () => {
    const backing = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return backing.size;
        },
        key: (index) => [...backing.keys()][index] ?? null,
        getItem: (key) => backing.get(key) ?? null,
        setItem: (key, value) => {
            backing.set(key, value);
        },
        removeItem: (key) => {
            backing.delete(key);
        },
        clear: () => backing.clear(),
    };
    const draft = { ...newRecordingDraft(), title: "Original", existing: { resourceId: "cloud", revision: 2 } };
    const scope = JSON.stringify(["https://platform.example", "account", "space"]);
    storeRecordingDraft(storage, scope, draft);
    for (const mismatch of [
        ["https://second.example", "account", "space"],
        ["https://platform.example", "another", "space"],
        ["https://platform.example", "account", "elsewhere"],
    ])
        assert.deepEqual(listRecordingDrafts(storage, JSON.stringify(mismatch)), []);
    const copy = copyRecordingDraft(draft);
    storeRecordingDraft(storage, scope, copy);
    assert.notEqual(copy.id, draft.id);
    assert.equal(copy.existing, undefined);
    assert.deepEqual(
        listRecordingDrafts(storage, scope).map(({ id, existing }) => [id, existing?.revision]),
        [
            [draft.id, 2],
            [copy.id, undefined],
        ],
    );
});

test("an initial approved page is replayed before a click and added only once", () => {
    const draft = newRecordingDraft();
    const initial = {
        sessionId: "session",
        navigation: 0,
        id: "initial",
        type: "navigation",
        path: "/",
        cause: "initial",
    } as const;
    const ready = applyRecordingEvent(draft, initial);
    assert.equal(applyRecordingEvent(ready, { ...initial, id: "repeated" }), ready);
    const clicked = applyRecordingEvent(ready, {
        sessionId: "session",
        navigation: 0,
        id: "click",
        type: "click",
        candidates: [{ locator, matches: 1 }],
    });
    assert.deepEqual(
        clicked.steps.map(({ step }) => step.action),
        ["goto", "click"],
    );
});

test("recording keeps the query, fragment and committed field value in action order", () => {
    const event = { sessionId: "session", navigation: 1 };
    const path = "/search?q=杭州#tomorrow";
    const start = applyRecordingEvent(newRecordingDraft(), {
        ...event,
        type: "navigation",
        cause: "explicit",
        id: "open",
        path,
    });
    const edit = applyRecordingEvent(start, {
        ...event,
        type: "fill",
        id: "edit",
        candidates: [],
        value: "杭州明天的天气",
    });
    assert.deepEqual(
        edit.steps.map(({ step }) => step),
        [
            { id: "step_open", action: "goto", path },
            { id: "step_edit", action: "fill", value: "杭州明天的天气", target: "" },
        ],
    );
});
