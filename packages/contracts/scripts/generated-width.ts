import ts from "typescript";

const maximumWidth = 120;

// 宽字符区间来自 Python 3.12 的 Unicode 15.0 East_Asian_Width 数据，保留未分配码点的同一属性值，
// 避免终端 Emoji 规则替代源码列宽。
// 区间只供显示列宽计算，组合标记和格式控制字符另按零列处理，不参与契约内容生成或字段值变换。
const wideRanges: readonly (readonly [number, number])[] = [
    [0x1100, 0x115f],
    [0x231a, 0x231b],
    [0x2329, 0x232a],
    [0x23e9, 0x23ec],
    [0x23f0, 0x23f0],
    [0x23f3, 0x23f3],
    [0x25fd, 0x25fe],
    [0x2614, 0x2615],
    [0x2648, 0x2653],
    [0x267f, 0x267f],
    [0x2693, 0x2693],
    [0x26a1, 0x26a1],
    [0x26aa, 0x26ab],
    [0x26bd, 0x26be],
    [0x26c4, 0x26c5],
    [0x26ce, 0x26ce],
    [0x26d4, 0x26d4],
    [0x26ea, 0x26ea],
    [0x26f2, 0x26f3],
    [0x26f5, 0x26f5],
    [0x26fa, 0x26fa],
    [0x26fd, 0x26fd],
    [0x2705, 0x2705],
    [0x270a, 0x270b],
    [0x2728, 0x2728],
    [0x274c, 0x274c],
    [0x274e, 0x274e],
    [0x2753, 0x2755],
    [0x2757, 0x2757],
    [0x2795, 0x2797],
    [0x27b0, 0x27b0],
    [0x27bf, 0x27bf],
    [0x2b1b, 0x2b1c],
    [0x2b50, 0x2b50],
    [0x2b55, 0x2b55],
    [0x2e80, 0x2e99],
    [0x2e9b, 0x2ef3],
    [0x2f00, 0x2fd5],
    [0x2ff0, 0x2ffb],
    [0x3000, 0x303e],
    [0x3041, 0x3096],
    [0x3099, 0x30ff],
    [0x3105, 0x312f],
    [0x3131, 0x318e],
    [0x3190, 0x31e3],
    [0x31f0, 0x321e],
    [0x3220, 0x3247],
    [0x3250, 0x4dbf],
    [0x4e00, 0xa48c],
    [0xa490, 0xa4c6],
    [0xa960, 0xa97c],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe10, 0xfe19],
    [0xfe30, 0xfe52],
    [0xfe54, 0xfe66],
    [0xfe68, 0xfe6b],
    [0xff01, 0xff60],
    [0xffe0, 0xffe6],
    [0x16fe0, 0x16fe4],
    [0x16ff0, 0x16ff1],
    [0x17000, 0x187f7],
    [0x18800, 0x18cd5],
    [0x18d00, 0x18d08],
    [0x1aff0, 0x1aff3],
    [0x1aff5, 0x1affb],
    [0x1affd, 0x1affe],
    [0x1b000, 0x1b122],
    [0x1b132, 0x1b132],
    [0x1b150, 0x1b152],
    [0x1b155, 0x1b155],
    [0x1b164, 0x1b167],
    [0x1b170, 0x1b2fb],
    [0x1f004, 0x1f004],
    [0x1f0cf, 0x1f0cf],
    [0x1f18e, 0x1f18e],
    [0x1f191, 0x1f19a],
    [0x1f200, 0x1f202],
    [0x1f210, 0x1f23b],
    [0x1f240, 0x1f248],
    [0x1f250, 0x1f251],
    [0x1f260, 0x1f265],
    [0x1f300, 0x1f320],
    [0x1f32d, 0x1f335],
    [0x1f337, 0x1f37c],
    [0x1f37e, 0x1f393],
    [0x1f3a0, 0x1f3ca],
    [0x1f3cf, 0x1f3d3],
    [0x1f3e0, 0x1f3f0],
    [0x1f3f4, 0x1f3f4],
    [0x1f3f8, 0x1f43e],
    [0x1f440, 0x1f440],
    [0x1f442, 0x1f4fc],
    [0x1f4ff, 0x1f53d],
    [0x1f54b, 0x1f54e],
    [0x1f550, 0x1f567],
    [0x1f57a, 0x1f57a],
    [0x1f595, 0x1f596],
    [0x1f5a4, 0x1f5a4],
    [0x1f5fb, 0x1f64f],
    [0x1f680, 0x1f6c5],
    [0x1f6cc, 0x1f6cc],
    [0x1f6d0, 0x1f6d2],
    [0x1f6d5, 0x1f6d7],
    [0x1f6dc, 0x1f6df],
    [0x1f6eb, 0x1f6ec],
    [0x1f6f4, 0x1f6fc],
    [0x1f7e0, 0x1f7eb],
    [0x1f7f0, 0x1f7f0],
    [0x1f90c, 0x1f93a],
    [0x1f93c, 0x1f945],
    [0x1f947, 0x1f9ff],
    [0x1fa70, 0x1fa7c],
    [0x1fa80, 0x1fa88],
    [0x1fa90, 0x1fabd],
    [0x1fabf, 0x1fac5],
    [0x1face, 0x1fadb],
    [0x1fae0, 0x1fae8],
    [0x1faf0, 0x1faf8],
    [0x20000, 0x2fffd],
    [0x30000, 0x3fffd],
];

