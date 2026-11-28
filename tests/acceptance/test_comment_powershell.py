"""PowerShell 注释验收只调用固定官方 Parser API，使用真实输入证明字符串边界与拒绝合同，任何待测语句都不得执行。"""

import importlib
import hashlib
import json
import subprocess
from pathlib import Path
import sys
import time
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SUPPORT = importlib.import_module("tests.acceptance.comment_audit_support")
BLOCKS = importlib.import_module("comment_blocks")


def syntax() -> Any:
    """延迟读取正式注释接口，让尚未提供的 PowerShell 适配能力产生真实红测而不依赖测试替身实现语法判断。"""
    return importlib.import_module("comment_syntax")


@pytest.mark.parametrize("newline", ["\n", "\r\n"])
def test_official_powershell_parser_keeps_real_ranges(newline: str) -> None:
    """官方语法必须区分普通字符串与双种 here-string，中文和补充字符之后的范围仍精确对应未归一化原文。"""
    source = newline.join(
        [
            '$x = "😀#伪 <#伪#>" #真实中文😀',
            "$y = '#伪注释'",
            '$a = @"',
            "#伪注释",
            '"@',
            "$b = @'",
            "<#伪块#>",
            "'@",
            "<#正文首行",
            "正文续行😀",
            "#>",
            "#尾行",
        ]
    )
    spans = syntax().comment_ranges(source.encode(), "powershell", "sample.ps1")
    assert [span["text"] for span in spans] == [
        "#真实中文😀",
        newline.join(["<#正文首行", "正文续行😀", "#>"]),
        "#尾行",
    ]
    assert [(span["start"], span["end"]) for span in spans] == [(1, 1), (9, 11), (12, 12)]
    for span in spans:
        assert source[span["offsetCodePoint"] : span["limitCodePoint"]] == span["text"]
        assert source.encode()[span["offsetByte"] : span["limitByte"]] == span["text"].encode()


@pytest.mark.parametrize(
    "source",
    [
        "#先前有效注释\nif (",
        "#先前有效注释\n<#未闭合",
        '#先前有效注释\n$x = "未闭合',
        "#先前有效注释\n$x = @'\n未闭合",
    ],
)
def test_real_invalid_powershell_rejects_entire_file(source: str) -> None:
    """真实官方解析错误须拒绝整份结果，即使错误之前已经有可用注释，也不能生成部分注释或暴露待测源码文字。"""
    with pytest.raises(syntax().CommentSyntaxError) as error:
        syntax().comment_ranges(source.encode(), "powershell", "bad\n" + "x" * 300)
    assert "未闭合" not in str(error.value)
    assert "\n" not in str(error.value)
    assert len(str(error.value)) < 260


def test_powershell_parse_api_does_not_execute_side_effects(tmp_path: Path) -> None:
    """含写文件和主动抛异常的合法语句只能作为解析数据，任何执行入口替代 Parser API 都必须被本例发现并阻断。"""
    target = tmp_path / "must-not-exist.txt"
    source = f"Set-Content -LiteralPath '{target}' -Value 'unexpected'\nthrow 'do not run'\n#真实"
    assert [
        item["text"] for item in syntax().comment_ranges(source.encode(), "powershell", "a.ps1")
    ] == ["#真实"]
    assert not target.exists()


