/** 发行生产器使用可移植排序与固定时间创建归档，目标路径由可信构建宿主选择且成员不能逃出源目录；声明供 TypeScript 宿主检查调用参数，实际实现复用同目录成熟 tar 适配模块。 */
export function archive(directory: string, members: string[], destination: string): Promise<void>;

/** 编译器提取先验证全部成员类型与总量，再将相同归档字节写入私有目标目录；声明保留异步失败边界，调用方仍负责先检查发行库存和业务工作区所有权，不能以类型声明代替验签。 */
export function extractCompiler(file: string, cwd: string): Promise<void>;
