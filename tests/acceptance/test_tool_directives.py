"""
以实际桥接器和审计入口验证固定工具标记的范围与计量，并隔离运行 Vite 转换确认警告差异及原始词元的保留。

输入只包含合成模块，动态导入表达式用于转换，测试不执行这些模块。
"""

import json
import os
import pathlib
import subprocess
import tempfile
import types
from unittest import mock

import pytest

from scripts import comment_audit
from tests.acceptance import comment_audit_support

repository_fixture = comment_audit_support.repository_fixture

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_DIRECTIVE = "/* @vite-ignore */"
_BODY = "这条说明解释模块地址由调用方传入，动态加载保留调用方的原始地址并交由浏览器解析，不预先解析模块来源。"
_BODY_ISSUE = "Chinese comment first line must contain at least 40 characters"
_RANGE_FIELDS = {"start", "end", "offset", "limit", "offsetCodePoint", "limitCodePoint", "text"}


def test_dynamic_import_directive_keeps_code_denominator(
    repository: pathlib.Path, tmp_path: pathlib.Path
) -> None:
    """
    只有动态导入和固定标记的仓库仍有一行代码，真实审计命令须因零注释比例退出且不报告正文问题。
    """
    name = "sample.ts"
    output = tmp_path / "audit.json"
    comment_audit_support.write_source(repository, name, f"import({_DIRECTIVE} modulePath);\n")
    result = comment_audit_support.run_audit_cli(repository, output, tmp_path)
    assert result.returncode == 1
    assert result.stderr == ""
    report = json.loads(output.read_text(encoding="utf-8"))
    assert set(report) == {
        "method",
        "generatedExclusions",
        "requiresHumanQualityReview",
        "ratio",
        "observedRatio",
        "coverageComplete",
        "unsupportedPaths",
        "passed",
        "files",
        "violations",
    }
    assert report["method"] == "syntax-comments-v1"
    assert report["ratio"] == report["observedRatio"] == 0
    assert report["files"] == [{"path": name, "commentLines": 0, "codeLines": 1}]
    assert report["requiresHumanQualityReview"] is True
    assert report["coverageComplete"] is True
    assert report["unsupportedPaths"] == report["violations"] == []
    assert report["passed"] is False

    bridge = comment_audit_support.run_typescript_bridge(repository, [name])
    assert json.loads(bridge.stdout) == {
        name: [
            {
                "start": 1,
                "end": 1,
                "offset": 7,
                "limit": 25,
                "offsetCodePoint": 7,
                "limitCodePoint": 25,
                "text": _DIRECTIVE,
                "codeDirective": "vite-ignore",
            }
        ]
    }


@pytest.mark.parametrize(
    ("newline", "coordinates"),
    [
        pytest.param("\r\n", (28, 51, 27, 50), id="crlf"),
        pytest.param("\r", (26, 46, 25, 45), id="cr"),
        pytest.param("\n", (26, 46, 25, 45), id="lf"),
        pytest.param("\u2028", (26, 46, 25, 45), id="ls"),
        pytest.param("\u2029", (26, 46, 25, 45), id="ps"),
    ],
)
def test_multiline_directive_preserves_coordinates_and_nonempty_lines(
    repository: pathlib.Path, newline: str, coordinates: tuple[int, int, int, int]
) -> None:
    """
    中文与补充字符前缀分别校验 UTF16 和码点位置，三行含词元的原文计入代码，夹在其中的空行不计入。
    """
    name = "sample.mjs"
    directive = newline.join(["/*", "", "\t@vite-ignore", "*/"])
    source = newline.join(['const 名称 = "中😀";', "import(", directive, "modulePath);", ""])
    comment_audit_support.write_source(repository, name, source)
    bridge = comment_audit_support.run_typescript_bridge(repository, [name])
    offset, limit, start_point, end_point = coordinates
    assert json.loads(bridge.stdout) == {
        name: [
            {
                "start": 3,
                "end": 6,
                "offset": offset,
                "limit": limit,
                "offsetCodePoint": start_point,
                "limitCodePoint": end_point,
                "text": directive,
                "codeDirective": "vite-ignore",
            }
        ]
    }
    _assert_counts(repository, name, 0, 6, [])