@pytest.mark.parametrize(
    "source",
    [b"#private\xff", b"#private\0", b"\xef\xbb\xbf#real\r\n", b" " * (4 * 1024 * 1024 + 1)],
)
def test_powershell_invalid_input_is_rejected_before_tool(
    source: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    """非法编码、零字节和超量输入在接触运行时前拒绝，输入保护不能等到第三方解析之后再凭碰巧出现的错误生效。"""
    adapter = importlib.import_module("comment_powershell")

    def forbidden() -> str:
        """工具构造在非法输入测试中不可达，若保护顺序退化须直接报测试失败以防工具状态掩盖真正的输入保护缺失。"""
        pytest.fail("runtime reached for invalid input")

    monkeypatch.setattr(adapter, "runtime_path", forbidden)
    with pytest.raises(syntax().CommentSyntaxError):
        syntax().comment_ranges(source, "powershell", "invalid.ps1")


def test_powershell_runtime_unavailable_is_not_empty_success(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """显式配置缺失工具时必须失败关闭，不能回退到缓存或系统工具使错误配置得到与可用运行时相同的成功结果。"""
    monkeypatch.setenv("VERIQ_POWERSHELL_PATH", str(tmp_path / "missing-pwsh"))
    with pytest.raises(syntax().CommentSyntaxError, match="runtime unavailable"):
        syntax().comment_ranges(b"#real", "powershell", "a.ps1")


def test_powershell_valid_json_cannot_hide_protocol_faults(monkeypatch: pytest.MonkeyPatch) -> None:
    """受控回包须绑定输入和真实范围，版本漂移、诊断、重复字段、代理中位、重叠或伪原文均不能靠合法 JSON 放行。"""
    adapter = importlib.import_module("comment_powershell")
    source = "'😀';#真实".encode()
    valid: dict[str, Any] = {
        "protocol": 1,
        "version": "7.6.6",
        "edition": "Core",
        "sha256": hashlib.sha256(source).hexdigest(),
        "byteLength": 14,
        "utf16Length": 8,
        "start": 0,
        "end": 8,
        "errorCount": 0,
        "comments": [[5, 8, "#真实"]],
    }
    # 独立给出补充字符坐标和长度预期，避免把实现的坐标算法抄入协议故障测试而掩盖同源偏移错误。
    monkeypatch.setattr(adapter, "runtime_path", lambda: "/trusted/pwsh")
    monkeypatch.setattr(adapter, "_run", lambda _runtime, _source: json.dumps(valid).encode())
    assert syntax().comment_ranges(source, "powershell", "a.ps1")[0]["text"] == "#真实"
    faults: list[dict[str, Any]] = [
        {"version": "7.7.0"},
        {"edition": "Desktop"},
        {"errorCount": 1},
        {"sha256": "0" * 64},
        {"byteLength": 0},
        {"utf16Length": 0},
        {"end": 7},
        {"protocol": True},
        {"comments": [[2, 8, "#真实"]]},
        {"comments": [[5, 8, "#真实"], [5, 8, "#真实"]]},
        {"comments": [[5, 8, "#伪造"]]},
        {"comments": [[5, 8, "\ud800"]]},
        {"comments": [[5, 9, "#真实"]]},
        {"comments": [[False, 8, "#真实"]]},
        {"extra": "unexpected"},
    ]
    payloads = [json.dumps(valid | fault).encode() for fault in faults]
    encoded = json.dumps(valid).encode()
    payloads.extend(
        [
            b"not-json",
            encoded + b"\n{}",
            encoded.replace(b'{"protocol": 1,', b'{"protocol":1,"protocol":1,', 1),
            b"\xff",
            encoded + b" " * (16 * 1024 * 1024 + 1),
        ]
    )
    for payload in payloads:
        monkeypatch.setattr(adapter, "_run", lambda _runtime, _source, data=payload: data)
        with pytest.raises(syntax().CommentSyntaxError):
            syntax().comment_ranges(source, "powershell", "a.ps1")


def test_powershell_audit_and_block_consumer_keep_denominator(tmp_path: Path) -> None:
    """真实消费者须接入 PowerShell 而保留原生阻断；空块和空行不计正文，字符串内标记及未注释代码始终进入代码分母。"""

    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "-q", "--template=", str(root)], check=True)
    source = '#说明\n$x = "#伪" #尾行\n<#\n正文\n\n#>\n<##>\nWrite-Host 1\n'
    (root / "a.ps1").write_bytes(source.encode())
    (root / "blocked.cpp").write_bytes(b"int x;\n")
    report = SUPPORT.audit(root)
    row = next(row for row in report["files"] if row["path"] == "a.ps1")
    assert (row["commentLines"], row["codeLines"]) == (3, 2)
    assert [item["path"] for item in report["unsupportedPaths"]] == ["blocked.cpp"]
    assert report["ratio"] is None and report["passed"] is False
    spans = BLOCKS.comment_ranges(root, [Path("a.ps1")])["a.ps1"]
    assert [item["text"] for item in spans] == ["#说明", "#尾行", "<#\n正文\n\n#>", "<##>"]
    assert not BLOCKS.replacements(source, spans)


