"""注释审计验收通过微型 Git 仓库调用真实 Python 审计和固定 TypeScript 桥接，验证补充字符与原始换行不会改变计数、
违规行或发行退出码，并保留既有范围和严格比例门槛。

夹具仅复制两个轻量脚本并只读链接既有解析器，不安装或复制依赖树。所有被审计片段都是受控输入，短注释专门验证失败规则而非项
目说明。
"""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any, cast

import pytest


ROOT = Path(__file__).resolve().parents[2]
LONG = (
    "注释审计以真实语法区间保留源码行号并检查首行文字长度确保补充字符和原始换行"
    "不会污染代码计数同时通过独立夹具验证报告及退出状态"
)


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    """每个验收使用独立且可清理的微型仓库，脚本副本保持只读且解析器只链接现有锁定版本；忽略工具目录使统计仅包含测试选择
    的输入，同时保留真实 Git 文件枚举路径。

    CLI 需要脚本副本位于原相对路径，才能真实验证由脚本位置确定仓库根目录的行为。

    """
    root = tmp_path / "checkout"
    root.mkdir()
    subprocess.run(["git", "init", "-q", "--template=", str(root)], check=True)
    (root / ".gitignore").write_text("scripts/\npackages/\n", encoding="utf-8")
    scripts = root / "scripts"
    scripts.mkdir()
    for name in ("comment_ranges.mjs", "comment_audit.py"):
        target = scripts / name
        shutil.copyfile(ROOT / "scripts" / name, target)
        target.chmod(0o444)
    dependencies = root / "packages/compiler/node_modules"
    dependencies.mkdir(parents=True)
    (dependencies / "typescript").symlink_to(
        (ROOT / "packages/compiler/node_modules/typescript").resolve(),
        target_is_directory=True,
    )
    return root


def _write(root: Path, name: str, text: str) -> None:
    """被测源码以明确的 UTF8 字节写入夹具，避免测试自身的文本换行转换提前消除 CRLF 反例；父目录只在当前临时仓库内创建，
    调用方负责声明实际应被审计的文件名。

    输入里的短说明和非中文文字属于审计规则的反例，不是本测试的源码注释。

    """
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(text.encode("utf-8"))


def _audit(root: Path) -> dict[str, Any]:
    """直接导入仓库里的生产审计模块并传入夹具根目录，使验收覆盖发行构建器使用的同一个公开函数；不替换子进程或解析器，
    工具缺失及坐标错误必须从真实调用传播给测试。

    CLI 测试另行运行只读脚本副本，验证公开报告文件和进程退出状态。

    """
    spec = importlib.util.spec_from_file_location(
        "veriq_comment_audit", ROOT / "scripts/comment_audit.py"
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return cast(dict[str, Any], module.audit(root))


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("'汉';/*中文*/", (4, 10, 4, 10, 1, 1, "/*中文*/")),
        ("'😀';/*中😀文*/", (5, 13, 4, 11, 1, 1, "/*中😀文*/")),
        ("/*中😀文*/'😀';", (0, 8, 0, 7, 1, 1, "/*中😀文*/")),
        ("'😀';\r\n//中😀文", (7, 13, 6, 11, 2, 2, "//中😀文")),
    ],
    ids=["bmp", "nonbmp-before-and-inside", "nonbmp-after", "raw-crlf"],
)
def test_bridge_keeps_utf16_and_adds_codepoint_coordinates(
    repository: Path, text: str, expected: tuple[int, int, int, int, int, int, str]
) -> None:
    """桥接必须同时保留原有 UTF16 坐标与新增码点边界，并在 BMP、补充字符和原始 CRLF 输入中指向同一段真实注释；
    字面预期值独立列出，防止测试复制实现中的映射算法而掩盖偏移错误。

    EOF 不追加换行，原字段的文本与行号也作为兼容性契约一并检查。

    """
    _write(repository, "sample.ts", text)
    result = subprocess.run(
        ["node", "scripts/comment_ranges.mjs"],
        cwd=repository,
        input='["sample.ts"]',
        capture_output=True,
        text=True,
        check=True,
    )
    offset, limit, point_offset, point_limit, start, end, content = expected
    ranges = json.loads(result.stdout)["sample.ts"]
    assert ranges == [
        {
            "offset": offset,
            "limit": limit,
            "offsetCodePoint": point_offset,
            "limitCodePoint": point_limit,
            "start": start,
            "end": end,
            "text": content,
        }
    ]
    assert text[point_offset:point_limit] == content
    assert text.encode("utf-16-le")[offset * 2 : limit * 2].decode("utf-16-le") == content


