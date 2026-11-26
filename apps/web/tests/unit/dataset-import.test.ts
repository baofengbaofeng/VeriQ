import assert from "node:assert/strict";
import test from "node:test";
import { canonicalBytes, type DatasetV2 } from "@veriq/contracts";
import { parseDatasetImport, parseDatasetSpreadsheet } from "../../src/features/resources/dataset-import";

const dataset: DatasetV2 = {
    schemaVersion: "2.0",
    shape: "TABLE",
    fields: Object.fromEntries([
        ["__proto__", { type: "string", required: true, nullable: false }],
        ["a.b", { type: "integer", required: false, nullable: true }],
    ]),
    source: { kind: "STATIC", rows: [] },
};

/**
 * 同一列所有非空单元格共同决定类型，遇到混合值保留原始字面文本，标识列既保留业务值也产生符合契约的行键。
 */
test("CSV infers fields from full columns and keeps identifier lexemes as business data", () => {
    const starter: DatasetV2 = {
        schemaVersion: "2.0",
        shape: "TABLE",
        fields: { name: { type: "string", required: true, nullable: false } },
        source: { kind: "STATIC", rows: [{ key: "row_1", values: { name: "" } }] },
    };
    const result = parseDatasetImport(
        "CSV",
        [
            "employee_code,Employee Name,enabled,score,department,empty",
            "001,Ada,true,2,operations,",
            "010,Bo,false,3.5,42,",
        ].join("\r\n"),
        starter,
    );
    assert.deepEqual(result.issues, []);
    assert.equal(result.plan?.rowKey, "employee_code");
    assert.equal(result.plan?.removedStarter, true);
    assert.deepEqual(result.plan?.fields, {
        employee_code: { type: "string", required: true, nullable: false },
        Employee_Name: { type: "string", required: true, nullable: false },
        enabled: { type: "boolean", required: true, nullable: false },
        score: { type: "number", required: true, nullable: false },
        department: { type: "string", required: true, nullable: false },
        empty: { type: "string", required: false, nullable: false },
    });
    assert.deepEqual(result.rows, [
        {
            key: "id_001",
            values: {
                employee_code: "001",
                Employee_Name: "Ada",
                enabled: true,
                score: 2,
                department: "operations",
                empty: "",
            },
        },
        {
            key: "id_010",
            values: {
                employee_code: "010",
                Employee_Name: "Bo",
                enabled: false,
                score: 3.5,
                department: "42",
                empty: "",
            },
        },
    ]);
    assert.deepEqual(starter.fields, { name: { type: "string", required: true, nullable: false } });
    assert.deepEqual(starter.source.rows, [{ key: "row_1", values: { name: "" } }]);
});

/**
 * 工作簿显式文本与实际数值使用不同的推断证据，日期保留标准文本且缺少单元格时不把它补成数字零。
 */
test("Excel infers typed cells without recasting worksheet text and dates", () => {
    const empty = { ...dataset, fields: {} };
    const result = parseDatasetSpreadsheet(
        [
            ["ID", "number", "text", "日期", "enabled"],
            [1, 2, "003", new Date("2026-01-05T00:00:00.000Z"), true],
            [2, null, "42", null, false],
        ],
        empty,
    );
    assert.deepEqual(result.issues, []);
    assert.equal(result.plan?.rowKey, "ID");
    assert.deepEqual(
        result.plan?.columns.find(({ header }) => header === "日期"),
        {
            header: "日期",
            field: "column_4",
            type: "string",
        },
    );
    assert.deepEqual(result.plan?.fields.number, { type: "integer", required: false, nullable: false });
    assert.deepEqual(result.rows, [
        {
            key: "id_1",
            values: { ID: "1", number: 2, text: "003", column_4: "2026-01-05T00:00:00.000Z", enabled: true },
        },
        { key: "id_2", values: { ID: "2", text: "42", column_4: "", enabled: false } },
    ]);
});

/**
 * 显式元数据优先于推断，候选列有歧义时生成稳定键，选定后的重复、空白和非法键必须阻止应用。
 */