def test_actual_windows_powershell_uses_both_consumers(tmp_path: Path) -> None:
    """本轮 Windows 独立脚本必须经正式适配生成区间并完成块工具处理，不能用排除路径或把代码藏入配置规避源码审计。"""

    path = Path(".github/scripts/windows-native-user.ps1")
    assert path.is_file()
    spans = syntax().comment_ranges((ROOT / path).read_bytes(), "powershell", str(path))
    assert spans
    assert BLOCKS.comment_ranges(ROOT, [path])[path.as_posix()] == spans
    subprocess.run(["git", "init", "-q", "--template=", str(tmp_path)], check=True)
    (tmp_path / path.name).write_bytes((ROOT / path).read_bytes())
    report = SUPPORT.audit(tmp_path)
    assert report["unsupportedPaths"] == []
    assert report["files"][0]["commentLines"] > 0


def test_powershell_process_timeout_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """真实运行时启动超出明确预算时须被终止并给出固定错误类别，不能返回空注释也不能把超时误报为成功解析的结果。"""
    adapter = importlib.import_module("comment_powershell")
    monkeypatch.setattr(adapter, "TIMEOUT_SECONDS", 0.001)
    with pytest.raises(syntax().CommentSyntaxError, match="parser timeout"):
        syntax().comment_ranges(b"#real", "powershell", "a.ps1")


def test_powershell_process_output_budget_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """真实运行时输出超限时必须终止且整份拒绝，进程输出预算与 JSON 解码前的回包预算均不能被合法输入产生的大回包绕过。"""
    adapter = importlib.import_module("comment_powershell")
    monkeypatch.setattr(adapter, "MAX_OUTPUT_BYTES", 128)
    with pytest.raises(syntax().CommentSyntaxError, match="output budget"):
        syntax().comment_ranges(b"#" + b"a" * 4096, "powershell", "a.ps1")


@pytest.mark.parametrize(
    "source,expected",
    [
        (b"", []),
        (
            b"#requires -Version 7.6\n#!/usr/bin/env pwsh\n",
            ["#requires -Version 7.6", "#!/usr/bin/env pwsh"],
        ),
        (b'# {"protocol":1,"comments":[]} "quote"\n', ['# {"protocol":1,"comments":[]} "quote"']),
    ],
)
def test_powershell_raw_boundaries_and_protocol_text_remain_data(
    source: bytes, expected: list[str]
) -> None:
    """空输入与伪回包注释保持原字节身份和坐标，未经批准的 requires 和解释器标记仍按普通注释规则交给质量审计。"""
    spans = syntax().comment_ranges(source, "powershell", "a.ps1")
    assert [span["text"] for span in spans] == expected


def test_powershell_consumer_uses_actual_nonempty_body(tmp_path: Path) -> None:
    """PowerShell 正文标点本身也属于非空说明，块分隔符不能被计入正文，独立代码行与字符串中的伪说明继续增加代码分母。"""

    root = tmp_path / "repo"
    root.mkdir()
    subprocess.run(["git", "init", "-q", "--template=", str(root)], check=True)
    (root / "a.ps1").write_bytes(b'#\n# /\n<#\n"\n#>\n$x="<#fake#>"\nWrite-Host 1\n')
    report = SUPPORT.audit(root)
    assert report["coverageComplete"] is True
    assert report["files"] == [{"path": "a.ps1", "commentLines": 2, "codeLines": 2}]


