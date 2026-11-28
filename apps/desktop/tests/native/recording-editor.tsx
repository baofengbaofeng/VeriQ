import { useEffect, useState } from "react";
import { validateRecordingCase } from "@veriq/web/desktop";
import { createRoot } from "react-dom/client";
import type { RecordingEvent } from "../../src/shared/recording.ts";
import { RecordingStepList } from "../../src/renderer/recording/RecordingStepList.tsx";
import {
    applyRecordingEvent,
    buildCaseDraft,
    newRecordingDraft,
    storeRecordingDraft,
} from "../../src/renderer/recording/draft-model.ts";

const versionId = "6091645d-c261-4042-bad0-2229628e9078";
const keys = ["ordinary", "unmarked", "typo", "toggle", "written", "suggest"];
const catalog = {
    versionId,
    document: {
        schemaVersion: "1.0" as const,
        elements: keys.map((key) => ({ key, locator: { by: "veriqId" as const, value: key } })),
    },
};

function Editor({ events }: { events: RecordingEvent[] }) {
    const [draft, setDraft] = useState(() =>
        events.reduce(applyRecordingEvent, {
            ...newRecordingDraft(),
            title: "Capture",
            roleKey: "operator",
            catalogVersionId: versionId,
            datasetVersionId: "7297ef3b-b010-442c-8aab-6aef90f50e16",
        }),
    );
    useEffect(() => storeRecordingDraft(localStorage, "fixture", draft), [draft]);
    const result = buildCaseDraft(draft, catalog, validateRecordingCase);
    return (
        <>
            <RecordingStepList
                phase="steps"
                steps={draft.steps}
                catalog={catalog}
                versions={[]}
                bindings={["{{data.city}}"]}
                propose={() => {}}
                update={(steps) => setDraft({ ...draft, steps })}
            />
            <output>{result.content ? JSON.stringify(result.content.document.steps) : "pending"}</output>
        </>
    );
}

export function openEditor(events: RecordingEvent[]) {
    createRoot(document.body.appendChild(document.createElement("main"))).render(<Editor events={events} />);
}
