"""示例资源必须在导入前满足服务端实际使用的资源正文契约，覆盖安装包读取器和仓库兼容副本，防止定位标记迁移遗漏。

读取真实资产而非重新构造测试目录，因此模式更新后未同步的包内资源会直接使回归失败。测试不连接数据库或启动浏览器。
"""

import copy
import hashlib
import json
from pathlib import Path

from veriq_server import contracts
from veriq_server.examples import resources

ROOT = Path(__file__).resolve().parents[4]


def test_sample_documents_follow_current_resource_contract():
    """安装包与镜像的所有资源都经过发布入口使用的同一契约校验，且两份原始字节必须与读取器提供的库存摘要一致。"""
    sample = resources.sample_package()
    for key in sample["manifest"]["order"]:
        asset = sample["assets"][key]
        assert not contracts.validate_schema("ResourceDocumentV1", asset), key
    for name, digest in sample["sourceInventory"].items():
        canonical = ROOT / "apps/srv/src/veriq_server/examples/data" / name
        mirror = ROOT / "fixtures/sample-workspace" / name
        assert canonical.read_bytes() == mirror.read_bytes(), name
        assert hashlib.sha256(canonical.read_bytes()).hexdigest() == digest, name
        if name != "manifest.json":
            assert not contracts.validate_schema(
                "ResourceDocumentV1", json.loads(mirror.read_bytes())
            )


def test_sample_catalog_rejects_legacy_locator_discriminator():
    """旧定位种类即使仍保留合法目录键也必须由实际服务端契约拒绝，避免迁移样例时意外引入破坏已选决策的兼容别名。"""
    catalog = copy.deepcopy(resources.sample_package()["assets"]["catalog"])
    catalog["document"]["elements"][0]["locator"]["by"] = "testId"
    assert contracts.validate_schema("ResourceDocumentV1", catalog)
