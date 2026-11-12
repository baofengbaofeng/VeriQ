import { useState, type ReactNode } from "react";
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
import type {
  JsonValue,
  ResourceKind,
  ResourceDocumentV1,
} from "@veriq/contracts";
import { Button, Section } from "@veriq/ui";
import { useTranslation } from "react-i18next";
import { useEditorTranslationOptions } from "./i18n";
// RHF paths stay bounded: recursive JSON leaves are edited by typed value controls.
// Canonical ResourceDocumentV1 is validated at Apply/save boundaries.
export type EditorValues = {
  content: { kind: ResourceKind; document: object };
};
export type PageReferenceScope = "CASE" | "FLOW" | "ASSERTION_TEMPLATE";
export const types = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
];
export const methods = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];
export function useValue<T>(name: string): T {
  return useWatch<EditorValues>({ name: name as FieldPath<EditorValues> }) as T;
}
export function useSet() {
  const { setValue } = useFormContext<EditorValues>();
  return (name: string, value: unknown) =>
    setValue(name as FieldPath<EditorValues>, value as never, {
      shouldDirty: true,
    });
}
export function Field({
  name,
  label,
  options,
  number,
  optional,
  testId,
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
  testId?: string;
  hint?: string;
  check?: boolean;
  password?: boolean;
  showUnlistedValue?: boolean;
}) {
  const { control } = useFormContext<EditorValues>();
  return (
    <label className={check ? "vq-check" : ""}>
      {label}
      <Controller
        control={control}
        name={name as FieldPath<EditorValues>}
        render={({ field }) =>
          check ? (
            <input
              type="checkbox"
              name={field.name}
              ref={field.ref}
              checked={(field.value as unknown) === true}
              onBlur={field.onBlur}
              onChange={(e) => field.onChange(e.target.checked)}
              data-testid={testId ?? name}
            />
          ) : options ? (
            <select
              ref={field.ref}
              name={field.name}
              onBlur={field.onBlur}
              value={typeof field.value === "string" ? field.value : ""}
              onChange={(e) =>
                field.onChange(
                  optional && !e.target.value ? undefined : e.target.value,
                )
              }
              data-testid={testId ?? name}
            >
              {optional && <option value="">—</option>}
              {showUnlistedValue &&
                typeof field.value === "string" &&
                field.value &&
                !options.includes(field.value) && (
                  <option value={field.value} disabled>
                    {field.value} · 未在当前作用域声明 / Not declared in this
                    scope
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
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              type={password ? "password" : number ? "number" : "text"}
              value={
                typeof field.value === "string" ||
                typeof field.value === "number"
                  ? field.value
                  : ""
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
              data-testid={testId ?? name}
            />
          )
        }
      />
      {hint && <small>{hint}</small>}
    </label>
  );
}
export type VersionOption = {
  id: string;
  name: string;
  versionNo: number;
  kind: ResourceKind;
  content?: ResourceDocumentV1;
};
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
  const { control } = useFormContext<EditorValues>();
  return (
    <label>
      {label}
      <Controller
        control={control}
        name={name as FieldPath<EditorValues>}
        render={({ field }) => (
          <select
            data-testid={name}
            value={typeof field.value === "string" ? field.value : ""}
            onBlur={field.onBlur}
            ref={field.ref}
            onChange={(e) =>
              field.onChange(
                optional && !e.target.value ? undefined : e.target.value,
              )
            }
          >
            <option value="">选择固定版本 / Select pinned version</option>
            {typeof field.value === "string" &&
              field.value &&
              !versions.some((v) => v.id === field.value) && (
                <option value={field.value}>
                  {field.value} (未加载 / unavailable)
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
  const drag = useDraggable({ id }),
    drop = useDroppable({ id });
  return (
    <div
      ref={drop.setNodeRef}
      className={"vq-item" + (drop.isOver ? " vq-drop" : "")}
    >
      <Button
        tone="secondary"
        ref={drag.setNodeRef}
        {...drag.attributes}
        {...drag.listeners}
        aria-label="拖动排序 / Drag to reorder"
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
export function List(props: {
  name: string;
  title: string;
  initial: () => unknown;
  children: (path: string, index: number) => ReactNode;
}) {
  const value = useValue<unknown>(props.name),
    set = useSet(),
    { t } = useTranslation(undefined, useEditorTranslationOptions);
  if (!Array.isArray(value))
    return (
      <Section title={props.title} testId={props.name}>
        <Button
          tone="secondary"
          data-testid={`${props.name}.add`}
          onClick={() => set(props.name, [props.initial()])}
        >
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
    <Section title={title} testId={name}>
      <DndContext
        sensors={sensors}
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
                onClick={() => array.move(index, index - 1)}
              >
                {t("up")}
              </Button>
              <Button
                tone="secondary"
                disabled={index === array.fields.length - 1}
                onClick={() => array.move(index, index + 1)}
              >
                {t("down")}
              </Button>
              <Button
                tone="danger"
                onClick={() => array.remove(index)}
                data-testid={`${name}.${index}.remove`}
              >
                {t("remove")}
              </Button>
            </div>
            <div className="vq-fields">
              {children(`${name}.${index}`, index)}
            </div>
          </DragRow>
        ))}
      </DndContext>
      <Button
        tone="secondary"
        data-testid={`${name}.add`}
        onClick={() => array.append(initial() as never)}
      >
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
/** Typed JSON values are business data/bindings, never evaluated or reparsed recursively. */
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
  const [key, setKey] = useState("");
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const objectValue =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  return (
    <div className="vq-value">
      <label>
        {label} · 类型 / Type
        <select
          aria-label={`${label} 类型 / Type`}
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
          <input
            aria-label={label}
            value={value as string}
            onChange={(e) => onChange(e.target.value)}
          />
          {allowBinding && (
            <small>
              支持完整占位符并保留类型 / Whole placeholders retain value types.
            </small>
          )}
          {allowBinding && bindings && (
            <select
              aria-label={`${label} 插入绑定 / Insert binding`}
              value=""
              onChange={(e) => {
                if (e.target.value) onChange(e.target.value);
              }}
            >
              <option value="">选择绑定 / Select binding</option>
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
        <>
          {value.map((v, i) => (
            <div key={i}>
              <JsonValueControl
                value={v}
                label={`${label}[${i}]`}
                allowBinding={allowBinding}
                bindings={bindings}
                onChange={(next) =>
                  onChange(value.map((x, j) => (j === i ? next : x)))
                }
              />
              <Button
                tone="danger"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                删除 / Remove {i}
              </Button>
            </div>
          ))}
          <Button tone="secondary" onClick={() => onChange([...value, ""])}>
            添加值 / Add value
          </Button>
        </>
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
                    Object.fromEntries(
                      Object.entries(objectValue).filter(
                        ([name]) => name !== k,
                      ),
                    ),
                  )
                }
              >
                删除 / Remove {k}
              </Button>
            </div>
          ))}
          <div className="vq-actions">
            <label>
              字段名 / Field name
              <input
                aria-label={`${label} 字段名 / Field name`}
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
              添加字段 / Add field
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
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
export function StringList({
  name,
  label,
  choices,
}: {
  name: string;
  label: string;
  choices?: string[];
}) {
  const value = useValue<string[] | undefined>(name) ?? [],
    set = useSet();
  return (
    <div>
      <label>{label}</label>
      {choices ? (
        choices.map((choice) => (
          <label key={choice} className="vq-check">
            <input
              type="checkbox"
              checked={value.includes(choice)}
              onChange={(e) =>
                set(
                  name,
                  e.target.checked
                    ? [...value, choice]
                    : value.filter((x) => x !== choice),
                )
              }
            />
            {choice}
          </label>
        ))
      ) : (
        <>
          {value.map((v, i) => (
            <div className="vq-actions" key={i}>
              <input
                aria-label={`${label} ${i + 1}`}
                value={v}
                onChange={(e) =>
                  set(
                    name,
                    value.map((x, j) => (j === i ? e.target.value : x)),
                  )
                }
              />
              <Button
                tone="danger"
                onClick={() =>
                  set(
                    name,
                    value.filter((_, j) => j !== i),
                  )
                }
              >
                删除 / Remove
              </Button>
            </div>
          ))}
          <Button
            tone="secondary"
            data-testid={`${name}.add`}
            onClick={() => set(name, [...value, ""])}
          >
            添加 / Add {label}
          </Button>
        </>
      )}
    </div>
  );
}
export function TypeMap({ name, label }: { name: string; label: string }) {
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
            onClick={() =>
              set(
                name,
                Object.fromEntries(
                  Object.entries(value).filter(([n]) => n !== k),
                ),
              )
            }
          >
            删除 / Remove
          </Button>
        </div>
      ))}
      <div className="vq-actions">
        <label>
          名称 / Name
          <input
            data-testid={`${name}.key`}
            value={key}
            onChange={(e) => keySet(e.target.value)}
          />
        </label>
        <Button
          tone="secondary"
          data-testid={`${name}.add`}
          disabled={
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(value, key)
          }
          onClick={() => {
            set(name, { ...value, [key]: "string" });
            keySet("");
          }}
        >
          添加 / Add {label}
        </Button>
      </div>
    </Section>
  );
}
