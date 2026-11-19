import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { validateSchema, type ElementCatalogV1 } from "../src/index.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sample = JSON.parse(
    execFileSync(
        root + "apps/srv/.venv/bin/python",
        [
            "-c",
            "import json; from veriq_server.examples.resources import sample_package; " +
                "print(json.dumps(sample_package()))",
        ],
        { cwd: root, encoding: "utf8" },
    ),
) as {
    manifest: { order: string[]; versionAliases: Record<string, string> };
    assets: Record<string, { document: unknown }>;
    sourceInventory: Record<string, string>;
};

/**
 * 示例接口返回带种类的资产信封，定位契约应校验其中的目录正文，避免只检查外层字段而漏掉真实标记迁移。
 */
test("packaged sample catalog document satisfies the current locator contract", () => {
    expect(validateSchema("ElementCatalogV1", sample.assets.catalog!.document)).toEqual([]);
});

test("mirrored sample catalog document satisfies the current locator contract", () => {
    const mirror = JSON.parse(readFileSync(root + "fixtures/sample-workspace/assets/catalog.json", "utf8"));
    expect(validateSchema("ElementCatalogV1", mirror.document)).toEqual([]);
});

test("sample catalogs reject the retired locator discriminator without an alias", () => {
    const catalog = structuredClone(sample.assets.catalog!.document) as ElementCatalogV1;
    const legacy = { ...catalog, elements: [{ ...catalog.elements[0], locator: { by: "testId", value: "name" } }] };
    expect(validateSchema("ElementCatalogV1", legacy)).not.toEqual([]);
});

/**
 * 安装包读取器计算的库存须对应真实源码字节，仓库兼容副本也须逐字节相同，不能用重新序列化掩盖两份资源漂移。
 */
test("sample package inventory binds every mirrored manifest and asset byte", () => {
    for (const [path, hash] of Object.entries(sample.sourceInventory)) {
        const packaged = readFileSync(root + "apps/srv/src/veriq_server/examples/data/" + path);
        expect(createHash("sha256").update(packaged).digest("hex"), path).toBe(hash);
        expect(readFileSync(root + "fixtures/sample-workspace/" + path).equals(packaged), path).toBe(true);
    }
    expect(Object.keys(sample.sourceInventory).sort()).toEqual(
        ["manifest.json", ...sample.manifest.order.map((key) => `assets/${key}.json`)].sort(),
    );
});

test("sample case references retain manifest aliases and catalog targets", () => {
    const document = sample.assets.case!.document as {
        catalogVersionId: string;
        datasetVersionId: string;
        fixtureVersionId: string;
        steps: { target?: string; versionId?: string; afterAssertions?: { target?: string }[] }[];
    };
    for (const key of ["catalog", "dataset", "fixture"] as const) {
        expect(document[`${key}VersionId`]).toBe(sample.manifest.versionAliases[key]);
    }
    expect(document.steps.find((step) => step.versionId)?.versionId).toBe(sample.manifest.versionAliases.flow);
    const catalog = sample.assets.catalog!.document as ElementCatalogV1;
    const targets = new Set(catalog.elements.map((element) => element.key));
    for (const step of document.steps) {
        if (step.target) expect(targets.has(step.target)).toBe(true);
        for (const assertion of step.afterAssertions ?? []) {
            if (assertion.target) expect(targets.has(assertion.target)).toBe(true);
        }
    }
});
