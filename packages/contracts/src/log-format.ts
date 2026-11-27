const logLevels = ["FATAL", "ERROR", "WARNING", "STRACE", "NOTICE", "TRACE", "DEBUG"] as const;
const eventTags = [
    "_undef",
    "_com_request_in",
    "_com_request_out",
    "_com_http_success",
    "_com_http_failure",
    "_com_mysql_success",
    "_com_mysql_failure",
    "_com_smtp_success",
    "_com_smtp_failure",
] as const;

export type LogLevel = (typeof logLevels)[number];
export type EventTag = (typeof eventTags)[number];

export interface LogInput {
    level: string;
    timestamp: Date;
    location: string;
    tag?: string;
    fields?: Readonly<Record<string, unknown>>;
}

const levelAliases: Record<string, LogLevel> = { INFO: "NOTICE", WARN: "WARNING", CRITICAL: "FATAL" };
const redacted = "***";
const secretName =
    "password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|credential(?:s)?|" +
    "authorization|cookie|session(?:[_-]?id)?|phone|id[_-]?card|email|dsn|(?:db|database)[_-]?url";
const sensitiveKey = new RegExp(`(?:^|_)(?:${secretName})(?:_|$)`, "i");
const secretAssignment = new RegExp(
    String.raw`(\b[a-z0-9_-]{0,128}?(?:${secretName})["']?[\s\u0085]*[:=][\s\u0085]*)` +
        String.raw`(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^\s\u0085,;&|"'<>]+)`,
    "gi",
);
const callerPattern = /^[^\s[\]:/\\\ud800-\udfff]{1,255}:[0-9]{1,10}$/u;
const urlCredentials = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s\u0085/?#]+@/gi;
const dsn = /\b(?:mysql|mariadb|postgres(?:ql)?|mongodb|redis|mssql)(?:[+-][\w-]{1,32})?:\/\/[^\s\u0085"'<>]+/gi;
const mobileNumber = /(?<![a-z0-9])(?:\+86[ -]?)?1[3-9][0-9]{9}(?![a-z0-9])/gi;
const identityNumber = /(?<![a-z0-9])[1-9][0-9]{5}(?:18|19|20)[0-9]{9}[0-9X](?![a-z0-9])/gi;
const authCredentials = /\b(?:Bearer|Basic)[\s\u0085]+[a-z0-9._~+/=-]+/gi;
const jwt = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.(?:[A-Za-z0-9_-]*\.){1,3}[A-Za-z0-9_-]*/g;
const email = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}/gi;
const maxBytes = 4096;
const encoder = new TextEncoder();
const escapes: Record<string, string> = {
    "\\": "\\\\",
    "|": "\\|",
    "=": "\\=",
    "\r": "\\r",
    "\n": "\\n",
    "\t": "\\t",
};

function isControl(code: number): boolean {
    return code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029;
}

function escapeKv(character: string): string {
    if (Object.hasOwn(escapes, character)) return escapes[character] ?? character;
    const code = character.charCodeAt(0);
    if (isControl(code)) {
        return `\\u${code.toString(16).padStart(4, "0")}`;
    }
    if (character.length === 1 && /[\ud800-\udfff]/.test(character)) return "\ufffd";
    return character;
}

function fieldValue(key: string, value: unknown): string | undefined {
    if (
        typeof value !== "string" &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value))
    )
        return undefined;

    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s.-]+/g, "_");
    if (!/_(?:count|total|length|size|bytes)$/i.test(normalizedKey) && sensitiveKey.test(normalizedKey)) {
        return redacted;
    }

    let text = String(value);
    if (key === "_stack") text = text.replace(/[\r\n]+/g, " ");
    if (key === "_msg" || key === "_stack" || key === "errmsg") {
        text = text.replace(mobileNumber, redacted).replace(identityNumber, redacted);
    }
    if (text.includes("://")) text = text.replace(dsn, redacted);
    if (text.includes("@")) text = text.replace(urlCredentials, "$1");
    text = text.replace(authCredentials, redacted);
    if (text.includes(":") || text.includes("=")) text = text.replace(secretAssignment, `$1${redacted}`);
    if (text.includes("eyJ")) text = text.replace(jwt, redacted);
    return text.includes("@") ? text.replace(email, redacted) : text;
}

/** Render one line using a bounded UTF-8 representation and UTC's numeric offset. */
export function renderLog({ level, timestamp, location, tag = "_undef", fields }: LogInput): string {
    const upperLevel = level.toUpperCase();
    const resolvedLevel =
        logLevels.find((candidate) => candidate === upperLevel) ??
        (Object.hasOwn(levelAliases, upperLevel) ? levelAliases[upperLevel] : "NOTICE");
    const resolvedTag = eventTags.find((candidate) => candidate === tag) ?? "_undef";
    const caller =
        location.match(callerPattern)?.[0] === location &&
        !Array.from(location).some((character) => isControl(character.charCodeAt(0)))
            ? location
            : "";
    const year = timestamp.getUTCFullYear();
    const instant = year >= 1 && year <= 9999 ? timestamp : new Date();
    const formatted = instant.toISOString().replace("Z", "+0000");
    const prefix = `[${resolvedLevel}][${formatted}][${caller}] ${resolvedTag}`;
    let line = prefix;
    let bytes = encoder.encode(line).length;
    for (const [key, raw] of Object.entries(fields ?? {})) {
        const value = fieldValue(key, raw);
        if (!key || value === undefined) continue;

        const field = `||${Array.from(key, escapeKv).join("")}=`;
        const fieldBytes = encoder.encode(field).length;
        if (bytes + fieldBytes + 3 > maxBytes) break;
        line += field;
        bytes += fieldBytes;
        for (const character of value) {
            const escaped = escapeKv(character);
            const size = encoder.encode(escaped).length;
            if (bytes + size + 3 > maxBytes) return `${line}…`;
            line += escaped;
            bytes += size;
        }
    }
    return line === prefix ? `${line}||` : line;
}