@pytest.mark.parametrize(
    "text",
    [
        f"const face = '汉'; /*{LONG}*/",
        f"const face = '😀'; /*{LONG}*/",
        f"/*{LONG}😀*/ const face = '汉';",
        f"/*{LONG}*/ const face = '😀';",
        f"const face = '汉'; //{LONG}😀",
    ],
    ids=[
        "bmp",
        "nonbmp-before-eof",
        "nonbmp-inside",
        "nonbmp-after",
        "nonbmp-inside-eof",
    ],
)
def test_eof_and_mixed_code_count_each_line_once(repository: Path, text: str) -> None:
    """没有尾换行的混合代码和注释行必须各计一次，即使补充字符位于注释之前或内部也不能越界或残留伪代码；
    这些片段直接复现旧版按 UTF16 索引 Python 字符列表时的文件尾异常。

    单行双计保持既有分母语义，因此比例应为二分之一且没有首行违规。

    """
    _write(repository, "sample.ts", text)
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 1, "codeLines": 1}]
    assert report["ratio"] == 0.5
    assert report["violations"] == []
    assert report["passed"] is True


@pytest.mark.parametrize("newline", ["\n", "\r\n"], ids=["lf", "crlf"])
def test_multiline_masks_preserve_raw_line_breaks(repository: Path, newline: str) -> None:
    """多行注释中的补充字符与原始换行必须在 Node 和 Python 两侧保持相同位置，遮罩只移除注释文字而保留跨行结构；
    块首尾混入代码时仍分别计数，并保留随后行注释和末行代码的位置。

    关闭分隔符所在行含代码时也计入注释，明确保留既有逐行规则而不重新定义统计口径。

    """
    text = newline.join(
        [
            f"const face = '😀'; /*{LONG}",
            " * 😀续行",
            " */ const tail = 1;",
            f"//{LONG}",
            "const done = 2;",
            "",
        ]
    )
    _write(repository, "sample.ts", text)
    assert (repository / "sample.ts").read_bytes() == text.encode("utf-8")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 4, "codeLines": 3}]
    assert report["ratio"] == 4 / 7
    assert report["violations"] == []
    assert report["passed"] is True


def test_crlf_without_supplementary_characters_preserves_following_code(
    repository: Path,
) -> None:
    """即使没有补充字符，Python 默认换行归一化也会让 Node 原始偏移遮罩到后续代码，因此该反例单独固定 CRLF 与纯 BMP
    文本，证明修复同时保留原始换行并正确统计块外两条语句。

    独立的关闭分隔符不制造注释计数，比例仍按两行有效说明和两行代码计算。

    """
    _write(
        repository,
        "sample.ts",
        f"const x = 1;\r\n/*{LONG}\r\n续行\r\n*/\r\nconst y = 2;\r\n",
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 2, "codeLines": 2}]
    assert report["ratio"] == 0.5
    assert report["violations"] == []
    assert report["passed"] is True


def test_adjacent_comments_and_slashes_in_literals_keep_exact_violation_line(
    repository: Path,
) -> None:
    """字符串、模板和正则中的斜杠必须留作代码，真实相邻行注释只用块首行校验长度；另一个混合代码短注释应准确报告第七行，
    避免坐标修复意外扩大注释识别范围或改变连续块合并规则。

    补充字符放在三种字面量中，使后续真实注释也覆盖累计偏移差的场景。

    """
    _write(
        repository,
        "sample.ts",
        'const text = "//字符串😀";\n'
        "const template = `/*模板😀*/`;\n"
        r"const regex = /\/\/|\/\*/;" + "\n"
        f"//{LONG}\n//续行\n\nconst x = 1; //短\n",
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 3, "codeLines": 4}]
    assert report["ratio"] == 3 / 7
    assert report["violations"] == [
        {
            "path": "sample.ts",
            "line": 7,
            "reason": "Chinese comment first line must contain at least 40 characters",
        }
    ]
    assert report["passed"] is False


