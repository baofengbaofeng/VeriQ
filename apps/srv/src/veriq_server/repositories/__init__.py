"""资源仓储包导出按 WorkspaceScope 约束的只读与内联产物访问接口，调用方必须先完成成员授权与安装行锁护栏，缺失时抛出稳定 Problem 码。
具体实现集中在 resource.ResourceRepository；本包不提供任何跨租户的便捷查询入口。
"""


