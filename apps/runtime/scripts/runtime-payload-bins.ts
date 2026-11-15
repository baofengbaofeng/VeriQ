import { RuntimePayloadError, type Bin } from "./runtime-payload-inputs.ts";
import { posix } from "node:path";
import { relative } from "./runtime-payload-tree.ts";

/** 命令模板只消费已经核验的有限目标路径并生成独立普通文件，目标正文仍留在原包位置以保持相对加载语义；开发宿主绝对 Node 路径及环境回退永远不能进入 VeriQ 候选。 */
const header = '#!/bin/sh\nbase=$(CDPATH= cd -- "${0%/*}" && pwd -P) || exit 1\n';
const nodeTemplate = `${header}exec "$base"/@@RUNNER@@ "$base"/@@TARGET@@ "$@"\n`;
const nativeTemplate = `${header}exec "$base"/@@TARGET@@ "$@"\n`;
/** 两种固定模板的真实 UTF8 字节通过唯一分隔符组成可摘要来源常量，收据同时绑定此摘要和本文件实际源码 Ref；路径参数只填受核有限位置，不能通过模板文本附带宿主 Node、环境搜索或任意输入可选命令。 */
export const BIN_SHIM_TEMPLATE = `${nodeTemplate}\0${nativeTemplate}`;

/** 每个命令都按其别名所在目录计算自身角色与原目标的相对位置，参数逐字转交而不经过求值；原生与 JavaScript 两种已核启动器之外的声明必须在生成之前失败关闭并保留来源事实。 */
export function renderBinShim(bin: Bin): Uint8Array {
    relative(bin.aliasPath);
    relative(bin.targetPath);
    if (!bin.aliasPath.includes("/.bin/") || !["node", "native"].includes(bin.launcher))
        throw new RuntimePayloadError("PAYLOAD_BIN_UNSUPPORTED");
    const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
    const root = posix.dirname(bin.aliasPath);
    return Buffer.from(
        (bin.launcher === "node" ? nodeTemplate : nativeTemplate)
            .replace("@@RUNNER@@", () => quote(posix.relative(root, "roles/runner/veriq_runner")))
            .replace("@@TARGET@@", () => quote(posix.relative(root, bin.targetPath))),
    );
}
