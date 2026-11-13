"""构建工具共用的纯标准库完整性检查用于正式 wheel、源码归档和静态暂存，避免 Hatch 隔离环境依赖尚未安装的服务端模块；运行时仍由已审定的生产静态读取器再次校验。

路径检查在复制之前执行，不能先 resolve 再丢失链接信息。
库存哈希绑定原始 JSON 字节，序列化顺序不会在检查时被改变。
这里的文件集合必须包含图外 worker、字体与公开复制资源。
"""

from hashlib import sha256
import json
import mimetypes
from pathlib import Path
import re
import stat
from typing import Any, cast


def safe_path(path: Path) -> None:
    """逐级检查目标和父目录，拒绝任何符号链接组件及特殊节点，允许尚未创建的普通目标；调用方必须先约束根目录与相对路径，不能把此函数误当作任意位置写入授权。

    缺失的父级可由受保护的构建目录创建。
    已存在的节点只允许普通文件与目录。
    FIFO、设备和套接字不能进入复制或散列流程。
    """
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError("Unsafe linked release path")
        if candidate.exists() and not (
            candidate.is_dir() or stat.S_ISREG(candidate.stat().st_mode)
        ):
            raise ValueError("Unsafe special release path")


def files(root: Path) -> dict[str, Path]:
    """枚举目录中的全部普通文件并保留 POSIX 相对路径，拒绝链接、危险 URL 字符和点段；隐藏构建资料也纳入库存，因此模块图之外的产物不会因过滤规则而被遗漏。

    排序确保相同输入产生稳定的库存字节。
    目录本身不成为库存项，但仍必须通过安全检查。
    空目录不承载运行代码，也不影响完整文件闭包。
    """
    safe_path(root)
    if not root.is_dir():
        raise ValueError("Missing frontend directory")
    result: dict[str, Path] = {}
    for path in sorted(root.rglob("*")):
        safe_path(path)
        relative = path.relative_to(root).as_posix()
        if any(c in relative for c in ("\\", "%", "\x00", "?", "#", ":")):
            raise ValueError("Unsafe release filename")
        if path.is_file():
            result[relative] = path
    return result


def validate_static(root: Path, version: str) -> dict[str, Any]:
    """正式产物必须同时满足完整库存、四字段身份、Vite 引用闭包和唯一 HTML 入口，任一字节或路径不匹配即拒绝；该检查不需要 Git、数据库或应用运行依赖。

    目录真实集合与库存集合精确相等，阻止遗留 assets 混入。
    metadata 是唯一不列入库存的文件，避免循环哈希。
    构建身份不接受未知字段，版本与 Python 项目一致。
    Vite 图不能替代物理库存，只增加导入完整性约束。
    布尔值不能作为长度通过整数类型检查。
    MIME 判断与生产服务相同，额外 HTML 不允许公开。
    """
    actual = files(root)
    required = {"index.html", ".vite/manifest.json", "static-manifest.json", "build-info.json"}
    if not required <= actual.keys():
        raise ValueError("Missing frontend release metadata or index")
    raw = actual["static-manifest.json"].read_bytes()
    inventory = json.loads(raw)
    info = json.loads(actual["build-info.json"].read_bytes())
    if (
        set(info) != {"version", "commit", "buildId", "staticManifestHash"}
        or info["version"] != version
        or not isinstance(info["commit"], str)
        or not re.fullmatch(r"[0-9a-f]{40,64}", info["commit"])
        or not isinstance(info["buildId"], str)
        or not 1 <= len(info["buildId"]) <= 120
        or info["staticManifestHash"] != sha256(raw).hexdigest()
    ):
        raise ValueError("Invalid frontend build identity")
    if set(inventory) != {"schemaVersion", "files"} or inventory["schemaVersion"] != "1.0":
        raise ValueError("Invalid frontend inventory")
    published = set()
    for entry in inventory["files"]:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "sizeBytes"}:
            raise ValueError("Invalid frontend inventory entry")
        name = entry["path"]
        if not isinstance(name, str) or name in published or name not in actual:
            raise ValueError("Invalid frontend inventory path")
        content = actual[name].read_bytes()
        if type(entry["sizeBytes"]) is not int or entry["sizeBytes"] != len(content):
            raise ValueError("Frontend size mismatch")
        if entry["sha256"] != sha256(content).hexdigest():
            raise ValueError("Frontend hash mismatch")
        published.add(name)
    if published != actual.keys() - {"static-manifest.json", "build-info.json"}:
        raise ValueError("Frontend inventory is not complete")
    graph = json.loads(actual[".vite/manifest.json"].read_bytes())
    if not isinstance(graph, dict) or graph.get("index.html", {}).get("isEntry") is not True:
        raise ValueError("Missing frontend Vite entry")
    for entry in graph.values():
        if not isinstance(entry, dict) or entry.get("file") not in published:
            raise ValueError("Invalid frontend Vite output")
        for field in ("css", "assets", "imports", "dynamicImports"):
            values = entry.get(field, [])
            allowed = graph if field in {"imports", "dynamicImports"} else published
            if not isinstance(values, list) or any(
                not isinstance(v, str) or v not in allowed for v in values
            ):
                raise ValueError("Invalid frontend Vite reference")
    for name in published - {"index.html"}:
        mime, encoding = mimetypes.guess_type(name)
        if Path(name).suffix.lower() in {".html", ".htm", ".shtml", ".xhtml", ".xht"} or (
            encoding is None
            and (mime or "").partition(";")[0].strip().lower()
            in {"text/html", "application/xhtml+xml"}
        ):
            raise ValueError("Additional frontend HTML is forbidden")
    return cast(dict[str, Any], info)
