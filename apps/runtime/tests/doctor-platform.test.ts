import assert from "node:assert/strict";
import test from "node:test";
import { doctorPlatform } from "../src/doctor.ts";

test("doctor reports the admitted host OS and architecture pair", () => {
    for (const arch of ["arm64", "x64"] as const) {
        assert.deepEqual(doctorPlatform("darwin", arch, true), { os: "darwin", arch });
        assert.equal(doctorPlatform("darwin", arch, false), undefined);
    }
    for (const os of ["linux", "win32"] as const) {
        assert.deepEqual(doctorPlatform(os, "x64", false), { os, arch: "x64" });
        assert.equal(doctorPlatform(os, "arm64", true), undefined);
    }
    assert.equal(doctorPlatform("darwin", "ia32", true), undefined);
    assert.equal(doctorPlatform("freebsd", "x64", false), undefined);
});
