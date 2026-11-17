/**
 * 头像组件用姓名首字生成圆形占位头像：当前账户数据不含头像字段，因此以 displayName 的首字符作为视觉标识。统一大小、文字
 * 颜色与背景由全局样式提供，调用方只传入要展示的姓名和可选尺寸。
 */

import type { CSSProperties } from "react";

/**
 * 头像公开属性：name 取首字符渲染，size 以像素控制圆直径，默认 32。空名称回退为问号占位，避免渲染出空圆。
 */
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
    const initial = name.trim().charAt(0) || "?";
    const style: CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.42) };
    return (
        <span className="vq-avatar" style={style} aria-hidden="true" title={name}>
            {initial}
        </span>
    );
}
