import { open, unlink, mkdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { controlOrigin, type DeviceConfig } from "../enrollment.ts";
/** Exact-origin bearer-only transport; no redirects/cookies and bounded streaming. */
export async function downloadBundle(
  config: DeviceConfig,
  bundleId: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(bundleId)) throw new Error("INVALID_BUNDLE_ID");
  const origin = controlOrigin(config.server),
    response = await fetch(
      `${origin}/internal/v1/workspaces/${encodeURIComponent(config.workspaceId)}/bundles/${bundleId}/download`,
      {
        headers: { Authorization: `Bearer ${config.deviceToken}` },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(60000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
  if (!response.ok || !response.body) throw new Error("BUNDLE_DOWNLOAD_FAILED");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error("UNSAFE_DESTINATION");
  const temporary = join(dirname(destination), `.${randomUUID()}.part`);
  let fd;
  try {
    fd = await open(temporary, "wx", 0o600);
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error("BUNDLE_SIZE_LIMIT");
      await fd.writeFile(chunk);
    }
    await fd.sync();
    await fd.close();
    fd = undefined;
    // Destination must be chosen by the trusted host; create-only prevents accidental overwrite.
    const { link } = await import("node:fs/promises");
    await link(temporary, destination);
    await unlink(temporary);
  } finally {
    await fd?.close();
    await unlink(temporary).catch(() => {});
  }
}
