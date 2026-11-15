/** 原生 D1 测试调用器只能启动构建脚本约定的固定成员，并把私有协议内容保存在内存中；它不授予正式 Runtime 发行能力、不修改宿主凭据后端，也不把独立测试通路误称为已安装产品接入。 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, lstat } from "node:fs/promises";

/** 固定路径只供本测试模块内部验证构建成员使用，正式发行仍必须由既有库存解析器授权；其中测试辅助程序与控制器位于独立目录，任何业务配置均不能通过这里替换生产可执行程序。 */
export const nativePaths = Object.freeze({
    production: fileURLToPath(new URL("../../build/vault-darwin/veriq_agent", import.meta.url)),
    test: fileURLToPath(new URL("../../build/vault-darwin-test/veriq_agent", import.meta.url)),
    controller: fileURLToPath(
        new URL("../../build/vault-darwin-test/veriq_keychain_controller", import.meta.url),
    ),
    memory: fileURLToPath(new URL("../../build/vault-darwin-test/veriq_acl_test", import.meta.url)),
});

/** 目标操作必须在真实 Mac 进程中开始，Linux 开发环境只能进行语法或类型验证；抛出的静态错误保留缺少实际目标的事实，既不自动下载工具链，也不将整组跳过计作原生通过。 */
export function requireMac() {
    if (process.platform !== "darwin" || !["x64", "arm64"].includes(process.arch))
        throw new Error("DARWIN_VAULT_TARGET_REQUIRED");
}

/** 独立测试调用选项仅描述固定构建成员的协议输入、继承配置以及取消观察，不作为正式凭据后端的能力对象；期限始终限制在五十到五千毫秒，测试门闩与额外参数负例不会进入生产可执行程序的运行选择接口。 */
type Options = {
    args?: string[];
    capability?: object | undefined;
    closeInput?: boolean;
    afterReady?: "eof" | "extra";
    timeoutMs?: number;
    cancel?: boolean;
};
/** 调用观察把实际 close 确认、退出码和停止原因分别记录，不能由超时信号推导 exitConfirmed；响应缓冲只供调用者在内存中验证并随后覆盖，原始 stderr 和系统异常对象不属于此公开测试结果类型。 */
type Observation = {
    code: number | null;
    exitConfirmed: boolean;
    reason: "complete" | "timeout" | "cancelled" | "protocol";
    bytes: Buffer;
    ready: boolean;
};

