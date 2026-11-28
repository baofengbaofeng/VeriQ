import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";

test("Chromium extracts the selected visible rows and rejects ambiguous or oversized data", async () => {
    const browser = await chromium.launch({
        executablePath: process.env.VERIQ_TEST_CHROMIUM ?? chromium.executablePath(),
    });
    try {
        const page = await browser.newPage();
        await page.setContent(`
            <table id="cities"><tr><th>City</th><th>Code</th></tr>
            <tr><td>Hang<span>zhou</span> <b hidden>private</b></td><td>0571</td></tr>
            <tr hidden><td>private</td><td>private</td></tr>
            <tr><td>New<br>York</td><td><input value="private">NY</td></tr></table>
            <ul id="cities-list"><li id="item">One<span aria-hidden="true">private</span>
                <span style="opacity:0">private</span><span style="visibility:hidden">private</span>
                <span style="color:transparent">private</span><span style="-webkit-text-security:disc">private</span>
                <script type="text/plain">private</script><textarea>private</textarea>
                <ul><li id="nested">Two</li></ul></li><li hidden>private</li><li>Three</li></ul>
            <table id="no-header"><tr><td>First</td><td>Second</td></tr></table>
            <table id="editable-row"><tr contenteditable="true"><td>private</td></tr><tr><td>public</td></tr></table>
            <ul id="clipped"><li>One<span style="display:block;height:0;overflow:hidden">private</span></li></ul>
            <table id="span"><tr><td colspan="2">Joined</td></tr></table>
            <table id="unequal"><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>
            <ol id="long"><li>${"a".repeat(257)}</li></ol>
            <ol id="too-many">${"<li>A</li>".repeat(201)}</ol>
            <table id="wide"><tr>${"<td>A</td>".repeat(13)}</tr></table>
            <form><input type="password"><ul id="credentials"><li>private</li></ul></form>
            <ul><li><a href="#"><b id="link-child">open</b></a><input id="field"></li></ul>
        `);
        const source = await readFile(new URL("../../src/preload/annotation-table.ts", import.meta.url), "utf8");
        const encoded = Buffer.from(stripTypeScriptTypes(source)).toString("base64");
        const url = `data:text/javascript;base64,${encoded}`;
        const cases = [
            "#cities td",
            "#item",
            "#nested",
            "#no-header",
            "#editable-row",
            "#clipped",
            "#cities tr[hidden] td",
            "#span",
            "#unequal",
            "#long",
            "#too-many",
            "#wide",
            "#credentials",
            "#link-child",
            "#field",
        ];
        const actual = await page.evaluate(
            async ({ url, cases }) => {
                const { findDataElement, readDataElement } = await import(url);
                return Object.fromEntries(
                    cases.map((selector) => {
                        const target = document.querySelector(selector);
                        if (!target) throw new Error(`Missing fixture element ${selector}`);
                        const data = findDataElement(target);
                        return [selector, data ? readDataElement(data) : null];
                    }),
                );
            },
            { url, cases },
        );
        assert.deepEqual(actual["#cities td"], {
            columns: ["City", "Code"],
            rows: [
                ["Hangzhou", "0571"],
                ["New York", "NY"],
            ],
        });
        assert.deepEqual(actual["#item"], { columns: ["value"], rows: [["One"], ["Three"]] });
        assert.deepEqual(actual["#nested"], { columns: ["value"], rows: [["Two"]] });
        assert.deepEqual(actual["#no-header"], {
            columns: ["column1", "column2"],
            rows: [["First", "Second"]],
        });
        assert.deepEqual(actual["#editable-row"], { columns: ["column1"], rows: [[""], ["public"]] });
        assert.deepEqual(actual["#clipped"], { columns: ["value"], rows: [["One"]] });
        for (const selector of cases.slice(6)) assert.equal(actual[selector], null, selector);
    } finally {
        await browser.close();
    }
});
