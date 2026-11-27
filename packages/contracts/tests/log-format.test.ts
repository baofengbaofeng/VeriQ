import { describe, expect, it } from "vitest";
import cases from "../fixtures/log-format.json" with { type: "json" };
import { renderLog } from "../src/log-format.js";

describe("EVENT_TAG formatter", () => {
    for (const { name, input, expected } of cases) {
        it(name, () => {
            expect(renderLog({ ...input, timestamp: new Date(input.timestamp) })).toBe(expected);
        });
    }

    it("uses the current time when the supplied timestamp is invalid", () => {
        const result = renderLog({ level: "NOTICE", timestamp: new Date(Number.NaN), location: "" });
        expect(result).toMatch(/^\[NOTICE\]\[\d{4}-\d{2}-\d{2}T[\d:.]+\+0000\]\[\] _undef\|\|$/);
    });

    it("caps UTF-8 output without splitting code points or escape sequences", () => {
        const result = renderLog({
            level: "DEBUG",
            timestamp: new Date("2026-10-15T06:03:27.812Z"),
            location: "log.ts:42",
            fields: { event: "test", details: "字🚀|".repeat(1000), tail: "unused" },
        });

        expect(Buffer.byteLength(result)).toBeLessThanOrEqual(4096);
        expect(Buffer.byteLength(result)).toBeGreaterThan(4088);
        expect(result).toMatch(/details=(字🚀\\\|)+(字(🚀)?)?…$/u);
    });
});
