/** 此独立测试 addon 只提供固定阶段的私有事件等待与读门放行，不修改正式 addon 的导出或状态；等待在 Node 工作线程执行且五秒到期必须失败，测试调度不能阻塞 JavaScript 清理定时器或伪造成功阶段。 */
#include "windows-schedule.h"
#include <napi.h>
#include <memory>

/** 等待对象独立持有本次测试事件直到实际系统等待结束，成功必须来自事件已信号而非 Promise 定时器；关闭或超时均以异常返回，事件句柄随对象释放，不保留跨测试的共享全局状态。 */
class WaitPhase : public Napi::AsyncWorker {
    Napi::Promise::Deferred deferred;
    veriq::Handle event;
public:
    /** 构造时先按当前 SID 和随机 nonce 获取固定测试事件，再创建等待任务的唯一句柄所有者；任何权限或事件名称错误都在排队前失败，不能改用公共命名对象或者无条件成功的替代通知。 */
    WaitPhase(Napi::Env env, const std::wstring& nonce, const std::wstring& phase) : Napi::AsyncWorker(env),
        deferred(Napi::Promise::Deferred::New(env)), event(veriq_test::scheduleEvent(nonce, phase)) {}
    /** 返回的 Promise 只由本次真实事件等待结果完成，调用方据此驱动受控读取而不是靠任意延迟猜测线程位置；此处不公开 HANDLE，也不允许 JavaScript 选择任意进程或事件名称。 */
    Napi::Promise promise() { return deferred.Promise(); }
    /** 后台等待保留既有五秒测试清理预算，实际内核未发出阶段信号时记录固定错误；不追加重试或延长截止时间，以免把没有触发取消窗口的运行误报成成功的原生行为证据。 */
    void Execute() override {
        const DWORD result = WaitForSingleObject(event.value, 5000);
        if (result == WAIT_TIMEOUT) SetError("NATIVE_TEST_PHASE_TIMEOUT");
        else if (result != WAIT_OBJECT_0) SetError("NATIVE_TEST_PHASE_WAIT_FAILED");
    }
    /** 只有 Execute 已确认目标事件信号后才兑现阶段完成通知，返回值不包含测试 nonce、SID 或底层句柄；业务侧仍须独立校验真实停止回执和匹配的磁盘排空证明，不能用调度成功替代。 */
    void OnOK() override { deferred.Resolve(Env().Undefined()); }
    /** 原生阶段未得到真实事件信号时拒绝原 Promise 并保留错误给测试聚合器，不能静默吞掉等待失败；随后清理仍由测试恢复原始日志和关闭自己确实拥有的控制流完成，未知状态保留证据。 */
    void OnError(const Napi::Error& error) override { deferred.Reject(error.Value()); }
};
/** 测试等待入口只接受固定事件阶段与本次 UUID，参数校验和私有 ACL 都在真实原生边界完成；正式 addon 完全没有该函数，测试调用失败会拒绝当前操作而不改变 guardian 的生产协议。 */
static Napi::Value waitPhase(const Napi::CallbackInfo& info) {
    try {
        veriq::require(info.Length() == 2 && info[0].IsString() && info[1].IsString(), "NATIVE_TEST_WAIT_INVALID");
        auto operation = std::make_unique<WaitPhase>(info.Env(), veriq::wide(info[0].As<Napi::String>().Utf8Value()), veriq::wide(info[1].As<Napi::String>().Utf8Value()));
        auto promise = operation->promise();
        operation->Queue();
        operation.release();
        return promise;
    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 读门放行只设置同一随机 nonce 的固定私有测试事件，调用后关闭本地句柄而由 guardian 保留等待端；重复清理放行不会终止任何进程，也不能被当成排空证明或跳过原始日志身份核验。 */
static Napi::Value releaseRead(const Napi::CallbackInfo& info) {
    try {
        veriq::require(info.Length() == 1 && info[0].IsString(), "NATIVE_TEST_RELEASE_INVALID");
        auto event = veriq_test::scheduleEvent(veriq::wide(info[0].As<Napi::String>().Utf8Value()), L"read-release");
        veriq::require(SetEvent(event.value) != 0, "NATIVE_TEST_RELEASE_FAILED");
        return info.Env().Undefined();
    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 模块注册只发生在显式构建的测试 addon 中，导出限于等待固定阶段和放行固定读门两项能力；正常产品模块仍由原 windows-addon 源码独立构建，不能因为安装了测试文件就启用调度控制。 */
static Napi::Object initialize(Napi::Env env, Napi::Object exports) {
    exports.Set("waitPhase", Napi::Function::New(env, waitPhase));
    exports.Set("releaseRead", Napi::Function::New(env, releaseRead));
    return exports;
}
NODE_API_MODULE(veriq_test_schedule, initialize)
