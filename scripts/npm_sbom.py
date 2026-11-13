"""前端依赖 SBOM 使用 pnpm 已解析的生产依赖树与实际安装包元数据，交由 CycloneDX 模型生成并验证标准格式；报告明确表示捆绑前闭包，不把 tree-shaking 后的实际代码大小伪装成精确组件范围。

本模块不实现版本解析或锁文件依赖求解。
上游许可和 NOTICE 原文复制到发行目录，不能只保留 SPDX 名称。
根锁文件摘要与 BOM 一同保存，便于对应构建输入。
"""

from hashlib import sha256
import json
from typing import Any
from pathlib import Path
import shutil
import subprocess

from cyclonedx.factory.license import LicenseFactory
from cyclonedx.model import Property
from cyclonedx.model.bom import Bom, BomMetaData
from cyclonedx.model.component import Component, ComponentType
from cyclonedx.output import make_outputter
from cyclonedx.schema import OutputFormat, SchemaVersion
from cyclonedx.validation.json import JsonStrictValidator
from packageurl import PackageURL


def npm_sbom(root: Path, destination: Path) -> dict[str, Any]:
    """调用 pnpm 读取真实生产依赖闭包，逐包读取实际版本与许可证后建立 CycloneDX 组件和依赖边；缺少许可元数据时失败，并保留上游声明文本供最终发行审查。

    工作区包采用自身真实版本，不把 link 路径当成版本号。
    同一包的不同版本分别建立组件，不能按名称合并。
    重复树节点只复用组件，依赖边仍从每次出现的节点收集。
    pnpm 输出负责依赖选择，本模块只做标准格式适配。
    """
    tree = json.loads(
        subprocess.check_output(
            ["pnpm", "--filter", "@veriq/web", "list", "--prod", "--depth", "Infinity", "--json"],
            cwd=root,
            text=True,
        )
    )
    destination.mkdir(parents=True, exist_ok=True)
    components: dict[str, Component] = {}
    edges: dict[str, set[str]] = {}
    license_factory = LicenseFactory()

    def visit(node: dict[str, Any]) -> Component:
        """一个树节点对应一个已安装 package.json，使用该文件定义组件身份并复制许可证；递归处理已解析子节点时只登记依赖边，不猜测缺失路径或通过网络补齐供应商信息。

        package.json 路径由 pnpm 提供，不受用户业务输入控制。
        许可证原文保留文件名，重复组件不会重复复制。
        """
        directory = Path(node["path"])
        metadata = json.loads((directory / "package.json").read_bytes())
        name, version = metadata["name"], metadata["version"]
        key = name + "@" + version
        if key not in components:
            license_name = metadata.get("license")
            if not isinstance(license_name, str) or not license_name:
                raise ValueError(f"Missing npm license metadata: {name}")
            namespace, _, basename = name.rpartition("/")
            component = Component(
                name=name,
                version=version,
                bom_ref=key,
                licenses=[license_factory.make_from_string(license_name)],
                purl=PackageURL(
                    type="npm", namespace=namespace or None, name=basename, version=version
                ),
            )
            components[key] = component
            notice_dir = destination / "licenses" / key.replace("/", "-").replace("@", "_")
            notice_dir.mkdir(parents=True)
            for path in directory.iterdir():
                if path.is_file() and path.name.upper().startswith(
                    ("LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT", "README")
                ):
                    shutil.copy2(path, notice_dir / path.name)
            (notice_dir / "metadata.json").write_text(
                json.dumps({"name": name, "version": version, "license": license_name}, indent=2)
                + "\n"
            )
        dependencies = [visit(child) for child in node.get("dependencies", {}).values()]
        edges.setdefault(key, set()).update(str(child.bom_ref) for child in dependencies)
        return components[key]

    main = visit(tree[0])
    main.type = ComponentType.APPLICATION
    bom = Bom(
        components=[item for item in components.values() if item is not main],
        metadata=BomMetaData(component=main),
        properties=[
            Property(
                name="veriq:scope",
                value="Web production dependency closure before bundling; tree shaking may remove code",
            ),
            Property(
                name="veriq:pnpmLockSha256",
                value=sha256((root / "pnpm-lock.yaml").read_bytes()).hexdigest(),
            ),
        ],
    )
    for key, dependencies in edges.items():
        bom.register_dependency(
            components[key], [components[dependency] for dependency in dependencies]
        )
    raw = make_outputter(bom, OutputFormat.JSON, SchemaVersion.V1_6).output_as_string()
    errors = JsonStrictValidator(SchemaVersion.V1_6).validate_str(raw)
    if errors:
        raise ValueError("Generated npm CycloneDX document failed validation")
    (destination / "web-sbom.json").write_text(raw + "\n")
    return {
        "components": len(components),
        "scope": "pre-bundle production dependency closure",
        "sha256": sha256((raw + "\n").encode()).hexdigest(),
    }
