/** Test-only bridge: real host APIs, with control physically stopped during execute. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DeviceStore } from '../src/enrollment.ts';
import { TrustStore, type IssuerTrust } from '../src/offline/trust.ts';
import { SecretStore } from '../src/credentials/store.ts';
import { downloadBundle } from '../src/offline/download.ts';
import { verifyBundle } from '../src/offline/verify.ts';
import { runOffline } from '../src/offline/run.ts';
import { uploadOffline } from '../src/offline/upload.ts';
import { LocalReports } from '../src/offline/reports.ts';
import type { OfflineResultV1 } from '@veriq/contracts';

process.title = 'veriq';
const [phase, profile, release] = process.argv.slice(2);
assert(profile && release);
const input = JSON.parse(await readFile(join(profile, 'integration-input.json'), 'utf8')) as {
    issuer: IssuerTrust; bundleId: string; secretVersionId: string; secret: string;
};
const config = await new DeviceStore(profile).load();
const trust = new TrustStore(join(profile, 'trust'));
const secrets = new SecretStore(join(profile, 'secrets'));
const root = join(profile, 'offline');
const installed = join(profile, 'installed');
if (phase === 'prepare') {
    await trust.bind(input.issuer, config.server, input.issuer.keys[0]!.fingerprint);
    await secrets.set({issuerId: input.issuer.issuerId, workspaceId: config.workspaceId,
        secretRef: 'business', versionId: input.secretVersionId}, {token: input.secret});
    const archive = join(profile, 'bundle.zip');
    await downloadBundle(config, input.bundleId, archive);
    await verifyBundle(archive, {trust, destination: installed, workspaceId: config.workspaceId});
} else if (phase === 'execute') {
    await assert.rejects(fetch(config.server + '/api/v1/setup', {signal: AbortSignal.timeout(2000)}));
    const result = await runOffline({directory: installed}, {root, trust, secrets,
        releaseDirectory: release, browserExecutable: process.env.VERIQ_TEST_CHROMIUM ?? '/usr/bin/chromium',
        deviceId: config.runnerId});
    assert.equal(result.outcome, 'PASSED', JSON.stringify(result.attempts.map(a => ({outcome: a.outcome, failure: a.failureCode}))));
    assert.equal(result.attempts[0]!.processStopped, true);
    const trace = result.attempts[0]!.artifacts.find(a => a.kind === 'TRACE');
    assert(trace?.artifactId);
    const reports = new LocalReports(root, workspace => workspace === config.workspaceId);
    const bytes = await reports.readRaw(config.workspaceId, result.localRunId, result.attempts[0]!.attemptId, trace.artifactId);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), trace.sha256);
    const snapshot = await reports.snapshot(config.workspaceId, result.localRunId);
    assert.equal(snapshot.reports[0]!.run.outcome, 'PASSED');
    assert.equal(snapshot.reports[0]!.gateNow.passed, false);
    await writeFile(join(profile, 'local-result.json'), JSON.stringify(result), {mode: 0o600});
} else if (phase === 'upload') {
    const result = JSON.parse(await readFile(join(profile, 'local-result.json'), 'utf8')) as OfflineResultV1;
    const first = await uploadOffline(root, result.localRunId, config);
    const second = await uploadOffline(root, result.localRunId, config);
    assert.equal(first.runId, second.runId);
    assert.equal(second.duplicate, true);
    assert.equal(second.officialGatePassed, false);
    await writeFile(join(profile, 'import-receipt.json'), JSON.stringify(first), {mode: 0o600});
} else throw new Error('INVALID_INTEGRATION_PHASE');
