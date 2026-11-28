import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { writeSync } from "node:fs";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import pino from "pino";
import { renderLog } from "@veriq/contracts/log-format";

const levels = { debug: 10, trace: 20, notice: 30, strace: 35, warning: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof levels;
type Entry = Parameters<typeof renderLog>[0];
type Fields = NonNullable<Entry["fields"]>;

type DiagnosticContext = { traceid: string; spanid: string };
const context = new AsyncLocalStorage<DiagnosticContext>();

function id(bytes: number): string {
    let value: string;
    do value = randomBytes(bytes).toString("hex");
    while (/^0+$/.test(value));
    return value;
}

/**
 * 在命令、IPC 或后台作业的入口生成独立标识，在异步调用完成前保持同一个上下文。
 */
export function withDiagnosticContext<T>(callback: (scope: DiagnosticContext) => T): T {
    const scope = { traceid: id(16), spanid: id(8) };
    return context.run(scope, callback, scope);
}

function callerProvenance(): { location: string; packageName?: string } {
    for (const frame of new Error().stack?.split("\n").slice(1) ?? []) {
        const match = frame.match(/(?:^|[/\\])([^/\\\s():]+):(\d+):\d+\)?$/);
        if (match?.[1] && !/^diagnostics(?:-[a-z0-9_-]+)?\.(?:[cm]?js|ts)$/i.test(match[1])) {
            const modules = frame
                .replaceAll("\\", "/")
                .matchAll(/\/node_modules\/((?:@[a-z0-9._-]+\/)?[a-z0-9_-][a-z0-9._-]*)\//gi);
            const packageName = Array.from(modules).at(-1)?.[1];
            return { location: `${match[1]}:${match[2]}`, ...(packageName ? { packageName } : {}) };
        }
    }
    return { location: "" };
}

const configuredLevel = process.env.LOG_LEVEL?.toLowerCase();
const threshold = configuredLevel && Object.hasOwn(levels, configuredLevel) ? (configuredLevel as Level) : "notice";
const names = new Map<number, Entry["level"]>(
    Object.entries(levels).map(([name, rank]) => [rank, name.toUpperCase() as Entry["level"]]),
);

const logger = pino(
    {
        base: null,
        customLevels: levels,
        useOnlyCustomLevels: true,
        level: threshold,
        redact: {
            paths: ["fields.token", "fields.deviceToken", "fields.deviceCode", "fields.authorization"],
            censor: "***",
        },
    },
    {
        write(value: string) {
            try {
                const { level, time, location, tag, fields } = JSON.parse(value);
                const line = renderLog({
                    level: names.get(level) ?? "NOTICE",
                    timestamp: new Date(time),
                    location,
                    tag,
                    fields,
                });
                writeSync(2, `${line}\n`);
            } catch {
                // 诊断目标在进程退出或重定向失败时可能不可写，正常业务和关闭流程不能依赖它。
            }
        },
    },
);

function emit(level: Level, tag: Entry["tag"], fields: Fields, location?: string): void {
    if (!logger.isLevelEnabled(level)) return;
    const operation = context.getStore();
    logger[level]({ location: location ?? callerProvenance().location, tag, fields: { ...operation, ...fields } });
}

const knownCodes = new Set([
    "AGENT_PROFILE_REQUIRED",
    "AGENT_SPAWN_FAILED",
    "AGENT_START_FAILED",
    "AGENT_STOP_UNCONFIRMED",
    "CANCELLED",
    "CONTROL_ORIGIN_MISMATCH",
    "COOKIE_ENCRYPTION_FUSE_REQUIRED",
    "COOKIE_OS_PROTECTION_UNAVAILABLE",
    "COOKIE_PLATFORM_UNSUPPORTED",
    "COOKIE_RUNTIME_UNVERIFIED",
    "CREDENTIAL_MODE_INVALID",
    "DESKTOP_LOGIN_ITEM_UNCONFIRMED",
    "DESKTOP_PRODUCT_VERSION_MISMATCH",
    "DOCTOR_FAILED",
    "ENGINE_NOT_APPROVED",
    "INDEPENDENT_NODE24_REQUIRED",
    "INVALID_ENGINE_INVENTORY",
    "INVALID_RESPONSE",
    "NETWORK_UNAVAILABLE",
    "PROCESS_QUARANTINED",
    "RELEASE_HASH_MISMATCH",
    "RESTRICTED_FILE_CONTEXT_REQUIRED",
    "RUNTIME_CONFIGURATION_MISMATCH",
    "RUNTIME_ROLE_MISMATCH",
    "RUNTIME_STORAGE_LOW",
    "RUNTIME_STORAGE_UNAVAILABLE",
    "RUNTIME_VAULT_CAPABILITY_UNVERIFIED",
]);

/**
 * 仅保留明确已知的操作错误码，第三方异常不会因消息恰好是大写字符串而将原始内容混入诊断。
 */
export function diagnosticCode(error: unknown, fallback: string): string {
    return error instanceof Error && knownCodes.has(error.message) ? error.message : fallback;
}

/**
 * 业务日志使用固定事件名和明确允许的字段，参数不包含请求正文、凭证或原始异常。
 */
export function getLogger(source: string) {
    const log = (level: Level, event: string, fields: Fields = {}) =>
        emit(level, "_undef", { source, event, ...fields });
    return {
        notice: (event: string, fields?: Fields) => log("notice", event, fields),
        warning: (event: string, fields?: Fields) => log("warning", event, fields),
        trace: (event: string, fields?: Fields) => log("trace", event, fields),
        strace: (event: string, fields?: Fields) => log("strace", event, fields),
        debug: (event: string, fields?: Fields) => log("debug", event, fields),
        error: (event: string, fields?: Fields) => log("error", event, fields),
        fatal: (event: string, fields?: Fields) => log("fatal", event, fields),
    };
}

/**
 * 仅在实际进程入口安装，吸收第三方 console 的普通消息，避免改变命令 stdout 和模块导入行为。
 */
export function installDiagnosticConsole(source: string): void {
    const methods = {
        log: "notice",
        info: "notice",
        warn: "warning",
        error: "error",
        debug: "debug",
        trace: "trace",
    } as const;
    for (const method of Object.keys(methods) as (keyof typeof methods)[]) {
        console[method] = (...values: unknown[]) => {
            if (!logger.isLevelEnabled(methods[method])) return;
            const { location, packageName } = callerProvenance();
            const error = values.find((value) => value instanceof Error);
            const errorName =
                error && ["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError"].includes(error.name)
                    ? error.name
                    : undefined;
            emit(
                methods[method],
                "_undef",
                {
                    source: packageName ?? source,
                    method,
                    error_name: errorName,
                    _msg: "Third-party console diagnostic",
                },
                location,
            );
        };
    }
}

/**
 * 只归一明确指定为第三方诊断的流，按完整行处理切分的 UTF-8，并限制无换行输入的占用。
 */
export function captureDiagnostics(stream: Readable, source: string): void {
    const { location } = callerProvenance();
    const operation = context.getStore();
    const decoder = new StringDecoder("utf8");
    let width = 0;
    let hasText = false;
    function flush() {
        if (hasText) {
            const log = () =>
                emit(
                    "warning",
                    "_undef",
                    {
                        source,
                        _msg: width > 2048 ? "Child diagnostic exceeded size limit" : "Third-party process diagnostic",
                    },
                    location,
                );
            if (operation) context.run(operation, log);
            else log();
        }
        width = 0;
        hasText = false;
    }
    function collect(chunk: string) {
        const lines = chunk.split("\n");
        for (const [index, part] of lines.entries()) {
            width = Math.min(width + part.length, 2049);
            hasText ||= /\S/.test(part);
            if (index < lines.length - 1) flush();
        }
    }
    stream.on("data", (chunk: Buffer) => collect(decoder.write(chunk)));
    stream.once("end", () => {
        collect(decoder.end());
        flush();
    });
}

/**
 * 仅供现有受信控制面使用。收到响应头即记录 HTTP 状态，实际正文和流的读取、校验及取消仍由调用者管理，避免额外消费响应。
 * 诊断只使用调用点提供的固定操作名和方法，不读取查询串、用户信息、请求正文或响应正文。
 */
export async function diagnosticFetch(
    fetcher: (input: string, init?: RequestInit) => Promise<Response>,
    operation: string,
    input: string,
    init: RequestInit = {},
): Promise<Response> {
    const { location } = callerProvenance();
    const execute = async ({ traceid }: DiagnosticContext) => {
        const cspanid = id(8);
        const headers = new Headers(init.headers);
        headers.set("x-trace-id", traceid);
        headers.set("x-cspanid", cspanid);
        const metadata = { cspanid, uri: operation, method: init.method ?? "GET" };
        const started = performance.now();
        let response: Response;
        try {
            response = await fetcher(input, { ...init, headers });
        } catch (error) {
            emit(
                "error",
                "_com_http_failure",
                {
                    ...metadata,
                    proc_time: (performance.now() - started) / 1000,
                    errno: init.signal?.aborted ? "REQUEST_ABORTED" : "NETWORK_ERROR",
                    errmsg: "Control request failed before response",
                },
                location,
            );
            throw error;
        }
        const fields = { ...metadata, proc_time: (performance.now() - started) / 1000 };
        if (response.ok) emit("notice", "_com_http_success", fields, location);
        else
            emit(
                "error",
                "_com_http_failure",
                {
                    ...fields,
                    errno: response.status,
                    errmsg: "Control endpoint returned an error status",
                },
                location,
            );
        return response;
    };
    const scope = context.getStore();
    return scope ? execute(scope) : withDiagnosticContext(execute);
}
