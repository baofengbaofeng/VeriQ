import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";

// CVA 只负责展示变体，原生 button 继续承担焦点、disabled、键盘和点击语义，所有 data 与 aria 属性必须透传，才能让 Radix
// asChild 和 VeriQ 目录定位同一个真实 DOM 元素。组合后的
// className 不参与测试身份，不把颜色、布局或翻译文案编码到 veriq-id。测试可以切换 intent，
// 但关键交互的可访问名称和行为必须保持一致。组件不自行添加随机标识，业务页面负责提供稳定的语义锚点。
const styles = cva("rounded px-3 py-2 focus-visible:outline disabled:opacity-50", {
    variants: { intent: { primary: "bg-blue-700 text-white", quiet: "border" } },
    defaultVariants: { intent: "primary" },
});

/**
 * 原生按钮属性与 CVA 展示参数保持分离，外部调用者可传入真实按钮事件与可访问属性；ref 最终必须到达 button，
 * 而不能停留在包装 div 上破坏弹层焦点恢复。type 缺省为 button，表单提交时由业务页面显式选择
 * submit。disabled 保留原生语义，不用 aria-disabled 伪装实际可点击按钮。没有引入新的依赖包，示例复用仓库已有 React18
 * 和 CVA 基线。
 */
export type VeriqButtonProps = ComponentPropsWithoutRef<"button"> & VariantProps<typeof styles>;

/**
 * 此按钮把 ref、事件以及所有标准 data 与 aria 属性交给最终交互 DOM，允许 Radix Trigger 或 Close 通过 asChild
 * 合并行为；调用方无需使用 force click
 * 或测试专属旁路才能激活正常业务交互。展示参数先消费，避免 intent 作为无意义 HTML 属性落在元素上。属性透传保持 React
 * 事件合并链，弹层仍使用正常键盘和焦点逻辑。children 仅由 React 渲染，
 * 组件不把普通文字交给 HTML 解析器。
 */
export const VeriqButton = forwardRef<HTMLButtonElement, VeriqButtonProps>(
    ({ intent, className, type = "button", ...props }, ref) => (
        <button ref={ref} type={type} className={styles({ intent, className })} {...props} />
    ),
);
VeriqButton.displayName = "VeriqButton";
