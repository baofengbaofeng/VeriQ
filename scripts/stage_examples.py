"""正式发行读取已跟踪的规范示例模块和 JSON 资产，核对仓库兼容副本并输出本次构建的源文件库存，不生成业务回执、不改写源码，也不依赖运行中的服务或 Git 查询。

规范来源固定为 Python 包，安装后 API 与 CLI 均读取同一资源。
仓库副本不参与运行，差异使发行失败而不是静默选择其中之一。
库存只写入受构建入口控制的 work 目录，不向包目录添加生成文件。
"""

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import tempfile
from typing import Any

ASSETS = ("catalog", "dataset", "fixture", "flow", "case", "suite", "environment")
MODULES = ("__init__.py", "bootstrap.py", "platform_http.py", "resources.py")
DATA = ("data/manifest.json", *(f"data/assets/{name}.json" for name in ASSETS))


def _read(root: Path, name: str) -> bytes:
    """只读取约定目录中的普通源文件并逐级拒绝符号链接，不允许包资源或仓库兼容副本通过路径别名指向其它内容，文件上限防止意外大文件进入发行源码库存。
    """
    path = root / name
    current = path
    while current != root.parent:
        if current.is_symlink():
            raise ValueError("Sample source cannot contain symbolic links")
        current = current.parent
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError("Sample source must be a regular file")
    with path.open("rb") as source:
        raw = source.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Sample source exceeded limit")
    return raw


def stage_examples(root: Path, output: Path) -> dict[str, Any]:
    """为正常发行生成可追溯的模块和数据散列，兼容 JSON 必须与规范包逐字节相同；输出仅允许当前仓库 work 下的普通路径，库存不声明代码经过编译或业务验收。

    源文件完全保持跟踪状态，避免正常构建末尾的源码绑定复核漂移。
    wheel 自身的 RECORD 与已有发行源绑定仍是完整性依据。
    缺文件、差异、非法清单或不安全输出均在 wheel 构建之前失败。
    本函数由持有发行锁的编排器调用，独立入口只生成独立库存文件。
    """
    root = root.absolute()
    work = root / "work"
    output = output.absolute()
    if not output.is_relative_to(work) or output == work:
        raise ValueError("Sample inventory output must be under repository work")
    for parent in (output, *output.parents):
        if parent.is_symlink():
            raise ValueError("Sample inventory output cannot traverse symbolic links")
        if parent == root:
            break
    package = root / "apps/srv/src/veriq_server/examples"
    records: list[dict[str, Any]] = []
    for name in (*MODULES, *DATA):
        raw = _read(package, name)
        if name in DATA:
            json.loads(raw)
            legacy_name = name.removeprefix("data/")
            if raw != _read(root / "fixtures/sample-workspace", legacy_name):
                raise ValueError("Repository sample copy differs from canonical package")
        records.append({"path": "veriq_server/examples/" + name,
                        "sha256": sha256(raw).hexdigest(), "sizeBytes": len(raw)})
    manifest = json.loads(_read(package, "data/manifest.json"))
    if manifest.get("schemaVersion") != "1.0" or manifest.get("order") != list(ASSETS):
        raise ValueError("Canonical sample manifest order differs")
    result = {"schemaVersion": "1.0", "files": records}
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, delete=False) as target:
        temporary = Path(target.name)
        try:
            json.dump(result, target, ensure_ascii=False, indent=4, sort_keys=True)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
    return result


def main() -> None:
    """独立源码库存入口只读取固定示例来源并把结果写到明确 work 子路径，不运行应用、编译器、测试或网络；实际正式发行应通过 build_release 在统一源码身份下调用此阶段。
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        stage_examples(args.root, args.output or args.root / "work/examples-source-inventory.json")
        print("Sample source inventory staged")
    except (OSError, ValueError, TypeError, AttributeError):
        parser.exit(1, "Sample source staging failed\n")


if __name__ == "__main__":
    main()
