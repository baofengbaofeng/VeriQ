"""使用独立临时源码调用锁定的检查器与格式化器，验证配置生效、错误失败及中文运行时内容和二次格式化稳定性。

这些夹具不接触产品源码，工具退出码来自真实子进程；发行编排的停止顺序由相邻入口验收单独证明。
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
DOC = "工具配置夹具通过合法中文常量验证检查结果，无需连接产品数据库或调用任何外部服务。"


def _tool(module: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    """以当前冻结环境的解释器执行实际工具并保留标准输出和退出码，避免命令缺失或其它环境中的同名程序冒充验证结果。"""
    return subprocess.run(
        [sys.executable, "-m", module, *arguments],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )


def test_pylint_accepts_documented_code_and_rejects_undefined_name(
    tmp_path: pathlib.Path,
) -> None:
    """同一份中文说明夹具先以合法常量通过检查，再引入真实未定义名称并核对具体诊断，证明配置没有屏蔽关键错误。"""
    source = tmp_path / "quality_fixture.py"
    source.write_text(
        f'"""{DOC}"""\n\nVALUE = "中文业务值"\n',
        encoding="utf-8",
    )
    arguments = ("--rcfile", str(ROOT / "apps/srv/pylintrc"), str(source))
    valid = _tool("pylint", *arguments)
    assert valid.returncode == 0, valid.stdout + valid.stderr
    source.write_text(
        source.read_text(encoding="utf-8") + "RESULT = missing_value\n",
        encoding="utf-8",
    )
    invalid = _tool("pylint", *arguments)
    assert invalid.returncode != 0
    assert "undefined-variable" in invalid.stdout


def test_black_checks_format_preserves_values_and_is_idempotent(
    tmp_path: pathlib.Path,
) -> None:
    """格式错误必须使只读检查失败，实际格式化后再次检查通过且运行值和中文字节保持一致，第二次写入不再修改文件。"""
    source = tmp_path / "format_fixture.py"
    source.write_text(
        f'"""{DOC}"""\n\n'
        "def value():\n    return {'message':'中文业务值','items':[1,2,3]}\n\n"
        "print(value())\n",
        encoding="utf-8",
    )
    arguments = ("--config", str(ROOT / "apps/srv/pyproject.toml"), str(source))
    before = subprocess.run(
        [sys.executable, str(source)],
        capture_output=True,
        check=True,
    )
    invalid = _tool("black", "--check", *arguments)
    assert invalid.returncode == 1, invalid.stdout + invalid.stderr
    formatted = _tool("black", *arguments)
    assert formatted.returncode == 0, formatted.stdout + formatted.stderr
    contents = source.read_bytes()
    after = subprocess.run(
        [sys.executable, str(source)],
        capture_output=True,
        check=True,
    )
    assert after.stdout == before.stdout
    assert "中文业务值".encode() in contents
    assert b"    return" in contents
    assert _tool("black", "--check", *arguments).returncode == 0
    assert _tool("black", *arguments).returncode == 0
    assert source.read_bytes() == contents
