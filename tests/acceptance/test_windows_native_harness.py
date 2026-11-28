"""原生验收夹具的恢复判断必须保留所有访问项与保护标志，仅接受系统实际添加的自动继承回执而拒绝权限变化。"""

import importlib
import json
from pathlib import Path
import sys
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

# 两份独立字串来自真实运行的原始证据，保留有效与继承访问项顺序，不能通过测试中的归一化推导预期结果。
D1_EXPECTED = (
    "D:(A;;FA;;;BA)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIIOID;GA;;;CO)"
    "(A;OICIID;0x1200a9;;;BU)(A;CIID;LC;;;BU)(A;CIID;DC;;;BU)"
)
D1_ACTUAL = (
    "D:AI(A;;FA;;;BA)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIIOID;GA;;;CO)"
    "(A;OICIID;0x1200a9;;;BU)(A;CIID;LC;;;BU)(A;CIID;DC;;;BU)"
)
CASES = [
    ("exact", D1_EXPECTED, D1_EXPECTED, True, True, False),
    ("d1_auto_inheritance", D1_EXPECTED, D1_ACTUAL, True, False, True),
    ("already_auto", D1_ACTUAL, D1_ACTUAL, True, True, False),
    ("remove_auto", D1_ACTUAL, D1_EXPECTED, False, False, False),
    (
        "wrong_sid",
        D1_EXPECTED,
        D1_ACTUAL.replace(";;;BA)", ";;;WD)", 1),
        False,
        False,
        True,
    ),
    (
        "wrong_rights",
        D1_EXPECTED,
        D1_ACTUAL.replace(";;FA;", ";;FR;", 1),
        False,
        False,
        True,
    ),
    ("extra_ace", D1_EXPECTED, D1_ACTUAL + "(A;;FW;;;WD)", False, False, True),
    ("duplicate_ace", D1_EXPECTED, D1_ACTUAL + "(A;;FA;;;BA)", False, False, True),
    (
        "ace_order",
        D1_EXPECTED,
        D1_ACTUAL.replace("(A;;FA;;;BA)(A;OICIID;FA;;;BA)", "(A;OICIID;FA;;;BA)(A;;FA;;;BA)"),
        False,
        False,
        True,
    ),
    (
        "inherited_flag",
        D1_EXPECTED,
        D1_ACTUAL.replace("OICIID", "OICI", 1),
        False,
        False,
        True,
    ),
    (
        "protect_added",
        D1_EXPECTED,
        D1_ACTUAL.replace("D:AI", "D:PAI"),
        False,
        False,
        True,
    ),
    (
        "protect_removed",
        D1_EXPECTED.replace("D:", "D:P"),
        D1_ACTUAL,
        False,
        False,
        True,
    ),
    (
        "request_added",
        D1_EXPECTED,
        D1_ACTUAL.replace("D:AI", "D:ARAI"),
        False,
        False,
        True,
    ),
    (
        "unknown_flag",
        D1_EXPECTED,
        D1_ACTUAL.replace("D:AI", "D:ZAI"),
        False,
        False,
        False,
    ),
    (
        "duplicate_ai",
        D1_EXPECTED,
        D1_ACTUAL.replace("D:AI", "D:AIAI"),
        False,
        False,
        False,
    ),
    (
        "duplicate_p",
        D1_EXPECTED,
        D1_ACTUAL.replace("D:AI", "D:PPAI"),
        False,
        False,
        False,
    ),
    (
        "duplicate_ar",
        D1_EXPECTED,
        D1_ACTUAL.replace("D:AI", "D:ARARAI"),
        False,
        False,
        False,
    ),
    ("unknown_exact", "D:Z(A;;FA;;;BA)", "D:Z(A;;FA;;;BA)", False, False, False),
    (
        "duplicate_exact",
        "D:AIAI(A;;FA;;;BA)",
        "D:AIAI(A;;FA;;;BA)",
        False,
        False,
        False,
    ),
    ("null_acl", D1_EXPECTED, "D:NO_ACCESS_CONTROL", False, False, False),
    (
        "case_change",
        D1_EXPECTED,
        D1_ACTUAL.replace("(A;;FA", "(a;;FA", 1),
        False,
        False,
        True,
    ),
    (
        "conditional_unicode_code_units",
        'D:(XA;;GR;;;BU;(@Resource.name == "\u00e9"))',
        'D:AI(XA;;GR;;;BU;(@Resource.name == "e\u0301"))',
        False,
        False,
        True,
    ),
    (
        "protected_request_kept",
        "D:PAR(A;;FR;;;SY)",
        "D:PARAI(A;;FR;;;SY)",
        True,
        False,
        True,
    ),
]

HELPER = r"""
param([string]$Harness, [string]$CasesPath)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.ToString() -cne '7.6.6') { throw 'HARNESS_TEST_RUNTIME_VERSION_REQUIRED' }
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Harness, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'HARNESS_TEST_PARSE_FAILED' }
$functions = @($ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -ceq 'Compare-SourceDacl'
}, $true))
if ($functions.Count -ne 1) { throw 'HARNESS_COMPARATOR_REQUIRED' }
. ([scriptblock]::Create($functions[0].Extent.Text))
$examples = Get-Content -LiteralPath $CasesPath -Raw | ConvertFrom-Json
$results = @(foreach ($example in $examples) {
    Compare-SourceDacl $example.expected $example.actual
})
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Compress -Depth 5))
"""


@pytest.fixture(scope="module", name="comparisons")
def _comparisons(tmp_path_factory: pytest.TempPathFactory) -> list[dict[str, Any]]:
    """官方语法树只提取无系统调用的受信比较函数，以真实进程执行固定输入，不加载主脚本的账户与权限流程。"""
    runtime = importlib.import_module("comment_powershell").runtime_path()
    process = importlib.import_module("comment_powershell_process")
    directory = tmp_path_factory.mktemp("windows-harness-comparison")
    helper = directory / "compare.ps1"
    source = directory / "cases.json"
    helper.write_text(HELPER, encoding="utf-8")
    source.write_text(
        json.dumps([{"expected": case[1], "actual": case[2]} for case in CASES]),
        encoding="utf-8",
    )
    output = process.run_parser(
        [
            runtime,
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(helper),
            str(ROOT / ".github/scripts/windows-native-user.ps1"),
            str(source),
        ],
        directory,
        20,
        65536,
    )
    results = json.loads(output)
    assert isinstance(results, list)
    assert all(isinstance(item, dict) for item in results)
    assert len(results) == len(CASES)
    return results


@pytest.mark.parametrize("index", range(len(CASES)), ids=[case[0] for case in CASES])
def test_source_dacl_comparison_preserves_exact_permissions(
    index: int, comparisons: list[dict[str, Any]]
) -> None:
    """真实系统转换只能添加自动继承标志，访问项的主体、权限、顺序及保护或请求位发生任何变化都必须明确拒绝。"""
    _, _, _, accepted, exact, applied = CASES[index]
    result = comparisons[index]
    assert result["accepted"] is accepted
    assert result["exactlyRestored"] is exact
    assert result["autoInheritanceApplied"] is applied
    if accepted:
        assert result["protectedAndRequestMatched"] is True
        assert result["orderedAcesMatched"] is True
