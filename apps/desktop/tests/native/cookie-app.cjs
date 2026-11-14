/** 此 Electron 夹具只调用正式 Cookie 保护门闩和 Chromium 的真实持久 Session，公开合成值用于目标平台磁盘与重启验证；输出仅含保护状态与提供者，不打印 Cookie、密钥或原始平台异常，也不创建产品 UI 或替代完整安装验收。 */
const { app, safeStorage, session } = require("electron");
const { require: typedRequire } = require("tsx/cjs/api");
const { writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { requireCookieProtection } = typedRequire("../../src/main/cookie-protection.ts", __filename);

const [profile, phase] = process.argv.slice(2);
if (!profile || !["write", "read", "fallback"].includes(phase))
    throw new Error("COOKIE_FIXTURE_ARGUMENTS_INVALID");
app.setName("VeriQ Cookie acceptance");
app.setPath("userData", profile);
if (phase === "fallback") app.commandLine.appendSwitch("password-store", "basic");
const value = "VeriQ-public-synthetic-cookie-native-check-2026";
const url = "https://cookie.veriq.invalid/";
const name = "veriq_cookie_protection_test";

void app
    .whenReady()
    .then(async () => {
        let protection;
        try {
            protection = await requireCookieProtection(safeStorage);
        } catch (error) {
            if (phase !== "fallback" || error.message !== "COOKIE_OS_PROTECTION_REQUIRED")
                throw new Error("COOKIE_FIXTURE_PROTECTION_FAILED");
            await writeFile(
                join(profile, "fallback.json"),
                JSON.stringify({ rejected: true, code: error.message }),
            );
            app.exit(0);
            return;
        }
        if (phase === "fallback") throw new Error("COOKIE_FIXTURE_FALLBACK_ACCEPTED");
        const target = session.fromPartition("persist:veriq-host");
        if (phase === "write") {
            await target.cookies.set({
                url,
                name,
                value,
                secure: true,
                httpOnly: true,
                sameSite: "strict",
                expirationDate: Math.floor(Date.now() / 1000) + 3600,
            });
            await target.cookies.flushStore();
        }
        const cookies = await target.cookies.get({ url, name });
        if (cookies.length !== 1 || cookies[0].value !== value)
            throw new Error("COOKIE_FIXTURE_ROUNDTRIP_FAILED");
        await writeFile(
            join(profile, `${phase}.json`),
            JSON.stringify({
                ...protection,
                path: target.storagePath,
                restored: phase === "read",
                electron: process.versions.electron,
                chrome: process.versions.chrome,
            }),
        );
        app.quit();
    })
    .catch(() => {
        console.error("Cookie fixture failed");
        app.exit(1);
    });