test("tabular imports prefer explicit keys and reject unusable inferred keys", () => {
    const empty = { ...dataset, fields: {} };
    const explicit = parseDatasetImport("CSV", "key,ID,employee_code\nmanual,001,002", empty);
    assert.equal(explicit.plan?.rowKey, "key");
    assert.deepEqual(explicit.rows, [{ key: "manual", values: { ID: "001", employee_code: "002" } }]);
    const ambiguous = parseDatasetImport("CSV", "user_id,team_id\nu,t\nv,s", empty);
    assert.equal(ambiguous.plan?.rowKey, null);
    assert.deepEqual(
        ambiguous.rows.map(({ key }) => key),
        ["row_1", "row_2"],
    );
    for (const text of ["id,label\n001,first\n001,second", "id,label\n,missing", "id,label\na/b,illegal"]) {
        const rejected = parseDatasetImport("CSV", text, empty);
        assert.equal(rejected.plan, undefined);
        assert.deepEqual(rejected.rows, []);
        assert.ok(rejected.issues.length);
    }
});

/**
 * 结构化值经过保真回写才推断为对象或数组，重复属性、过长整数和小数舍入会退回文字并保留原始拼写。
 */
test("CSV inference preserves ambiguous numbers and JSON as strings", () => {
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const data = [
        '["first",false]',
        '{"active":true}',
        '{"active":true,"active":false}',
        "[9007199254740992]",
        "0.12345678901234567890",
        "1.5E-3",
    ];
    const result = parseDatasetImport(
        "CSV",
        `list,object,duplicate,big,precision,scientific\n${data.map(quote).join(",")}`,
        { ...dataset, fields: {} },
    );
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.rows, [
        {
            key: "row_1",
            values: {
                list: ["first", false],
                object: { active: true },
                duplicate: data[2],
                big: data[3],
                precision: data[4],
                scientific: 0.0015,
            },
        },
    ]);
});

/**
 * 推断只补齐新字段，不以文件内容改写已有类型或忽略必填字段，并对规范化后会冲突的列关闭整个导入。
 */
test("CSV inference preserves declared fields and rejects normalized header collisions", () => {
    const declared = {
        ...dataset,
        fields: { name: { type: "string" as const, required: true, nullable: false } },
    };
    const existing = parseDatasetImport("CSV", "name,score\n123,4", declared);
    assert.deepEqual(existing.plan?.fields.name, declared.fields.name);
    assert.deepEqual(existing.rows, [{ key: "row_1", values: { name: "123", score: 4 } }]);
    const absent = parseDatasetImport("CSV", "score\n4", declared);
    assert.equal(absent.plan, undefined);
    assert.deepEqual(absent.issues, [{ row: 2, field: "name", code: "DATASET_REQUIRED_FIELD_MISSING" }]);
    const collision = parseDatasetImport("CSV", "Employee Name,Employee_Name\nAda,Bo", declared);
    assert.deepEqual(collision.issues, [{ row: 1, field: "Employee_Name", code: "DUPLICATE_COLUMN" }]);
});

/**
 * 导出的文件可能在表头前后包含独立空行，记录应使用第一条实际表头，并保留带引号的空字符串及原始诊断行号。
 */
test("CSV finds headers after blank lines without discarding quoted empty values", () => {
    const empty = { ...dataset, fields: {} };
    const result = parseDatasetImport("CSV", '\r\n \t\r\nName\r\n""\r\nAda\r\n\r\n', empty);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.plan?.fields, { Name: { type: "string", required: false, nullable: false } });
    assert.deepEqual(result.rows, [
        { key: "row_1", values: { Name: "" } },
        { key: "row_2", values: { Name: "Ada" } },
    ]);
    assert.equal(parseDatasetImport("CSV", '\n\nname\n"broken', empty).issues[0]?.row, 4);
    assert.equal(parseDatasetImport("CSV", "\n\nname,name\nAda,Bo", empty).issues[0]?.row, 3);
});

/**
 * 树导入仍要求明确指定父节点与顺序，若标识列用作行键，父引用使用同一映射以保留原始树结构。
 */
test("tree inference maps identifier-derived keys and parent references consistently", () => {
    const tree: DatasetV2 = { ...dataset, shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const result = parseDatasetImport("CSV", "id,parentKey,order\n001,,0\n002,001,1", tree);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.rows, [
        { key: "id_001", parentKey: null, order: 0, values: { id: "001" } },
        { key: "id_002", parentKey: "id_001", order: 1, values: { id: "002" } },
    ]);
    assert.deepEqual(parseDatasetImport("CSV", "id,name\n001,Ada", tree).issues, [
        { row: 1, field: "parentKey", code: "MISSING_COLUMN" },
    ]);
});

