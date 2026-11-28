import assert from "node:assert/strict";
import test from "node:test";
import { RecordingSession, recordingTarget } from "../src/main/recording-session.ts";

test("test_old_navigation_event_is_discarded", () => {
    const frame = {};
    const session = new RecordingSession(17);
    session.setMode("record");
    const sender = { contentsId: 17, frame };
    const event = {
        sessionId: session.id,
        navigation: 1,
        generation: 1,
        candidates: [{ locator: { by: "veriqId", value: "save" }, matches: 1 }],
    };
    session.finishNavigation(frame);
    assert.equal(session.acceptEvent(sender, event)?.type, "click");
    session.beginNavigation();
    assert.equal(session.acceptEvent(sender, event), undefined);
    session.finishNavigation(frame);
    assert.equal(session.acceptEvent(sender, event), undefined);
    assert.equal(session.acceptEvent(sender, { ...event, navigation: 2 })?.navigation, 2);
});

test("rejects another view, a subframe, oversized events and inactive sessions", () => {
    const frame = {};
    const session = new RecordingSession(17);
    session.finishNavigation(frame);
    session.setMode("annotate");
    const sender = { contentsId: 17, frame };
    const event = { sessionId: session.id, navigation: 1, generation: 1, candidates: [] };
    assert.equal(session.acceptEvent({ ...sender, contentsId: 16 }, event), undefined);
    assert.equal(session.acceptEvent({ ...sender, frame: {} }, event), undefined);
    assert.equal(session.acceptEvent(sender, { ...event, contents: "x".repeat(17000) }), undefined);
    const ack = { sessionId: session.id, navigation: 1, generation: 1 };
    assert.equal(session.acceptsArm(sender, ack), true);
    assert.equal(session.acceptsArm({ ...sender, frame: {} }, ack), false);
    assert.equal(session.acceptEvent(sender, event), undefined);
    session.setMode("paused");
    assert.equal(session.acceptEvent(sender, event), undefined);
    session.setMode("annotate");
    assert.equal(session.acceptsArm(sender, ack), false);
    assert.equal(session.acceptEvent(sender, event), undefined);
    session.close();
    session.setMode("record");
    assert.equal(session.acceptEvent(sender, event), undefined);
});

test("navigation accepts only HTTP(S) URLs on the published environment's approved origins", () => {
    const base = "https://app.example/app";
    const origins = [base, "https://auth.example/"];
    assert.equal(recordingTarget(base, origins, "/page").href, "https://app.example/page");
    assert.equal(recordingTarget(base, origins, "https://auth.example/login").origin, "https://auth.example");
    for (const input of [
        "//outside.example",
        "https://outside.example",
        "file:///tmp/private",
        "https://name@app.example",
        "/a\\b",
    ]) {
        assert.throws(() => recordingTarget(base, origins, input), /RECORDING_TARGET_DENIED/);
    }
});

test("a committed text edit belongs to the armed recording frame only", () => {
    const session = new RecordingSession(18);
    const frame = {};
    session.setMode("record");
    session.finishNavigation(frame);
    const sender = { contentsId: 18, frame };
    const edit = {
        sessionId: session.id,
        navigation: 1,
        generation: 1,
        candidates: [{ locator: { by: "role", role: "textbox" }, matches: 1 }],
        value: "杭州明天的天气",
    };
    assert.equal(session.acceptEvent(sender, edit)?.type, "fill");
    assert.equal(session.acceptEvent(sender, { ...edit, value: "x".repeat(4097) }), undefined);
    assert.equal(session.acceptEvent({ ...sender, frame: {} }, edit), undefined);
    session.setMode("annotate");
    assert.equal(session.acceptEvent(sender, { ...edit, generation: 2 }), undefined);
});

test("an annotation offers actions for its target and reads options only after capture was selected", () => {
    const session = new RecordingSession(18);
    const sender = { contentsId: 18, frame: {} };
    session.setMode("annotate");
    session.finishNavigation(sender.frame);
    const arm = { sessionId: session.id, navigation: 1, generation: 1 };
    const candidates = [{ locator: { by: "veriqId", value: "city" }, matches: 1 }];
    const target = { ...arm, type: "annotation-target", requestId: 1, kind: "select", candidates };
    const options = [{ label: "杭州", value: "hgh" }];
    const reply = { ...arm, type: "annotation-options", requestId: 1, captureId: "unrequested", options };

    assert.equal(session.acceptEvent(sender, reply), undefined);
    const selected = session.acceptEvent(sender, target);
    assert.ok(selected?.type === "annotation-target");
    assert.deepEqual(selected.actions, ["catalog", "click", "captureOptions", "bindColumn"]);
    assert.equal(session.chooseAnnotation(selected.id, "fill"), undefined);
    const binding = session.chooseAnnotation(selected.id, "bindColumn");
    assert.ok(binding?.type === "annotation-action");
    assert.equal(binding.action, "bindColumn");
    assert.equal(binding.targetId, selected.id);
    assert.deepEqual(binding.candidates, candidates);
    assert.equal("options" in binding, false);
    assert.equal(session.acceptEvent(sender, reply), undefined);

    const catalog = session.chooseAnnotation(selected.id, "catalog");
    assert.ok(catalog?.type === "annotation-action");
    const capture = session.chooseAnnotation(selected.id, "captureOptions");
    assert.ok(capture?.type === "read-options");
    assert.equal(session.acceptEvent(sender, reply), undefined);
    reply.captureId = capture.captureId;
    assert.equal(session.acceptEvent({ ...sender, frame: {} }, reply), undefined);
    assert.equal(session.acceptEvent(sender, { ...reply, requestId: 2 }), undefined);
    const captured = session.acceptEvent(sender, reply);
    assert.ok(captured?.type === "annotation-action");
    assert.deepEqual(captured.options, options);
    assert.equal(captured.action, "captureOptions");
    assert.equal(captured.targetId, selected.id);
    assert.equal(session.acceptEvent(sender, reply), undefined);
});

