# Ubuntu 的应用策略只授予包管理器固定且由 root 拥有的 GUI 与宿主测试 Chrome 使用用户命名空间，不能匹配用户可写目录或修改
# 全局限制；安装后的实际沙箱启动仍必须在原生目标另行验收。
abi <abi/4.0>,
include <tunables/global>

profile "veriq" "/opt/${sanitizedProductName}/veriq" flags=(unconfined) {
    userns,
}

profile "veriq_test_chrome" "/opt/${sanitizedProductName}/resources/runtime/browser/chrome-linux64/chrome"
    flags=(unconfined) {
    userns,
}
