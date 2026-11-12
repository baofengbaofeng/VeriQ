/**
 * 本文件 apps/web/src/features/resources/Monaco.tsx 实现 VeriQ Web/共享 UI 界面能力并导出公开组件与辅助函数
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
 * 若行为变更，请同步更新契约样例、相关测试与可观察的错误码语义。
 */

import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/language/json/monaco.contribution";
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
 * 公开符号 Monaco（function）定义 apps/web/src/features/resources/Monaco.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
 * 公开符号 MonacoDiff（function）定义 apps/web/src/features/resources/Monaco.tsx 对外可复用的界面或工具接口
 * 本段注释补充输入前提、失败关闭策略以及与相邻模块的契约对齐方式。
 * 实现时不得绕过 Workspace 归属校验，也不得把密钥或明文凭证写入日志。
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
