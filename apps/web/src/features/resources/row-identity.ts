/** 原始 JSON 数组和字符串数组没有领域标识，编辑器在挂载时为每一行分配私有标记并通过明确的增删操作维护它们；这些标记只进入 React key，从不写入表单或请求正文。 */
import { useState } from "react";

/** 这个钩子只接受首次挂载的行数，不能用后续长度或文本猜测替换关系；调用方在导入、重置及切换数组类型时必须重挂载所属编辑器，让新文档获得完整的新行生命周期。 */
export function usePrimitiveRows(initialLength: number) {
    // 重复值、空字符串及持续输入都不参与身份判断，因此编辑文字不会替换输入节点；初始化函数只在数组编辑器创建时运行，不能在每次 map 时生成随机 key。
    const [keys, setKeys] = useState(() =>
        Array.from({ length: initialLength }, () => crypto.randomUUID()),
    );
    // 追加和删除先更新同一局部边界的 sidecar，再由调用者同步写入业务数组；React 会将同一输入事件的两项更新合并，保留删除位置之后所有存活行的节点。
    const append = () => setKeys((previous) => [...previous, crypto.randomUUID()]);
    const remove = (index: number) =>
        setKeys((previous) => previous.filter((_, position) => position !== index));
    return { keys, append, remove };
}