/**
 * 部门表有两列父标识时只把明确的 parent 用于树结构，同级排序按对应父组独立计算且保留原业务列。
 */
test("department Excel uses parent and generates separate sibling orders in file order", () => {
    const tree: DatasetV2 = { ...dataset, shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const result = parseDatasetSpreadsheet(
        [
            ["parent", "id", "dept_code", "dept_parent"],
            [null, "001", "A", null],
            ["001", "003", "A1", "A"],
            [null, "002", "B", null],
            ["002", "004", "B1", "B"],
            ["001", "005", "A2", "A"],
        ],
        tree,
    );
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.plan?.tree, { parentKey: "parent", order: null });
    assert.deepEqual(result.rows, [
        {
            key: "id_001",
            parentKey: null,
            order: 0,
            values: { parent: "", id: "001", dept_code: "A", dept_parent: "" },
        },
        {
            key: "id_003",
            parentKey: "id_001",
            order: 0,
            values: { parent: "001", id: "003", dept_code: "A1", dept_parent: "A" },
        },
        {
            key: "id_002",
            parentKey: null,
            order: 1,
            values: { parent: "", id: "002", dept_code: "B", dept_parent: "" },
        },
        {
            key: "id_004",
            parentKey: "id_002",
            order: 0,
            values: { parent: "002", id: "004", dept_code: "B1", dept_parent: "B" },
        },
        {
            key: "id_005",
            parentKey: "id_001",
            order: 1,
            values: { parent: "001", id: "005", dept_code: "A2", dept_parent: "A" },
        },
    ]);
});

/**
 * 显式行键、父节点和顺序优先于推断，未被用作树结构的 parent 仍按普通字段导入而不影响关系。
 */
