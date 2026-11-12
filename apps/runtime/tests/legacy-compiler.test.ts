/** Retained compiler compatibility uses actual Git source and real locked archives. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, realpath, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { canonicalBytes } from '@veriq/contracts';
import { snapshot, id } from '../../../packages/compiler/tests/helpers.ts';
import { loadRelease, sha256 } from '../src/execution/release.ts';

const base = '10379f05b95facb4db78591d930f60d2cfe34b81';
test('retained pre-T12 compiler supports VALIDATE and TEST without optional diagnostics export', { timeout: 180000 }, async () => {
    const repository = fileURLToPath(new URL('../../../', import.meta.url));
    const root = await mkdtemp(join(tmpdir(), 'veriq-legacy-compiler-'));
    const old = join(root, 'old'), build = join(root, 'build'), release = join(root, 'release'), work = join(root, 'work');
    try {
        await mkdir(old);
        const archive = execFileSync('git', ['archive', base, 'packages/compiler', 'packages/contracts', 'packages/runner-sdk', 'pnpm-lock.yaml'], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
        execFileSync('tar', ['-x', '-C', old], { input: archive });
        // Reuse installed third-party packages; local @veriq names resolve to the
        // historical source tree. The producer packs actual old SDK/contracts bytes.
        for (const pkg of ['compiler', 'contracts', 'runner-sdk']) {
            const modules = join(old, 'packages', pkg, 'node_modules');
            await mkdir(join(modules, '@veriq'), { recursive: true });
            for (const name of await readdir(join(repository, 'packages', pkg, 'node_modules'))) {
                if (name === '@veriq') continue;
                await symlink(await realpath(join(repository, 'packages', pkg, 'node_modules', name)), join(modules, name));
            }
            for (const name of ['compiler', 'contracts', 'runner-sdk'])
                await symlink(join(old, 'packages', name), join(modules, '@veriq', name));
        }
        const source = snapshot();
        const sourcePath = join(root, 'source.json');
        await writeFile(sourcePath, canonicalBytes(source));
        const tsx = fileURLToPath(import.meta.resolve('tsx'));
        execFileSync(process.execPath, ['--import', tsx, 'tests/queue-fixture.ts', sourcePath, build], { cwd: join(old, 'packages/runner-sdk'), timeout: 120000, stdio: 'pipe' });
        const index = JSON.parse(await readFile(join(build, 'index.json'), 'utf8'));
        for (const file of index.inventory.engines[0].files) {
            await mkdir(dirname(join(release, file.path)), { recursive: true });
            await copyFile(join(build, file.sha256), join(release, file.path));
        }
        await writeFile(join(release, 'inventory.json'), canonicalBytes(index.inventory));
        const approved = await loadRelease(release, '0.1.0');
        for (const [path, bytes] of Object.entries(approved.files)) {
            await mkdir(dirname(join(work, path)), { recursive: true });
            await writeFile(join(work, path), bytes);
        }
        await mkdir(join(work, 'engine/compiler'), { recursive: true });
        execFileSync('tar', ['-xzf', join(work, 'engine/compiler.tgz'), '-C', join(work, 'engine/compiler')]);
        execFileSync('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(root, 'npm-cache')], { cwd: work, timeout: 60000, stdio: 'pipe' });
        const capability = execFileSync(process.execPath, ['--import', tsx, '--input-type=module', '-e', "import * as compiler from './engine/compiler/src/index.ts';console.log(typeof compiler.safeDiagnostics)"], { cwd: work }).toString().trim();
        assert.equal(capability, 'undefined');
        await writeFile(join(work, 'release.json'), canonicalBytes(approved.entry));
        await mkdir(join(work, 'source'));
        await writeFile(join(work, 'source/asset-snapshot.json'), canonicalBytes(source));
        await copyFile(join(repository, 'apps/runtime/src/execution/compile-entry.mjs'), join(work, 'compile-entry.mjs'));
        const invoke = async (kind: string) => {
            await writeFile(join(work, 'invocation.json'), JSON.stringify({ kind, work }));
            return spawnSync(process.execPath, ['--import', tsx, 'compile-entry.mjs'], { cwd: work, encoding: 'utf8', timeout: 30000 });
        };
        const validated = await invoke('VALIDATE');
        assert.equal(validated.status, 0, validated.stderr);
        assert.deepEqual(JSON.parse(await readFile(join(work, 'worker-result.json'), 'utf8')), { kind: 'VALIDATE', businessOutcome: 'PASSED', cleanupStatus: 'NOT_REQUIRED' });
        const retainedBundle = await readFile(join(build, 'bundle.json'));
        assert.equal(sha256(await readFile(join(work, 'bundle.json'))), sha256(retainedBundle));
        assert(!JSON.parse(retainedBundle.toString()).files.some((f: { path: string }) => f.path === 'metadata/report-display.json'));
        await writeFile(join(work, 'execution.json'), canonicalBytes({ schemaVersion: '1.0', workspaceId: id(99), runId: id(10), caseExecutionId: id(11), caseVersionId: id(1), assetSourceHash: source.sourceHash, environmentVersionId: id(12), environment: { schemaVersion: '1.0', baseURL: 'http://127.0.0.1', apiBaseURL: 'http://127.0.0.1', allowedOrigins: ['http://127.0.0.1'], locale: 'en', timezone: 'UTC', roles: [{ roleKey: 'reader', authAdapterVersionId: id(13), secretRef: 'business', secretVersionId: id(14), allowedIdentityIds: ['reader'] }] }, roleKey: 'reader', browser: 'chromium', variables: {}, secretVersions: [{ secretRef: 'business', versionId: id(14) }], authAdapters: [{ workspaceId: id(99), versionId: id(13), configuration: { kind: 'HTTP_BEARER', identityPath: '/identity', identityPointer: '/id' }, contentHash: sha256(canonicalBytes({ kind: 'HTTP_BEARER', identityPath: '/identity', identityPointer: '/id' })) }], namespace: 'retained', attemptNo: 1 }));
        const tested = await invoke('TEST');
        assert.equal(tested.status, 0, tested.stderr);
        assert.deepEqual(JSON.parse(await readFile(join(work, 'worker-result.json'), 'utf8')), { kind: 'READY' });
        // Existing provenance comparison still rejects a changed retained bundle.
        const changed = JSON.parse(retainedBundle.toString());
        changed.sourceHash = '0'.repeat(64);
        await writeFile(join(work, 'bundle.json'), canonicalBytes(changed));
        const forged = await invoke('TEST');
        assert.notEqual(forged.status, 0);
        assert.match(forged.stderr, /COMPILED_PROVENANCE_MISMATCH/);
        await writeFile(join(work, 'source/asset-snapshot.json'), '{}');
        const invalid = await invoke('VALIDATE');
        assert.equal(invalid.status, 0, invalid.stderr);
        const failure = JSON.parse(await readFile(join(work, 'worker-result.json'), 'utf8'));
        assert.equal(failure.businessOutcome, 'ERROR');
        assert.equal(failure.failureCode, 'COMPILATION_FAILED');
        assert.equal(failure.diagnostics, undefined);
        console.log(JSON.stringify({ historicalSource: base, compilerArchive: sha256(approved.files['engine/compiler.tgz']!), inventoryHash: approved.inventoryHash, retainedBundle: sha256(retainedBundle) }));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
