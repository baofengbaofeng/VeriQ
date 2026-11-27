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
    assert.equal(session.acceptEvent(sender, event)?.type, "annotation");
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