test("tree CSV prefers explicit key, parentKey and order over competing aliases", () => {
    const tree: DatasetV2 = { ...dataset, shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const csv = "key,id,parentKey,parent,order\nroot,001,,ignore,12\nleaf,002,root,also_ignore,5";
    const result = parseDatasetImport("CSV", csv, tree);
    assert.deepEqual(result.issues, []);
    assert.equal(result.plan?.rowKey, "key");
    assert.deepEqual(result.plan?.tree, { parentKey: "parentKey", order: "order" });
    assert.deepEqual(result.rows, [
        { key: "root", parentKey: null, order: 12, values: { id: "001", parent: "ignore" } },
        { key: "leaf", parentKey: "root", order: 5, values: { id: "002", parent: "also_ignore" } },
    ]);
});

/**
 * 裸 parent 列映射后的树仍检查孤儿和循环，显式限定的业务列以及仅相似的列名不会被猜作父引用。
 */
test("tree alias import rejects invalid hierarchy and ambiguous parent sources", () => {
    const tree: DatasetV2 = { ...dataset, shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const examples = [
        ["id,parent\n001,999", "DATASET_ORPHAN_NODE"],
        ["id,parent\n001,002\n002,001", "DATASET_TREE_CYCLE"],
        ["id,values.parent\n001,", "MISSING_COLUMN"],
        ["id,dept_parent\n001,", "MISSING_COLUMN"],
    ];
    for (const [csv, code] of examples) {
        const result = parseDatasetImport("CSV", csv ?? "", tree);
        assert.deepEqual(result.rows, []);
        assert.equal(result.issues[0]?.code, code);
    }
});

/**
 * 数字单元格的原始文本使超出安全整数范围的标识不会先被浮点舍入，两条真实标识因此可以生成不同的行键。
 */
test("Excel preserves unrounded identifier lexemes from raw numeric cells", () => {
    const identifiers = ["9007199254740992", "9007199254740993"];
    const result = parseDatasetSpreadsheet([["employee_id"], ...identifiers.map((numberText) => [{ numberText }])], {
        ...dataset,
        fields: {},
    });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(
        result.rows,
        identifiers.map((identifier) => ({
            key: `id_${identifier}`,
            values: { employee_id: identifier },
        })),
    );
});

/**
 * 数值型单元格保留工作簿自己的十进制拼写，不用 CSV 的 JSON 数字词法拒绝正号、前置小数点或树节点顺序。
 */
test("Excel accepts native decimal spelling for declared numbers and tree order", () => {
    const tree: DatasetV2 = {
        ...dataset,
        shape: "TREE",
        fields: { score: { type: "number", required: true, nullable: false } },
        source: { kind: "STATIC", rows: [] },
    };
    const result = parseDatasetSpreadsheet(
        [
            ["id", "parentKey", "order", "score", "second"],
            ["-5", null, { numberText: "+1" }, { numberText: ".5" }, { numberText: "1." }],
        ],
        tree,
    );
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.rows, [
        { key: "id_-5", parentKey: null, order: 1, values: { id: "-5", score: 0.5, second: 1 } },
    ]);
});

/**
 * 数字已经声明时也要核对输入与回写是否等值，防止同一文件重导入后把不可精确表示的列值静默舍入。
 */
test("declared CSV and Excel numbers reject decimal rounding but preserve exact spellings", () => {
    const declared = {
        ...dataset,
        fields: { score: { type: "number" as const, required: true, nullable: false } },
    };
    for (const text of ["0.10000000000000001", "9007199254740993", "1e-5000", "1e999"]) {
        const csv = parseDatasetImport("CSV", `key,score\nr,${text}`, declared);
        const excel = parseDatasetSpreadsheet(
            [
                ["key", "score"],
                ["r", { numberText: text }],
            ],
            declared,
        );
        for (const result of [csv, excel]) {
            assert.deepEqual(result.rows, []);
            assert.deepEqual(result.issues, [{ row: 2, field: "score", code: "DATASET_FIELD_TYPE_MISMATCH" }]);
        }
    }
    const exact = `0.1${"0".repeat(100)}`;
    assert.deepEqual(parseDatasetImport("CSV", `key,score\nr, \t${exact} \t`, declared).rows, [
        { key: "r", values: { score: 0.1 } },
    ]);
    assert.deepEqual(
        parseDatasetSpreadsheet(
            [
                ["key", "score"],
                ["r", { numberText: "+000.10" }],
            ],
            declared,
        ).rows,
        [{ key: "r", values: { score: 0.1 } }],
    );
});

/**
 * 顺序是直接用于树结构的数字元数据，转换规则必须与已声明字段一致，并指向出现精度问题的原始行和列。
 */
test("tree order rejects lossy numeric spellings in CSV and Excel", () => {
    const tree: DatasetV2 = { ...dataset, shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const text = "0.10000000000000001";
    const csv = parseDatasetImport("CSV", `key,parentKey,order\nr,,${text}`, tree);
    const excel = parseDatasetSpreadsheet(
        [
            ["key", "parentKey", "order"],
            ["r", null, { numberText: text }],
        ],
        tree,
    );
    for (const result of [csv, excel]) {
        assert.deepEqual(result.rows, []);
        assert.deepEqual(result.issues, [{ row: 2, field: "order", code: "DATASET_FIELD_TYPE_MISMATCH" }]);
    }
});

/**
 * 空工作表不能应用为清空操作，声称为数字的损坏单元格也不能在推断阶段静默转成正常的文本字段。
 */
test("Excel rejects absent headers and malformed numeric cell contents", () => {
    for (const sheet of [[], [[]], [["score"], [{ numberText: "invalid" }]]]) {
        const result = parseDatasetSpreadsheet(sheet, dataset);
        assert.equal(result.plan, undefined);
        assert.deepEqual(result.rows, []);
        assert.ok(result.issues.length);
    }
});

/**
 * 工作簿的数字和布尔单元格按字段类型读取，字面文本和子父标识保持完整，中间空白行不改变实际报错位置。
 */
test("Excel maps typed tree rows, literal texts and original worksheet row numbers", () => {
    const tree: DatasetV2 = {
        ...dataset,
        shape: "TREE",
        fields: { ...dataset.fields, active: { type: "boolean", required: true, nullable: false } },
    };
    const header = ["key", "parentKey", "order", "__proto__", "a.b", "active"];
    const root = ["root", null, 0, "001\r\n a ", null, true];
    const leaf = ["leaf", "root", 1, "002", 0, false];
    assert.deepEqual(parseDatasetSpreadsheet([header, root, [null], leaf], tree), {
        rows: [
            { key: "root", parentKey: null, order: 0, values: { ["__proto__"]: "001\r\n a ", active: true } },
            { key: "leaf", parentKey: "root", order: 1, values: { ["__proto__"]: "002", "a.b": 0, active: false } },
        ],
        issues: [],
        plan: {
            fields: tree.fields,
            columns: [
                { header: "__proto__", field: "__proto__", type: "string" },
                { header: "a.b", field: "a.b", type: "integer" },
                { header: "active", field: "active", type: "boolean" },
            ],
            rowKey: "key",
            removedStarter: false,
            tree: { parentKey: "parentKey", order: "order" },
        },
    });
    const invalid = parseDatasetSpreadsheet([header, root, [null], [...leaf.slice(0, 5), "bad"]], tree);
    assert.deepEqual(invalid.rows, []);
    assert.deepEqual(invalid.issues, [{ row: 4, field: "active", code: "DATASET_FIELD_TYPE_MISMATCH" }]);
    const orphan = parseDatasetSpreadsheet([header, root, [null], ["leaf", "missing", ...leaf.slice(2)]], tree);
    assert.deepEqual(orphan.rows, []);
    assert.deepEqual(orphan.issues, [{ row: 4, field: "parentKey", code: "DATASET_ORPHAN_NODE" }]);
});

/**
 * 校验可与原型属性重名的字段以及含点的字段，空串必须保留而可选数字留空应产生真正缺失的属性。
 */
test("CSV preserves quoted strings, empty strings, absent integers and literal field names", () => {
    const result = parseDatasetImport("CSV", 'key,__proto__,a.b\r\na,"comma, ""x""\r\ny",0\r\nb,,  \r\n', dataset);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.rows, [
        { key: "a", values: { ["__proto__"]: 'comma, "x"\r\ny', "a.b": 0 } },
        { key: "b", values: { ["__proto__"]: "" } },
    ]);
});

/**
 * 从结构化行数组导入显式空值并拒绝类型错配；失败的候选行整体不可用，调用方始终能继续读取原始数据。
 */
test("JSON keeps explicit null and rejects bad types", () => {
    const row = { key: "a", values: { ["__proto__"]: "", "a.b": null } };
    assert.deepEqual(parseDatasetImport("JSON", JSON.stringify([row]), dataset), { rows: [row], issues: [] });
    const invalid = parseDatasetImport(
        "JSON",
        JSON.stringify([row, { ...row, values: { ...row.values, "a.b": "1" } }]),
        dataset,
    );
    assert.deepEqual(invalid.rows, []);
    assert.ok(invalid.issues.some((issue) => issue.row === 2 && issue.field === "a.b"));
});

/**
 * 来自普通业务数组的字段名遵循与表格相同的映射规则，原生类型、空值和缺失值共同决定新字段的声明。
 */
test("JSON infers types and row keys from plain objects", () => {
    const empty = { ...dataset, fields: {} };
    const input = [
        { id: "001", "Team Name": "East", score: 2, mixed: true, array: [1], object: { active: true } },
        { id: "010", "Team Name": null, score: 2.5, mixed: "known", flag: false, absent: null },
    ];
    const result = parseDatasetImport("JSON", JSON.stringify(input), empty);
    assert.deepEqual(result.issues, []);
    assert.equal(result.plan?.rowKey, "id");
    assert.deepEqual(result.plan?.fields, {
        id: { type: "string", required: true, nullable: false },
        Team_Name: { type: "string", required: true, nullable: true },
        score: { type: "number", required: true, nullable: false },
        mixed: { type: "string", required: true, nullable: false },
        array: { type: "array", required: false, nullable: false },
        object: { type: "object", required: false, nullable: false },
        flag: { type: "boolean", required: false, nullable: false },
        absent: { type: "string", required: false, nullable: true },
    });
    assert.deepEqual(result.rows, [
        {
            key: "id_001",
            values: { id: "001", Team_Name: "East", score: 2, mixed: "true", array: [1], object: { active: true } },
        },
        {
            key: "id_010",
            values: { id: "010", Team_Name: null, score: 2.5, mixed: "known", flag: false, absent: null },
        },
    ]);
});

/**
 * 原有结构化行仍按显式键入库，推断只为未知值补充声明，表单初建的占位数据不会要求用户先手动删除。
 */
test("JSON infers additional fields in structured rows and removes a blank starter", () => {
    const starter: DatasetV2 = {
        schemaVersion: "2.0",
        shape: "TABLE",
        fields: { name: { type: "string", required: true, nullable: false } },
        source: { kind: "STATIC", rows: [{ key: "row_1", values: { name: "" } }] },
    };
    const rows = [{ key: "explicit", values: { ["__proto__"]: true, score: 3 } }];
    const result = parseDatasetImport("JSON", JSON.stringify(rows), starter);
    assert.deepEqual(result.issues, []);
    assert.equal(result.plan?.removedStarter, true);
    assert.deepEqual(result.plan?.fields, {
        ["__proto__"]: { type: "boolean", required: true, nullable: false },
        score: { type: "integer", required: true, nullable: false },
    });
    assert.deepEqual(result.rows, rows);
    assert.deepEqual(Object.keys(starter.fields), ["name"]);
});

/**
 * 树形对象使用同一个标识映射生成行键和父引用，排序缺省时也要复用已有树约束并验证父节点真实存在。
 */
test("plain JSON tree rows infer parent links and preserve invalid-parent diagnostics", () => {
    const tree: DatasetV2 = { ...dataset, shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const rows = [
        { id: 1, parent: null, label: "root" },
        { id: 2, parent: 1, label: "leaf" },
        { id: 3, parent: 1, label: "last" },
    ];
    const result = parseDatasetImport("JSON", JSON.stringify(rows), tree);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.plan?.tree, { parentKey: "parent", order: null });
    assert.deepEqual(result.rows, [
        { key: "id_1", parentKey: null, order: 0, values: rows[0] },
        { key: "id_2", parentKey: "id_1", order: 0, values: rows[1] },
        { key: "id_3", parentKey: "id_1", order: 1, values: rows[2] },
    ]);
    const orphan = parseDatasetImport("JSON", JSON.stringify([rows[0], { ...rows[1], parent: 4 }]), tree);
    assert.deepEqual(orphan.issues, [{ row: 2, field: "parentKey", code: "DATASET_ORPHAN_NODE" }]);

    const unsafeReference = parseDatasetImport(
        "JSON",
        '[{"id":"9007199254740992","parentKey":null},{"id":"child","parentKey":9007199254740993}]',
        tree,
    );
    assert.deepEqual(unsafeReference, { rows: [], issues: [{ row: 2, field: "row", code: "INVALID_JSON" }] });
});

/**
 * 扁平导入仍按已存在的字段声明拒绝错配和缺失，混合新字段也不能用字符串回退吞掉不可保存的原生值。
 */
test("JSON inference never recasts declared fields or hides unportable mixed values", () => {
    const declared = {
        ...dataset,
        fields: { score: { type: "number" as const, required: true, nullable: false } },
    };
    const wrongType = parseDatasetImport("JSON", '[{"id":"a","score":"3"}]', declared);
    assert.deepEqual(wrongType.issues, [{ row: 1, field: "score", code: "DATASET_FIELD_TYPE_MISMATCH" }]);
    const missing = parseDatasetImport("JSON", '[{"id":"a","flag":true}]', declared);
    assert.deepEqual(missing.issues, [{ row: 1, field: "score", code: "DATASET_REQUIRED_FIELD_MISSING" }]);
    for (const badValue of ["1e999", '{"number":9007199254740993}', '{"text":"\\ud800"}']) {
        const source = `[{"mixed":${badValue}},{"mixed":"ordinary text"}]`;
        const result = parseDatasetImport("JSON", source, { ...dataset, fields: {} });
        assert.deepEqual(result.rows, []);
        assert.deepEqual(result.issues, [{ row: 1, field: "JSON", code: "INVALID_JSON" }]);
    }
});

/**
 * 原始文本保留多字节字符和格式空白的真实长度，恰好达到上限的粘贴数据仍能正常解析为可应用的记录。
 */
test("accepts 10 MiB of UTF-8 paste and rejects one excess byte", () => {
    const row = { key: "a", values: { ["__proto__"]: "文", "a.b": null } };
    const limit = 10 * 1024 * 1024;
    const input = JSON.stringify([row]);
    const pasted = " ".repeat(limit - Buffer.byteLength(input)) + input;
    assert.deepEqual(parseDatasetImport("JSON", pasted, dataset), { rows: [row], issues: [] });
    assert.deepEqual(parseDatasetImport("JSON", pasted + " ", dataset), {
        rows: [],
        issues: [{ row: 1, field: "JSON", code: "DATASET_SIZE_LIMIT" }],
    });
});

/**
 * 候选文档包含字段声明和完整资源封装，验证实际可保存的规范字节边界，避免只按原始行数组的大小放行。
 */
test("accepts a 10 MiB canonical draft and rejects a smaller input that expands past that limit", () => {
    const limit = 10 * 1024 * 1024;
    const draft = (value: string) => ({
        kind: "DATASET",
        document: { ...dataset, source: { kind: "STATIC", rows: [{ key: "a", values: { ["__proto__"]: value } }] } },
    });
    const available = limit - canonicalBytes(draft("")).byteLength;
    const value = "文".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
    const atLimit = draft(value);
    assert.equal(canonicalBytes(atLimit).byteLength, limit);
    const accepted = parseDatasetImport("JSON", JSON.stringify(atLimit.document.source.rows), dataset);
    assert.deepEqual(accepted.issues, []);
    assert.equal(accepted.rows[0]?.values.__proto__, value);

    const aboveLimitInput = JSON.stringify(draft(value + "x").document.source.rows);
    assert.ok(Buffer.byteLength(aboveLimitInput) <= limit);
    assert.deepEqual(parseDatasetImport("JSON", aboveLimitInput, dataset), {
        rows: [],
        issues: [{ row: 1, field: "JSON", code: "DATASET_SIZE_LIMIT" }],
    });

    const dense = "[" + "{},".repeat(480_000) + "{}]";
    assert.deepEqual(parseDatasetImport("JSON", dense, { ...dataset, fields: {} }), {
        rows: [],
        issues: [{ row: 1, field: "JSON", code: "DATASET_SIZE_LIMIT" }],
    });
});

/**
 * 逐项覆盖文本转换不能容忍的歧义，尤其是必填数字的空格不能通过数字构造函数误转换为合法的零。
 */
test("CSV fails closed on invalid quoting, record width, numbers and blank required numbers", () => {
    const numeric = { ...dataset, fields: { n: { type: "number" as const, required: true, nullable: false } } };
    for (const text of ['key,n\na,"1', "key,n\na,1,2", "key,n\na,1e999", "key,n\na, "]) {
        const result = parseDatasetImport("CSV", text, numeric);
        assert.deepEqual(result.rows, []);
        assert.equal(result.issues[0]?.row, 2);
    }
});

/**
 * 合理大小的文本在展开行对象后可能超过资源预算。按候选文档的实际编码字节计算，避免预检通过后才发现无法应用。
 */
test("enforces candidate budget even for compact CSV", () => {
    const escaped = "\t".repeat(5 * 1024 * 1024);
    const result = parseDatasetImport("CSV", 'key,__proto__\na,"' + escaped + '"', dataset);
    assert.deepEqual(result.rows, []);
    assert.equal(result.issues[0]?.code, "DATASET_SIZE_LIMIT");
});

/**
 * 引用后面的父节点可以成功，环和过深的树则必须复用编译器的稳定诊断；字段错误也须定位到对应的行。
 */
test("tree checks preserve forward references, detect cycles and enforce depth", () => {
    const tree: DatasetV2 = { schemaVersion: "2.0", shape: "TREE", fields: {}, source: { kind: "STATIC", rows: [] } };
    const rows = Array.from({ length: 101 }, (_, i) => ({
        key: "r" + i,
        parentKey: i === 0 ? null : "r" + (i - 1),
        order: 0,
        values: {},
    }));
    const deep = parseDatasetImport("JSON", JSON.stringify(rows), tree);
    assert.deepEqual(deep.issues, [{ row: 101, field: "parentKey", code: "DATASET_TREE_DEPTH_LIMIT" }]);
    assert.equal(
        parseDatasetImport("CSV", "key,parentKey,order\na,b,1\nb,a,0", tree).issues[0]?.code,
        "DATASET_TREE_CYCLE",
    );
    assert.deepEqual(parseDatasetImport("CSV", "key,parentKey,order\na,b,1\nb,,0", tree).issues, []);
});

/**
 * 行结构缺失属性与额外属性均应显示原始键，含斜线和波浪号的未声明值不向用户展示指针转义文本。
 */
test("JSON issues identify missing and extra keys and decode pointer tokens", () => {
    const parse = (row: unknown) => parseDatasetImport("JSON", JSON.stringify([row]), dataset).issues;
    assert.ok(parse({ values: {} }).some((i) => i.field === "key"));
    assert.ok(parse({ key: "a", values: {}, "x/~odd": true }).some((i) => i.field === "x/~odd"));
    assert.ok(parse({ key: "a", values: { ["__proto__"]: "", "x/~odd": true } }).some((i) => i.field === "x/~odd"));
});

/**
 * 跨行文本上的闭引号错误、未闭引号都指向物理起始行及当前字段，不能误报引号所在的下一物理行。
 */
test("malformed CSV quotes identify record start and offending column", () => {
    for (const ending of ['a,"one\ntwo"oops,1', 'a,"one\ntwo']) {
        assert.deepEqual(parseDatasetImport("CSV", "key,__proto__,a.b\n" + ending, dataset).issues, [
            { row: 2, field: "__proto__", code: "INVALID_CSV" },
        ]);
    }
});

/**
 * 显式限定字段列以区分行元数据，重复检查使用解析后的业务键，因此两种等价拼写不能覆盖彼此。
 */
test("qualified CSV headers distinguish row metadata and literal dotted field names", () => {
    const fields = Object.fromEntries(
        ["key", "parentKey", "order", "values.foo", "a.b"].map((k) => [
            k,
            { type: "string" as const, required: true, nullable: false },
        ]),
    );
    const tree: DatasetV2 = { schemaVersion: "2.0", shape: "TREE", fields, source: { kind: "STATIC", rows: [] } };
    const header = "key,parentKey,order,values.key,values.parentKey,values.order,values.values.foo,a.b";
    assert.deepEqual(parseDatasetImport("CSV", header + "\nr,,3,k,p,o,f,ab", tree), {
        rows: [
            {
                key: "r",
                parentKey: null,
                order: 3,
                values: { key: "k", parentKey: "p", order: "o", "values.foo": "f", "a.b": "ab" },
            },
        ],
        issues: [],
        plan: {
            fields,
            columns: header
                .split(",")
                .slice(3)
                .map((source) => ({
                    header: source,
                    field: source.replace(/^values\./u, ""),
                    type: "string",
                })),
            rowKey: "key",
            removedStarter: false,
            tree: { parentKey: "parentKey", order: "order" },
        },
    });
    assert.deepEqual(parseDatasetImport("CSV", header + ",values.a.b", tree).issues, [
        { row: 1, field: "a.b", code: "DUPLICATE_COLUMN" },
    ]);
});

/**
 * 输入包含转义的孤立代理项时，原始文本仍可由 JSON 解析，预检必须与服务端规范化字节约束保持一致。
 */
test("JSON rejects unpaired UTF-16 instead of accepting a draft the server cannot save", () => {
    const text = JSON.stringify([{ key: "a", values: { ["__proto__"]: "\ud800" } }]);
    const result = parseDatasetImport("JSON", text, dataset);
    assert.deepEqual(result.rows, []);
    assert.ok(result.issues.length);
});

/**
 * 结构错误、字段语义错误及宽表头都只保留界面能够显示的问题，任意未展示错误都不能使导入结果含有可应用的行。
 */
test("crowded imports keep the first hundred diagnostics and reject all rows", () => {
    const semantic = Array.from({ length: 2400 }, (_, i) => ({ key: "r" + i, values: { "a.b": "invalid" } }));
    const extras = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => ["extra" + i, 0]));
    for (const [format, input, lastRow, lastField] of [
        ["JSON", JSON.stringify(Array(2400).fill(null)), 100, "row"],
        ["JSON", JSON.stringify(semantic), 50, "__proto__"],
        ["JSON", JSON.stringify([{ key: "r", values: {}, ...extras }]), 1, "extra99"],
        ["CSV", ["key", ...Array(1200).fill("bad")].join(","), 1, "bad"],
    ] as const) {
        const result = parseDatasetImport(format, input, dataset);
        assert.deepEqual(result.rows, []);
        assert.equal(result.issues.length, 100);
        assert.equal(result.issues[0]?.row, 1);
        assert.equal(result.issues.at(-1)?.row, lastRow);
        assert.equal(result.issues.at(-1)?.field, lastField);
    }
});
