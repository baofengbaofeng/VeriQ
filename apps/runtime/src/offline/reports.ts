/** Typed host projection matching the shared LocalReportAdapter without browser imports. */
import { join } from 'node:path';
import type { OfflineResultV1, PlatformComponents, JsonValue, ReportDisplayV1 } from '@veriq/contracts';
import { validateSchema } from '@veriq/contracts';
import { LocalStore } from './store.ts';
import { readBoundedFile } from './config.ts';
import { sha256 } from '../execution/release.ts';
type S = PlatformComponents['schemas'];
export interface LocalReportSnapshot {
    workspaceId: string;
    reports: S['RunReportDTO'][];
    history: Record<string, S['ReportEventDTO'][]>;
    displays: Record<string, S['ReportDisplayDTO']>;
    artifacts: Record<string, S['ReportArtifactDTO'][]>;
}
const blocked = { passed: false, reasons: ['OFFLINE_IMPORT', 'REVOCATION_UNKNOWN', 'RESULT_AUTHENTICITY_UNVERIFIED'] };
export class LocalReports {
    constructor(private root: string, private authorizeRaw: (workspaceId: string) => boolean) { }
    async snapshot(workspaceId: string, runId: string): Promise<LocalReportSnapshot> {
        const store = await LocalStore.open(this.root);
        try {
            const result = store.result(workspaceId, runId), state = store.history(workspaceId, 1000).find(row => row.id === runId)?.state;
            const report: S['RunReportDTO'] = { run: { id: runId, workspaceId, source: 'OFFLINE_IMPORT', state: state === 'RUNNING' ? 'RUNNING' : 'FINISHED', outcome: result.outcome, snapshotHash: result.manifestSha256, createdAt: result.startedAt, triggerKind: 'OFFLINE_IMPORT', gateAtExecution: false, gateNow: false }, cases: [], gateAtExecution: blocked, gateNow: blocked, statistics: { caseCount: 0, firstPassCount: 0, retryPassCount: 0, infrastructureErrorCount: 0 } };
            const snapshot: LocalReportSnapshot = { workspaceId, reports: [report], history: {}, displays: {}, artifacts: {} };
            for (const attempt of result.attempts) {
                const caseId = attempt.execution?.caseExecutionId ?? attempt.attemptId;
                let item = report.cases.find(c => c.id === caseId);
                if (!item) {
                    item = { id: caseId, caseVersionId: attempt.caseVersionId, state: report.run.state, outcome: attempt.outcome, provenance: { source: 'OFFLINE_IMPORT', dirty: result.dirty, revocationStatus: result.revocationStatus, actualEnvironment: result.actualEnvironment as unknown as JsonValue }, attempts: [] };
                    report.cases.push(item);
                }
                item.outcome = attempt.attemptNo === 2 && attempt.outcome === 'PASSED' ? 'UNSTABLE' : attempt.outcome;
                const events = store.events(workspaceId, runId, attempt.attemptId, 0, 10000);
                item.attempts.push({ id: attempt.attemptId, attemptNo: attempt.attemptNo, runtimeId: null, phase: state === 'RUNNING' ? 'RUNNING' : 'FINISHED', outcome: attempt.outcome, facts: { outcome: attempt.outcome, cleanup: attempt.cleanupStatus, processStopped: attempt.processStopped ?? false, ...(attempt.failureCode ? { errorCode: attempt.failureCode } : {}), ...(attempt.diagnostics ? { diagnostics: attempt.diagnostics as unknown as JsonValue } : {}) }, createdAt: result.startedAt, activatedAt: null, finishedAt: state === 'RUNNING' ? null : result.finishedAt, lastSequence: events.length, provenance: { source: 'OFFLINE_IMPORT', deviceId: result.deviceId, trustStatus: result.trustStatus, dirty: result.dirty, revocationStatus: result.revocationStatus }, gateAtExecution: blocked, gateNow: blocked, compensations: [] });
                snapshot.history[attempt.attemptId] = events.map(e => ({ ...e, payload: e.payload as unknown as JsonValue, valuesAvailable: true }));
                snapshot.artifacts[attempt.attemptId] = attempt.artifacts.filter(f => f.artifactId && f.kind).map(f => ({ id: f.artifactId!, attemptId: attempt.attemptId, sha256: f.sha256, sizeBytes: f.sizeBytes, kind: f.kind!, sensitivity: 'CREDENTIAL_RESTRICTED', state: 'AVAILABLE' }));
                const environment = Object.fromEntries(Object.entries(result.actualEnvironment).filter(([k, v]) => ['baseURL', 'apiBaseURL', 'locale', 'timezone'].includes(k) && typeof v === 'string')) as Record<string, string>;
                let display: S['ReportDisplayDTO'] = { display: null, metadataStatus: 'ABSENT', environment };
                try {
                    const raw = await readBoundedFile(join(this.root, 'work', attempt.attemptId, 'metadata/report-display.json'), 1024 * 1024);
                    const metadata = JSON.parse(raw.toString()) as ReportDisplayV1;
                    if (validateSchema('ReportDisplayV1', metadata).length)
                        throw new Error('INVALID_REPORT_DISPLAY');
                    const selected = metadata.cases.find(c => c.caseVersionId === attempt.caseVersionId);
                    if (selected)
                        display = { display: selected, metadataStatus: 'AVAILABLE', environment };
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw error;
                }
                snapshot.displays[attempt.attemptId] = display;
            }
            report.statistics = { caseCount: report.cases.length, firstPassCount: result.attempts.filter(a => a.attemptNo === 1 && a.outcome === 'PASSED').length, retryPassCount: result.attempts.filter(a => a.attemptNo === 2 && a.outcome === 'PASSED').length, infrastructureErrorCount: result.attempts.filter(a => a.outcome === 'ERROR').length };
            return snapshot;
        }
        finally {
            store.close();
        }
    }
    async readRaw(workspaceId: string, runId: string, attemptId: string, artifactId: string): Promise<Buffer> {
        if (!this.authorizeRaw(workspaceId))
            throw new Error('RAW_EVIDENCE_FORBIDDEN');
        const store = await LocalStore.open(this.root);
        let result: OfflineResultV1;
        try {
            result = store.result(workspaceId, runId);
        }
        finally {
            store.close();
        }
        const attempt = result.attempts.find(a => a.attemptId === attemptId), artifact = attempt?.artifacts.find(a => a.artifactId === artifactId);
        if (!artifact || !/^[-a-zA-Z0-9_.]{1,240}$/.test(artifact.path))
            throw new Error('LOCAL_ARTIFACT_NOT_FOUND');
        const bytes = await readBoundedFile(join(this.root, 'work', attemptId, 'evidence', artifact.path), 32 * 1024 * 1024);
        if (bytes.length !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256)
            throw new Error('LOCAL_ARTIFACT_CHANGED');
        return bytes;
    }
}
