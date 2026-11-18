/**
 * 在结构门禁之后校验数据集值与树关系，保留旧版数据列诊断，并让独立资源和闭包中的同一版本共用语义入口。
 * 这里只检查静态数据及其元数据，不改变冻结行的顺序，不转换值，也不加载任何数据来源。
 */

import type { DatasetDocument, TreeDataRowV2 } from "./types.generated.js";
import { accepts, pointerKey, valueType } from "./bindings.js";

/**
 * 沿用资源依赖闭包的百层深度预算，根节点占一层，因此根到最深子节点最多经过九十九条父子链接。
 * 树遍历缓存已完成节点的深度；无效分支用零标记，后续子节点不会重复发送相同祖先的错误。
 */
const MAX_TREE_DEPTH = 100;

/**
 * 把验证过结构的数据集投影为带位置的编译诊断。可选字段允许缺失而保留显式空值的独立语义，行键以冻结版本为范围。
 * path 是外层快照中的文档指针；单独调用时默认返回相对数据集文档的指针。
 */
export function validateDataset(document: DatasetDocument, path = "") {
    const issues: { code: string; path: string; message: string }[] = [];
    const fail = (code: string, suffix: string, message = code) => issues.push({ code, path: path + suffix, message });

    /**
     * 已发布旧数据集继续执行原有全部列必填与类型规则，保留旧校验代码和重复键的数组级问题位置。
     * 新版字段的缺省和空值规则只从新版声明读取，不从旧版列推导。
     */
    if (document.schemaVersion === "1.0") {
        const seen = new Set<string>();
        for (const row of document.rows) {
            if (seen.has(row.key)) fail("DUPLICATE_ID", "/rows", row.key);
            seen.add(row.key);
        }
        for (const [index, row] of document.rows.entries()) {
            const valuesPath = `/rows/${index}/values/`;
            for (const [key, type] of Object.entries(document.columns))
                if (!Object.hasOwn(row.values, key) || !accepts(type, valueType(row.values[key])))
                    fail("DATA_TYPE_MISMATCH", valuesPath + pointerKey(key));
            for (const key of Object.keys(row.values))
                if (!Object.hasOwn(document.columns, key)) fail("UNKNOWN_DATA_COLUMN", valuesPath + pointerKey(key));
        }
        return issues;
    }

    /**
     * 按自有属性匹配字段和值，避免把对象原型上的名字当成真实字段。行键索引同时检测重复键并供树父链接查询。
     * 对于无效的重复行，保留首个键位置作为诊断依据；树关系不能在键有歧义时求值。
     */
    const rows = document.source.rows;
    const indexes = new Map<string, number>();
    const required = Object.keys(document.fields).filter((key) => document.fields[key]!.required);
    for (const [index, row] of rows.entries()) {
        const rowPath = `/source/rows/${index}`;
        if (indexes.has(row.key)) fail("DATASET_DUPLICATE_ROW_KEY", rowPath + "/key");
        else indexes.set(row.key, index);

        /**
         * 按实际值计数，仅在必填字段不足时定位首个缺失字段。稀疏表无需逐行扫描整份声明，也不会为空行产生大量诊断。
         * 显式 null 仍计为已提供字段，是否接受它由 nullable 单独决定，且数字和字符串从不相互转换。
         */
        let presentRequired = 0;
        for (const [key, value] of Object.entries(row.values)) {
            const valuePath = rowPath + "/values/" + pointerKey(key);
            const field = Object.hasOwn(document.fields, key) ? document.fields[key] : undefined;
            if (!field) {
                fail("DATASET_UNKNOWN_FIELD", valuePath);
                continue;
            }
            if (field.required) presentRequired++;
            if (value === null) {
                if (!field.nullable) fail("DATASET_FIELD_NULL_FORBIDDEN", valuePath);
            } else if (!accepts(field.type, valueType(value))) fail("DATASET_FIELD_TYPE_MISMATCH", valuePath);
        }
        if (presentRequired < required.length) {
            const missing = required.find((key) => !Object.hasOwn(row.values, key))!;
            fail("DATASET_REQUIRED_FIELD_MISSING", rowPath + "/values/" + pointerKey(missing));
        }
    }

    if (document.shape === "TREE" && indexes.size === rows.length)
        validateTreeLinks(document.source.rows, indexes, fail);
    return issues;
}

/**
 * 用迭代路径检查父链接，以便深树和循环不消耗调用栈。每条链访问已缓存的祖先或首次发现终点后，再沿相反方向回填深度。
 * 本地访问集合识别当前链的环，深度缓存则让其它分支访问同一祖先时只读取一次结果。
 */
function validateTreeLinks(
    rows: TreeDataRowV2[],
    indexes: Map<string, number>,
    fail: (code: string, suffix: string) => void,
) {
    const depths = new Map<number, number>();
    const parentPath = (index: number) => `/source/rows/${index}/parentKey`;

    /**
     * 冻结数组顺序只决定遇见问题的先后。父节点可以排在子节点之后，平级 order 相同也不会使父链接变得含糊。
     * 命中已知的无效祖先就结束该链；循环或孤立节点的定位始终指向实际需要修正的父链接。
     */
    for (const start of indexes.values()) {
        if (depths.has(start)) continue;
        const chain = new Set<number>();
        let current = start;
        while (!depths.has(current)) {
            if (chain.has(current)) {
                fail("DATASET_TREE_CYCLE", parentPath(current));
                break;
            }
            const key = rows[current]!.parentKey;
            if (key === null) {
                depths.set(current, 1);
                break;
            }
            chain.add(current);
            const next = indexes.get(key);
            if (next === undefined) {
                fail("DATASET_ORPHAN_NODE", parentPath(current));
                break;
            }
            current = next;
        }
        let depth = depths.get(current) ?? 0;

        /**
         * 对成功链接的父链逐层累加；首次超限的节点报告错误并标记无效，后代不重复报告该链的同一种深度错误。
         * 遇到孤立或循环的链一律缓存为无效，避免再次遍历其共享的出错分支。
         */
        for (const index of [...chain].reverse()) {
            if (depth > 0 && ++depth > MAX_TREE_DEPTH) {
                fail("DATASET_TREE_DEPTH_LIMIT", parentPath(index));
                depth = 0;
            }
            depths.set(index, depth);
        }
    }
}