/**
 * 显示列宽逐码点累计，中文和全角字符依 Unicode 宽属性占两列，组合标记与格式控制占零列，其余字符占一列。
 * 不按 Emoji 序列合并宽度，因此与仓库静态检查器和固定等宽字体的源码列定义保持一致。
 */
function displayWidth(text: string): number {
    let columns = 0;
    for (const character of text) {
        if (character === "\t") {
            columns += 4 - (columns % 4);
            continue;
        }
        if (/[\p{Mn}\p{Me}\p{Cf}]/u.test(character)) continue;
        const codePoint = character.codePointAt(0)!;
        columns += wideRanges.some(([start, end]) => codePoint >= start && codePoint <= end) ? 2 : 1;
    }
    return columns;
}

/**
 * 生成器统一将真实块注释的边界独占一行，并仅在显示列宽超限时拆分正文或类型声明，字符串等词法单元始终保留。
 * 保持普通生成行的原有格式，使只读生成检查和源码发行得到相同结果。
 */
export function limitGeneratedWidth(content: string): string {
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
    const replacements: { start: number; end: number; text: string }[] = [];
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
        if (kind !== ts.SyntaxKind.MultiLineCommentTrivia && kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
        const start = scanner.getTokenPos();
        const end = scanner.getTextPos();
        const lineStart = content.lastIndexOf("\n", start - 1) + 1;
        const lineEnd = content.indexOf("\n", end);
        const indent = content.slice(lineStart, start);
        const comment = content.slice(start, end);
        const block = kind === ts.SyntaxKind.MultiLineCommentTrivia;
        const suffix = content.slice(end, lineEnd < 0 ? content.length : lineEnd);
        if (indent.trim() || suffix.trim()) continue;
        if (!block && !comment.split("\n").some((line) => displayWidth(indent + line) > maximumWidth)) continue;
        const opening = comment.startsWith("/**") ? "/**" : block ? "/*" : "//";
        const text = block ? comment.slice(opening.length, -2) : comment.slice(2);
        const bodyLines = text.split("\n").map((line) => line.trimStart().replace(/^\* ?/, "").trimEnd());
        while (bodyLines.length && !bodyLines[0]) bodyLines.shift();
        while (bodyLines.length && !bodyLines[bodyLines.length - 1]) bodyLines.pop();
        const rows: string[] = block ? [opening] : [];
        for (const body of bodyLines) {
            if (!body) {
                rows.push(block ? " *" : "//");
                continue;
            }
            const prefix = block ? " * " : "// ";
            rows.push(...wrapWords(body, maximumWidth - displayWidth(indent + prefix)).map((part) => prefix + part));
        }
        if (block) rows.push(" */");
        replacements.push({ start, end, text: rows.join("\n" + indent) });
    }
    let result = content;
    for (const replacement of replacements.reverse()) {
        result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
    }
    return result
        .split("\n")
        .flatMap((line) => {
            if (displayWidth(line) <= maximumWidth) return [line];
            const indent = line.match(/^\s*/)?.[0] ?? "";
            const continuation = indent + "    ";
            const lines: string[] = [];
            let remainder = line;
            while (displayWidth(remainder) > maximumWidth) {
                const tokens = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, remainder);
                let boundary = 0;
                let preferredBoundary = 0;
                for (let kind = tokens.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = tokens.scan()) {
                    const position = tokens.getTextPos();
                    if (displayWidth(remainder.slice(0, position)) > maximumWidth) break;
                    boundary = position;
                    if (kind === ts.SyntaxKind.CommaToken || kind === ts.SyntaxKind.OpenBraceToken) {
                        preferredBoundary = position;
                    } else if (kind === ts.SyntaxKind.BarToken) {
                        preferredBoundary = tokens.getTokenPos();
                    }
                }
                boundary = preferredBoundary || boundary;
                if (!boundary || !remainder.slice(boundary).trim()) {
                    throw new Error("Generated source contains a token wider than 120 display columns");
                }
                lines.push(remainder.slice(0, boundary).trimEnd());
                remainder = continuation + remainder.slice(boundary).trimStart();
            }
            return [...lines, remainder];
        })
        .join("\n");
}

/**
 * 按现有空白拆分生成文档的说明文字，中文片段逐字测量显示宽度，完整词能够放下时保持技术名称和链接的连续性。
 * 这只改变生成注释的物理换行，不参与 Schema 或业务值的计算。
 */
function wrapWords(text: string, width: number): string[] {
    const rows: string[] = [];
    let remainder = text;
    while (displayWidth(remainder) > width) {
        let columns = 0;
        let length = 0;
        for (const character of remainder) {
            columns += displayWidth(character);
            if (columns > width) break;
            length += character.length;
        }
        const space = remainder.lastIndexOf(" ", length);
        if (space > 0) length = space;
        rows.push(remainder.slice(0, length).trimEnd());
        remainder = remainder.slice(length).trimStart();
    }
    if (remainder) rows.push(remainder);
    return rows;
}
