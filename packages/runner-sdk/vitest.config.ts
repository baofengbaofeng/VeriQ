import { defineConfig } from "vitest/config";
export default defineConfig({
    test: {
        testTimeout: 15000,
        hookTimeout: 15000,
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            reporter: ["text", "json-summary"],
            thresholds: { lines: 75 },
        },
    },
});
