"""仓库入口只转交已安装的 VeriQ 示例导入模块，算法和资源只有 Python 包内一份正式来源，不再维护与安装发行可能分叉的第二套
HTTP、验证或发布实现。

先使用控制服务既有 Python 环境；安装发行可直接运行同名模块。此入口不会向 sys.path 注入仓库源码，也不隐式退回任意文件路径
。
"""

from veriq_server.examples.bootstrap import entrypoint


if __name__ == "__main__":
    entrypoint()
