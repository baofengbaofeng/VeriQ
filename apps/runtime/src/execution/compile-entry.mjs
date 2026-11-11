import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import * as compiler from './engine/compiler/src/index.ts';
import { canonicalBytes } from '@veriq/contracts';
const invocation = JSON.parse(await readFile(new URL('./invocation.json', import.meta.url), 'utf8'));
const root = invocation.work;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const vendor = {};
for (const file of release.files)
    if (file.path.startsWith('vendor/'))
        vendor[file.path] = await readFile(join(root, file.path));
const distribution = { engineVersion: release.engineVersion, runnerSdkVersion: release.runnerSdkVersion, dependencies: release.dependencies, packageJson: await readFile(join(root, 'package.json')), packageLock: await readFile(join(root, 'package-lock.json')), files: vendor };
let result;
let diagnostics;
if (invocation.kind === 'CLEANUP')
    result = { kind: 'READY' };
else
    try {
        const source = JSON.parse(await readFile(join(root, 'source/asset-snapshot.json'), 'utf8'));
        // Retained approved engines predate structured diagnostics. Their own
        // compiler remains authoritative; absent capability means absent details.
        if (typeof compiler.safeDiagnostics === 'function') {
            diagnostics = compiler.safeDiagnostics(compiler.analyze(source).issues);
            if (diagnostics.length) throw new Error("ASSET_VALIDATION_FAILED");
        }
        const output = compiler.compileFiles(source, distribution);
        if (invocation.kind === 'VALIDATE') {
            for (const [path, bytes] of Object.entries(output.files)) {
                await mkdir(dirname(join(root, path)), { recursive: true });
                await writeFile(join(root, path), bytes, { mode: 0o600 });
            }
            await writeFile(join(root, 'bundle.json'), canonicalBytes(output.bundle), { mode: 0o600 });
            result = { kind: 'VALIDATE', businessOutcome: 'PASSED', cleanupStatus: 'NOT_REQUIRED' };
        }
        else {
            const supplied = JSON.parse(await readFile(join(root, 'bundle.json'), 'utf8'));
            if (hash(canonicalBytes(supplied)) !== hash(canonicalBytes(output.bundle)))
                throw new Error('COMPILED_PROVENANCE_MISMATCH');
            const files = {};
            for (const entry of supplied.files)
                files[entry.path] = await readFile(join(root, entry.path));
            for (const [path, bytes] of Object.entries(output.files))
                if (hash(bytes) !== hash(files[path]))
                    throw new Error('COMPILED_PROVENANCE_MISMATCH');
            compiler.assembleExecution(supplied, JSON.parse(await readFile(join(root, 'execution.json'), 'utf8')), files);
            result = { kind: 'READY' };
        }
    }
    catch (error) {
        if (invocation.kind !== 'VALIDATE')
            throw new Error('COMPILED_PROVENANCE_MISMATCH');
        const code = diagnostics?.[0]?.code ?? 'COMPILATION_FAILED';
        // Never persist compiler diagnostics containing source literals, URLs or credentials.
        await writeFile(join(root, 'compiler.log'), `VeriQ compiler failed: ${code}\n`, { mode: 0o600 });
        result = { kind: 'VALIDATE', businessOutcome: 'ERROR', cleanupStatus: 'NOT_REQUIRED', failureCode: code, ...(diagnostics?.length ? { diagnostics } : {}) };
    }
await writeFile(join(root, 'worker-result.json'), JSON.stringify(result), { mode: 0o600 });
