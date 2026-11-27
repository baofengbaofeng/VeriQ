import type { DatasetV1, DatasetV2, ResourceDocumentV1, ResourceKind } from "@veriq/contracts";
import type { RecordingVersionOption } from "@veriq/web/desktop";
import type { RecordingServices } from "./services";

export type PublishedVersion = Omit<RecordingVersionOption, "content"> & {
    resourceId: string;
    content: ResourceDocumentV1;
};

const versionKinds = [
    "ELEMENT_CATALOG",
    "ENVIRONMENT",
    "DATASET",
    "FLOW",
    "FIXTURE",
    "ASSERTION_TEMPLATE",
] as const satisfies readonly ResourceKind[];

export async function listPublishedVersions(
    services: RecordingServices,
    signal: AbortSignal,
): Promise<PublishedVersion[]> {
    async function list(kind: ResourceKind) {
        const result: PublishedVersion[] = [];
        let cursor: string | undefined;
        do {
            const page = await services.resources.list(kind, cursor, signal);
            for (const resource of page.items) {
                if (resource.status === "ARCHIVED" || !resource.latestVersionId) continue;
                let versionCursor: string | undefined;
                do {
                    const versions = await services.resources.versions(resource.id, versionCursor, signal);
                    for (const version of versions.items)
                        result.push({
                            id: version.id,
                            resourceId: resource.id,
                            name: resource.name,
                            kind: resource.kind,
                            versionNo: version.versionNo,
                            content: version.content as ResourceDocumentV1,
                        });
                    versionCursor = versions.nextCursor ?? undefined;
                } while (versionCursor);
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return result;
    }
    return (await Promise.all(versionKinds.map(list))).flat();
}

export function datasetColumns(document: DatasetV1 | DatasetV2 | undefined): string[] {
    if (!document) return [];
    return Object.keys(document.schemaVersion === "1.0" ? document.columns : document.fields);
}

export function staticRowKeys(document: DatasetV1 | DatasetV2 | undefined): string[] {
    if (!document) return [];
    if (document.schemaVersion === "1.0") return document.rows.map(({ key }) => key);
    return document.source.kind === "STATIC" ? document.source.rows.map(({ key }) => key) : [];
}
