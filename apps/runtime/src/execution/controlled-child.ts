/** VeriQ 的 TypeScript 入口仅转发共享 MJS 的具名值与公开类型，使现有源码消费者保留原导入路径；Worker 后续可用普通 Node 直接导入同一个实现，避免运行时依赖 checkout 的类型加载器。
 * 本文件不创建观察状态、监听器或协议解析器。
 * 生命周期及取消权限统一由 controlled-child.mjs 管理。
 * 类型声明位于对应 d.mts，原有接口名称保持兼容。
 */
export { trackObservedCli } from "./controlled-child.mjs";
/** 原有公开类型保持具名转发并统一由共享声明定义，消费者不需要更换 TypeScript 导入路径；新增取消方法属于同一返回接口，不引入第二份运行实现或分叉的选项合同。 */
export type {
    ObservedCliOptions,
    CliExitObservation,
    ControlledChildResult,
} from "./controlled-child.mjs";
