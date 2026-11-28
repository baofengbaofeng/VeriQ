import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { _electron } from "playwright-core";
import electronPath from "electron";
import { build } from "vite";
import { RecordingSession } from "../../src/main/recording-session.ts";
import type { RecordingDraft } from "../../src/renderer/recording/draft-model.ts";
import type { RecordingEvent } from "../../src/shared/recording.ts";

test(
    "trusted edits from the isolated recording preload read only declared business values",
    { timeout: 60000 },
    async () => {
        const directory = await mkdtemp(join(tmpdir(), "veriq-recording-"));
        try {
            await build({
                configFile: false,
                logLevel: "silent",
                build: {
                    outDir: directory,
                    emptyOutDir: false,
                    lib: {
                        entry: resolve("src/preload/recording.ts"),
                        formats: ["cjs"],
                        fileName: () => "recording.cjs",
                    },
                    rollupOptions: { external: ["electron"] },
                },
            });
            await build({
                configFile: false,
                logLevel: "silent",
                esbuild: { jsx: "automatic" },
                define: { "process.env.NODE_ENV": JSON.stringify("production") },
                build: {
                    outDir: directory,
                    emptyOutDir: false,
                    rollupOptions: { output: { inlineDynamicImports: true } },
                    lib: {
                        entry: resolve("tests/native/recording-editor.tsx"),
                        formats: ["iife"],
                        name: "recordingEditor",
                        fileName: () => "draft.js",
                    },
                },
            });
            await writeFile(
                join(directory, "inputs.html"),
                `
            <script src="draft.js"></script>
            <input id="ordinary" veriq-id="ordinary" veriq-record-value="public">
            <textarea id="unmarked" veriq-id="unmarked"></textarea>
            <input id="typo" veriq-id="typo" veriq-record-value="Public">
            <input id="pin" veriq-record-value="public">
            <input id="other" placeholder="Passcode" veriq-record-value="public">
            <label for="labelled">验证码</label><input id="labelled" veriq-record-value="public">
            <span id="caption">Access token</span>
            <input id="referenced" aria-labelledby="caption" veriq-record-value="public">
            <form id="auth"><input id="box" veriq-record-value="public"></form>
            <input id="pw" type="password" form="auth" veriq-record-value="public">
            <input id="named" name="userName" veriq-record-value="public">
            <span id="help">Recovery code</span>
            <input id="described" aria-describedby="help" veriq-record-value="public">
            <form><input id="clobbered" veriq-record-value="public">
                <input name="elements"><input type="password"></form>
            <label for="imageOnly"><img alt="PIN"></label>
            <input id="imageOnly" veriq-record-value="public">
            <label for="mixedLabel">Pass<span title="hint"></span>code</label>
            <input id="mixedLabel" veriq-record-value="public">
            <span id="ariaName" aria-label="Passcode"></span>
            <input id="fromAria" aria-labelledby="ariaName" veriq-record-value="public">
            <h2 id="heading">Sign in</h2>
            <form aria-labelledby="heading"><input id="fromForm" veriq-record-value="public"></form>
            <datalist id="cities"><option value="Hangzhou"></option></datalist>
            <input id="written" veriq-id="written" list="cities" veriq-record-value="public">
            <input id="suggest" veriq-id="suggest" list="cities">
            <select id="choice" veriq-record-value="public"><option>One</option><option>Two</option></select>
            <input id="toggle" veriq-id="toggle"><input id="scripted" veriq-record-value="public">
        `,
            );
            const app = await _electron.launch({
                executablePath: String(electronPath),
                args: [resolve("tests/native/recording-app.cjs"), directory],
                chromiumSandbox: true,
            });
            try {
                const page = await app.firstWindow();
                await app.evaluate(() => Reflect.get(globalThis, "recordingArmed"));
                await app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScriptInIsolatedWorld(999, [
                        {
                            code: `
                    globalThis.readIds = [];
                    for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
                        const desc = Object.getOwnPropertyDescriptor(proto, "value");
                        Object.defineProperty(proto, "value", { ...desc, get() {
                            globalThis.readIds.push(this.id);
                            return desc.get.call(this);
                        } });
                    }
                    void 0;
                `,
                        },
                    ]),
                );
                const privateValue = "synthetic-private-marker";
                for (const id of [
                    "ordinary",
                    "unmarked",
                    "typo",
                    "pin",
                    "other",
                    "labelled",
                    "referenced",
                    "box",
                    "pw",
                    "named",
                    "described",
                    "clobbered",
                    "imageOnly",
                    "mixedLabel",
                    "fromAria",
                    "fromForm",
                    "toggle",
                    "written",
                    "suggest",
                ]) {
                    await page.locator(`#${id}`).focus();
                    await page.keyboard.insertText(id === "ordinary" || id === "written" ? "city" : privateValue);
                    if (id === "toggle")
                        await page.locator("#toggle").evaluate((el) => el.setAttribute("veriq-record-value", "public"));
                    await page.keyboard.press("Tab");
                }
                await page.locator("#choice").press("ArrowDown");
                await page.locator("#choice").press("Tab");
                await page.locator("#scripted").evaluate((el) => {
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    el.dispatchEvent(new Event("change", { bubbles: true }));
                });
                const reads = await app.evaluate(({ BrowserWindow }) =>
                    BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScriptInIsolatedWorld(999, [
                        { code: "globalThis.readIds" },
                    ]),
                );
                assert.deepEqual([...new Set(reads)], ["ordinary", "written"]);
                const edits = await app.evaluate(() => Reflect.get(globalThis, "recordedEdits"));
                assert.equal(JSON.stringify(edits).includes(privateValue), false);
                const session = new RecordingSession(1);
                const sender = { frame: {}, contentsId: 1 };
                session.finishNavigation(sender.frame);
                session.setMode("record");
                const events: RecordingEvent[] = [];
                for (const edit of edits) {
                    const event = session.acceptEvent(sender, { ...edit, sessionId: session.id });
                    assert.ok(event);
                    events.push(event);
                }
                await page.evaluate((events) => Reflect.get(window, "recordingEditor").openEditor(events), events);
                const steps = page.locator("details.recording-step");
                await steps.nth(5).waitFor();
                const restored = await page.evaluate(() => {
                    const key = Object.keys(localStorage).find((key) => key.startsWith("veriq:recording:1:fixture:"));
                    return key ? localStorage.getItem(key) : null;
                });
                assert.ok(restored);
                assert.equal(restored.includes(privateValue), false);
                const draft: RecordingDraft = JSON.parse(restored);
                assert.deepEqual(
                    draft.steps.map(({ step }) => ("value" in step ? step.value : step.action)),
                    ["city", "fill", "fill", "fill", "city", "fill"],
                );
                assert.equal(await page.locator("output").textContent(), "pending");
                for (const index of [1, 2, 3, 5]) {
                    const step = steps.nth(index);
                    await step.locator("summary").click();
                    if (index === 1) {
                        await step.getByLabel(/备注|Note/).fill("reviewed");
                        assert.match(await step.locator("summary").innerText(), /Business value required/);
                        await step
                            .getByRole("textbox", { name: /值|Value/ })
                            .first()
                            .fill("test city");
                    } else if (index === 2 || index === 5) {
                        await step.getByRole("button", { name: /Use empty string/ }).click();
                    } else {
                        await step.getByRole("combobox", { name: /从冻结字段绑定|Bind frozen data field/ }).click();
                        await page.getByRole("option", { name: "{{data.city}}" }).click();
                    }
                    assert.doesNotMatch(await step.locator("summary").innerText(), /Business value required/);
                }
                const exported: { value: string }[] = JSON.parse(await page.locator("output").innerText());
                assert.deepEqual(
                    exported.map((step) => step.value),
                    ["city", "test city", "", "{{data.city}}", "city", ""],
                );
            } finally {
                await app.close();
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    },
);
