"""限制供应商对话增量的秘密回显，并在每次写出前复核当前登录员工是否还有权接收本会话事件。"""

import re
from collections.abc import Awaitable, Callable
from typing import Any

from ..service import Problem
from .report import protected_string_variants, redact

_REFERENCE_MARKERS = ("secretRef", "{{secret")


class ReplyStreamRedactor:
    """只保留可能拼成秘密或凭据引用标记的短尾部，普通回复仍可立即显示，而跨任意增量边界的模式不会泄露。"""

    def __init__(self, secrets: set[str]):
        """沿用报告脱敏的编码集合，完整模式替换和不完整尾部判断共享同一来源，避免两个写出渠道各自漏掉编码。"""
        variants = protected_string_variants(secrets)
        self._match = (
            re.compile("|".join(re.escape(item) for item in variants)) if variants else None
        )
        self._patterns = (*variants, *_REFERENCE_MARKERS)
        self._pending = ""
        self._withheld_reference = False

    def _stable_end(self, text: str) -> int:
        """返回第一个仍可能与将来增量拼成受保护模式的位置，只有尾部且以模式首字符开头的子串需要检查。"""
        end = len(text)
        for pattern in self._patterns:
            start = max(0, len(text) - len(pattern) + 1)
            while (match := text.find(pattern[0], start, end)) != -1:
                if pattern.startswith(text[match:]):
                    end = match
                    break
                start = match + 1
        return end

    def _emit(self, text: str, end: int) -> str:
        """在安全边界前遇到的完整秘密整段消耗，即使它穿过候选尾部，也不会把它后半段作为普通增量重新释放。"""
        pieces = []
        last = 0
        if self._match is not None:
            for match in self._match.finditer(text):
                if match.start() >= end:
                    break
                pieces.extend((text[last : match.start()], "[REDACTED]"))
                last = match.end()
        end = max(end, last)
        self._pending = text[end:]
        return "".join((*pieces, text[last:end]))

    def feed(self, fragment: str) -> str:
        """拼接可能拆分的尾部再检查本批内容；凭据引用标记出现后抑制当批和后续文本，直到完成事件替换回复。"""
        if self._withheld_reference:
            return ""
        text = self._pending + fragment
        if any(marker in text for marker in _REFERENCE_MARKERS):
            self._withheld_reference = True
            self._pending = ""
            return "[WITHHELD_REFERENCE]"
        return self._emit(text, self._stable_end(text))

    def finish(self) -> str:
        """模型成功完成后不存在可继续拼接的增量，使曾暂留但缺少完整匹配的尾部按普通文字或完整秘密处理。"""
        return self._emit(self._pending, len(self._pending))


def sanitize_stream_reply(value: Any, protected: set[str]) -> Any:
    """结算前再次检查完整领域回复，引用标记必须在替换已知秘密之前识别，避免重叠时遗漏后面的引用值。"""
    if isinstance(value, str) and any(marker in value for marker in _REFERENCE_MARKERS):
        return "[WITHHELD_REFERENCE]"
    return redact(value, protected)


def guard_agent_stream(
    authorize: Callable[[], Awaitable[None]],
    emit: Callable[[str, dict[str, Any]], Awaitable[None]],
) -> Callable[[str, dict[str, Any]], Awaitable[bool]]:
    """组合独立授权事务与网络发送，已知会话归档或员工权利撤销时关闭本轮实时写出，持续完成费用结算。"""
    revoked = False

    async def publish(event: str, data: dict[str, Any]) -> bool:
        """送出本帧之前重新读取授权，明确的访问丢失只关闭输出；配置错误等非授权问题由调用方按通常方式处理。"""
        nonlocal revoked
        if revoked:
            return False
        try:
            await authorize()
        except Problem as problem:
            if (
                problem.status not in {401, 403, 404, 410}
                and problem.code != "AGENT_SESSION_ARCHIVED"
            ):
                raise
            revoked = True
            return False
        await emit(event, data)
        return True

    return publish
