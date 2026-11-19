"""从仓库直接编译原生确认助手并对比普通和优化模式，使用内存函数记录显示连接、归属判断、按键发送和清理顺序。"""

import ctypes
import dataclasses
import pathlib
import sys
import types
from collections.abc import Callable
from typing import NoReturn

import pytest

_HELPER = pathlib.Path(__file__).resolve().parents[1] / "e2e" / "native_confirm.py"
_DISPLAY = 7
_TARGET = 41
_FOCUS = 100
_KEYSYMS = {b"Right": 101, b"Return": 102, b"Escape": 103}
_KEYCODES = {101: 21, 102: 22, 103: 23}

type _Argument = str | int | bytes | None
type _Call = tuple[_Argument, ...]


@dataclasses.dataclass(frozen=True)
class _Scenario:
    """使用虚构的显示句柄、窗口归属和父链构造各条路径，并在需要时为首次查询提供可核对释放的子窗口内存。"""

    display: int | None = _DISPLAY
    ownership: dict[int, int] = dataclasses.field(default_factory=dict)
    parents: dict[int, int] = dataclasses.field(default_factory=dict)
    with_children: bool = False
    unmapped_keysym: int | None = None


def _record(calls: list[_Call], name: str, result: int | None) -> Callable[..., int | None]:
    def record(*arguments: _Argument) -> int | None:
        calls.append((name, *arguments))
        return result

    return record


def _bind_x11(scenario: _Scenario, calls: list[_Call]) -> types.SimpleNamespace:
    """模拟助手所用的接口并通过原生参数形状填充返回值，子窗口指针仅引用测试期间保留的受管内存对象。"""
    child = ctypes.c_ulong(456)

    def get_focus(display: int | None, focus: object, revert: object) -> int:
        calls.append(("focus", display))
        ctypes.cast(ctypes.c_void_p.from_param(focus), ctypes.POINTER(ctypes.c_ulong))[0] = _FOCUS
        ctypes.cast(ctypes.c_void_p.from_param(revert), ctypes.POINTER(ctypes.c_int))[0] = 0
        return 1

    def transient_hint(display: int, window: int, owner: object) -> int:
        calls.append(("hint", display, window))
        if window not in scenario.ownership:
            return 0
        ctypes.cast(ctypes.c_void_p.from_param(owner), ctypes.POINTER(ctypes.c_ulong))[0] = (
            scenario.ownership[window]
        )
        return 1

    def query_tree(display: int, window: int, *outputs: object) -> int:
        calls.append(("tree", display, window))
        if window not in scenario.parents:
            return 0
        root, parent, children, count = map(ctypes.c_void_p.from_param, outputs)
        ctypes.cast(root, ctypes.POINTER(ctypes.c_ulong))[0] = 1
        ctypes.cast(parent, ctypes.POINTER(ctypes.c_ulong))[0] = scenario.parents[window]
        if window == _FOCUS and scenario.with_children:
            ctypes.cast(children, ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)))[0] = (
                ctypes.pointer(child)
            )
            ctypes.cast(count, ctypes.POINTER(ctypes.c_uint))[0] = 1
        return 1

    def free(children: object) -> int:
        address = ctypes.cast(ctypes.c_void_p.from_param(children), ctypes.c_void_p).value
        assert address == ctypes.addressof(child)
        calls.append(("free",))
        return 0

    def keysym(key: bytes) -> int:
        calls.append(("keysym", key))
        return _KEYSYMS[key]

    def keycode(display: int, symbol: int) -> int:
        calls.append(("keycode", display, symbol))
        return 0 if symbol == scenario.unmapped_keysym else _KEYCODES[symbol]

    return types.SimpleNamespace(
        XOpenDisplay=_record(calls, "open", scenario.display),
        XGetInputFocus=get_focus,
        XGetTransientForHint=transient_hint,
        XQueryTree=query_tree,
        XFree=free,
        XStringToKeysym=keysym,
        XKeysymToKeycode=keycode,
        XFlush=_record(calls, "flush", 0),
        XCloseDisplay=_record(calls, "close", 0),
    )


def _run_helper(
    monkeypatch: pytest.MonkeyPatch,
    optimize: int,
    scenario: _Scenario,
    mode: tuple[str, ...] = (),
) -> tuple[list[_Call], AssertionError | RuntimeError | None]:
    """安装两个内存库并封锁底层装载入口后才执行助手源文件，保留真实分支生成的调用轨迹和原始异常。"""
    calls: list[_Call] = []
    libraries = {
        "libX11.so.6": _bind_x11(scenario, calls),
        "libXtst.so.6": types.SimpleNamespace(XTestFakeKeyEvent=_record(calls, "event", 1)),
    }

    def load_library(name: str) -> types.SimpleNamespace:
        if name not in libraries:
            pytest.fail("Unexpected library requested by native confirmation helper")
        return libraries[name]

    def reject_real_load(*arguments: object) -> NoReturn:
        # 保留底层装载器的实际参数以便报告越界调用，但在参数触及任何库文件之前就结束测试并记录失败。
        pytest.fail(f"Unexpected real ctypes loader call: {arguments!r}")

    with monkeypatch.context() as patches:
        patches.setattr(ctypes, "_dlopen", reject_real_load)
        patches.setattr(ctypes, "CDLL", load_library)
        patches.setattr(sys, "argv", [str(_HELPER), str(_TARGET), *mode])
        code = compile(_HELPER.read_bytes(), str(_HELPER), "exec", optimize=optimize)
        run = types.FunctionType(code, {"__name__": "__main__"})
        try:
            run()
        except (AssertionError, RuntimeError) as error:
            return calls, error
    return calls, None


