import { isAbsolute, resolve } from "node:path";
import { loadRelease } from "../../apps/runtime/src/execution/release.ts";

/** 测试启动器只能成组选择独立候选目录、版本与预期规范摘要，三个值全部来自运维测试环境；默认保留已记录的旧候选身份，覆盖时仍逐字节验证完整库存，不能让 renderer 或业务请求决定发行信任。 */
export async function testEngine(root: string, environment: NodeJS.ProcessEnv = process.env) {
    const supplied = [
        environment.VERIQ_TEST_ENGINE_DIRECTORY,
        environment.VERIQ_TEST_ENGINE_VERSION,
        environment.VERIQ_TEST_ENGINE_HASH,
    ];
    if (
        supplied.some((value) => value !== undefined) &&
        !supplied.every((value) => value !== undefined && value !== "")
    )
        throw new Error("INCOMPLETE_TEST_ENGINE");
    const [directory, version, hash] = supplied.every((value) => value !== undefined)
        ? (supplied as [string, string, string])
        : [
              resolve(root, "work/t18-engine-verified"),
              "1.0.0",
              "4ac7053892d4dbeb957fbda59d9b70dd13a1b5b4ea3ea7acce310b9bfc431bcd",
          ];
    if (
        !isAbsolute(directory) ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
        !/^[a-f0-9]{64}$/.test(hash)
    )
        throw new Error("INVALID_TEST_ENGINE");
    const release = await loadRelease(directory, version);
    if (release.inventoryHash !== hash) throw new Error("TEST_ENGINE_HASH_MISMATCH");
    return { directory, version, hash };
}
