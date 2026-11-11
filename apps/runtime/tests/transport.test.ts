import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { RuntimeClient } from '../src/enrollment.ts';
test('an empty queue is a successful 204, not an invalid JSON response', async () => {
    const server = createServer((_request, response) => { response.writeHead(204); response.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        assert.equal(await new RuntimeClient(`http://127.0.0.1:${address.port}`).request('/internal/v1/jobs/claim', 'POST', {}, 'test'), undefined);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
test('assigned absolute same-control-origin downloads work while foreign URLs receive no authorization', async () => {
    const { AgentClient } = await import('../src/agent/transport.ts');
    const { createHash } = await import('node:crypto');
    const payload = Buffer.from('immutable');
    let requests = 0;
    const server = createServer((request, response) => { requests++; assert.equal(request.headers.authorization, 'Bearer parent-token'); response.end(payload); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const address = server.address();
        assert(address && typeof address !== 'string');
        const origin = `http://127.0.0.1:${address.port}`;
        const client = new AgentClient({ client: new RuntimeClient(origin), withCredential: async (operation: (config: {
                deviceToken: string;
            }) => Promise<unknown>) => operation({ deviceToken: 'parent-token' }) } as unknown as ConstructorParameters<typeof AgentClient>[0]);
        const proof = { leaseToken: 'lease', fencingToken: 1 };
        assert.deepEqual(await client.download(origin + '/content', createHash('sha256').update(payload).digest('hex'), proof, new AbortController().signal), payload);
        await assert.rejects(client.download('http://localhost:1/content', 'a'.repeat(64), proof, new AbortController().signal), /CONTROL_ORIGIN_MISMATCH/);
        assert.equal(requests, 1);
    }
    finally {
        server.closeAllConnections();
        server.close();
    }
});
