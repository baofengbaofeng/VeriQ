/** 独立测试 addon 复用正式文件实现并只在此编译目标启用有限阶段调度，生产产物不含故障状态或导出；错误动作在真实系统调用前发生，关闭动作则在真实 close 后发生以检查描述符撤销语义。
 * 观察回调可以在已打开 inode 的读取期间制造真实截断、增长或名字替换。
 * 每次回调仅执行一次，测试断言异常原样传播，不被当作系统成功。
 * 模块路径位于 native-tests，正式开发加载器不会寻找此文件。
 * 同一 gyp 图可以显式构建测试目标，默认正式构建不会生成它。
 * 测试结束释放回调引用，避免持有下一轮 fixture 的秘密或目录状态。
 */
#define VERIQ_DARWIN_PRIVATE_TESTS 1
#include "../../native/darwin/addon.cc"

namespace veriq::darwin {
/** 调度状态只属于独立测试模块当前线程的 Node 环境，不读取任何产品环境变量；重复次数有固定上限，支持持续 EINTR 的终止断言而不在测试中制造永久忙等。
 * callback 的持久引用在环境清理前释放，不跨线程复用。
 * reset 在每个 finally 调用，故障不会泄漏到下一个正常行为样本。
 */
struct Schedule {
    std::string phase;
    int action = 0;
    size_t remaining = 0;
    std::string hookPhase;
    Napi::FunctionReference hook;
};
thread_local Schedule* schedule = nullptr;
int testPoint(const char* phase, int fd) {
    /** 观察回调在匹配阶段只取出一次并先撤销持久引用，回调中的同步文件修改因而不会再次触发自身；传入数字仅供测试核对当前真正持有对象，正式 API 仍没有采用调用方数字的路径。
     * 清除 hookPhase 发生在回调前，允许回调显式安排另一个不同阶段。
     * 回调异常属于测试错误，统一边界保持原 JavaScript 错误对象。
     * 没有匹配 hook 时不会额外打开、写入或查询任何文件。
     */
    if (schedule->hookPhase == phase && !schedule->hook.IsEmpty()) {
        auto callback = schedule->hook.Value();
        schedule->hook.Reset();
        schedule->hookPhase.clear();
        callback.Call({Napi::Number::New(callback.Env(), fd)});
    }
    if (schedule->phase != phase || schedule->remaining == 0) return 0;
    /** 有限故障计数在触发前递减，单次 EINTR 后会自动回到真实内核调用，连续六十四次可验证有界重试终止；error 动作在当前固定阶段抛 EIO，不能伪造 ENOENT 绕过正式缺失语义。
     * short 和 zero 交给正式读写循环处理，保留真实进展或零进展判断。
     * close 阶段在真实 close 后调用，仍验证已经撤销描述符状态。
     * 不匹配阶段完全不消耗故障计数，便于精确定位发布前后。
     */
    schedule->remaining--;
    if (schedule->action == 4) throw Failure("DARWIN_PRIVATE_IO", phase, EIO);
    return schedule->action;
}
}

/** 测试入口在同一正式 API 旁增加显式调度函数，只有独立 native-tests 产物能加载这些导出；参数错误仍走统一固定错误边界，调度不会通过全局配置或生产装载路径取得权限。
 * error、eintr、short、zero 分别覆盖系统失败、中断、短操作和零进展分支。
 * hook 仅用于真实文件变化，不伪造 fstat 结果或修改正式校验代码。
 */
Napi::Object initializePrivateFileFaults(Napi::Env env, Napi::Object exports) {
    using namespace veriq::darwin;
    schedule = new Schedule();
    env.AddCleanupHook([](Schedule* owned) { delete owned; schedule = nullptr; }, schedule);
    initialize(env, exports);
    /** setFault 只在独立测试模块导出且要求阶段、动作与次数三个明确参数，次数最多一百二十八；测试通过实际行为检查每个阶段的旧内容保留或新内容不确定，不通过读取源码字符串判断分支存在。
     * phase 长度受限，动作只映射四个固定枚举。
     * 无效动作不会打开任何生产后门，因为该代码没有编译进生产模块。
     * 每次设置替换上一次故障计划，不在运行产品时积累调度队列。
     * 计数归零后继续使用真实系统操作。
     */
    exports.Set("setFault", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 3, "test.fault.arguments");
            const auto phase = text(info[0]), action = text(info[1]);
            require(phase.size() <= 80, "test.fault.phase");
            schedule->phase = phase;
            schedule->action = action == "eintr" ? 1 : action == "short" ? 2 :
                action == "zero" ? 3 : action == "error" ? 4 : action == "acl-absent" ? 5 :
                action == "acl-empty" ? 6 : action == "acl-denied" ? 7 : action == "acl-unknown" ? 8 : 0;
            require(schedule->action != 0, "test.fault.action");
            schedule->remaining = limit(info[2], 128);
            return info.Env().Undefined();
        });
    }));
    /** setHook 在正式读取的两个观察点执行一次同步 JavaScript 回调，用真实文件操作制造增长、截断或名字替换；测试不修改 fstat 返回值，也不把模拟成功当作原生读写已经完成的证据。
     * 原生持有被测文件后才调用回调，因此可区分路径和 inode 锚定行为。
     * 持久引用只属于当前测试环境，重设时释放先前回调。
     * finally 调用 resetFaults，异常不影响后续测试。
     * 生产导出名单的独立断言确保没有这项能力。
     */
    exports.Set("setHook", Napi::Function::New(env, [](const Napi::CallbackInfo& info) -> Napi::Value {
        return boundary(info.Env(), [&]() -> Napi::Value {
            require(info.Length() == 2 && info[1].IsFunction(), "test.hook.arguments");
            schedule->hookPhase = text(info[0]);
            require(schedule->hookPhase.size() <= 80, "test.hook.phase");
            schedule->hook = Napi::Persistent(info[1].As<Napi::Function>());
            return info.Env().Undefined();
        });
    }));
    /** 清理显式撤销阶段、次数与观察回调引用，让独立测试之间没有隐含故障继承；此方法不修改文件系统或吞掉前一条断言错误，资源清理由各 fixture 的 finally 继续负责。
     * 每个使用调度的测试在 finally 调用，包含预期失败与非预期异常。
     * 释放回调避免它保活临时目录或文件拥有者。
     * 返回 undefined 只描述调度已清空，不代表任何文件提交。
     */
    exports.Set("resetFaults", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
        schedule->phase.clear();
        schedule->remaining = 0;
        schedule->hookPhase.clear();
        schedule->hook.Reset();
        return info.Env().Undefined();
    }));
    return exports;
}
NODE_API_MODULE(veriq_private_files_fault, initializePrivateFileFaults)
