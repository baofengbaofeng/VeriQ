"""从登录请求识别用于会话列表展示的浏览器和系统类别，识别值仅供用户辨认会话，从不作为授权凭据使用。"""

# 兼容标记经常与真正浏览器名称同时出现，先匹配带 Chromium 或 Safari 标记的衍生客户端，避免把已知值误分类。
_BROWSERS = (
    ("ELECTRON", ("electron/",)),
    ("EDGE", ("edg/", "edga/", "edgios/", "edge/")),
    ("OPERA", ("opr/", "opera/")),
    ("FIREFOX", ("firefox/", "fxios/")),
    ("CHROMIUM", ("chromium/",)),
    ("CHROME", ("chrome/", "crios/", "headlesschrome/")),
    ("SAFARI", ("safari/",)),
)

# 移动浏览器通常发送兼容桌面或 Linux 的标记，优先匹配 iOS、Android 和 ChromeOS 的专属系统标记。
_SYSTEMS = (
    ("IOS", ("iphone", "ipad", "ipod")),
    ("WINDOWS", ("windows",)),
    ("ANDROID", ("android",)),
    ("CHROMEOS", ("cros ",)),
    ("MACOS", ("macintosh", "mac os x")),
    ("LINUX", ("linux",)),
)


def _match_category(header: str, categories: tuple[tuple[str, tuple[str, ...]], ...]) -> str:
    """保持匹配顺序得到单个分类，未知标记收敛到同一个类别，输出不含任意请求字符或具体客户端版本号。"""
    return next(
        (family for family, tokens in categories if any(token in header for token in tokens)),
        "OTHER",
    )


def classify_session_client(user_agent: str) -> tuple[str | None, str | None]:
    """缺失头部代表没有记录，非空头部只返回有限分类；截断用于匹配的字符范围，避免异常长头部增加处理成本。"""
    header = user_agent[:1024].strip().lower()
    if not header:
        return None, None
    return _match_category(header, _BROWSERS), _match_category(header, _SYSTEMS)
