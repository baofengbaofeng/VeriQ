"""历史仓库模块仅重导出已安装包中的标准库 HTTP 客户端，保留外部示例调用方的导入兼容性，同时确保 Cookie、CSRF、
重定向与错误处理只有一份规范实现来源。

这个文件不创建请求，也不从源码目录动态查找另一份客户端。包内实现随正常 wheel 安装，不要求控制服务主机拥有 Git 或 Node。
"""

from veriq_server.examples.platform_http import NoRedirect, Platform

__all__ = ["NoRedirect", "Platform"]