def test_powershell_tool_discovery_preserves_explicit_and_cache_priority(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """工具发现仅按显式配置、项目固定版本缓存和系统路径依次选择，缺失显式工具不能悄悄回退，完全缺失也必须明确失败。"""
    adapter = importlib.import_module("comment_powershell")
    monkeypatch.setattr(adapter, "__file__", str(tmp_path / "scripts/comment_powershell.py"))
    monkeypatch.setattr(adapter.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(adapter.platform, "system", lambda: "Linux")
    path_tool = tmp_path / "system/pwsh"
    path_tool.parent.mkdir()
    path_tool.touch()
    monkeypatch.setattr(adapter.shutil, "which", lambda _name: str(path_tool))
    cache_tool = tmp_path / ".superpowers/cache/powershell-parser/7.6.6/linux-x64/pwsh"
    cache_tool.parent.mkdir(parents=True)
    cache_tool.touch()
    monkeypatch.delenv("VERIQ_POWERSHELL_PATH", raising=False)
    assert adapter.runtime_path() == str(cache_tool)
    monkeypatch.setenv("VERIQ_POWERSHELL_PATH", str(path_tool))
    assert adapter.runtime_path() == str(path_tool)
    monkeypatch.setenv("VERIQ_POWERSHELL_PATH", "relative/pwsh")
    with pytest.raises(adapter.PowerShellError):
        adapter.runtime_path()
    monkeypatch.delenv("VERIQ_POWERSHELL_PATH")
    cache_tool.unlink()
    assert adapter.runtime_path() == str(path_tool)
    monkeypatch.setattr(adapter.shutil, "which", lambda _name: None)
    with pytest.raises(adapter.PowerShellError):
        adapter.runtime_path()


@pytest.mark.parametrize(
    "source,expected",
    [
        ('"hello $(\n#内部真实\n1\n)"\n#外部真实', ["#内部真实", "#外部真实"]),
        (
            '$x = @"\n#普通文本\n$(\n<#内部真实#>\n"#内部字符串"\n)\n"@\n#外部真实',
            ["<#内部真实#>", "#外部真实"],
        ),
    ],
)
def test_powershell_expandable_string_subexpression_uses_official_nested_tokens(
    source: str, expected: list[str]
) -> None:
    """可展开字符串的子表达式含真实语法，官方嵌套 token 的注释须与外部说明一并计数，普通字符串内容仍保持数据身份。"""
    spans = syntax().comment_ranges(source.encode(), "powershell", "nested.ps1")
    assert [span["text"] for span in spans] == expected


repository_fixture = SUPPORT.repository_fixture


def test_powershell_missing_tool_cli_emits_no_partial_report(
    repository: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """真实审计进程遇到缺失 PowerShell 工具须拒绝整份报告，即便此前的 Python 文件已计量成功也不能发布部分覆盖结果。"""
    (repository / "a.py").write_bytes(b"x = 1\n")
    (repository / "b.ps1").write_bytes(b"#real\nWrite-Host 1\n")
    monkeypatch.setenv("VERIQ_POWERSHELL_PATH", str(tmp_path / "missing-pwsh"))
    output = tmp_path / "report.json"
    result = SUPPORT.run_audit_cli(repository, output, tmp_path)
    assert result.returncode == 2
    assert not output.exists()
    assert "runtime unavailable" in result.stderr
    assert "#real" not in result.stderr


def test_powershell_using_module_parse_does_not_execute_module(tmp_path: Path) -> None:
    """官方解析入口处理 using module 时也不得执行被引用模块，模块内写文件语句只作为辅助反例用于发现任何运行入口替换。"""
    marker = tmp_path / "side-effect"
    module = tmp_path / "example.psm1"
    module.write_text(
        f"Set-Content -LiteralPath '{marker}' -Value 'unexpected'\nclass Example {{}}\n",
        encoding="utf-8",
    )
    source = f"using module '{module}'\n#real"
    assert [
        span["text"]
        for span in syntax().comment_ranges(source.encode(), "powershell", "module.ps1")
    ] == ["#real"]
    assert not marker.exists()


def test_powershell_temporary_io_failure_stays_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """临时文件系统故障也属于解析不确定性，异常中携带的任意路径或多行私有文字都不能穿过统一诊断进入审计进程日志。"""
    adapter = importlib.import_module("comment_powershell")

    def unavailable(**_kwargs: Any) -> Any:
        """受控故障仅替代临时目录创建边界，禁止传播私有错误正文，实际语法与正常进程测试继续使用正式文件系统和运行时。"""
        raise OSError("private\n" + "x" * 300)

    monkeypatch.setattr(adapter.tempfile, "mkdtemp", unavailable)
    with pytest.raises(syntax().CommentSyntaxError) as error:
        syntax().comment_ranges(b"#real", "powershell", "sample.ps1")
    assert "private" not in str(error.value)
    assert "\n" not in str(error.value)


def test_powershell_inherited_output_child_cannot_extend_deadline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """真实控制进程先退出后仍须回收继承输出的子进程，完整解析期限不能被输出管道的 EOF 等待悄悄延长。"""
    adapter = importlib.import_module("comment_powershell")
    child = tmp_path / "child.py"
    parent = tmp_path / "parent.py"
    child_pid = tmp_path / "child.pid"
    child.write_text(
        "import os, pathlib, sys, time\n"
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))\n"
        "time.sleep(8)\n",
        encoding="utf-8",
    )
    parent.write_text(
        "import pathlib, subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, sys.argv[1], sys.argv[2]])\n"
        "while not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.01)\n",
        encoding="utf-8",
    )
    runtime = adapter.runtime_path()
    control = [sys.executable, str(parent), str(child), str(child_pid)]
    original = adapter.run_parser

    def controlled(_arguments: list[str], directory: Path, timeout: float, limit: int) -> bytes:
        """只替换启动命令为快速受控父子进程，正式进程管理与完整回包校验均保持真实，避免冷启动抖动掩盖生命周期缺陷。"""
        return original(control, directory, timeout, limit)

    monkeypatch.setattr(adapter, "run_parser", controlled)
    monkeypatch.setattr(adapter, "TIMEOUT_SECONDS", 3)
    started = time.monotonic()
    with pytest.raises(syntax().CommentSyntaxError):
        syntax().comment_ranges(b"#real", "powershell", "a.ps1")
    elapsed = time.monotonic() - started
    assert child_pid.exists(), "controlled child did not start; regression probe is inconclusive"
    pid = int(child_pid.read_text())
    state = subprocess.run(
        [
            runtime,
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            f"if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}",
        ],
        capture_output=True,
        timeout=10,
        check=False,
    )
    assert elapsed < 5, f"three-second parser budget took {elapsed:.3f} seconds"
    assert state.returncode == 0, "parser child survived process cleanup"


@pytest.mark.parametrize("cleanup_complete", [True, False])
def test_powershell_retains_files_when_cleanup_cannot_be_confirmed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, cleanup_complete: bool
) -> None:
    """运行器无法确认成员全部终止时须保留临时文件，避免删除仍可能被运行时使用的源码；确认终止的失败则正常清理目录。"""
    adapter = importlib.import_module("comment_powershell")
    runner = importlib.import_module("comment_powershell_process")
    directory = tmp_path / "parser"
    directory.mkdir()
    monkeypatch.setattr(adapter.tempfile, "mkdtemp", lambda **_kwargs: str(directory))

    def failed(*_args: Any) -> bytes:
        """只在进程管理边界注入无法确认的终止状态，文件创建与清理仍走正式路径，避免用被测输出推导预期目录策略。"""
        raise runner.ProcessBudgetError("PowerShell parser cleanup unconfirmed", cleanup_complete)

    monkeypatch.setattr(adapter, "run_parser", failed)
    with pytest.raises(syntax().CommentSyntaxError, match="cleanup unconfirmed"):
        syntax().comment_ranges(b"#real", "powershell", "a.ps1")
    assert directory.exists() is not cleanup_complete
    if not cleanup_complete:
        assert (directory / "source.bin").read_bytes() == b"#real"
