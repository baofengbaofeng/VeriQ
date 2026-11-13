/** 测试编译体只在真实 START 已被读取后暂停下一次控制 ReadFile，保持生产 guardian 的原始循环算法并调用真实 Win32 API；它与生产二进制不同，正式目标不会包含这些包装器或测试事件。 */
#include "windows-schedule.h"
#include <atomic>
#include <mutex>
#include <thread>
#include <iostream>

namespace veriq_test {
/** 调度状态只属于一个独立测试 guardian，控制线程单独记录已读命令且主线程只读取原子线程身份；三个私有事件分别证明读前到达、真实取消未命中和显式放行，不把延迟或超时当作已经经过目标窗口。 */
struct Schedule {
    std::string token, line;
    veriq::Handle ready, missed, release;
    std::atomic<DWORD> controlId{0};
    bool armed = false, gated = false;
    /** 三个阶段句柄在进入原生产入口之前即以私有 ACL 创建，nonce 来自该次正式启动参数并保持不变；状态对象在生产入口返回前一直存活，控制线程与取消观察不会引用已经销毁的测试事件。 */
    explicit Schedule(const std::wstring& nonce) : token(veriq::utf8(nonce)), ready(scheduleEvent(nonce, L"read-ready")),
        missed(scheduleEvent(nonce, L"cancel-missed")), release(scheduleEvent(nonce, L"read-release")) {}
};
static Schedule* schedule = nullptr;
/** 包装器在原始 while 的 closed 检查之后才执行，只有完整 START 命令确实读取完才阻塞下一次真实控制读取；有界测试门释放后仍调用原生 ReadFile，不能返回伪造字节或跳过真实 EOF 与排空行为。 */
static BOOL readFile(HANDLE handle, LPVOID buffer, DWORD size, LPDWORD count, LPOVERLAPPED overlap) {
    if (handle != GetStdHandle(STD_INPUT_HANDLE)) return ::ReadFile(handle, buffer, size, count, overlap);
    schedule->controlId = GetCurrentThreadId();
    if (schedule->armed && !schedule->gated) {
        schedule->gated = true;
        veriq::require(SetEvent(schedule->ready.value) != 0, "NATIVE_TEST_READY_FAILED");
        veriq::require(WaitForSingleObject(schedule->release.value, 5000) == WAIT_OBJECT_0, "NATIVE_TEST_READ_GATE_TIMEOUT");
    }
    const BOOL result = ::ReadFile(handle, buffer, size, count, overlap);
    const DWORD error = GetLastError();
    if (result && count && *count == 1) {
        const auto byte = *static_cast<char*>(buffer);
        if (byte == '\n') {
            if (schedule->line == "START " + schedule->token) schedule->armed = true;
            schedule->line.clear();
        } else {
            veriq::require(schedule->line.size() < 128, "NATIVE_TEST_CONTROL_LIMIT");
            schedule->line += byte;
        }
    }
    SetLastError(error);
    return result;
}
/** 取消包装器只观察真实 API 对已记录控制线程返回的 ERROR_NOT_FOUND，其他线程或成功取消都不能满足测试握手；额外事件操作后恢复原始线程错误码，让生产算法看见原本的系统返回而非测试伪造结果。 */
static BOOL cancelSynchronousIo(HANDLE thread) {
    const BOOL result = ::CancelSynchronousIo(thread);
    const DWORD error = GetLastError();
    if (!result && error == ERROR_NOT_FOUND && GetThreadId(thread) == schedule->controlId)
        veriq::require(SetEvent(schedule->missed.value) != 0, "NATIVE_TEST_CANCEL_OBSERVATION_FAILED");
    SetLastError(error);
    return result;
}
}

#define ReadFile veriq_test::readFile
#define CancelSynchronousIo veriq_test::cancelSynchronousIo
#define wmain scheduledGuardianMain
#include "../../native/windows-guardian.cc"
#undef wmain
#undef CancelSynchronousIo
#undef ReadFile

/** 测试入口只从正式启动协议已有的 nonce 参数创建本次调度状态，再调用同一 guardian 源码生成的入口；不读取环境授权开关，所有测试事件随该进程的真实线程结束而关闭，异常仍以失败退出码暴露。 */
int wmain(int argc, wchar_t** argv) {
    try {
        veriq::require(argc >= 4, "NATIVE_TEST_ARGUMENTS_INVALID");
        veriq_test::Schedule state(argv[2]);
        veriq_test::schedule = &state;
        return scheduledGuardianMain(argc, argv);
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 126;
    }
}