/** 测试管道沿用正式协议的单帧与五秒上限，并独立等待 close 事实才完成调用；超时只终止本次子进程，任何秘密响应在断言前转换为布尔或固定状态，原始标准错误完全不进入测试报告。 */
export async function nativeCall(
    path: string,
    frame: string,
    options: Options = {},
): Promise<Observation> {
    requireMac();
    if (!Object.values(nativePaths).includes(path)) throw new Error("DARWIN_VAULT_MEMBER_INVALID");
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 5000)
        throw new Error("DARWIN_VAULT_DEADLINE_INVALID");
    return await new Promise((resolve, reject) => {
        const child = spawn(path, options.args ?? [], {
            env: { PATH: "/usr/bin:/bin" },
            stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        let reason: Observation["reason"] = "complete",
            ready = false,
            bytes = Buffer.alloc(0),
            stderr = 0;
        let killWatch: NodeJS.Timeout | undefined;
        const stop = (why: Observation["reason"]) => {
            if (reason !== "complete") return;
            reason = why;
            child.kill("SIGKILL");
            killWatch = setTimeout(() => reject(new Error("DARWIN_VAULT_EXIT_UNCONFIRMED")), 1000);
        };
        const deadline = setTimeout(() => stop("timeout"), timeoutMs);
        child.on("error", () => stop("protocol"));
        child.stdin.on("error", () => {});
        child.stdout.on("data", (chunk: Buffer) => {
            if (bytes.length + chunk.length > 512) {
                chunk.fill(0);
                stop("protocol");
                return;
            }
            const next = Buffer.concat([bytes, chunk]);
            bytes.fill(0);
            chunk.fill(0);
            bytes = next;
            if (!ready && bytes.equals(Buffer.from("V1 test-ready\n"))) {
                ready = true;
                if (options.afterReady === "extra") child.stdin.write("x");
                if (options.afterReady === "eof") child.stdin.end();
                if (options.cancel) stop("cancelled");
            }
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.length;
            chunk.fill(0);
            if (stderr > 512) stop("protocol");
        });
        child.on("close", (code) => {
            clearTimeout(deadline);
            clearTimeout(killWatch);
            child.stdin.destroy();
            resolve({ code, exitConfirmed: true, reason, ready, bytes });
        });
        const capability = child.stdio[3];
        if (capability && "end" in capability) {
            capability.on("error", () => {});
            capability.end(options.capability ? JSON.stringify(options.capability) + "\n" : "");
        }
        child.stdin.write(frame);
        if (options.closeInput) child.stdin.end();
    });
}

/** 内存测试先用合成系统状态检查生产共用错误边界，再比较跨重启模板和恶意类型树，标准输出只接受固定标记；这些回归不访问持久存储，调用者也不会把 ACL、签名数据或原始系统异常加入测试日志。 */
export async function runMemoryChecks(): Promise<boolean> {
    const status = await nativeCall(nativePaths.memory, "", { args: ["--status-regression"] });
    const statusPassed =
        status.exitConfirmed &&
        status.code === 0 &&
        status.bytes.equals(Buffer.from("SECURITY_STATUS_CHECKS_PASSED\n"));
    const expectedFailure =
        status.exitConfirmed &&
        status.code === 1 &&
        status.bytes.equals(Buffer.from("SECURITY_STATUS_CHECKS_FAILED\n"));
    status.bytes.fill(0);
    if (!statusPassed) {
        throw new Error(
            expectedFailure
                ? "DARWIN_SECURITY_STATUS_REGRESSION_FAILED"
                : "DARWIN_SECURITY_STATUS_REGRESSION_PROTOCOL_INVALID",
        );
    }
    const result = await nativeCall(nativePaths.memory, "");
    const ok =
        result.exitConfirmed &&
        result.code === 0 &&
        result.bytes.equals(Buffer.from("ACL_MEMORY_CHECKS_PASSED\n"));
    result.bytes.fill(0);
    return ok;
}

/** 专用控制器由操作者配置的会话声明启动，并在原生层再次核对真实 UID、登录名和安全会话；声明文件不含密码或密钥，密码由系统随机源在控制器内产生，创建与删除的偏好副作用只允许发生在该可丢弃账户。 */
export async function dedicatedFixture() {
    requireMac();
    const configPath = process.env.VERIQ_D1_DISPOSABLE_SESSION;
    if (!configPath) throw new Error("DARWIN_VAULT_DISPOSABLE_SESSION_REQUIRED");
    const info = await lstat(configPath);
    if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 4096 ||
        info.uid !== process.getuid!() ||
        info.mode & 0o077
    )
        throw new Error("DARWIN_VAULT_SESSION_CONFIG_INVALID");
    const attestation: unknown = JSON.parse(await readFile(configPath, "utf8"));
    const child = spawn(nativePaths.controller, [], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let pending = Buffer.alloc(0),
        sequence = Promise.resolve(),
        closed = false;
    let receive: ((value: Record<string, unknown>) => void) | undefined;
    let failure: ((error: Error) => void) | undefined;
    const exited = new Promise<void>((resolve) =>
        child.once("close", () => {
            closed = true;
            failure?.(new Error("DARWIN_VAULT_CONTROLLER_EXITED"));
            resolve();
        }),
    );
    /** 控制器错误也必须等待真实 close 才能交回调用方，最多一秒的退出核对与五秒请求期限分别计量；超过核对期限保留明确未知结果，不把已经调用 kill 当成控制器及其自有存储都完成清理。 */
    const confirmedExit = async () => {
        if (closed) return;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("DARWIN_VAULT_CONTROLLER_EXIT_UNCONFIRMED")),
                1000,
            );
            void exited.then(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    };
    child.on("error", () => failure?.(new Error("DARWIN_VAULT_CONTROLLER_FAILED")));
    child.stdin.on("error", () => {});
    child.stderr.on("data", (bytes: Buffer) => {
        bytes.fill(0);
    });
    child.stdout.on("data", (bytes: Buffer) => {
        if (pending.length + bytes.length > 8192) {
            bytes.fill(0);
            child.kill("SIGKILL");
            return;
        }
        const next = Buffer.concat([pending, bytes]);
        pending.fill(0);
        bytes.fill(0);
        pending = next;
        const newline = pending.indexOf(10);
        if (newline < 0) return;
        try {
            const reply: unknown = JSON.parse(pending.subarray(0, newline).toString("utf8"));
            if (
                !reply ||
                typeof reply !== "object" ||
                Array.isArray(reply) ||
                newline !== pending.length - 1
            )
                throw new Error();
            pending.fill(0);
            pending = Buffer.alloc(0);
            receive?.(reply as Record<string, unknown>);
        } catch {
            child.kill("SIGKILL");
        }
    });
    const command = async (
        operation: string,
        fields: object = {},
    ): Promise<Record<string, unknown>> => {
        const frame = (fields as { frame?: unknown }).frame;
        const mutation =
            operation === "race" ||
            (operation === "run" && typeof frame === "string" && /^V1 (set|delete) /.test(frame));
        let complete!: () => void;
        const prior = sequence;
        sequence = new Promise<void>((resolve) => {
            complete = resolve;
        });
        await prior;
        try {
            if (closed) throw new Error("DARWIN_VAULT_CONTROLLER_CLOSED");
            return await new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    reject(new Error("DARWIN_VAULT_CONTROLLER_DEADLINE"));
                }, 5000);
                failure = (error) => {
                    clearTimeout(timer);
                    reject(error);
                };
                receive = (value) => {
                    clearTimeout(timer);
                    receive = undefined;
                    failure = undefined;
                    if (value.ok !== true) reject(new Error("DARWIN_VAULT_CONTROLLER_REFUSED"));
                    else resolve(value);
                };
                child.stdin.write(JSON.stringify({ operation, ...fields }) + "\n");
            });
        } catch {
            if (!closed) child.kill("SIGKILL");
            pending.fill(0);
            await confirmedExit();
            throw new Error(
                mutation
                    ? "DARWIN_VAULT_MUTATION_UNCONFIRMED"
                    : "DARWIN_VAULT_CONTROLLER_OPERATION_FAILED",
            );
        } finally {
            complete();
        }
    };
    try {
        await command("create", { attestation });
    } catch {
        child.kill("SIGKILL");
        await confirmedExit();
        throw new Error("DARWIN_VAULT_SESSION_REFUSED");
    }
    const call = async (
        operation: string,
        profile: string,
        version: string,
        key?: Buffer,
        fault?: string,
    ) => {
        const reply = await command("run", {
            frame: `V1 ${operation} ${profile} ${version}${key ? " " + key.toString("base64url") : ""}\n`,
            fault,
        });
        if (
            reply.exitConfirmed !== true ||
            typeof reply.response !== "string" ||
            typeof reply.code !== "number" ||
            reply.response.length > 512
        )
            throw new Error("DARWIN_VAULT_EXIT_UNCONFIRMED");
        return {
            exitConfirmed: true,
            code: reply.code,
            bytes: Buffer.from(reply.response, "ascii"),
        };
    };
    return {
        /** 普通状态调用只允许既有 V1 固定状态回执且要求原生进程已经正常退出，任何含密钥的读取回复都不能误入此解析器；原始管道缓冲在返回或抛错之前覆盖，测试断言只能得到不会泄漏材料的状态字符串。 */
        async status(operation: string, profile: string, version: string, key?: Buffer) {
            const result = await call(operation, profile, version, key);
            try {
                const match =
                    /^V1 (ok|missing|failed|locked|unavailable|mutation-unconfirmed)\n$/.exec(
                        result.bytes.toString("ascii"),
                    );
                if (result.code !== 0 || !match) {
                    if (operation === "set" || operation === "delete")
                        return "mutation-unconfirmed";
                    throw new Error("DARWIN_VAULT_RESPONSE_INVALID");
                }
                return match[1];
            } finally {
                result.bytes.fill(0);
            }
        },
        /** 精确版本读取通过新的真实 helper 进程完成，并在内存里与期望三十二字节的规范 V1 编码比较；实际回复和期望缓冲都在 finally 中覆盖，失败仅返回布尔而不让断言框架打印两个密钥的字节差异。 */
        async matches(profile: string, version: string, key: Buffer) {
            const result = await call("get", profile, version);
            const expected = Buffer.from(`V1 ok ${key.toString("base64url")}\n`);
            try {
                return result.code === 0 && result.bytes.equals(expected);
            } finally {
                result.bytes.fill(0);
                expected.fill(0);
            }
        },
        /** 测试管理操作只交给已经完成会话声明的固定控制器，调用方不能选择任意可执行程序或钥匙串路径；方法等待该操作的明确结果并由控制器负责真正的 lock 或 unlock，不在 TypeScript 中模拟锁定标志。 */
        async control(operation: string, fields: object = {}) {
            await command(operation, fields);
        },
        /** 两个真实 helper 在控制器内同时启动并停在已确认缺失的写入边界，测试要求真实系统返回一次新增和一次重复；返回值只包含计数、布尔和退出事实，不把排队串行调用误当作竞争，也不输出任一密钥正文。 */
        async race(profile: string, version: string, first: Buffer, second: Buffer) {
            const reply = await command("race", {
                profile,
                version,
                keys: [first.toString("base64url"), second.toString("base64url")],
            });
            return (
                reply.absent === 2 &&
                reply.added === 1 &&
                reply.duplicate === 1 &&
                reply.exited === 2 &&
                reply.outcomes === true &&
                reply.readback === true
            );
        },
        /** 未变化证明要求控制器实际重读目标材料、公开 ACL 和非秘密属性三个独立结果都成立，任何不可读取或不匹配都不会降级成主密文文件未变；调用方只接收布尔组合，底层材料和权限主体保持在私有通道内。 */
        async unchanged(profile: string, version: string) {
            const reply = await command("unchanged", {
                profile,
                version,
            });
            return (
                reply.valueUnchanged === true &&
                reply.aclUnchanged === true &&
                reply.attributesUnchanged === true
            );
        },
        /** 独立系统拒绝检查要求被拒绝的 helper 实际尝试秘密读取并观察自身前后解锁，控制器另行核验真实状态及值、ACL、属性未变；所有事实与正常退出都必须成立，缺失字段或任何错误均不能被当作策略拒绝已有覆盖。 */
        async readDenial(profile: string, version: string) {
            const reply = await command("read-denial", { profile, version });
            return [
                "readAttempted",
                "osDenied",
                "helperUnlockedBefore",
                "helperUnlockedAfter",
                "controllerUnlockedBefore",
                "controllerUnlockedAfter",
                "exitConfirmed",
                "classifiedFailed",
                "valueUnchanged",
                "aclUnchanged",
                "attributesUnchanged",
            ].every((field) => reply[field] === true);
        },
        /** 测试故障分别在系统新增和删除返回后使 helper 死亡，调用器先确认没有确定性成功回复且进程确实退出，再用同一档案版本只读核对；新增读回原材料而删除读回缺失，两种结果都不能由死亡本身推导或自动重放。 */
        async uncertainRecovery(profile: string, version: string, key: Buffer) {
            const result = await call("set", profile, version, key, "after-add");
            const uncertain = result.code !== 0 && result.bytes.length === 0;
            result.bytes.fill(0);
            const recovered = await call("get", profile, version);
            const expected = Buffer.from(`V1 ok ${key.toString("base64url")}\n`);
            let verified: boolean;
            try {
                verified = uncertain && recovered.code === 0 && recovered.bytes.equals(expected);
            } finally {
                expected.fill(0);
                recovered.bytes.fill(0);
            }
            if (!verified) return false;
            const deletion = await call("delete", profile, version, undefined, "after-delete");
            const deletionUncertain = deletion.code !== 0 && deletion.bytes.length === 0;
            deletion.bytes.fill(0);
            const missing = await call("get", profile, version);
            try {
                return (
                    deletionUncertain &&
                    missing.code === 0 &&
                    missing.bytes.equals(Buffer.from("V1 missing\n"))
                );
            } finally {
                missing.bytes.fill(0);
            }
        },
        /** 夹具清理要求控制器显式完成自有存储删除并关闭自身进程，错误路径也覆盖积累的私有响应并有界核对实际退出；若内核没有确认退出则抛出未知清理错误，而不是让 finally 结束被误解为系统状态已经恢复。 */
        async cleanup() {
            try {
                await command("cleanup");
                child.stdin.end();
                await confirmedExit();
            } finally {
                pending.fill(0);
                if (!closed) {
                    child.kill("SIGKILL");
                    await confirmedExit();
                }
            }
        },
    };
}
