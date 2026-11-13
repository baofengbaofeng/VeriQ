/** 此默认关闭的测试编译体在真实首实例管道和 TSFN 已分配后注入标准线程构造异常，用于观察真实资源清理；它不是自然系统资源耗尽证据，正式 addon 编译不定义该宏，也没有运行时故障开关或额外导出。 */
#include <system_error>

/** 故障明确位于监听线程尚未创建而 callback 已经存在的窗口，异常类型与标准线程资源不可用失败一致；固定标记只让测试确认确实到达该路径，不伪造 HANDLE、成功回执、回调释放或正常进程退出。 */
static void failPipeListener() {
    throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again), "NATIVE_TEST_THREAD_CREATION_FAILURE");
}
#define VERIQ_TEST_FAIL_PIPE_LISTENER failPipeListener
#include "../../native/windows-addon.cc"
#undef VERIQ_TEST_FAIL_PIPE_LISTENER
