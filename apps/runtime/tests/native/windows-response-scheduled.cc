/** 本测试编译体在真实响应写入之后暂停会话线程，观测关闭对同一线程执行真实取消却尚无同步 I/O 的窗口；它保留生产读写与关闭算法，正式 addon 不含包装器或测试事件，也不声称两个二进制逐字节相同。 */
#include "windows-schedule.h"
#include <napi.h>
#include <atomic>
#include <memory>
#include <thread>
#include <mutex>
#include <deque>

namespace veriq_test {
/** 三个私有事件只服务一个独立 Agent 的单次响应会话，真实线程标识在发布状态时一起保存；固定端点前缀后的随机 nonce 绑定测试控制器，不从全局环境获取能力，也不开放任意事件名称。 */
struct ResponseSchedule {
    veriq::Handle ready, missed, release;
    DWORD threadId = GetCurrentThreadId();
    explicit ResponseSchedule(const std::wstring& nonce) : ready(scheduleEvent(nonce, L"response-ready")),
        missed(scheduleEvent(nonce, L"close-missed")), release(scheduleEvent(nonce, L"response-release")) {}
};
static std::atomic<ResponseSchedule*> responseSchedule{nullptr};
/** 只有原算法完成真实响应写入才进入此门，测试状态持续存活到模块卸载以覆盖关闭线程的观察；五秒内未得到显式放行必须失败，不把超时当作已复现取消窗口，也不替代下一次真实系统调用。 */
static void responseWritten(const std::wstring& name) {
    const std::wstring prefix = L"\\\\.\\pipe\\veriq-close-";
    veriq::require(name.rfind(prefix, 0) == 0, "NATIVE_TEST_ENDPOINT_INVALID");
    static ResponseSchedule state(name.substr(prefix.size()));
    ResponseSchedule* expected = nullptr;
    veriq::require(responseSchedule.compare_exchange_strong(expected, &state), "NATIVE_TEST_SESSION_REPEATED");
    veriq::require(SetEvent(state.ready.value) != 0, "NATIVE_TEST_READY_FAILED");
    veriq::require(WaitForSingleObject(state.release.value, 5000) == WAIT_OBJECT_0, "NATIVE_TEST_RESPONSE_GATE_TIMEOUT");
}
/** 包装器始终调用真实取消接口，只在目标确为已暂停的响应线程且内核返回 ERROR_NOT_FOUND 时记录阶段；随后恢复原始错误码，不伪造取消成功，也不让其他线程或其他失败满足测试前提。 */
static BOOL cancelSynchronousIo(HANDLE thread) {
    const BOOL result = ::CancelSynchronousIo(thread);
    const DWORD error = GetLastError();
    auto* state = responseSchedule.load();
    if (state && !result && error == ERROR_NOT_FOUND && GetThreadId(thread) == state->threadId)
        veriq::require(SetEvent(state->missed.value) != 0, "NATIVE_TEST_CANCEL_OBSERVATION_FAILED");
    SetLastError(error);
    return result;
}
}

#define VERIQ_TEST_RESPONSE_WRITTEN veriq_test::responseWritten
#define CancelSynchronousIo veriq_test::cancelSynchronousIo
#include "../../native/windows-addon.cc"
#undef CancelSynchronousIo
#undef VERIQ_TEST_RESPONSE_WRITTEN
