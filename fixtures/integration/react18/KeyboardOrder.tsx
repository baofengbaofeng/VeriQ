import { useState } from "react";
import { DndContext, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";

/** 排序项标识必须来自稳定业务 id，界面顺序由父应用保存并从服务端重新读取；同一记录可改变位置，但 data-record-key 与拖动 id 不能随视觉下标变化。
 */
export interface OrderItem { id: string; title: string; }

function Row({ item, pending }: { item: OrderItem; pending: boolean }) {
    // 拖动柄使用原生按钮承接 dnd-kit 的键盘监听与 ref，放置目标使用同一业务 id，记录容器保留稳定身份，确保键盘 Space、箭头及 Escape 能完成正常用户操作。
    // 拖动变换只改变视觉位置，最终顺序由 onDragEnd 提交给父应用持久化。
    // pending 期间不继续发起排序写入，失败留给父组件显示并恢复原服务端顺序。
    // 不提供测试专用排序接口，DSL 可以通过 press 作用于正常拖动按钮。
    const drag = useDraggable({ id: item.id, disabled: pending });
    const drop = useDroppable({ id: item.id });
    return (
        <li ref={drop.setNodeRef} data-testid="order.row" data-record-key={item.id}>
            <button type="button" ref={drag.setNodeRef} {...drag.listeners} {...drag.attributes} data-testid="order.handle"
                disabled={pending} aria-label={`Move ${item.title}`}
                style={{ transform: drag.transform ? `translate(${drag.transform.x}px, ${drag.transform.y}px)` : undefined }}>
                {item.title}
            </button>
        </li>
    );
}

/** 本组件通过正常键盘拖动重新排列并调用真实持久化回调，不把拖动动画当成保存成功；父应用需要等待写入及只读查询完成后更新 items，失败时保留原顺序并向用户显示错误。
 * dnd-kit core 已在仓库基线中声明，不要求新增 sortable 依赖。
 * 键盘传感器默认支持 Space/Enter 开始和结束、Escape 取消。
 * 正式页面还应通过翻译系统提供动作标签，示例默认使用英文。
 */
export function KeyboardOrder({ items, persist }: { items: OrderItem[]; persist: (ids: string[]) => Promise<void> }) {
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);
    const sensors = useSensors(useSensor(KeyboardSensor));
    async function end(event: DragEndEvent) {
        if (!event.over || event.active.id === event.over.id || pending) return;
        const ids = items.map((item) => item.id);
        const from = ids.indexOf(String(event.active.id));
        const to = ids.indexOf(String(event.over.id));
        if (from < 0 || to < 0) return;
        const [id] = ids.splice(from, 1);
        ids.splice(to, 0, id!);
        setPending(true);
        setFailed(false);
        try { await persist(ids); }
        catch { setFailed(true); }
        finally { setPending(false); }
    }
    return (
        <>
            {failed && <p role="alert" data-testid="order.error">Order save failed</p>}
            <DndContext sensors={sensors} onDragEnd={end}>
                <ul data-testid="order.list" aria-busy={pending}>{items.map((item) => <Row key={item.id} item={item} pending={pending} />)}</ul>
            </DndContext>
        </>
    );
}
