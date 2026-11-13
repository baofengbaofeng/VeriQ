"""Hatch 构建钩子区分开发 editable 与正式 wheel，只有正式产物强制包含经过完整库存校验的前端；源码归档携带合同和构建帮助模块，使没有 Git 或仓库父级时仍可重建。

静态目录从默认遍历排除，然后通过唯一映射加入，避免重复 ZIP 成员。
合同资源沿用原有包内路径，不改变运行时查找协议。
钩子只依赖标准库及 Hatchling，不导入尚未安装的应用。
"""

import importlib.util
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface[Any]):
    """在后端选择具体产物类型后注入强制资源，editable 不检查前端，而正式 wheel 与 sdist 共享相同的静态校验；归档内优先读取随包携带的合同副本，避免依赖外部工作区。

    版本由 Hatch 已解析的项目元数据提供。
    缺失入口、库存或迁移属于构建失败，不生成空壳 wheel。
    不调用 Git，也不会在构建时生成伪造的提交标识。
    """

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        """根据目标类型选择包内路径或源码相对路径，正式构建先检查静态字节再映射资源；开发安装只保留合同映射，因此干净 checkout 能在尚未构建 React 时安装开发依赖。

        sdist 显式携带帮助模块和钩子，后续 wheel 无需原仓库。
        force_include 的键使用实际绝对源路径，避免受调用 cwd 影响。
        此钩子不负责测试门禁，构建发行入口另行执行完整验证。
        """
        root = Path(self.root)
        contracts = root / "_release/contracts"
        if not contracts.exists():
            contracts = root.parent.parent / "packages/contracts"
        mappings = build_data.setdefault("force_include", {})
        prefix = "_release/contracts" if self.target_name == "sdist" else "veriq_server"
        mappings[str(contracts / "schemas")] = prefix + (
            "/schemas" if self.target_name == "sdist" else "/_schemas"
        )
        mappings[str(contracts / "openapi/platform.yaml")] = prefix + (
            "/openapi/platform.yaml" if self.target_name == "sdist" else "/_openapi.json"
        )
        if version == "editable":
            return
        spec = importlib.util.spec_from_file_location(
            "veriq_release_support", root / "release_support.py"
        )
        assert spec is not None and spec.loader is not None
        support = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(support)
        static = root / "src/veriq_server/static/dist"
        support.validate_static(static, self.metadata.version)
        engine = root / "src/veriq_server/release/engine-inventory.json"
        if not engine.is_file():
            raise ValueError("Missing candidate engine inventory")
        if not list((root / "src/veriq_server/migrations/versions").glob("*.py")):
            raise ValueError("Missing server migrations")
        destination = (
            "src/veriq_server/static/dist"
            if self.target_name == "sdist"
            else "veriq_server/static/dist"
        )
        mappings[str(static)] = destination
        mappings[str(engine)] = (
            "src/veriq_server/release/engine-inventory.json"
            if self.target_name == "sdist"
            else "veriq_server/release/engine-inventory.json"
        )
        for name, relative in [
            ("LICENSE", "LICENSE"),
            ("NOTICE", "THIRD_PARTY_NOTICES.md"),
            ("server.example.json", "deploy/server.example.json"),
        ]:
            source = root / "_release" / name
            if not source.exists():
                source = root.parent.parent / relative
            if not source.is_file():
                raise ValueError("Missing server release legal or configuration resource")
            mappings[str(source)] = (
                "_release/" if self.target_name == "sdist" else "veriq_server/release/"
            ) + name
        if self.target_name == "sdist":
            for name in ("hatch_build.py", "release_support.py"):
                mappings[str(root / name)] = name
