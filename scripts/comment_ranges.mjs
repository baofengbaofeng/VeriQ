/**
 * 注释审计复用 TypeScript 解析器定位语法节点前后的真实注释区间，避免把字符串、模板或正则表达式中的斜杠当作说明；输出只
 * 包含位置与注释文本，不修改被检查源码。
 * Python 审计器负责语言、首行长度和覆盖率的统一判定。
 * 生成文件的排除由显式清单控制，不在这里猜测文件用途。
 * 同一注释可能属于多个节点，按起止偏移去重后再计数。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * 审计默认加载仓库冻结安装的编译器，也允许开发工具显式指定已有编译器路径，避免为静态扫描复制或安装另一套依赖。
 */
const compilerPath = process.env.VERIQ_TYPESCRIPT_PATH;
const { default: ts } = await import(
    compilerPath
        ? pathToFileURL(compilerPath).href
        : new URL("../packages/compiler/node_modules/typescript/lib/typescript.js", import.meta.url).href
);
const paths = JSON.parse(readFileSync(0, "utf8"));
const output = {};
for (const path of paths) {
    const text = readFileSync(path, "utf8");
    /**
     * 每个文件只遍历一次原文建立 UTF16 有效边界到 Unicode 码点位置的映射，成对代理字符仅推进一个码点；解析器的注释边界
     * 不会拆分字符，原始偏移仍保留给既有消费者使用。
     */
    const codePointOffsets = new Uint32Array(text.length + 1);
    let offset = 0;
    let codePointOffset = 0;
    for (const character of text) {
        offset += character.length;
        codePointOffset += 1;
        codePointOffsets[offset] = codePointOffset;
    }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const ranges = new Map();
    const visit = (node) => {
        for (const position of [node.pos, node.end]) {
            for (const range of [
                ...(ts.getLeadingCommentRanges(text, position) ?? []),
                ...(ts.getTrailingCommentRanges(text, position) ?? []),
            ]) {
                ranges.set(`${range.pos}:${range.end}`, range);
            }
        }
        for (const child of node.getChildren(source)) visit(child);
    };
    visit(source);
    output[path] = [...ranges.values()].map((range) => ({
        start: source.getLineAndCharacterOfPosition(range.pos).line + 1,
        end: source.getLineAndCharacterOfPosition(range.end - 1).line + 1,
        offset: range.pos,
        limit: range.end,
        offsetCodePoint: codePointOffsets[range.pos],
        limitCodePoint: codePointOffsets[range.end],
        text: text.slice(range.pos, range.end),
    }));
}
process.stdout.write(JSON.stringify(output));
