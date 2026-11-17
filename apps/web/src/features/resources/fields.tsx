/**
 * 资源草稿 RHF 字段工具：路径读写、版本选择、列表编辑与受控 JSON 值，路径深度有界。禁止在控件内 fetch；字段控件内部禁
 * 止发起任何 Workspace fetch。
 * Apply/save 边界再跑 ResourceDocumentV1 校验；递归 JSON 叶不用裸 textarea 执行。
 */

import { tx, useAppLocale } from "../../locale";
import { useId, useState, type ReactNode } from "react";
import {
    Controller,
    useFieldArray,
    useFormContext,
    useWatch,
    type FieldPath,
    type FieldValues,
    type Control,
} from "react-hook-form";
import {
    DndContext,
    useDraggable,
    useDroppable,
    PointerSensor,
    KeyboardSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import type { JsonValue, ResourceKind, ResourceDocumentV1 } from "@veriq/contracts";
import { Button, Section } from "@veriq/ui";
import { useTranslation } from "react-i18next";
import { useEditorTranslationOptions } from "./i18n";
import { usePrimitiveRows } from "./row-identity";
/**
 * 编辑器根表单值类型，包裹资源草稿文档与 UI 辅助字段，供 useForm 泛型使用。辅助字段不会提交到 DraftWrite。与服务器
 * Draft.content 对齐的部分经 save 提交；其余仅本地。
 */
export type EditorValues = {
    content: { kind: ResourceKind; document: object };
};
/**
 * 页面引用可选范围：CASE/FLOW/ASSERTION_TEMPLATE，限制 VersionField 可选版本集合。断言编辑器用其过滤模板引用，避免跨
 * kind 误绑。
 */
export type PageReferenceScope = "CASE" | "FLOW" | "ASSERTION_TEMPLATE";
/**
 * JSON Schema 风格基础类型名列表，供 TypeMap/JsonValueControl 下拉使用。切换类型会重置默认值。与契约校验器接受的类型字
 * 符串保持一致。
 */
export const types = ["string", "number", "integer", "boolean", "object", "array", "null"];
/**
 * HTTP 方法枚举，供用例步骤 apiRequest 与网络断言 query.method 下拉共用。与合约 HTTP 断言枚举一致。顺序固定便于快照测
 * 试；不含 TRACE 等非业务方法。
 */
export const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
/**
 * 从 RHF 读取指定路径的当前值（泛型 T），供字段组件订阅局部状态而不整表重渲染策略由 RHF 决定。名称参数为点分路径。路径
 * 必须落在 EditorValues 内；越界返回 undefined。
 */
export function useValue<T>(name: string): T {
    return useWatch<EditorValues>({ name: name as FieldPath<EditorValues> }) as T;
}
/**
 * 返回向 RHF 写入路径值的 setter，供 List/Json 控件在增删改时更新草稿。批量更新应合并为一次 setValue。不自动标记 dirty
 * 以外的副作用；保存仍由编辑器工具栏触发。
 */
export function useSet() {
    const { setValue } = useFormContext<EditorValues>();
    return (name: string, value: unknown) =>
        setValue(name as FieldPath<EditorValues>, value as never, {
            shouldDirty: true,
        });
}
/**
 * 资源草稿用文本/数字等简单字段，绑定 RHF 路径与双语 label，区别于 ui.tsx 的原生 Field。支持 required 与只读展示模式。
 * 校验信息就地展示；不发起 API。
 */
export function Field({
    name,
    label,
    options,
    number,
    optional,
    hint,
    check,
    password,
    showUnlistedValue = false,
}: {
    name: string;
    label: string;
    options?: readonly string[];
    number?: boolean;
    optional?: boolean;
    hint?: string;
    check?: boolean;
    password?: boolean;
    showUnlistedValue?: boolean;
}) {
    useAppLocale();
    const { control } = useFormContext<EditorValues>();
    const id = useId();
    return (
        <label htmlFor={id} className={check ? "vq-check" : ""}>
            {label}
            <Controller
                control={control}
                name={name as FieldPath<EditorValues>}
                render={({ field }) =>
                    check ? (
                        <input
                            id={id}
                            type="checkbox"
                            name={field.name}
                            ref={field.ref}
                            checked={(field.value as unknown) === true}
                            onBlur={field.onBlur}
                            onChange={(e) => field.onChange(e.target.checked)}
                        />
                    ) : options ? (
                        <select
                            id={id}
                            ref={field.ref}
                            name={field.name}
                            onBlur={field.onBlur}
                            value={typeof field.value === "string" ? field.value : ""}
                            onChange={(e) => field.onChange(optional && !e.target.value ? undefined : e.target.value)}
                        >
                            {optional && <option value="">—</option>}
                            {showUnlistedValue &&
                                typeof field.value === "string" &&
                                field.value &&
                                !options.includes(field.value) && (
                                    <option value={field.value} disabled>
                                        {field.value} {tx(" · 未在当前作用域声明 / Not declared in this scope")}
                                    </option>
                                )}
                            {options.map((o) => (
                                <option key={o} value={o}>
                                    {o}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <input
                            id={id}
                            name={field.name}
                            ref={field.ref}
                            onBlur={field.onBlur}
                            type={password ? "password" : number ? "number" : "text"}
                            value={
                                typeof field.value === "string" || typeof field.value === "number" ? field.value : ""
                            }
                            onChange={(e) =>
                                field.onChange(
                                    e.target.value === "" && optional
                                        ? undefined
                                        : number
                                          ? e.target.value === ""
                                              ? undefined
                                              : Number(e.target.value)
                                          : e.target.value,
                                )
                            }
                        />
                    )
                }
            />
            {hint && <small>{hint}</small>}
        </label>
    );
}
/**
 * 版本下拉选项：id、展示标签与可选内容摘要，供固定引用字段过滤。content 可选用于列名提示；可选 content 供数据集列名提
 * 示而不是提交。由编辑器从 adapter.versions 映射而来，不直接等于 Version
 * DTO。
 */
export type VersionOption = {
    id: string;
    name: string;
    versionNo: number;
    kind: ResourceKind;
    content?: ResourceDocumentV1;
};
/**
 * 在允许的 kind/scope 内选择不可变 versionId，写入草稿引用字段。空值表示清除固定引用；空值表示清除草稿里的该固定版本引
 * 用。清空表示未绑定；发布后引用不会随远端新版本自动浮动。
 */
export function VersionField({
    name,
    label,
    kind,
    versions,
    optional,
}: {
    name: string;
    label: string;
    kind: ResourceKind;
    versions: VersionOption[];
    optional?: boolean;
}) {
    useAppLocale();
    const { control } = useFormContext<EditorValues>();
    const id = useId();
    return (
        <label htmlFor={id}>
            {label}
            <Controller
                control={control}
                name={name as FieldPath<EditorValues>}
                render={({ field }) => (
                    <select
                        id={id}
                        name={field.name}
                        value={typeof field.value === "string" ? field.value : ""}
                        onBlur={field.onBlur}
                        ref={field.ref}
                        onChange={(e) => field.onChange(optional && !e.target.value ? undefined : e.target.value)}
                    >
                        <option value="">{tx("选择固定版本 / Select pinned version")}</option>
                        {typeof field.value === "string" &&
                            field.value &&
                            !versions.some((v) => v.id === field.value) && (
                                <option value={field.value}>
                                    {field.value} {tx(" (未加载 / unavailable)")}
                                </option>
                            )}
                        {versions
                            .filter((v) => v.kind === kind)
                            .map((v) => (
                                <option key={v.id} value={v.id}>
                                    {v.name} · v{v.versionNo} · {v.id}
                                </option>
                            ))}
                    </select>
                )}
            />
        </label>
    );
}
function DragRow({ id, children }: { id: string; children: ReactNode }) {
    useAppLocale();
    const drag = useDraggable({ id }),
        drop = useDroppable({ id });
    return (
        <div ref={drop.setNodeRef} className={"vq-item" + (drop.isOver ? " vq-drop" : "")}>
            <Button
                tone="secondary"
                ref={drag.setNodeRef}
                {...drag.attributes}
                {...drag.listeners}
                aria-label={tx("拖动排序 / Drag to reorder")}
                style={
                    drag.transform
                        ? {
                              transform: `translate(${drag.transform.x}px, ${drag.transform.y}px)`,
                          }
                        : undefined
                }
            >
                ↕
            </Button>
            {children}
        </div>
    );
}
/**
 * 通用数组字段编辑器：上移/下移/删除/添加，子项由 render 回调绘制。添加时调用调用方提供的 factory；新增一行时调用调用
 * 方传入的 factory 函数。
 * 变更经 useSet 写回；用于步骤、断言、字符串列表等。
 */
export function List(props: {
    name: string;
    title: string;
    initial: () => unknown;
    children: (path: string, index: number) => ReactNode;
}) {
    useAppLocale();
    const value = useValue<unknown>(props.name),
        set = useSet(),
        { t } = useTranslation(undefined, useEditorTranslationOptions);
    if (!Array.isArray(value))
        return (
            <Section title={props.title}>
                <Button tone="secondary" onClick={() => set(props.name, [props.initial()])}>
                    {t("add")} {props.title}
                </Button>
            </Section>
        );
    return <FieldArrayList {...props} />;
}
function FieldArrayList({
    name,
    title,
    initial,
    children,
}: {
    name: string;
    title: string;
    initial: () => unknown;
    children: (path: string, index: number) => ReactNode;
}) {
    useAppLocale();
    const { control } = useFormContext<EditorValues>(),
        { t } = useTranslation(undefined, useEditorTranslationOptions);
    const array = useFieldArray({
        control: control as unknown as Control<FieldValues>,
        name,
        keyName: "_formId",
    });
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor),
    );
    return (
        <Section title={title}>
            <p>{tx("Use Move up and Move down to reorder rows with the keyboard.")}</p>
            <DndContext
                sensors={sensors}
                accessibility={{
                    screenReaderInstructions: {
                        draggable: tx(
                            "Press Space to pick up a row, arrow keys to move, Space to drop, or Escape to cancel.",
                        ),
                    },
                    announcements: {
                        onDragStart: ({ active }) =>
                            tx("Moving row {{position}}", {
                                position: array.fields.findIndex((row) => row._formId === active.id) + 1,
                            }),
                        onDragOver: ({ over }) =>
                            over
                                ? tx("Over row {{position}}", {
                                      position: array.fields.findIndex((row) => row._formId === over.id) + 1,
                                  })
                                : tx("Outside the list"),
                        onDragEnd: () => tx("Reordering finished"),
                        onDragCancel: () => tx("Reordering cancelled"),
                    },
                }}
                onDragEnd={({ active, over }) => {
                    if (!over || over.id === active.id) return;
                    const from = array.fields.findIndex((x) => x._formId === active.id),
                        to = array.fields.findIndex((x) => x._formId === over.id);
                    if (from >= 0 && to >= 0) array.move(from, to);
                }}
            >
                {array.fields.map((item, index) => (
                    <DragRow key={item._formId} id={item._formId}>
                        <div className="vq-actions">
                            <span>{index + 1}</span>
                            <Button
                                tone="secondary"
                                disabled={!index}
                                aria-label={tx("Move row {{position}} up", { position: index + 1 })}
                                onClick={() => array.move(index, index - 1)}
                            >
                                {t("up")}
                            </Button>
                            <Button
                                tone="secondary"
                                disabled={index === array.fields.length - 1}
                                aria-label={tx("Move row {{position}} down", {
                                    position: index + 1,
                                })}
                                onClick={() => array.move(index, index + 1)}
                            >
                                {t("down")}
                            </Button>
                            <Button tone="danger" onClick={() => array.remove(index)}>
                                {t("remove")}
                            </Button>
                        </div>
                        <div className="vq-fields">{children(`${name}.${index}`, index)}</div>
                    </DragRow>
                ))}
            </DndContext>
            <Button tone="secondary" onClick={() => array.append(initial() as never)}>
                {t("add")} {title}
            </Button>
        </Section>
    );
}
function defaultValue(type: string): JsonValue {
    return type === "string"
        ? ""
        : type === "boolean"
          ? false
          : type === "object"
            ? {}
            : type === "array"
              ? []
              : type === "null"
                ? null
                : 0;
}
/**
 * 按类型编辑 JSON 叶子（含 object/array 有界展开），业务数据不当作可执行脚本。null 类型单独可选。
 * 类型切换会重置为该类型默认值，避免残留非法形状。
 */
export function JsonValueControl({
    value,
    onChange,
    label,
    allowBinding = false,
    bindings,
}: {
    value: JsonValue;
    onChange: (value: JsonValue) => void;
    label: string;
    allowBinding?: boolean;
    bindings?: string[];
}) {
    useAppLocale();
    const [key, setKey] = useState("");
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const objectValue = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
    return (
        <div className="vq-value">
            <label>
                {label} {tx(" · 类型 / Type")}
                <select
                    aria-label={tx("{{value0}} 类型 / Type", { value0: label })}
                    value={type}
                    onChange={(e) => onChange(defaultValue(e.target.value))}
                >
                    {types
                        .filter((x) => x !== "integer")
                        .map((x) => (
                            <option key={x}>{x}</option>
                        ))}
                </select>
            </label>
            {type === "string" && (
                <label>
                    {label}
                    <input aria-label={label} value={value as string} onChange={(e) => onChange(e.target.value)} />
                    {allowBinding && (
                        <small>{tx("支持完整占位符并保留类型 / Whole placeholders retain value types.")}</small>
                    )}
                    {allowBinding && bindings && (
                        <select
                            aria-label={tx("{{value0}} 插入绑定 / Insert binding", {
                                value0: label,
                            })}
                            value=""
                            onChange={(e) => {
                                if (e.target.value) onChange(e.target.value);
                            }}
                        >
                            <option value="">{tx("选择绑定 / Select binding")}</option>
                            {bindings.map((binding) => (
                                <option key={binding} value={binding}>
                                    {binding}
                                </option>
                            ))}
                        </select>
                    )}
                </label>
            )}
            {type === "number" && (
                <label>
                    {label}
                    <input
                        aria-label={label}
                        type="number"
                        value={value as number}
                        onChange={(e) => onChange(Number(e.target.value))}
                    />
                </label>
            )}
            {type === "boolean" && (
                <label className="vq-check">
                    {label}
                    <input
                        aria-label={label}
                        type="checkbox"
                        checked={value as boolean}
                        onChange={(e) => onChange(e.target.checked)}
                    />
                </label>
            )}
            {Array.isArray(value) && (
                <JsonArrayControl
                    value={value}
                    label={label}
                    onChange={onChange}
                    allowBinding={allowBinding}
                    bindings={bindings}
                />
            )}
            {type === "object" && value !== null && !Array.isArray(value) && (
                <>
                    {Object.entries(objectValue).map(([k, v]) => (
                        <div className="vq-item" key={k}>
                            <JsonValueControl
                                value={v}
                                label={`${label}.${k}`}
                                allowBinding={allowBinding}
                                bindings={bindings}
                                onChange={(next) => onChange({ ...objectValue, [k]: next })}
                            />
                            <Button
                                tone="danger"
                                onClick={() =>
                                    onChange(
                                        Object.fromEntries(Object.entries(objectValue).filter(([name]) => name !== k)),
                                    )
                                }
                            >
                                {tx("删除 / Remove ")}
                                {k}
                            </Button>
                        </div>
                    ))}
                    <div className="vq-actions">
                        <label>
                            {tx("字段名 / Field name")}
                            <input
                                aria-label={tx("{{value0}} 字段名 / Field name", { value0: label })}
                                value={key}
                                onChange={(e) => setKey(e.target.value)}
                            />
                        </label>
                        <Button
                            tone="secondary"
                            disabled={
                                !key ||
                                Object.hasOwn(objectValue, key) ||
                                ["__proto__", "constructor", "prototype"].includes(key)
                            }
                            onClick={() => {
                                onChange({ ...objectValue, [key]: "" });
                                setKey("");
                            }}
                        >
                            {tx("添加字段 / Add field")}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
function JsonArrayControl({
    value,
    onChange,
    label,
    allowBinding,
    bindings,
}: {
    value: JsonValue[];
    onChange: (value: JsonValue) => void;
    label: string;
    allowBinding: boolean;
    bindings?: string[];
}) {
    useAppLocale();
    const rows = usePrimitiveRows(value.length);
    // 数组子组件随类型分支创建与销毁，父数组删除行时也按其私有 key 保留存活子树；索引只决定当前业务写入位置，不能成为任
    // 何一层数组的 React 身份。
    return (
        <>
            {value.map((item, index) => (
                <div key={rows.keys[index]}>
                    <JsonValueControl
                        value={item}
                        label={`${label}[${index}]`}
                        allowBinding={allowBinding}
                        bindings={bindings}
                        onChange={(next) =>
                            onChange(value.map((entry, position) => (position === index ? next : entry)))
                        }
                    />
                    <Button
                        tone="danger"
                        onClick={() => {
                            rows.remove(index);
                            onChange(value.filter((_, position) => position !== index));
                        }}
                    >
                        {tx("删除 / Remove ")}
                        {index}
                    </Button>
                </div>
            ))}
            <Button
                tone="secondary"
                onClick={() => {
                    rows.append();
                    onChange([...value, ""]);
                }}
            >
                {tx("添加值 / Add value")}
            </Button>
        </>
    );
}
/**
 * 单路径 JSON 编辑入口，内部用 JsonValueControl，供断言 expected 等字段复用。label 与错误就近展示。
 * 不在输入过程中 eval；仅在 Apply/save 做契约校验。
 */
export function JsonField({
    name,
    label,
    allowBinding = false,
    bindings,
}: {
    name: string;
    label: string;
    allowBinding?: boolean;
    bindings?: string[];
}) {
    useAppLocale();
    const { control } = useFormContext<EditorValues>();
    return (
        <Controller
            control={control}
            name={name as FieldPath<EditorValues>}
            render={({ field }) => (
                <JsonValueControl
                    label={label}
                    value={(field.value === undefined ? {} : field.value) as JsonValue}
                    onChange={field.onChange}
                    allowBinding={allowBinding}
                    bindings={bindings}
                />
            )}
        />
    );
}
/**
 * 字符串数组编辑（允许身份 ID 等），提供增删与排序，写入指定 RHF 路径。重复项由调用方决定是否允许；是否允许重复字符串
 * 完全由调用方自行约束。
 * 空串是否允许由业务 Schema 决定，控件原样保留输入，不自动 trim、去重或包装成带 UI 标记的对象。
 */
export function StringList({ name, label, choices }: { name: string; label: string; choices?: string[] }) {
    useAppLocale();
    const value = useValue<string[] | undefined>(name) ?? [],
        set = useSet();
    return (
        <fieldset>
            <legend>{label}</legend>
            {choices ? (
                choices.map((choice) => (
                    <label key={choice} className="vq-check">
                        <input
                            type="checkbox"
                            checked={value.includes(choice)}
                            onChange={(e) =>
                                set(
                                    name,
                                    e.target.checked ? [...value, choice] : value.filter((entry) => entry !== choice),
                                )
                            }
                        />
                        {choice}
                    </label>
                ))
            ) : (
                <FreeStringRows name={name} label={label} value={value} />
            )}
        </fieldset>
    );
}
function FreeStringRows({ name, label, value }: { name: string; label: string; value: string[] }) {
    useAppLocale();
    const rows = usePrimitiveRows(value.length),
        set = useSet();
    // 每行仍有独立可访问名称，而 fieldset 的 legend 命名整个字符串集合；行标记与文本分离，重复或空值不会合并，删除前面
    // 的行也不会重建仍在输入的后续节点。
    return (
        <>
            {value.map((entry, index) => (
                <div className="vq-actions" key={rows.keys[index]}>
                    <input
                        aria-label={`${label} ${index + 1}`}
                        value={entry}
                        onChange={(e) =>
                            set(
                                name,
                                value.map((item, position) => (position === index ? e.target.value : item)),
                            )
                        }
                    />
                    <Button
                        tone="danger"
                        onClick={() => {
                            rows.remove(index);
                            set(
                                name,
                                value.filter((_, position) => position !== index),
                            );
                        }}
                    >
                        {tx("删除 / Remove")}
                    </Button>
                </div>
            ))}
            <Button
                tone="secondary"
                onClick={() => {
                    rows.append();
                    set(name, [...value, ""]);
                }}
            >
                {tx("添加 / Add ")}
                {label}
            </Button>
        </>
    );
}
/**
 * string->类型 的映射编辑器，用于流程参数声明等 Record 结构。删除键不会残留空条目；删除某个键之后不得残留空的占位条目。
 * 键名冲突时覆盖；不调用 Workspace API。
 */
export function TypeMap({ name, label }: { name: string; label: string }) {
    useAppLocale();
    const value = useValue<Record<string, string> | undefined>(name) ?? {},
        set = useSet(),
        [key, keySet] = useState("");
    return (
        <Section title={label}>
            {Object.entries(value).map(([k, v]) => (
                <div key={k} className="vq-actions">
                    <span>{k}</span>
                    <select
                        aria-label={`${label}.${k}`}
                        value={v}
                        onChange={(e) => set(name, { ...value, [k]: e.target.value })}
                    >
                        {types.map((x) => (
                            <option key={x}>{x}</option>
                        ))}
                    </select>
                    <Button
                        tone="danger"
                        onClick={() => set(name, Object.fromEntries(Object.entries(value).filter(([n]) => n !== k)))}
                    >
                        {tx("删除 / Remove")}
                    </Button>
                </div>
            ))}
            <div className="vq-actions">
                <label>
                    {tx("名称 / Name")}
                    <input value={key} onChange={(e) => keySet(e.target.value)} />
                </label>
                <Button
                    tone="secondary"
                    disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(value, key)}
                    onClick={() => {
                        set(name, { ...value, [key]: "string" });
                        keySet("");
                    }}
                >
                    {tx("添加 / Add ")}
                    {label}
                </Button>
            </div>
        </Section>
    );
}
