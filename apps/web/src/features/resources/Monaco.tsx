/**
 * Monaco 只读/可写封装与 Diff：用于 JSON 源码模式和已发布生成 TS 的只读查看。语言模式由 props 传入。
 * 不在此执行代码；大文件由调用方限制，避免阻塞 UI 线程。
 */

import { useEffect, useId, useRef, type ReactNode } from "react";
import { tx, useAppLocale } from "../../locale";
/**
 * Monaco 的精简编辑器入口不会提前登记所有功能服务，语言模式的异步加载却可能随后启用这些功能；首次创建编辑器前导入官方
 * 注册集合，防止离线分包顺序产生未知服务错误。
 */
import "monaco-editor/features/register.all";
import * as monaco from "monaco-editor/editor";
import "monaco-editor/language/json/monaco.contribution";
/**
 * TypeScript 的语言服务只订阅语言激活事件，不会自行登记语言标识；必须同时加载同版官方语言定义，使只读生成源码真正创建
 * TypeScript 模型并启动匹配的本地语言 worker。
 */
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
 * 共享编辑器在带有 Web 主题标记的文档中更新配色；只更新 Monaco 的主题服务，保留正在编辑的模型、光标和撤销栈。
 */
function useDocumentTheme() {
    useEffect(() => {
        const root = document.documentElement;
        if (!root.hasAttribute("data-veriq-web")) return;
        const synchronize = () => monaco.editor.setTheme(root.dataset.theme === "dark" ? "vs-dark" : "vs");
        synchronize();
        const observer = new MutationObserver(synchronize);
        observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, []);
}

/**
 * 编辑器字号由 Monaco 用于光标和排版测量。读取网页字号变量更新已有实例，保留模型、光标位置和撤销记录。
 */
function bindEditorFontSize(editor: { updateOptions: (options: { fontSize: number }) => void }, base: number) {
    const root = document.documentElement;
    if (!root.hasAttribute("data-veriq-web")) return () => {};
    let previous = base;
    const synchronize = () => {
        const reduction = Number.parseFloat(getComputedStyle(root).getPropertyValue("--vq-font-reduction")) || 0;
        const fontSize = base - reduction;
        if (fontSize === previous) return;
        editor.updateOptions({ fontSize });
        previous = fontSize;
    };
    synchronize();
    window.addEventListener("resize", synchronize);
    return () => window.removeEventListener("resize", synchronize);
}

/**
 * 源码区域只修改当前编辑器的 Tab 焦点上下文，保留其它实例的首选项，键盘离开后下次进入源码恢复缩进。
 */
function bindSourceTabNavigation(editor: monaco.editor.IStandaloneCodeEditor) {
    const tabMovesFocus = editor.createContextKey<boolean>("editorTabMovesFocus", true);
    let released = false;
    const synchronize = () => tabMovesFocus.set(released || !editor.hasTextFocus());
    const subscriptions = [
        editor.onDidFocusEditorText(() => {
            released = false;
            synchronize();
        }),
        editor.onDidBlurEditorText(synchronize),
        editor.onDidChangeConfiguration(synchronize),
        editor.addAction({
            id: "veriq.releaseSourceTab",
            label: tx("Move keyboard focus out of the source editor"),
            keybindingContext: "editorTextFocus",
            keybindings: [
                monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyM,
                monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.KeyM,
            ],
            run: () => {
                released = true;
                synchronize();
            },
        }),
    ];
    return () => {
        for (const subscription of subscriptions) subscription.dispose();
    };
}

/**
 * 草稿源码与只读生成结果共用受控编辑器，语言由调用方指定；模型独立于界面配色，在组件卸载时释放。
 * 提供底部操作的调用方在编辑期间保持传入同一布局，源码宿主与操作分占边框内的独立区域。
 */
export function Monaco({
    value,
    onChange,
    language = "json",
    readOnly = false,
    label = "JSON source",
    automaticTabNavigation = false,
    footer,
}: {
    value: string;
    onChange?: (value: string) => void;
    language?: string;
    readOnly?: boolean;
    label?: string;
    automaticTabNavigation?: boolean;
    footer?: ReactNode;
}) {
    useAppLocale();
    useDocumentTheme();
    const helpId = useId();
    const describedBy = automaticTabNavigation && readOnly ? undefined : helpId;
    const localizedLabel = tx(label);
    const host = useRef<HTMLDivElement>(null),
        instance = useRef<monaco.editor.IStandaloneCodeEditor>(),
        change = useRef(onChange),
        latestValue = useRef(value);
    change.current = onChange;
    /**
     * 创建模型只随语言、只读与标签变化，文本和回调通过每次渲染更新的引用读取最新值；普通受控输入继续复用同一个模型与撤
     * 销栈，外部文本变化仍由独立同步副作用处理。
     */
    latestValue.current = value;
    useEffect(() => {
        const container = host.current;
        if (!container) return;
        const model = monaco.editor.createModel(latestValue.current, language);
        const fontSize = 13;
        const editor = monaco.editor.create(container, {
            model,
            readOnly,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            ariaLabel: tx(label),
            fontSize,
            tabSize: 2,
            tabFocusMode: automaticTabNavigation,
            wordWrap: "on",
        });
        instance.current = editor;
        const unbindFontSize = bindEditorFontSize(editor, fontSize);
        const unbindTabNavigation = automaticTabNavigation && !readOnly ? bindSourceTabNavigation(editor) : undefined;
        const subscription = editor.onDidChangeModelContent(() => change.current?.(editor.getValue()));
        return () => {
            unbindTabNavigation?.();
            unbindFontSize();
            subscription.dispose();
            editor.dispose();
            model.dispose();
            instance.current = undefined;
        };
    }, [language, readOnly, label, automaticTabNavigation]);
    // 界面语言只更新编辑器已有的可访问名称，不能重建模型、清空撤销栈或改变用户选区；调用方显式修改 label、只读或代码语
    // 言时仍保留原有完整生命周期行为。
    useEffect(() => {
        instance.current?.updateOptions({ ariaLabel: localizedLabel });
    }, [localizedLabel]);
    useEffect(() => {
        if (instance.current && instance.current.getValue() !== value) instance.current.setValue(value);
    }, [value]);
    const editorHost = <div className="vq-monaco" ref={host} />;
    return (
        <fieldset className="vq-monaco-field" aria-describedby={describedBy}>
            <legend className="vq-visually-hidden">{localizedLabel}</legend>
            {footer ? (
                <div className="vq-monaco-frame">
                    {editorHost}
                    {footer}
                </div>
            ) : (
                editorHost
            )}
            {automaticTabNavigation ? (
                !readOnly && (
                    <p id={helpId} className="vq-visually-hidden">
                        {tx("Press Ctrl+M (Control+Shift+M on macOS), then Tab to leave the source editor.")}
                    </p>
                )
            ) : (
                <>
                    <p id={helpId} className="vq-field-hint">
                        {tx(
                            "Use Ctrl+M (Control+Shift+M on macOS) to switch between editing with Tab and moving " +
                                "keyboard focus.",
                        )}
                    </p>
                    <button
                        type="button"
                        onClick={() => instance.current?.trigger("keyboard", "editor.action.toggleTabFocusMode", null)}
                    >
                        {tx("Toggle Tab key navigation")}
                    </button>
                </>
            )}
        </fieldset>
    );
}
/**
 * 并排展示 original/modified 文本差异，用于版本内容对比，二者皆只读。左右滚动默认联动；左右窗格皆只读并且默认保持滚动
 * 位置联动。不发起网络；字符串已由适配器加载。
 */
export function MonacoDiff({ original, modified }: { original: string; modified: string }) {
    useAppLocale();
    useDocumentTheme();
    const localizedLabel = tx("Version difference");
    const labelRef = useRef(localizedLabel);
    labelRef.current = localizedLabel;
    const host = useRef<HTMLDivElement>(null);
    const instance = useRef<monaco.editor.IStandaloneDiffEditor>();
    useEffect(() => {
        const container = host.current;
        if (!container) return;
        const left = monaco.editor.createModel(original, "json"),
            right = monaco.editor.createModel(modified, "json");
        const editor = monaco.editor.createDiffEditor(container, {
            readOnly: true,
            automaticLayout: true,
            renderSideBySide: false,
            minimap: { enabled: false },
            ariaLabel: labelRef.current,
            originalEditable: false,
        });
        instance.current = editor;
        editor.setModel({ original: left, modified: right });
        const unbindFontSize = bindEditorFontSize(editor, monaco.editor.EditorOptions.fontSize.defaultValue);
        return () => {
            unbindFontSize();
            editor.dispose();
            left.dispose();
            right.dispose();
            instance.current = undefined;
        };
    }, [original, modified]);
    useEffect(() => {
        instance.current?.updateOptions({ ariaLabel: localizedLabel });
    }, [localizedLabel]);
    return <div className="vq-monaco" ref={host} />;
}
