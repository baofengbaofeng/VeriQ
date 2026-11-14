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

type Options = {
    args?: string[];
    capability?: object | undefined;
    closeInput?: boolean;
    afterReady?: "eof" | "extra";
    timeoutMs?: number;
    cancel?: boolean;
};
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

/** 内存测试程序自行比较跨重启模板并检查恶意类型树，标准输出仅允许固定成功标记；调用者不会将 ACL 的路径、签名数据或任何底层错误对象附加到断言差异和流水线日志中。 */
export async function runMemoryChecks(): Promise<boolean> {
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
        } finally {
            complete();
        }
    };
    try {
        await command("create", { attestation });
    } catch {
        child.kill("SIGKILL");
        await exited;
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
        async status(operation: string, profile: string, version: string, key?: Buffer) {
            const result = await call(operation, profile, version, key);
            try {
                const match =
                    /^V1 (ok|missing|failed|locked|unavailable|mutation-unconfirmed)\n$/.exec(
                        result.bytes.toString("ascii"),
                    );
                if (result.code !== 0 || !match) throw new Error("DARWIN_VAULT_RESPONSE_INVALID");
                return match[1];
            } finally {
                result.bytes.fill(0);
            }
        },
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
        async control(operation: string, fields: object = {}) {
            await command(operation, fields);
        },
        async unchanged(profile: string, version: string, key: Buffer) {
            const reply = await command("unchanged", {
                profile,
                version,
                key: key.toString("base64"),
            });
            return reply.unchanged === true;
        },
        async uncertainRecovery(profile: string, version: string, key: Buffer) {
            const result = await call("set", profile, version, key, "after-add");
            const uncertain = result.code !== 0 && result.bytes.length === 0;
            result.bytes.fill(0);
            const recovered = await call("get", profile, version);
            const expected = Buffer.from(`V1 ok ${key.toString("base64url")}\n`);
            try {
                return uncertain && recovered.code === 0 && recovered.bytes.equals(expected);
            } finally {
                expected.fill(0);
                recovered.bytes.fill(0);
            }
        },
        async cleanup() {
            try {
                await command("cleanup");
                child.stdin.end();
                await exited;
            } finally {
                pending.fill(0);
                if (!closed) {
                    child.kill("SIGKILL");
                    await exited;
                }
            }
        },
    };
}
