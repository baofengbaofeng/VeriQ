import type { PlatformComponents } from "@veriq/contracts";
import { canonicalBytes, CloudReportAdapter, CloudResourceAdapter } from "@veriq/web/desktop";
import type { CloudOperation } from "../../shared/operations.generated";

type Schema = PlatformComponents["schemas"];

type DraftInput = {
    clientDraftId: string;
    key: string;
    name: string;
    content: Schema["ResourceDocumentV1"];
    existing?: { resourceId: string; revision: number };
};

async function documentHash(content: DraftInput["content"]): Promise<string> {
    const bytes = new Uint8Array(canonicalBytes(content));
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function waitForPoll(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const timer = window.setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
        }, 700);
        const abort = () => {
            window.clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
    });
}

/** Bind the authoring operations to the chosen workspace and the desktop's typed cloud transport. */
export function createRecordingServices(workspaceId: string) {
    const resources = new CloudResourceAdapter(workspaceId);
    const reports = new CloudReportAdapter(workspaceId);
    const params = { workspaceId };

    async function cloud<Result>(operation: CloudOperation, signal?: AbortSignal): Promise<Result> {
        signal?.throwIfAborted();
        const response = await window.veriq.cloud(operation);
        signal?.throwIfAborted();
        return response as Result;
    }

    async function saveDraft(input: DraftInput, signal?: AbortSignal): Promise<Schema["DraftDTO"]> {
        if (!input.existing) {
            const { id } = await resources.create(
                {
                    kind: input.content.kind,
                    key: input.key,
                    name: input.name,
                    content: input.content,
                    clientDraftId: input.clientDraftId,
                },
                signal,
            );
            const saved = await resources.draft(id, signal);
            if (saved.revision !== 1 || saved.documentHash !== (await documentHash(input.content))) {
                throw new Error("STALE_REVISION");
            }
            return saved;
        }
        const { resourceId, revision } = input.existing;
        const hash = await documentHash(input.content);
        const current = await resources.draft(resourceId, signal);
        if (current.documentHash === hash && (current.revision === revision || current.revision === revision + 1)) {
            return current;
        }
        if (current.revision !== revision) throw new Error("STALE_REVISION");
        try {
            return await resources.save(resourceId, { revision, content: input.content }, signal);
        } catch (error) {
            signal?.throwIfAborted();
            // Recover a committed save whose reply was lost without applying the same edit twice.
            const saved = await resources.draft(resourceId, signal).catch(() => null);
            if (saved?.revision === revision + 1 && saved.documentHash === hash) {
                return saved;
            }
            throw error;
        }
    }

    async function validateDraft(resourceId: string, revision: number, signal?: AbortSignal) {
        const preview = await resources.preview(resourceId, signal);
        if (preview.revision !== revision) throw new Error("STALE_REVISION");
        return resources.validate(resourceId, { revision, sourceHash: preview.sourceHash }, signal);
    }

    async function publishDraft(resourceId: string, revision: number, signal?: AbortSignal) {
        const timeout = AbortSignal.timeout(180_000);
        const polling = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let job = await validateDraft(resourceId, revision, polling);
        while (job.state !== "FINISHED") {
            await waitForPoll(polling);
            job = await resources.job(job.id, polling);
        }
        if (job.outcome !== "PASSED") throw new Error(job.errorCode ?? "VALIDATION_FAILED");
        const receipt = await resources.receipt(job.id, polling);
        return resources.publish(resourceId, { revision, validationReceiptId: receipt.id }, polling);
    }

    async function runtimes(signal?: AbortSignal): Promise<Schema["RuntimeDTO"][]> {
        const results: Schema["RuntimeDTO"][] = [];
        let cursor: string | null = null;
        do {
            const page: Schema["RuntimeDTOPageEnvelope"]["data"] = await cloud(
                { operation: "listRuntimes", params, ...(cursor ? { query: { cursor } } : {}) },
                signal,
            );
            results.push(...page.items);
            cursor = page.nextCursor ?? null;
        } while (cursor);
        return results;
    }

    return {
        resources,
        reports,
        saveDraft,
        validateDraft,
        publishDraft,
        runtimes,
        startTrial: (data: Schema["RunCreate"], idempotencyKey: string, signal?: AbortSignal) =>
            cloud<Schema["RunDTO"]>({ operation: "createRun", params, data, idempotencyKey }, signal),
        cancelTrial: (runId: string, signal?: AbortSignal) =>
            cloud<Schema["RunDTO"]>(
                { operation: "cancelRun", params: { workspaceId, runId }, data: { reason: "Cancelled from recorder" } },
                signal,
            ),
        createPlan: (data: Schema["ExecutionPlanWrite"], signal?: AbortSignal) =>
            cloud<Schema["ExecutionPlanDTO"]>({ operation: "createExecutionPlan", params, data }, signal),
        launchPlan: (planId: string, data: Schema["TriggerRequest"], idempotencyKey: string, signal?: AbortSignal) =>
            cloud<Schema["TriggerReceipt"]>(
                { operation: "triggerExecutionPlan", params: { workspaceId, planId }, data, idempotencyKey },
                signal,
            ),
    };
}

export type RecordingServices = ReturnType<typeof createRecordingServices>;