@pytest.mark.parametrize(
    ("first", "passed"),
    [("中" * 38 + "😀", False), ("中" * 39 + "😀", True)],
    ids=["39", "40"],
)
def test_first_line_threshold_counts_unicode_characters(
    repository: Path, first: str, passed: bool
) -> None:
    """首行长度必须按 Unicode 字符判定三十九与四十的边界，补充字符只能贡献一个字符而不能因 UTF16 双单元提前通过；
    片段没有代码干扰比例，因此失败只能来自真实的首行长度违规。

    两种输入均以中文开头且位于无尾换行的文件末尾，覆盖字符计数和遮罩边界的结合。

    """
    _write(repository, "sample.ts", f"//{first}")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.ts", "commentLines": 1, "codeLines": 0}]
    assert report["ratio"] == 1
    assert report["passed"] is passed
    assert report["violations"] == (
        []
        if passed
        else [
            {
                "path": "sample.ts",
                "line": 1,
                "reason": "Chinese comment first line must contain at least 40 characters",
            }
        ]
    )


@pytest.mark.parametrize(
    ("code", "ratio", "passed"),
    [("const z = 3;\n", 0.4, False), ("", 0.5, True)],
    ids=["exact-40", "above-40"],
)
def test_ratio_remains_strict_with_no_quality_violations(
    repository: Path, code: str, ratio: float, passed: bool
) -> None:
    """覆盖率恰好百分之四十必须拒绝而超过该值才通过，连续两行有效注释的首行已满足中文长度要求，确保边界结果真实来自严格
    比例比较而不是另一个违规条件或分母变化。

    额外代码行只改变代码计数，注释内容和合并规则在两个场景中保持一致。

    """
    _write(repository, "sample.ts", f"//{LONG}\n//续行\nconst x = 1;\nconst y = 2;\n{code}")
    report = _audit(repository)
    assert report["files"] == [
        {"path": "sample.ts", "commentLines": 2, "codeLines": 3 if code else 2}
    ]
    assert report["violations"] == []
    assert report["ratio"] == ratio
    assert report["passed"] is passed


def test_owned_git_scope_keeps_tests_old_files_and_only_explicit_exclusions(
    repository: Path,
) -> None:
    """真实 Git 枚举必须同时纳入已跟踪旧源码和尚未忽略的测试文件，只排除既有三个生成文件与私有证据；普通名称带
    generated 的源码仍被审计，防止修复通过扩大排除或丢弃旧文件改变门禁范围。

    被排除片段故意使用无效说明，若范围意外扩大将使实际报告出现额外文件和违规。

    """
    for name in ("old.ts", "tests/new.ts", "other.generated.ts"):
        _write(repository, name, f"//{LONG}\n")
    subprocess.run(["git", "add", "old.ts"], cwd=repository, check=True)
    generated = [
        "apps/desktop/src/shared/operations.generated.ts",
        "packages/contracts/src/api.generated.ts",
        "packages/contracts/src/types.generated.ts",
    ]
    for name in [*generated, ".superpowers/private.ts", "ignored.txt"]:
        _write(repository, name, "//短\n")
    subprocess.run(["git", "add", "--force", "--", *generated], cwd=repository, check=True)
    report = _audit(repository)
    assert report == {
        "method": "syntax-comments-v1",
        "generatedExclusions": sorted(generated),
        "requiresHumanQualityReview": True,
        "ratio": 1,
        "passed": True,
        "files": [
            {"path": name, "commentLines": 1, "codeLines": 0}
            for name in ["old.ts", "other.generated.ts", "tests/new.ts"]
        ],
        "violations": [],
    }


