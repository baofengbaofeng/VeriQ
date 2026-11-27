import { browserLog } from "./browser-logging";

function newId(length: number): string {
    const bytes = new Uint8Array(length);
    do {
        crypto.getRandomValues(bytes);
    } while (bytes.every((byte) => byte === 0));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function responseId(response: Response, header: string, pattern: RegExp, fallback: string): string {
    const value = response.headers.get(header);
    return value && pattern.test(value) ? value.toLowerCase() : fallback;
}

export async function tracedFetch(
    operation: "web.api.binary" | "web.api.json" | "web.api.stream",
    path: string,
    options: RequestInit,
): Promise<Response> {
    const traceid = newId(16);
    const spanid = newId(8);
    const cspanid = newId(8);
    const headers = new Headers(options.headers);
    headers.set("x-trace-id", traceid);
    headers.set("x-cspanid", cspanid);
    const start = performance.now();
    let response: Response;
    try {
        response = await fetch(`/api/v1${path}`, { ...options, headers });
    } catch (error) {
        browserLog("ERROR", "_com_http_failure", {
            traceid,
            spanid,
            cspanid,
            operation,
            proc_time: (performance.now() - start) / 1000,
            errno: options.signal?.aborted ? "ABORTED" : "FETCH_FAILED",
            errmsg: options.signal?.aborted ? "Request aborted" : "Network request failed",
        });
        throw error;
    }
    const responseSpan = responseId(response, "x-cspanid", /^(?!0{16}$)[0-9a-f]{16}$/i, cspanid);
    const fields = {
        traceid: responseId(response, "x-trace-id", /^(?!0{32}$)[0-9a-f]{32}$/i, traceid),
        spanid,
        cspanid,
        ...(responseSpan === cspanid ? {} : { response_spanid: responseSpan }),
        operation,
        proc_time: (performance.now() - start) / 1000,
    };
    if (response.ok) browserLog("NOTICE", "_com_http_success", { ...fields, status: response.status });
    else browserLog("ERROR", "_com_http_failure", { ...fields, errno: response.status, errmsg: "HTTP request failed" });
    return response;
}