@pytest.fixture(name="optimize", params=[0, 1], ids=["normal", "optimized"])
def fixture_optimize(request: pytest.FixtureRequest) -> int:
    """将同一个助手源码分别按两种优化级别编译，pytest 本身继续正常执行夹具断言和调用顺序比较。"""
    return int(request.param)


def test_missing_display_stops_before_focus(monkeypatch: pytest.MonkeyPatch, optimize: int) -> None:
    """连接没有返回显示句柄时应立即报告错误，任何焦点查询、键盘动作或空句柄清理都表明保护已经失效。"""
    calls, problem = _run_helper(monkeypatch, optimize, _Scenario(display=None))
    assert calls == [("open", None)]
    assert str(problem) == "Private test display unavailable"


def _expected_walk(windows: range) -> list[_Call]:
    walk: list[_Call] = []
    for window in windows:
        walk.append(("hint", 7, window))
        walk.append(("tree", 7, window))
    return walk


@pytest.mark.parametrize(
    ("scenario", "walk"),
    [
        pytest.param(
            _Scenario(ownership={100: 99}),
            [("hint", 7, 100), ("tree", 7, 100)],
            id="foreign-owner-query-failed",
        ),
        pytest.param(
            _Scenario(parents={100: 100}, with_children=True),
            [("hint", 7, 100), ("tree", 7, 100), ("free",)],
            id="self-parent-releases-children",
        ),
        pytest.param(
            _Scenario(parents={100: 0}),
            [("hint", 7, 100), ("tree", 7, 100)],
            id="null-parent",
        ),
        pytest.param(
            _Scenario(
                ownership={120: 41}, parents={window: window + 1 for window in range(100, 120)}
            ),
            _expected_walk(range(100, 120)),
            id="owned-window-after-bound",
        ),
    ],
)
def test_unowned_focus_stops_without_key_events(
    monkeypatch: pytest.MonkeyPatch, optimize: int, scenario: _Scenario, walk: list[_Call]
) -> None:
    """核对拒绝路径查询过的窗口与清理顺序，越界目标和无法继续搜索的窗口都只允许关闭已打开的显示连接。"""
    calls, problem = _run_helper(monkeypatch, optimize, scenario)
    assert calls == [("open", None), ("focus", 7), *walk, ("close", 7)]
    assert str(problem) == "Owned native modal is not focused"


def test_zero_keycode_stops_before_sending(monkeypatch: pytest.MonkeyPatch, optimize: int) -> None:
    """焦点通过归属校验后仍须拒绝未映射的首个按键，既不能发送零键码，也不能继续下一个按键或刷新事件。"""
    scenario = _Scenario(ownership={100: 41}, unmapped_keysym=101)
    calls, problem = _run_helper(monkeypatch, optimize, scenario)
    assert calls == [
        ("open", None),
        ("focus", 7),
        ("hint", 7, 100),
        ("keysym", b"Right"),
        ("keycode", 7, 101),
        ("close", 7),
    ]
    if optimize == 0 and isinstance(problem, AssertionError):
        assert str(problem) == ""
    else:
        assert isinstance(problem, RuntimeError)
        assert str(problem) == "Native modal keycode unavailable"


@pytest.mark.parametrize(
    ("mode", "keys"),
    [
        pytest.param(
            (),
            [
                ("keysym", b"Right"),
                ("keycode", 7, 101),
                ("event", 7, 21, 1, 0),
                ("event", 7, 21, 0, 0),
                ("keysym", b"Return"),
                ("keycode", 7, 102),
                ("event", 7, 22, 1, 0),
                ("event", 7, 22, 0, 0),
            ],
            id="confirm",
        ),
        pytest.param(
            ("cancel",),
            [
                ("keysym", b"Escape"),
                ("keycode", 7, 103),
                ("event", 7, 23, 1, 0),
                ("event", 7, 23, 0, 0),
            ],
            id="cancel",
        ),
    ],
)
def test_owned_modal_preserves_event_and_cleanup_order(
    monkeypatch: pytest.MonkeyPatch,
    optimize: int,
    capsys: pytest.CaptureFixture[str],
    mode: tuple[str, ...],
    keys: list[_Call],
) -> None:
    """第十九次向父窗口移动后仍可匹配属于目标的模态，核对释放子窗口后发送全部按下和抬起事件的顺序。"""
    scenario = _Scenario(
        ownership={119: 41},
        parents={window: window + 1 for window in range(100, 119)},
        with_children=True,
    )
    calls, problem = _run_helper(monkeypatch, optimize, scenario, mode)
    remaining_walk = _expected_walk(range(101, 119))
    assert calls == [
        ("open", None),
        ("focus", 7),
        ("hint", 7, 100),
        ("tree", 7, 100),
        ("free",),
        *remaining_walk,
        ("hint", 7, 119),
        *keys,
        ("flush", 7),
        ("close", 7),
    ]
    assert problem is None
    assert capsys.readouterr().out == "Handled owned native dialog\n"