@pytest.mark.parametrize(
    "directive",
    [
        pytest.param("/*@vite-ignore*/", id="no-whitespace"),
        pytest.param("/*\u00a0\t@vite-ignore\ufeff*/", id="nbsp-tab-bom"),
    ],
)
def test_import_directive_accepts_javascript_whitespace(
    repository: pathlib.Path, directive: str
) -> None:
    """
    词元可没有周围空白，也可包含 JavaScript 接受的制表符及非 ASCII 空白，原文须完整回传。
    """
    name = "sample.js"
    comment_audit_support.write_source(repository, name, f"import({directive} modulePath);")
    bridge = comment_audit_support.run_typescript_bridge(repository, [name])
    (item,) = json.loads(bridge.stdout)[name]
    assert item["text"] == directive
    assert item["codeDirective"] == "vite-ignore"
    _assert_counts(repository, name, 0, 1, [])


@pytest.mark.parametrize(
    ("source", "spelling", "code"),
    [
        pytest.param("import(@ modulePath);", "/* @Vite-ignore */", 1, id="wrong-case"),
        pytest.param("import(@ modulePath);", "/* 中文 @vite-ignore */", 1, id="chinese-before"),
        pytest.param("import(@ modulePath);", "/* @vite-ignore 中文 */", 1, id="chinese-after"),
        pytest.param("import(@ modulePath);", "/* @vite-ignore-extra */", 1, id="prefix"),
        pytest.param("import(@ modulePath);", "/* @vite-ignroe */", 1, id="typo"),
        pytest.param("import(@ modulePath);", "/*\u0085@vite-ignore\u0085*/", 1, id="nel"),
        pytest.param("@\n", _DIRECTIVE, 0, id="outside"),
        pytest.param("obj.import(@ modulePath);", _DIRECTIVE, 1, id="method"),
        pytest.param('type T = import(@ "fixture").T;', _DIRECTIVE, 1, id="type-expression"),
        pytest.param('import type @ { T } from "fixture";', _DIRECTIVE, 1, id="type-declaration"),
        pytest.param("import(modulePath @);", _DIRECTIVE, 1, id="after-argument"),
        pytest.param("import(modulePath, @ {});", _DIRECTIVE, 1, id="second-argument"),
        pytest.param("import((@ modulePath));", _DIRECTIVE, 1, id="inside-argument"),
        pytest.param("import(@\nmodulePath);", "// /* @vite-ignore */", 2, id="line-comment"),
    ],
)
def test_unqualified_tool_spelling_remains_an_ordinary_comment(
    repository: pathlib.Path, source: str, spelling: str, code: int
) -> None:
    """
    只有首参前导区间的完整固定块词元获分类，拼法或宿主不合格时区间结构及普通正文检查保持原口径。
    """
    name = "sample.ts"
    comment_audit_support.write_source(repository, name, source.replace("@", spelling))
    bridge = comment_audit_support.run_typescript_bridge(repository, [name])
    (item,) = json.loads(bridge.stdout)[name]
    assert set(item) == _RANGE_FIELDS
    assert item["text"] == spelling
    _assert_counts(repository, name, 1, code, [1])


def test_literal_markers_are_code_without_comment_ranges(repository: pathlib.Path) -> None:
    """
    字符串、模板静态正文、正则字符组及 JSX 标签文字中的同形内容不得进入范围，四条赋值仍占四行代码。
    """
    name = "sample.tsx"
    source = (
        f'const string = "{_DIRECTIVE}";\n'
        f"const template = `{_DIRECTIVE}`;\n"
        f"const pattern = /[{_DIRECTIVE}]/;\n"
        f"const jsx = <p>{_DIRECTIVE}</p>;\n"
    )
    comment_audit_support.write_source(repository, name, source)
    bridge = comment_audit_support.run_typescript_bridge(repository, [name])
    assert json.loads(bridge.stdout) == {name: []}
    _assert_counts(repository, name, 0, 4, [])


