/** 保险库文件层只处理固定用途的有限私有成员，Linux 持有目录描述符并通过其内核引用打开子项，Windows 复用同句柄原生校验；该层不取得事务锁，也不自动重试提交，因此可在一个档案事务内复用。 */
import { constants } from "node:fs";
import { open, opendir, mkdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const LIMIT = 2 * 1024 * 1024;
function member(name: string) {
    if (!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(name) || name.includes(".."))
        throw new Error("VAULT_FILE_NAME_INVALID");
    return name;
}
function vaultMember(name: string): boolean {
    if (
        [
            "profile.json",
            "profile-next.json",
            "transaction.json",
            "migration.json",
            "initialization.json",
        ].includes(name) ||
        /^record-[0-9a-f-]{36}\.json$/.test(name)
    )
        return true;
    if (["local-secrets.json", "device.json", "rotation.json"].includes(name)) return false;
    throw new Error("VAULT_FILE_NAME_INVALID");
}
function fileLimit(name: string) {
    return vaultMember(name) ? LIMIT : name === "local-secrets.json" ? 1024 * 1024 : 65536;
}
function missing(error: unknown) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 一个文件会话持有真实档案目录直到事务结束，所有成员名均受固定字符和长度约束；Linux 不通过配置路径重新打开已经授权的父项，已有公开或错误拥有者的目录不会被自动收紧冒充合法私有数据。 */
export class VaultFiles {
    private constructor(
        readonly directory: string,
        private handle?: FileHandle,
    ) {}

    /** 打开档案逐级拒绝符号链接并从创建时使用私有模式，已有最终目录必须由当前用户拥有且权限恰为七百；Windows 委托既有当前 SID 与无重解析父链规则，不改变管理员拥有者政策。 */
    static async acquire(directory: string): Promise<VaultFiles> {
        directory = resolve(directory);
        if (process.platform === "win32") {
            const { windowsNative } = await import("../native/windows.ts");
            windowsNative().privatePath(directory, true);
            return new VaultFiles(directory);
        }
        let parent = await open(parse(directory).root, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
            const parts = directory.slice(parse(directory).root.length).split("/").filter(Boolean);
            for (const part of parts) {
                const path = `/proc/self/fd/${parent.fd}/${part}`;
                try {
                    await mkdir(path, { mode: 0o700 });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
                }
                const child = await open(
                    path,
                    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
                );
                await parent.close();
                parent = child;
            }
            const st = await parent.stat();
            if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o777) !== 0o700)
                throw new Error("VAULT_DIRECTORY_NOT_PRIVATE");
            return new VaultFiles(directory, parent);
        } catch (error) {
            await parent.close();
            throw error;
        }
    }
    private path(name: string) {
        return this.handle
            ? `/proc/self/fd/${this.handle.fd}/${member(name)}`
            : join(this.directory, member(name));
    }
    private async checked(name: string) {
        const fd = await open(
            this.path(name),
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const st = await fd.stat();
            if (
                !st.isFile() ||
                st.uid !== process.getuid!() ||
                (st.mode & 0o777) !== 0o600 ||
                st.size > fileLimit(name)
            )
                throw new Error("VAULT_FILE_NOT_PRIVATE");
            return fd;
        } catch (error) {
            await fd.close();
            throw error;
        }
    }

    /** 初始化只需判断目录是否已有任何成员，不枚举或读取其秘密内容，目录迭代器在首次观察后立即关闭；已有密文、日志或临时残留均阻止把丢失清单当作新档案，实际文件读写仍走各平台私有句柄校验。 */
    async empty(): Promise<boolean> {
        const directory = await opendir(
            this.handle ? `/proc/self/fd/${this.handle.fd}` : this.directory,
        );
        try {
            return (await directory.read()) === null;
        } finally {
            await directory.close();
        }
    }
    /** 空初始化恢复只能接触清单和自身有限日志，任何密文、事务记录或未知临时成员都会阻止换钥；目录迭代最多检查允许数量再加一个成员，既不读取秘密内容，也不把无法检查的条目忽略为可安全重置。 */
    async containsOnly(names: string[]): Promise<boolean> {
        for (const name of names) {
            if (!vaultMember(name)) throw new Error("VAULT_FILE_NAME_INVALID");
        }
        const directory = await opendir(
            this.handle ? `/proc/self/fd/${this.handle.fd}` : this.directory,
        );
        try {
            for (let index = 0; index <= names.length; index++) {
                const entry = await directory.read();
                if (entry === null) return true;
                if (!names.includes(entry.name)) return false;
            }
            return false;
        } finally {
            await directory.close();
        }
    }
    /** 私有读取只将真正不存在映射为未定义，所有权限、大小、拥有者和读取变化均保留失败；读取在同一描述符上按已观测大小完成且最多两兆字节，不能由文件持续增长制造无限内存分配。 */
    async read(name: string): Promise<string | undefined> {
        try {
            if (process.platform === "win32") {
                const { windowsNative } = await import("../native/windows.ts");
                return (
                    vaultMember(name)
                        ? windowsNative().readVaultFile(this.path(name))
                        : windowsNative().readPrivateFile(this.path(name), fileLimit(name))
                ).toString("utf8");
            }
            const fd = await this.checked(name);
            try {
                const size = (await fd.stat()).size;
                const bytes = Buffer.alloc(size);
                let offset = 0;
                while (offset < size) {
                    const result = await fd.read(bytes, offset, size - offset, offset);
                    if (!result.bytesRead) throw new Error("VAULT_FILE_CHANGED");
                    offset += result.bytesRead;
                }
                if ((await fd.stat()).size !== size) throw new Error("VAULT_FILE_CHANGED");
                return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } finally {
                await fd.close();
            }
        } catch (error) {
            if (missing(error)) return undefined;
            throw error;
        }
    }

    /** 原子替换先验证已有成员并刷新独占临时文件，再在所持目录下发布和刷新目录；发布后的任何错误明确表示提交不确定，调用方必须使用日志恢复，不能自动重放业务回调或宣称原文件未改变。 */
    async write(name: string, value: string): Promise<void> {
        member(name);
        if (!vaultMember(name)) throw new Error("VAULT_FILE_NAME_INVALID");
        if (Buffer.byteLength(value) > LIMIT) throw new Error("VAULT_ENVELOPE_LIMIT");
        const temporary = `.${randomUUID()}.tmp`;
        if (process.platform === "win32") {
            const { windowsNative } = await import("../native/windows.ts");
            windowsNative().replaceVaultFile(this.directory, name, temporary, value);
            return;
        }
        try {
            const previous = await this.checked(name);
            await previous.close();
        } catch (error) {
            if (!missing(error)) throw error;
        }
        const path = `/proc/self/fd/${this.handle!.fd}/${temporary}`;
        const fd = await open(
            path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        let committed = false;
        try {
            await fd.writeFile(value);
            await fd.sync();
            await rename(path, this.path(name));
            committed = true;
            await this.handle!.sync();
        } catch (error) {
            if (committed) throw new Error("VAULT_COMMIT_UNCONFIRMED");
            throw error;
        } finally {
            await fd.close();
            if (!committed)
                await unlink(path).catch((error) => {
                    if (!missing(error)) throw error;
                });
        }
    }

    /** 退休只针对当前私有目录中的有界普通成员，真正缺失可作为已完成而未知错误必须传播；Linux 的删除随后刷新已持有目录，Windows 保留原生删除标记与关闭语义，不声称物理擦除。 */
    async remove(name: string): Promise<void> {
        try {
            if (process.platform === "win32") {
                const { windowsNative } = await import("../native/windows.ts");
                if (vaultMember(name)) windowsNative().removeVaultFile(this.path(name));
                else windowsNative().removePrivate(this.path(name));
                return;
            }
            const fd = await this.checked(name);
            try {
                await unlink(this.path(name));
            } finally {
                await fd.close();
            }
            try {
                await this.handle!.sync();
            } catch {
                throw new Error("VAULT_COMMIT_UNCONFIRMED");
            }
        } catch (error) {
            if (!missing(error)) throw error;
        }
    }

    /** 事务结束后释放当前文件会话拥有的目录描述符，不触碰系统密钥或其他档案的连接；调用方应在 finally 执行，关闭异常仍需上报而不能被当作已经得到新的持久化保证。 */
    async close(): Promise<void> {
        await this.handle?.close();
    }
}
