import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** 桌面共享构建使用契约包自身已锁定的 Ajv 及格式库生成独立校验函数，运行中的 renderer 不再编译字符串；替换只针对契约内部校验器模块，主进程与独立 Node 的默认入口不受影响。 */
export function desktopValidators() {
    const contracts = resolve("../../packages/contracts");
    const require = createRequire(resolve(contracts, "package.json"));
    const { Ajv2020 } = require("ajv/dist/2020.js");
    const formats = require("ajv-formats");
    const standalone = require("ajv/dist/standalone").default;
    const output = resolve("dist-desktop/validators.cjs");
    return {
        name: "veriq-static-desktop-validators",
        enforce: "pre",
        async buildStart() {
            const schema = JSON.parse(
                await readFile(resolve(contracts, "schemas/platform-v1.schema.json"), "utf8"),
            );
            const ajv = new Ajv2020({
                allErrors: true,
                strict: true,
                validateFormats: true,
                code: { source: true },
            });
            formats(ajv);
            ajv.addSchema(schema);
            const validators = Object.fromEntries(
                Object.keys(schema.$defs).map((name) => [name, `${schema.$id}#/$defs/${name}`]),
            );
            // 官方生成器保留格式校验运行时引用；按契约包解析绝对依赖路径供 Vite 打包，产物中不会保留本机路径或需要额外下载的脚本。
            const generated = standalone(ajv, validators).replace(
                /require\("([^" ]+)"\)/g,
                (_match, id) => `require(${JSON.stringify(require.resolve(id))})`,
            );
            await mkdir(resolve("dist-desktop"), { recursive: true });
            await writeFile(
                output,
                generated + "\nexports.schemaValidator = name => exports[name];\n",
            );
        },
        resolveId(source, importer) {
            if (source === "./validators.js" && importer === resolve(contracts, "src/index.ts"))
                return output;
        },
    };
}
