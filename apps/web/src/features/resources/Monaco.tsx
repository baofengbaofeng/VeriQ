/**
 * Monaco 只读/可写封装与 Diff：用于 JSON 源码模式和已发布生成 TS 的只读查看。语言模式由 props 传入。
 * 不在此执行代码；大文件由调用方限制，避免阻塞 UI 线程。
 */

import { useEffect, useRef } from "react";
/** Monaco 的精简编辑器入口不会提前登记所有功能服务，语言模式的异步加载却可能随后启用这些功能；首次创建编辑器前导入官方注册集合，防止离线分包顺序产生未知服务错误。 */
import "monaco-editor/features/register.all";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/language/json/monaco.contribution";
/** TypeScript 的语言服务只订阅语言激活事件，不会自行登记语言标识；必须同时加载同版官方语言定义，使只读生成源码真正创建 TypeScript 模型并启动匹配的本地语言 worker。 */
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/language/typescript/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
(self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: (_moduleId: string, label: string) =>
        label === "json"
            ? new JsonWorker()
            : ["typescript", "javascript"].includes(label)
              ? new TsWorker()
              : new EditorWorker(),
};
/**
 * 受控编辑器：value/onChange；只读时隐藏写入能力，供草稿 JSON 与生成源码共用。卸载时dispose编辑器实例。
 * 主题与字号固定；语言由 props 指定。
 */
export function Monaco({
    value,
    onChange,
    language = "json",
    readOnly = false,
    label = "JSON source",
    testId = "monaco",
}: {
    value: string;
    onChange?: (value: string) => void;
    language?: string;
    readOnly?: boolean;
    label?: string;
    testId?: string;
}) {
    const host = useRef<HTMLDivElement>(null),
        instance = useRef<monaco.editor.IStandaloneCodeEditor>(),
        change = useRef(onChange);
    change.current = onChange;
    useEffect(() => {
        const model = monaco.editor.createModel(value, language);
        const editor = monaco.editor.create(host.current!, {
            model,
            readOnly,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            ariaLabel: label,
            fontSize: 13,
            tabSize: 2,
            wordWrap: "on",
        });
        instance.current = editor;
        const subscription = editor.onDidChangeModelContent(() =>
            change.current?.(editor.getValue()),
        );
        return () => {
            subscription.dispose();
            editor.dispose();
            model.dispose();
            instance.current = undefined;
        };
    }, [language, readOnly, label]);
    useEffect(() => {
        if (instance.current && instance.current.getValue() !== value)
            instance.current.setValue(value);
    }, [value]);
    return <div className="vq-monaco" ref={host} data-testid={testId} />;
}
/**
 * 并排展示 original/modified 文本差异，用于版本内容对比，二者皆只读。左右滚动默认联动；左右窗格皆只读并且默认保持滚动位置联动。
 * 不发起网络；字符串已由适配器加载。
 */
export function MonacoDiff({ original, modified }: { original: string; modified: string }) {
    const host = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const left = monaco.editor.createModel(original, "json"),
            right = monaco.editor.createModel(modified, "json");
        const editor = monaco.editor.createDiffEditor(host.current!, {
            readOnly: true,
            automaticLayout: true,
            renderSideBySide: false,
            minimap: { enabled: false },
            ariaLabel: "Version difference",
            originalEditable: false,
        });
        editor.setModel({ original: left, modified: right });
        return () => {
            editor.dispose();
            left.dispose();
            right.dispose();
        };
    }, [original, modified]);
    return <div className="vq-monaco" data-testid="resource-diff" ref={host} />;
}