@pytest.mark.parametrize(
    ("comment", "exit_code"),
    [(LONG + "😀", 0), ("短😀", 1)],
    ids=["success", "rule-failure"],
)
def test_cli_writes_report_and_returns_rule_exit_from_another_cwd(
    repository: Path, tmp_path: Path, comment: str, exit_code: int
) -> None:
    """公开命令从仓库外执行时仍必须读取脚本所在仓库，生成可消费的报告并按真实中文首行规则返回成功或失败；
    输入含补充字符且没有尾换行，使 CLI 同时证明修复路径和发行退出码保持一致。

    报告写到嵌套的新目录，真实验证输出父目录创建而不借用审计函数返回值作预期。

    """
    _write(repository, "sample.ts", f"//{comment}")
    output = tmp_path / "reports/result.json"
    result = subprocess.run(
        [
            sys.executable,
            str(repository / "scripts/comment_audit.py"),
            "--output",
            str(output),
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
    )
    assert result.returncode == exit_code, result.stderr
    assert result.stderr == ""
    assert result.stdout == f"Comment ratio: 100.0000%; violations: {exit_code}\n"
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["method"] == "syntax-comments-v1"
    assert report["requiresHumanQualityReview"] is True
    assert report["files"] == [{"path": "sample.ts", "commentLines": 1, "codeLines": 0}]
    assert report["ratio"] == 1
    assert report["passed"] is (exit_code == 0)
    assert report["violations"] == (
        []
        if exit_code == 0
        else [
            {
                "path": "sample.ts",
                "line": 1,
                "reason": "Chinese comment first line must contain at least 40 characters",
            }
        ]
    )


def test_missing_node_fails_instead_of_returning_an_empty_pass(
    repository: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """解析工具不存在时审计必须传播真实工具缺失异常，不能以空范围或空报告假装通过；测试只在专属 PATH 中保留实际 Git
    可执行文件，不替换解析器、子进程或审计函数的行为。

    环境变量由 pytest 在本例结束时恢复，不影响其他夹具或项目依赖。

    """
    _write(repository, "sample.ts", f"//{LONG}\n")
    executable = shutil.which("git")
    assert executable
    tools = tmp_path / "git-only"
    tools.mkdir()
    (tools / "git").symlink_to(executable)
    monkeypatch.setenv("PATH", str(tools))
    with pytest.raises(FileNotFoundError) as caught:
        _audit(repository)
    assert caught.value.filename == "node"


def test_missing_typescript_fails_through_real_node(repository: Path) -> None:
    """固定解析器链接缺失时真实 Node 必须失败并使 Python 审计抛出子进程错误，不能仅验证 Node 可执行文件存在便把没有解析
    结果的源码视为合规；删除操作只作用于本例拥有的临时链接。

    现有依赖目标始终只读且保留，异常输出用于确认失败确实来自解析器装载。

    """
    _write(repository, "sample.ts", f"//{LONG}\n")
    (repository / "packages/compiler/node_modules/typescript").unlink()
    with pytest.raises(subprocess.CalledProcessError) as caught:
        _audit(repository)
    assert caught.value.returncode != 0
    assert caught.value.cmd == ["node", "scripts/comment_ranges.mjs"]


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"], ids=["lf", "crlf", "bare-cr"])
def test_python_physical_newlines_preserve_the_code_denominator(
    repository: Path, newline: str
) -> None:
    """Python 合法的三种物理换行必须产生相同的注释与代码行数，尤其裸回车不能让分词器把两行语句折叠到一行而将不足百分之四
    十的输入误判通过；真实审计报告同时固定分母、比例和门禁结果。

    文件按原始字节写入并使用恰好六十个中文字的首行，排除质量违规对比例结果的干扰。

    """
    text = newline.join(["#" + "中" * 60, "x=1", "y=2", ""])
    _write(repository, "sample.py", text)
    assert (repository / "sample.py").read_bytes() == text.encode("utf-8")
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.py", "commentLines": 1, "codeLines": 2}]
    assert report["ratio"] == 1 / 3
    assert report["violations"] == []
    assert report["passed"] is False


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"], ids=["lf", "crlf", "bare-cr"])
def test_python_docstring_and_inline_comment_keep_physical_line_positions(
    repository: Path, newline: str
) -> None:
    """文档串由 AST 确认而同行注释由分词器定位，两者必须在所有合法物理换行下指向相同行号，防止裸回车让文档串的代码扣除误
    伤后续语句或让同行注释污染另一行的计数与首行判定。

    第一行仅为有效文档串，第二行同时计入代码和注释，第三行只贡献代码，因此比例固定为二分之一。

    """
    _write(
        repository,
        "sample.py",
        newline.join([f'"""{LONG}"""', f"x=1 #{LONG}", "y=2", ""]),
    )
    report = _audit(repository)
    assert report["files"] == [{"path": "sample.py", "commentLines": 2, "codeLines": 2}]
    assert report["ratio"] == 0.5
    assert report["violations"] == []
    assert report["passed"] is True
