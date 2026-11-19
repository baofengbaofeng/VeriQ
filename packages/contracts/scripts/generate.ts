import { readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";
import { limitGeneratedWidth } from "./generated-width.js";

const directory = new URL("../", import.meta.url);
const source = JSON.parse(await readFile(new URL("schemas/platform-v1.schema.json", directory), "utf8"));
const aliases = Object.entries(source.$defs as Record<string, { $ref?: string }>).filter(([, value]) => value.$ref);
const concrete = Object.fromEntries(
    Object.entries(source.$defs).filter(([name]) => !aliases.some(([alias]) => name === alias)),
);
const definitions: Parameters<typeof compile>[0] = {
    type: "object",
    additionalProperties: false,
    $defs: concrete,
    properties: Object.fromEntries(Object.keys(concrete).map((name) => [name, { $ref: `#/$defs/${name}` }])),
};
const types = await compile(definitions, "ContractDefinitions", {
    bannerComment: "/* Generated from schemas/platform-v1.schema.json. Run pnpm contracts:generate. */",
    unreachableDefinitions: true,
    enableConstEnums: false,
    additionalProperties: false,
});
const aliasTypes = aliases.map(([name, value]) => `export type ${name} = ${value.$ref!.split("/").at(-1)};`).join("\n");
const api = astToString(
    await openapiTS(new URL("openapi/platform.yaml", directory), {
        inject:
            'import type { JsonValue as ContractJsonValue, BindingJsonValue as ContractBindingJsonValue } from "' +
            './types.generated.js";',
        // 递归 JSON 通过同一规范 Schema 生成的合同类型表达，索引访问递归属性不能覆盖任意 JSON 值，因此复用该类型。
        transform(_schema, { path }) {
            if (path?.endsWith("/JsonValue")) return ts.factory.createTypeReferenceNode("ContractJsonValue");
            if (path?.endsWith("/BindingJsonValue"))
                return ts.factory.createTypeReferenceNode("ContractBindingJsonValue");
        },
    }),
);
const outputs = new Map([
    ["src/types.generated.ts", types + "\n" + aliasTypes + "\n"],
    ["src/api.generated.ts", "/* Generated from openapi/platform.yaml. Run pnpm contracts:generate. */\n" + api],
]);
for (const [name, content] of outputs) {
    const file = new URL(name, directory);
    // 生成类型统一整理块注释边界并按显示列宽拆行，完整保留合同类型和说明文字，只读生成检查仍逐字比较输出结果。
    const formatted = limitGeneratedWidth(content);
    if (process.argv.includes("--check")) {
        if ((await readFile(file, "utf8")) !== formatted)
            throw new Error(`${name} is stale; run pnpm contracts:generate`);
    } else {
        await writeFile(file, formatted);
    }
}
