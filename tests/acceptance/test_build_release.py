"""发行入口验收检查应急参数、原子输出和失败保留行为，使用实际文件系统而非模拟成功命令；这些测试防止未完成检查的候选获得正常发行标志，也防止覆盖上一次有效部署资料。

完整构建成本较高，流水线端到端验证由真实 build.sh 门禁承担。
这里独立验证无需数据库或浏览器即可确定的发布安全边界。
"""

import importlib.util
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[2]


def test_skip_tests_requires_an_auditable_reason() -> None:
    """应急跳过参数没有原因时必须在安装依赖和创建输出之前失败，错误应明确指出 reason；验证实际入口而非 argparse 源码，避免新增包装脚本绕过参数约束。

    此请求不授权任何构建步骤执行。
    返回码必须是参数错误，不接受文件缺失或权限错误冒充通过。
    """
    result = subprocess.run(
        ["bash", str(ROOT / "build.sh"), "--skip-tests"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "--reason" in result.stderr


def test_atomic_publish_preserves_previous_release_on_rejection(tmp_path: Path) -> None:
    """发布器必须拒绝尚无完整校验结果的候选并保留旧输出，只有携带成功标志和一致性摘要的目录才能切换原子指针；读者通过同一个 output/server 名称看到完整版本。

    实际目录与符号链接用于验证文件系统效果。
    未验证候选不得通过默认值或缺字段变成成功。
    """
    spec = importlib.util.spec_from_file_location(
        "veriq_build_release", ROOT / "scripts/build_release.py"
    )
    assert spec and spec.loader, "Release implementation is missing"
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    output = tmp_path / "output"
    output.mkdir()
    old = output / "previous"
    old.mkdir()
    (old / "release.json").write_text('{"buildId":"old"}')
    (output / "server").symlink_to(old.name, target_is_directory=True)
    candidate = tmp_path / "candidate"
    candidate.mkdir()
    (candidate / "release.json").write_text(json.dumps({"buildId": "new", "status": "FAILED"}))
    try:
        module.publish(candidate, output)
    except ValueError:
        pass
    else:
        raise AssertionError("Unverified release was published")
    assert (output / "server/release.json").read_text() == '{"buildId":"old"}'
    raw = json.dumps({"buildId": "new", "status": "VERIFIED"})
    (candidate / "release.json").write_text(raw)
    (candidate / "sha256sums").write_text("0" * 64 + "  release.json\n")
    with pytest.raises(ValueError, match="checksum"):
        module.publish(candidate, output)
    assert (output / "server/release.json").read_text() == '{"buildId":"old"}'
    (candidate / "sha256sums").write_text(sha256(raw.encode()).hexdigest() + "  release.json\n")
    module.publish(candidate, output)
    assert (output / "server/release.json").read_text() == raw
    assert (old / "release.json").read_text() == '{"buildId":"old"}'
