import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExecutionSupervisor } from '../src/execution/supervisor.ts';
test('an exhausted granted lease cannot start an execution process even if the wall clock is skewed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'veriq-t10-expired-'));
    try {
        const supervisor = new ExecutionSupervisor({ root: directory } as ConstructorParameters<typeof ExecutionSupervisor>[0]);
        await assert.rejects(supervisor.runAttempt({ claim: { attemptId: '11111111-1111-4111-8111-111111111111', expiresAt: '2026-01-01T00:01:00Z', serverTime: '2026-01-01T00:00:00Z', leaseDurationMs: 60000 }, requestStarted: 0, responseReceived: 60000 } as Parameters<ExecutionSupervisor['runAttempt']>[0], new AbortController().signal), /LEASE_BUDGET_EXHAUSTED/);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
