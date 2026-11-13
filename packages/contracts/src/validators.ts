import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../schemas/platform-v1.schema.json" with { type: "json" };

/** 默认契约校验器在可信 Node 或原有 Web 环境按需编译，桌面共享构建将本模块替换为同一 Ajv 配置生成的静态函数；便携 JSON 检查和错误映射仍由统一契约入口负责。 */
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats.default(ajv);
ajv.addSchema(schema);

/** 按已存在的契约定义返回 Ajv 函数，调用方先验证名称后才会到达这里；这个窄边界允许受 CSP 限制的桌面在构建时编译全部定义，不引入第二套校验规则或删减字段检查。 */
export function schemaValidator(name: string) {
    return ajv.getSchema(`${schema.$id}#/$defs/${name}`)!;
}
