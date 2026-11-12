import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '@veriq/contracts';
import { randomUUID } from 'node:crypto';
test('offline attempts retain variant execution, physical stop and retry safety facts', () => {
    const value = { attemptId: randomUUID(), caseVersionId: randomUUID(), attemptNo: 1, outcome: 'ERROR', cleanupStatus: 'NOT_REQUIRED', lastSequence: 0, events: [], artifacts: [], processStopped: true, retrySafety: 'UNKNOWN', failureCode: 'LOCAL_CREDENTIAL_MISSING', sourceKind: 'PUBLISHED', variantKey: 'a'.repeat(64) };
    assert.deepEqual(validateSchema('OfflineAttemptV1', value), []);
    assert.notDeepEqual(validateSchema('OfflineAttemptV1', { ...value, processStopped: 'yes' }), []);
});
