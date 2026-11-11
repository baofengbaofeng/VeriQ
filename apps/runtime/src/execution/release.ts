import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalBytes, validateSchema, type ApprovedEngineInventoryV1 } from '@veriq/contracts';
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface EngineRelease {
    entry: ApprovedEngineInventoryV1['engines'][number];
    files: Record<string, Uint8Array>;
    inventoryHash: string;
}
/** Operator-selected local release; a Job or downloaded catalog can never approve itself. */
export async function loadRelease(root: string, version: string): Promise<EngineRelease> {
    const raw = await readFile(join(root, 'inventory.json'));
    if (raw.length > 1024 * 1024)
        throw new Error('ENGINE_INVENTORY_LIMIT');
    const inventory = JSON.parse(raw.toString()) as ApprovedEngineInventoryV1;
    if (validateSchema('ApprovedEngineInventoryV1', inventory).length)
        throw new Error('INVALID_ENGINE_INVENTORY');
    const entry = inventory.engines.find(e => e.engineVersion === version);
    if (!entry)
        throw new Error('ENGINE_NOT_APPROVED');
    const files: Record<string, Uint8Array> = {};
    let total = 0;
    for (const file of entry.files) {
        if (!/^(package\.json|package-lock\.json|dependencies\.json|engine\/compiler\.tgz|vendor\/[a-zA-Z0-9_.-]+\.tgz)$/.test(file.path))
            throw new Error('INVALID_RELEASE_PATH');
        const bytes = await readFile(join(root, file.path));
        total += bytes.length;
        if (total > 128 * 1024 * 1024 || bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256)
            throw new Error('RELEASE_HASH_MISMATCH');
        files[file.path] = bytes;
    }
    for (const required of ['package.json', 'package-lock.json', 'dependencies.json', 'engine/compiler.tgz'])
        if (!files[required])
            throw new Error('INCOMPLETE_RELEASE');
    return { entry, files, inventoryHash: sha256(canonicalBytes(entry)) };
}
