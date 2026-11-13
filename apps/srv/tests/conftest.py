"""生产静态测试在临时安装包目录中生成小型发布输入并替换资源定位边界；真实应用、Tornado 文件处理与鉴权逻辑保持不变，开发测试无需创建发行目录。

资源定位只替换 veriq_server 包，不影响其它 Python 依赖。
此 fixture 不改 make_app、处理器或安全配置。
每个测试有独立 tmp_path，损坏文件不会传到下一个场景。
安装包路径刻意包含 static/dist 层级。
fixture 本身不启动数据库、Node 或浏览器。
生成内容用于协议与文件服务测试，不能作为正式发布产物。
实际前端构建由独立 HTTPS 浏览器测试读取。
该测试也只在临时包目录中生成测试库存。
正式 stage、wheel hook 和发行身份生成属于 T18。
测试返回根目录，调用方可精确删除某个输入。
所有声明摘要都对保存下来的原始文件字节计算。
UTF-8 HTML、JS、CSS 和 SVG 提供不同类型的真实文件。
内部元数据没有作为额外公开文件复制。
"""

import hashlib
from importlib import resources
import json

import pytest

from veriq_server import __version__


@pytest.fixture
def static_package(tmp_path, monkeypatch):
    """构造与 Vite 清单格式一致的包内资源及公开构建元数据，测试可独立删除或损坏文件以检查生产启动失败，同时避免写入源码包目录污染后续开发检查。

    index.html 是唯一允许的 HTML 入口。
    JS 和 CSS 名称符合 Vite 默认指纹样式。
    favicon 刻意不进入 Vite 的 assets 引用。
    这个图外文件必须由完整库存授权后才能被服务。
    .vite/manifest.json 保留真实入口与 CSS 引用结构。
    isEntry 标记用于验证构建确实有可加载入口。
    模块图先写盘，再进入完整库存。
    完整库存按相对路径稳定排序，便于手工核对失败。
    sizeBytes 来自对应文件的实际长度。
    sha256 来自对应文件的原始字节。
    库存生成时还没有写入两个身份元数据文件。
    因而它们不会误入自身文件集合，避免哈希循环。
    inventory_raw 保存的字节就是顶层公开哈希的输入。
    不在解析后重新格式化库存再计算摘要。
    version 使用当前 Python 包版本，覆盖前后端版本一致性。
    commit 和 buildId 为明确的测试身份，不声明真实发行来源。
    这些元数据不携带测试数据库地址或运行密钥。
    monkeypatch 只替换 package resources 的定位边界。
    非 VeriQ 包请求仍委托原始资源实现。
    请求结束后 pytest 自动恢复该替换。
    临时目录由 pytest 管理，不覆盖源码静态目录。
    测试可在应用启动后替换某个文件为链接，检查请求时门禁。
    """
    package = tmp_path / "installed" / "veriq_server"
    root = package / "static" / "dist"
    (root / "assets").mkdir(parents=True)
    (root / ".vite").mkdir()
    (root / "index.html").write_text('<html><div id="root">VeriQ</div></html>')
    (root / "assets" / "app-Abc123xy.js").write_text('console.log("VeriQ");')
    (root / "assets" / "app-Def456xy.css").write_text("body { color: black; }")
    (root / "favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg"/>')
    manifest = {
        "index.html": {
            "file": "assets/app-Abc123xy.js",
            "isEntry": True,
            "css": ["assets/app-Def456xy.css"],
            "assets": [],
        }
    }
    raw = json.dumps(manifest).encode()
    (root / ".vite" / "manifest.json").write_bytes(raw)
    inventory = {
        "schemaVersion": "1.0",
        "files": [
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "sizeBytes": path.stat().st_size,
            }
            for path in sorted(root.rglob("*"))
            if path.is_file()
        ],
    }
    inventory_raw = json.dumps(inventory).encode()
    (root / "static-manifest.json").write_bytes(inventory_raw)
    (root / "build-info.json").write_text(
        json.dumps(
            {
                "version": __version__,
                "commit": "f21e0d7648717534d77234f59808da36d5fefeae",
                "buildId": "t17-fixture",
                "staticManifestHash": hashlib.sha256(inventory_raw).hexdigest(),
            }
        )
    )
    original = resources.files
    monkeypatch.setattr(
        resources, "files", lambda anchor: package if anchor == "veriq_server" else original(anchor)
    )
    return root
