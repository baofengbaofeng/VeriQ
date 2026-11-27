import { renderLog, type LogInput, type LogLevel } from "@veriq/contracts/log-format";

const consoleLevels = {
    debug: "DEBUG",
    info: "NOTICE",
    log: "NOTICE",
    warn: "WARNING",
    error: "ERROR",
    trace: "TRACE",
} as const satisfies Record<string, LogLevel>;

type DiagnosticTarget = EventTarget & { console: Console };
let output: ((line: string) => void) | undefined;
let source: "web" | "desktop.renderer";

function fileName(address: string): string | undefined {
    return address.split(/[?#]/, 1)[0]?.match(/\/([\w.-]+\.[cm]?[jt]sx?)$/)?.[1];
}

function callerLocation(): string {
    const frame = new Error().stack?.split("\n").filter((line) => /:\d+:\d+\)?$/.test(line))[2];
    const match = frame?.match(/^(.*):(\d+):\d+\)?$/);
    if (!match) return "";
    const file = fileName(match[1]);
    return file ? `${file}:${match[2]}` : "";
}

export function browserLog(level: LogLevel, tag: LogInput["tag"], fields: LogInput["fields"], location?: string): void {
    if (!output || level === "DEBUG" || level === "TRACE") return;
    try {
        output(
            renderLog({
                level,
                timestamp: new Date(),
                location: location ?? callerLocation(),
                tag,
                fields: { source, ...fields },
            }),
        );
    } catch {
        // Diagnostics must preserve the caller's original result and cannot log failures through the console wrapper.
    }
}

export function installBrowserDiagnostics(name: "web" | "desktop.renderer", target: DiagnosticTarget = window): void {
    if (output) return;
    source = name;
    output = target.console.log.bind(target.console);
    for (const method of Object.keys(consoleLevels) as (keyof typeof consoleLevels)[]) {
        target.console[method] = (...args: unknown[]) => {
            const [first] = args;
            browserLog(
                consoleLevels[method],
                "_undef",
                { event: `console.${method}`, argument_count: args.length, _msg: consoleMessage(first) },
                callerLocation(),
            );
        };
    }
    target.addEventListener("error", (event) => {
        event.preventDefault();
        const location = typeof ErrorEvent !== "undefined" && event instanceof ErrorEvent ? errorLocation(event) : "";
        browserLog("ERROR", "_undef", { event: "web.uncaught_error", errmsg: "Uncaught browser error" }, location);
    });
    target.addEventListener("unhandledrejection", (event) => {
        event.preventDefault();
        browserLog("ERROR", "_undef", { event: "web.unhandled_rejection", errmsg: "Unhandled promise rejection" }, "");
    });
}

function consoleMessage(value: unknown): string | number | boolean | undefined {
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value !== "string") return undefined;
    if (value.length > 2048 || /^\s*[[<{]/.test(value)) return "[omitted]";
    return value.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/api\/|\/[^\s<>()?]*\?)[^\s<>()]+/gi, "[url]");
}

function errorLocation(event: ErrorEvent): string {
    const file = fileName(event.filename);
    return file && event.lineno > 0 ? `${file}:${event.lineno}` : "";
}