@pytest.mark.parametrize(
    ("body", "issues"),
    [pytest.param(_BODY, [], id="valid-note"), pytest.param("太短", [1], id="short-note")],
)
def test_same_line_ordinary_comment_and_repeated_directives(
    repository: pathlib.Path, body: str, issues: list[int]
) -> None:
    """
    同一行的两个合格工具词元只保留一行代码，同行普通说明仍独立进入注释行数并按正文质量决定门禁。
    """
    name = "sample.ts"
    source = f"import(/* {body} */ {_DIRECTIVE} {_DIRECTIVE} modulePath);\n"
    comment_audit_support.write_source(repository, name, source)
    bridge = comment_audit_support.run_typescript_bridge(repository, [name])
    ranges = json.loads(bridge.stdout)[name]
    assert [item.get("codeDirective") for item in ranges] == [None, "vite-ignore", "vite-ignore"]
    _assert_counts(repository, name, 1, 1, issues)


def test_unknown_role_remains_an_ordinary_comment(
    repository: pathlib.Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """
    将未知角色交给正式审计消费者，确认类型声明外的运行时值不参与豁免，仍遮罩代码并校验中文正文。
    """
    name = "sample.js"
    comment_audit_support.write_source(repository, name, _DIRECTIVE)
    bridge = comment_audit_support.run_typescript_bridge(repository, [name])
    ranges = json.loads(bridge.stdout)
    ranges[name][0]["codeDirective"] = "unknown"
    boundary = types.SimpleNamespace(check_output=mock.Mock(return_value=json.dumps(ranges)))
    monkeypatch.setattr(comment_audit, "subprocess", boundary)
    report = comment_audit.audit(repository)
    assert report["files"] == [{"path": name, "commentLines": 1, "codeLines": 0}]
    assert report["violations"] == [{"path": name, "line": 1, "reason": _BODY_ISSUE}]
    assert report["passed"] is False


@pytest.mark.parametrize("paths", [["valid.ts", "invalid.ts"], ["invalid.ts", "valid.ts"]])
def test_invalid_syntax_prevents_partial_bridge_output(
    repository: pathlib.Path, paths: list[str]
) -> None:
    """
    混合批次含坏语法时必须拒绝发布所有范围，即使合法的动态导入先被读取，也不能泄露半份 JSON。
    """
    comment_audit_support.write_source(repository, "valid.ts", f"import({_DIRECTIVE} modulePath);")
    comment_audit_support.write_source(repository, "invalid.ts", f"import({_DIRECTIVE} modulePath;")
    with pytest.raises(subprocess.CalledProcessError) as caught:
        comment_audit_support.run_typescript_bridge(repository, paths)
    assert caught.value.returncode == 1
    assert caught.value.stdout == ""
    assert '"invalid.ts":1:' in caught.value.stderr
    assert "TS1005" in caught.value.stderr


def _assert_counts(
    root: pathlib.Path, name: str, comments: int, code: int, issues: list[int]
) -> None:
    """
    将手算物理行数与正式审计报告逐项比较，同一行上的说明与代码分别进入计数，违规位置应指向实际词元。
    """
    report = comment_audit_support.audit(root)
    assert report["files"] == [{"path": name, "commentLines": comments, "codeLines": code}]
    ratio = comments / (comments + code)
    assert report["ratio"] == report["observedRatio"] == ratio
    assert report["passed"] is (ratio > 0.4 and not issues)
    assert report["violations"] == [
        {"path": name, "line": line, "reason": _BODY_ISSUE} for line in issues
    ]


_VITE_TRANSFORM = """
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [vitePath, root, ...paths] = process.argv.slice(1);
let networkAttempts = 0;
const refuseNetwork = () => {
    networkAttempts += 1;
    throw new Error("Network access is disabled for the Vite transformation fixture");
};
net.Server.prototype.listen = refuseNetwork;
net.Socket.prototype.connect = refuseNetwork;

const vite = await import(pathToFileURL(vitePath).href);
const esbuild = createRequire(realpathSync(vitePath))("esbuild");
const logger = vite.createLogger("silent");
const warnings = [];
const errors = [];
const cases = {};
logger.warn = (message) => warnings.push(message);
logger.warnOnce = logger.warn;
logger.error = (message) => errors.push(message);
let server;
try {
    server = await vite.createServer({
        root,
        configFile: false,
        envDir: join(root, "env"),
        envFile: false,
        cacheDir: join(root, "cache"),
        publicDir: false,
        customLogger: logger,
        optimizeDeps: { noDiscovery: true, include: [] },
        server: {
            middlewareMode: true,
            hmr: false,
            ws: false,
            watch: null,
            preTransformRequests: false,
        },
    });
    const startupWarnings = warnings.splice(0);
    if (startupWarnings.length) throw new Error(startupWarnings.join("\\n"));
    for (const path of paths) {
        const earlierWarnings = warnings.length;
        const transformed = await server.transformRequest("/" + path);
        cases[path] = { code: transformed?.code, warnings: warnings.slice(earlierWarnings) };
    }
} finally {
    try {
        await server?.close();
    } finally {
        await esbuild.stop();
    }
}
process.stdout.write(JSON.stringify({ version: vite.version, cases, errors, networkAttempts }));
"""


def test_vite_transform_consumes_exact_dynamic_import_directive(tmp_path: pathlib.Path) -> None:
    """
    同形的合成 JS 与 TS 模块通过 Vite 公开转换入口，真实分析警告只在缺标记或标记被改写的负例出现。

    中间件不监听，配置和环境路径局限于临时目录，仅向子进程提供可执行文件搜索路径。
    """
    cases = {
        "exact": f"{_DIRECTIVE} modulePath",
        "absent": "modulePath",
        "chinese": "/* 普通中文 @vite-ignore */ modulePath",
        "typo": "/* @vite-ignroe */ modulePath",
    }
    paths: dict[str, str] = {}
    with tempfile.TemporaryDirectory(dir=tmp_path) as directory:
        root = pathlib.Path(directory)
        (root / "env").mkdir()
        for extension, annotation in (("js", ""), ("ts", ": string")):
            for case, argument in cases.items():
                path = f"{case}.{extension}"
                source = f"export const load = (modulePath{annotation}) => import({argument});"
                comment_audit_support.write_source(root, path, source)
                paths[path] = (root / path).resolve().as_posix()
        result = subprocess.run(
            [
                "node",
                "--input-type=module",
                "--eval",
                _VITE_TRANSFORM,
                str(_ROOT / "apps/web/node_modules/vite/dist/node/index.js"),
                str(root),
                *paths,
            ],
            cwd=root,
            env={"PATH": os.environ.get("PATH", os.defpath)},
            capture_output=True,
            check=True,
            timeout=30,
            text=True,
        )
    report = json.loads(result.stdout)
    assert not root.exists()
    assert result.stderr == ""
    assert report["version"] == "6.4.5"
    assert report["errors"] == []
    assert report["networkAttempts"] == 0
    assert set(report["cases"]) == set(paths)
    for path, transformed in report["cases"].items():
        assert transformed["code"]
        if path.startswith("exact."):
            assert transformed["warnings"] == []
            assert transformed["code"].count(_DIRECTIVE) == 1
        else:
            (warning,) = transformed["warnings"]
            assert "The above dynamic import cannot be analyzed by Vite." in warning
            assert paths[path] in warning
