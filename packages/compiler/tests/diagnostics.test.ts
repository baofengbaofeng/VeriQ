import { expect, it } from "vitest";
import * as compiler from "../src/index.js";
import { snapshot } from "./helpers.js";

it("retains actual analyzer code and source pointer without echoing source values", () => {
    const source = snapshot([{ id: "click", action: "click", target: "synthetic-private-credential" }]);
    const issues = compiler.analyze(source).issues;
    const actual = issues.find((issue) => issue.code === "UNKNOWN_ELEMENT")!;
    expect(actual).toBeDefined();
    const project = compiler.safeDiagnostics;
    expect(project, "compiler needs a structured safe diagnostic projection").toBeTypeOf("function");
    const projected = project!(issues);
    expect(projected).toContainEqual({
        code: actual.code,
        path: actual.path,
        pathStatus: "EXACT",
        message: "Element is not declared in the pinned catalog.",
    });
    expect(JSON.stringify(projected)).not.toContain("synthetic-private-credential");
});

it("bounds diagnostic count and omits unsafe dynamic paths instead of inventing locations", () => {
    const issues = Array.from({ length: 150 }, () => ({
        code: "UNKNOWN_ELEMENT",
        path: "/assets/0/document/vars/synthetic-private-credential",
        message: "synthetic-private-credential",
    }));
    const project = compiler.safeDiagnostics;
    expect(project).toBeTypeOf("function");
    const result = project!(issues);
    expect(result).toHaveLength(100);
    expect(result.every((issue) => issue.path === "")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-credential");
});

/**
 * 非指针前缀不能被路径分段白名单误当作根段，空根指针和合法源码指针仍须逐字保留，并且消息映射保持固定。
 */
it.each(["synthetic-private-prefix", "synthetic-private-prefix/assets"])(
    "redacts non-pointer diagnostic paths: %s",
    (path) => {
        const result = compiler.safeDiagnostics([
            { code: "UNKNOWN_ELEMENT", path, message: "synthetic-private-prefix" },
        ]);
        expect(result).toEqual([
            {
                code: "UNKNOWN_ELEMENT",
                path: "",
                pathStatus: "REDACTED",
                message: "Element is not declared in the pinned catalog.",
            },
        ]);
        expect(JSON.stringify(result)).not.toContain("synthetic-private-prefix");
    },
);
it.each(["", "/assets/0/document/steps/0/id"])("retains valid source pointers: %s", (path) => {
    expect(compiler.safeDiagnostics([{ code: "UNKNOWN_ELEMENT", path, message: "source value" }])).toEqual([
        {
            code: "UNKNOWN_ELEMENT",
            path,
            pathStatus: "EXACT",
            message: "Element is not declared in the pinned catalog.",
        },
    ]);
});
