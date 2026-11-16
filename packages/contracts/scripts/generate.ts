import { readFile, writeFile } from "node:fs/promises";
import { compile } from "json-schema-to-typescript";
import openapiTS, { astToString } from "openapi-typescript";
import ts from "typescript";
import { limitGeneratedWidth } from "./generated-width.js";

const directory = new URL("../", import.meta.url);
const source = JSON.parse(
    await readFile(new URL("schemas/platform-v1.schema.json", directory), "utf8"),
);
const aliases = Object.entries(source.$defs as Record<string, { $ref?: string }>).filter(
    ([, value]) => value.$ref,
);
const concrete = Object.fromEntries(
    Object.entries(source.$defs).filter(([name]) => !aliases.some(([alias]) => name === alias)),
);
const definitions: Parameters<typeof compile>[0] = {
    type: "object",
    additionalProperties: false,
    $defs: concrete,
    properties: Object.fromEntries(
        Object.keys(concrete).map((name) => [name, { $ref: `#/$defs/${name}` }]),
    ),
};
const types = await compile(definitions, "ContractDefinitions", {
    bannerComment:
        "/* Generated from schemas/platform-v1.schema.json. Run pnpm contracts:generate. */",
    unreachableDefinitions: true,
    enableConstEnums: false,
    additionalProperties: false,
});
const aliasTypes = aliases
    .map(([name, value]) => `export type ${name} = ${value.$ref!.split("/").at(-1)};`)
    .join("\n");
const api = astToString(
    await openapiTS(new URL("openapi/platform.yaml", directory), {
        inject:
            'import type { JsonValue as ContractJsonValue, BindingJsonValue as ContractBindingJsonValue } from "' +
            './types.generated.js";',
        // An indexed-access recursive property cannot represent arbitrary JSON in TS.
        // Reuse the recursive type generated from the same canonical schema instead.
        transform(_schema, { path }) {
            if (path?.endsWith("/JsonValue"))
                return ts.factory.createTypeReferenceNode("ContractJsonValue");
            if (path?.endsWith("/BindingJsonValue"))
                return ts.factory.createTypeReferenceNode("ContractBindingJsonValue");
        },
    }),
);
const outputs = new Map([
    ["src/types.generated.ts", types + "\n" + aliasTypes + "\n"],
    [
        "src/api.generated.ts",
        "/* Generated from openapi/platform.yaml. Run pnpm contracts:generate. */\n" + api,
    ],
]);
for (const [name, content] of outputs) {
    const file = new URL(name, directory);
    // 生成类型按真实显示列宽拆行，长联合类型和文档说明都经过同一确定性处理，只读检查仍逐字比较生成结果。
    const formatted = limitGeneratedWidth(content);
    if (process.argv.includes("--check")) {
        if ((await readFile(file, "utf8")) !== formatted)
            throw new Error(`${name} is stale; run pnpm contracts:generate`);
    } else {
        await writeFile(file, formatted);
    }
}
