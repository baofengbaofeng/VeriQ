import { RecordingStepConfiguration, type RecordingVersionOption } from "@veriq/web/desktop";
import type { LocatorV1 } from "@veriq/contracts";
import { useCallback } from "react";
import { requiresTarget, type CatalogVersion, type DraftStep, type StepPhase } from "./draft-model";

const phases: Record<StepPhase, string> = {
    prepare: "准备 / Prepare",
    steps: "操作 / Actions",
    SUCCESS: "成功后清理 / Cleanup after success",
    FAILURE: "失败后清理 / Cleanup after failure",
    CANCELLED: "取消后清理 / Cleanup after cancellation",
};

export function locatorLabel(locator: LocatorV1): string {
    return locator.by === "veriqId"
        ? `veriqId: ${locator.value}`
        : `${locator.role}${locator.name ? ` · ${locator.name}` : ""}`;
}

interface StepListProps {
    phase: StepPhase;
    steps: DraftStep[];
    preceding?: DraftStep[];
    catalog: CatalogVersion | undefined;
    versions: RecordingVersionOption[];
    update(items: DraftStep[]): void;
    propose(locator: LocatorV1): void;
    bindings: string[];
    revealStepId?: string;
}

export function RecordingStepList({
    phase,
    steps,
    preceding = [],
    catalog,
    versions,
    update,
    propose,
    bindings,
    revealStepId,
}: StepListProps) {
    const reveal = useCallback((element: HTMLDetailsElement | null) => {
        if (!element) return;
        element.open = true;
        element.querySelector("summary")?.focus();
    }, []);
    function replace(id: string, updateItem: (item: DraftStep) => DraftStep) {
        update(steps.map((item) => (item.step.id === id ? updateItem(item) : item)));
    }
    return (
        <fieldset>
            <legend>{phases[phase]}</legend>
            {steps.map((item, index) => {
                const { step, target, recording } = item;
                return (
                    <details
                        key={step.id}
                        ref={step.id === revealStepId ? reveal : undefined}
                        data-testid={`recording-step-${step.id}`}
                        className="recording-step"
                    >
                        <summary>
                            {index + 1}. {step.action}
                            {item.disabled ? " · disabled" : ""}
                            {item.note ? ` · ${item.note}` : ""}
                        </summary>
                        <label>
                            <input
                                type="checkbox"
                                checked={!item.disabled}
                                onChange={(event) =>
                                    replace(step.id, (current) => ({ ...current, disabled: !event.target.checked }))
                                }
                            />
                            启用 / Enabled
                        </label>
                        <label>
                            备注 / Note
                            <input
                                maxLength={160}
                                value={item.note ?? ""}
                                onChange={(event) =>
                                    replace(step.id, (current) => ({ ...current, note: event.target.value }))
                                }
                            />
                        </label>
                        {requiresTarget(step) && (
                            <label>
                                确认目录元素 / Confirm catalog element
                                <select
                                    value={target?.catalogVersionId === catalog?.versionId ? (target?.key ?? "") : ""}
                                    onChange={(event) => {
                                        const key = event.target.value;
                                        replace(step.id, (current) => {
                                            const { target: _previous, ...rest } = current;
                                            return key && catalog
                                                ? { ...rest, target: { key, catalogVersionId: catalog.versionId } }
                                                : rest;
                                        });
                                    }}
                                >
                                    <option value="">从唯一候选匹配 / Match unique recorded locator</option>
                                    {catalog?.document.elements.map(({ key }) => (
                                        <option key={key} value={key}>
                                            {key}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        {requiresTarget(step) &&
                            recording?.candidates.map(({ locator, matches }) => (
                                <p key={locatorLabel(locator)}>
                                    {locatorLabel(locator)} · {matches} matches
                                    {matches === 1 && (
                                        <button type="button" onClick={() => propose(locator)}>
                                            加入目录草稿 / Add to catalog draft
                                        </button>
                                    )}
                                </p>
                            ))}
                        <RecordingStepConfiguration
                            step={step}
                            versions={versions}
                            preceding={[...preceding, ...steps.slice(0, index)]
                                .filter((entry) => !entry.disabled)
                                .map((entry) => entry.step)}
                            bindings={bindings}
                            onChange={(next) => {
                                if (JSON.stringify(next) !== JSON.stringify(step))
                                    replace(step.id, (current) => ({
                                        ...current,
                                        step: JSON.parse(JSON.stringify(next)),
                                    }));
                            }}
                        />
                        <div className="header-actions">
                            <button
                                type="button"
                                disabled={index === 0}
                                onClick={() => {
                                    const reordered = steps.slice();
                                    reordered.splice(index - 1, 2, item, ...reordered.slice(index - 1, index));
                                    update(reordered);
                                }}
                            >
                                上移 / Move up
                            </button>
                            <button
                                type="button"
                                disabled={index === steps.length - 1}
                                onClick={() => {
                                    const reordered = steps.slice();
                                    const following = reordered[index + 1];
                                    if (following) reordered.splice(index, 2, following, item);
                                    update(reordered);
                                }}
                            >
                                下移 / Move down
                            </button>
                            <button
                                type="button"
                                onClick={() => update(steps.filter(({ step: candidate }) => candidate.id !== step.id))}
                            >
                                移除 / Remove
                            </button>
                        </div>
                    </details>
                );
            })}
            <button
                type="button"
                disabled={steps.length >= 500}
                onClick={() =>
                    update([...steps, { step: { id: `step_${crypto.randomUUID()}`, action: "goto", path: "/" } }])
                }
            >
                添加步骤 / Add step
            </button>
        </fieldset>
    );
}
