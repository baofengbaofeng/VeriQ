/**
 * 浏览器夹具仅组合实际抽屉、字段、输入和共享确认框，保留生产样式与严格模式，不复制焦点或对话框实现。
 * 本入口只由开发服务器按测试路径加载，未注册到产品路由，也未加入发布构建入口。
 * 合成资源没有后端；确认次数作为用户可见状态验证按钮确实收到普通指针操作。
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConfirmDialog } from "@veriq/ui";
import { Field } from "../src/components/Field";
import { Input } from "../src/components/Input";
import { Sheet } from "../src/components/Sheet";
import "../src/style.css";
import "../src/features/resources/resources.css";

/**
 * 夹具只持有打开状态与确认计数，两个自然命名的入口分别模拟列表编辑和新增资源，便于核对原始焦点归属。
 * 关闭、嵌套取消、焦点圈定和提示展示全部交给实际组件，不设置额外事件处理器修补交互。
 * 字段内容是公开合成建议，不包含真实恢复短语、用户信息或测试定位标记。
 */
function InteractionFixture() {
    const [open, setOpen] = useState(false);
    const [archives, setArchives] = useState(0);
    const advice = "Use a unique synthetic recovery phrase. Store it offline and never reuse an account password.";
    return (
        <main>
            <h1>Synthetic resource interactions</h1>
            <button type="button" onClick={() => setOpen(true)}>
                Edit synthetic resource
            </button>
            <button type="button" onClick={() => setOpen(true)}>
                Create synthetic resource
            </button>
            <Sheet
                open={open}
                onOpenChange={setOpen}
                title="Synthetic resource"
                description="Component regression fixture"
            >
                <p role="status">Archive confirmations: {archives}</p>
                <Field label="Synthetic recovery phrase" htmlFor="synthetic-phrase" longHint={advice}>
                    <Input id="synthetic-phrase" defaultValue="public synthetic phrase" />
                </Field>
                <ConfirmDialog
                    title="Archive synthetic resource?"
                    trigger="Archive synthetic resource"
                    confirmLabel="Confirm archive"
                    cancelLabel="Cancel archive"
                    onConfirm={() => setArchives((n) => n + 1)}
                >
                    This synthetic archive only increments the visible confirmation count.
                </ConfirmDialog>
            </Sheet>
        </main>
    );
}

/**
 * 使用真实严格模式挂载使组件经历开发期效果重放，不能用普通根节点掩盖抽屉首次挂载时的焦点生命周期问题。
 * 入口容器只承担 React 挂载职责，浏览器用例始终通过用户可感知的角色、名称和标签访问内容。
 */
const container = document.getElementById("root");
if (!container) throw new Error("INTERACTION_FIXTURE_ROOT_MISSING");
createRoot(container).render(
    <StrictMode>
        <InteractionFixture />
    </StrictMode>,
);
