import ts from "typescript";

const maximumWidth = 120;

// 宽字符区间来自 Python 3.12 的 Unicode 15.0 East_Asian_Width 数据，保留未分配码点的同一属性值，
// 避免终端 Emoji 规则替代源码列宽。
// 区间只供显示列宽计算，组合标记和格式控制字符另按零列处理，不参与契约内容生成或字段值变换。
const wideRanges: readonly (readonly [number, number])[] = [
    [0x1100, 0x115F],
    [0x231A, 0x231B],
    [0x2329, 0x232A],
    [0x23E9, 0x23EC],
    [0x23F0, 0x23F0],
    [0x23F3, 0x23F3],
    [0x25FD, 0x25FE],
    [0x2614, 0x2615],
    [0x2648, 0x2653],
    [0x267F, 0x267F],
    [0x2693, 0x2693],
    [0x26A1, 0x26A1],
    [0x26AA, 0x26AB],
    [0x26BD, 0x26BE],
    [0x26C4, 0x26C5],
    [0x26CE, 0x26CE],
    [0x26D4, 0x26D4],
    [0x26EA, 0x26EA],
    [0x26F2, 0x26F3],
    [0x26F5, 0x26F5],
    [0x26FA, 0x26FA],
    [0x26FD, 0x26FD],
    [0x2705, 0x2705],
    [0x270A, 0x270B],
    [0x2728, 0x2728],
    [0x274C, 0x274C],
    [0x274E, 0x274E],
    [0x2753, 0x2755],
    [0x2757, 0x2757],
    [0x2795, 0x2797],
    [0x27B0, 0x27B0],
    [0x27BF, 0x27BF],
    [0x2B1B, 0x2B1C],
    [0x2B50, 0x2B50],
    [0x2B55, 0x2B55],
    [0x2E80, 0x2E99],
    [0x2E9B, 0x2EF3],
    [0x2F00, 0x2FD5],
    [0x2FF0, 0x2FFB],
    [0x3000, 0x303E],
    [0x3041, 0x3096],
    [0x3099, 0x30FF],
    [0x3105, 0x312F],
    [0x3131, 0x318E],
    [0x3190, 0x31E3],
    [0x31F0, 0x321E],
    [0x3220, 0x3247],
    [0x3250, 0x4DBF],
    [0x4E00, 0xA48C],
    [0xA490, 0xA4C6],
    [0xA960, 0xA97C],
    [0xAC00, 0xD7A3],
    [0xF900, 0xFAFF],
    [0xFE10, 0xFE19],
    [0xFE30, 0xFE52],
    [0xFE54, 0xFE66],
    [0xFE68, 0xFE6B],
    [0xFF01, 0xFF60],
    [0xFFE0, 0xFFE6],
    [0x16FE0, 0x16FE4],
    [0x16FF0, 0x16FF1],
    [0x17000, 0x187F7],
    [0x18800, 0x18CD5],
    [0x18D00, 0x18D08],
    [0x1AFF0, 0x1AFF3],
    [0x1AFF5, 0x1AFFB],
    [0x1AFFD, 0x1AFFE],
    [0x1B000, 0x1B122],
    [0x1B132, 0x1B132],
    [0x1B150, 0x1B152],
    [0x1B155, 0x1B155],
    [0x1B164, 0x1B167],
    [0x1B170, 0x1B2FB],
    [0x1F004, 0x1F004],
    [0x1F0CF, 0x1F0CF],
    [0x1F18E, 0x1F18E],
    [0x1F191, 0x1F19A],
    [0x1F200, 0x1F202],
    [0x1F210, 0x1F23B],
    [0x1F240, 0x1F248],
    [0x1F250, 0x1F251],
    [0x1F260, 0x1F265],
    [0x1F300, 0x1F320],
    [0x1F32D, 0x1F335],
    [0x1F337, 0x1F37C],
    [0x1F37E, 0x1F393],
    [0x1F3A0, 0x1F3CA],
    [0x1F3CF, 0x1F3D3],
    [0x1F3E0, 0x1F3F0],
    [0x1F3F4, 0x1F3F4],
    [0x1F3F8, 0x1F43E],
    [0x1F440, 0x1F440],
    [0x1F442, 0x1F4FC],
    [0x1F4FF, 0x1F53D],
    [0x1F54B, 0x1F54E],
    [0x1F550, 0x1F567],
    [0x1F57A, 0x1F57A],
    [0x1F595, 0x1F596],
    [0x1F5A4, 0x1F5A4],
    [0x1F5FB, 0x1F64F],
    [0x1F680, 0x1F6C5],
    [0x1F6CC, 0x1F6CC],
    [0x1F6D0, 0x1F6D2],
    [0x1F6D5, 0x1F6D7],
    [0x1F6DC, 0x1F6DF],
    [0x1F6EB, 0x1F6EC],
    [0x1F6F4, 0x1F6FC],
    [0x1F7E0, 0x1F7EB],
    [0x1F7F0, 0x1F7F0],
    [0x1F90C, 0x1F93A],
    [0x1F93C, 0x1F945],
    [0x1F947, 0x1F9FF],
    [0x1FA70, 0x1FA7C],
    [0x1FA80, 0x1FA88],
    [0x1FA90, 0x1FABD],
    [0x1FABF, 0x1FAC5],
    [0x1FACE, 0x1FADB],
    [0x1FAE0, 0x1FAE8],
    [0x1FAF0, 0x1FAF8],
    [0x20000, 0x2FFFD],
    [0x30000, 0x3FFFD],
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
    return result.split("\n").flatMap((line) => {
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
    }).join("\n");
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
