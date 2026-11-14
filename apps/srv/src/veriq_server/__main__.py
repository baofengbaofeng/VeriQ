"""Python 模块入口复用唯一控制服务 CLI，使离线安装与容器可以通过 python -m veriq_server 执行相同配置校验、迁移和生产启动流程，避免另建一套缺少安全检查的启动路径。

本模块不解析第二套参数，也不动态补充发行元数据。
导入 CLI 后只在作为模块运行时调用入口，普通包导入不会启动服务。
"""

from .cli import main

if __name__ == "__main__":
    main()
