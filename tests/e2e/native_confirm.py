"""私有 Xvfb 显示内只向当前 Electron 主窗口拥有的真实模态对话框发送确认按键，先沿聚焦窗口父链校验 WM_TRANSIENT_FOR，避免用替换对话框返回值或无目标的全局键盘事件伪造用户确认。"""

import ctypes as c
import sys

x = c.CDLL("libX11.so.6")
t = c.CDLL("libXtst.so.6")
x.XOpenDisplay.argtypes = [c.c_char_p]
x.XOpenDisplay.restype = c.c_void_p
x.XGetInputFocus.argtypes = [c.c_void_p, c.POINTER(c.c_ulong), c.POINTER(c.c_int)]
x.XGetTransientForHint.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong)]
x.XQueryTree.argtypes = [
    c.c_void_p,
    c.c_ulong,
    c.POINTER(c.c_ulong),
    c.POINTER(c.c_ulong),
    c.POINTER(c.POINTER(c.c_ulong)),
    c.POINTER(c.c_uint),
]
x.XStringToKeysym.argtypes = [c.c_char_p]
x.XStringToKeysym.restype = c.c_ulong
x.XKeysymToKeycode.argtypes = [c.c_void_p, c.c_ulong]
x.XKeysymToKeycode.restype = c.c_uint
x.XFlush.argtypes = [c.c_void_p]
x.XFree.argtypes = [c.c_void_p]
x.XCloseDisplay.argtypes = [c.c_void_p]
t.XTestFakeKeyEvent.argtypes = [c.c_void_p, c.c_uint, c.c_int, c.c_ulong]
display = x.XOpenDisplay(None)
assert display, "Private test display unavailable"
try:
    target = int(sys.argv[1])
    focus, revert = c.c_ulong(), c.c_int()
    x.XGetInputFocus(display, c.byref(focus), c.byref(revert))
    window = focus.value
    matched = False
    for _ in range(20):
        transient = c.c_ulong()
        if (
            x.XGetTransientForHint(display, window, c.byref(transient))
            and transient.value == target
        ):
            matched = True
            break
        root, parent, count = c.c_ulong(), c.c_ulong(), c.c_uint()
        children = c.POINTER(c.c_ulong)()
        if not x.XQueryTree(
            display,
            window,
            c.byref(root),
            c.byref(parent),
            c.byref(children),
            c.byref(count),
        ):
            break
        if children:
            x.XFree(children)
        if parent.value in (0, window):
            break
        window = parent.value
    assert matched, "Owned native modal is not focused"
    for key in (
        (b"Escape",)
        if len(sys.argv) > 2 and sys.argv[2] == "cancel"
        else (b"Right", b"Return")
    ):
        code = x.XKeysymToKeycode(display, x.XStringToKeysym(key))
        assert code
        t.XTestFakeKeyEvent(display, code, 1, 0)
        t.XTestFakeKeyEvent(display, code, 0, 0)
    x.XFlush(display)
    print("Handled owned native dialog")
finally:
    x.XCloseDisplay(display)