test("replaced targets, stale documents and invalid option payloads cannot create annotation steps", () => {
    const session = new RecordingSession(23);
    const sender = { contentsId: 23, frame: {} };
    session.setMode("annotate");
    session.finishNavigation(sender.frame);
    const arm = { sessionId: session.id, navigation: 1, generation: 1 };
    const target = { ...arm, type: "annotation-target", requestId: 2, kind: "text", candidates: [] };
    assert.equal(session.acceptEvent(sender, { ...target, options: [] }), undefined);
    const text = session.acceptEvent(sender, target);
    assert.ok(text?.type === "annotation-target");
    assert.deepEqual(text.actions, ["catalog", "click", "fill"]);
    const firstFill = session.chooseAnnotation(text.id, "fill");
    const secondFill = session.chooseAnnotation(text.id, "fill");
    assert.ok(firstFill?.type === "annotation-action" && secondFill?.type === "annotation-action");
    assert.notEqual(firstFill.id, secondFill.id);

    const generic = session.acceptEvent(sender, { ...target, kind: "generic" });
    assert.ok(generic?.type === "annotation-target");
    assert.equal(session.chooseAnnotation(text.id, "fill"), undefined);
    assert.deepEqual(generic.actions, ["catalog", "click"]);
    session.beginNavigation();
    session.finishNavigation(sender.frame);
    assert.equal(session.chooseAnnotation(generic.id, "click"), undefined);

    const select = session.acceptEvent(sender, { ...target, navigation: 2, kind: "select" });
    assert.ok(select?.type === "annotation-target");
    const capture = session.chooseAnnotation(select.id, "captureOptions");
    assert.ok(capture?.type === "read-options");
    const reply = { ...arm, navigation: 2, type: "annotation-options", requestId: 2, captureId: capture.captureId };
    const entry = { label: "杭州", value: "hgh" };
    for (const options of [
        Array(201).fill(entry),
        [{ ...entry, label: "x".repeat(257) }],
        [{ ...entry, secret: "x" }],
    ]) {
        assert.equal(session.acceptEvent(sender, { ...reply, options }), undefined);
    }
    session.setMode("paused");
    session.setMode("annotate");
    assert.equal(session.acceptEvent(sender, { ...reply, options: [entry] }), undefined);
});

test("extracts only the requested bounded table and rejects options replies for a table capture", () => {
    const session = new RecordingSession(31);
    const sender = { contentsId: 31, frame: {} };
    session.setMode("annotate");
    session.finishNavigation(sender.frame);
    const arm = { sessionId: session.id, navigation: 1, generation: 1 };
    const target = { ...arm, type: "annotation-target", requestId: 1, kind: "table", candidates: [] };
    const table = { columns: ["名称", "数量"], rows: [["样品", "5"]] };
    const picked = session.acceptEvent(sender, target);
    assert.ok(picked?.type === "annotation-target");
    assert.deepEqual(picked.actions, ["catalog", "click", "extractData"]);
    assert.equal("table" in picked, false);
    const request = session.chooseAnnotation(picked.id, "extractData");
    assert.ok(request?.type === "read-table");
    const reply = { ...arm, requestId: 1, captureId: request.captureId, type: "annotation-table", table };
    assert.equal(
        session.acceptEvent(sender, {
            ...arm,
            requestId: 1,
            captureId: request.captureId,
            type: "annotation-options",
            options: [{ label: "A", value: "a" }],
        }),
        undefined,
    );
    for (const invalid of [
        { columns: [], rows: [[]] },
        { columns: Array(13).fill("A"), rows: [Array(13).fill("B")] },
        { ...table, rows: [] },
        { ...table, rows: Array(201).fill(["a", "b"]) },
        { ...table, rows: [["x"]] },
        { ...table, rows: [["x", "a".repeat(257)]] },
        { ...table, hidden: "unexpected" },
    ])
        assert.equal(session.acceptEvent(sender, { ...reply, table: invalid }), undefined);
    const result = session.acceptEvent(sender, reply);
    assert.ok(result?.type === "annotation-action");
    assert.deepEqual(result.table, table);
    assert.equal(result.targetId, picked.id);
    assert.equal(result.action, "extractData");
    const second = session.chooseAnnotation(picked.id, "extractData");
    assert.ok(second?.type === "read-table");
    assert.equal(session.acceptEvent(sender, reply), undefined);
    const list = session.acceptEvent(sender, { ...target, kind: "list", requestId: 2 });
    assert.ok(list?.type === "annotation-target" && list.actions.includes("extractData"));
    assert.equal(session.acceptEvent(sender, { ...reply, captureId: second.captureId }), undefined);
});
