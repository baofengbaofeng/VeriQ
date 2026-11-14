/** Windows Node-API 适配器只暴露本机私有管道、当前用户 ACL 与精确进程身份操作；阻塞内核 I/O 在工作线程执行，关闭事件取消全部重叠请求，JavaScript 回调通过受限生命周期的线程安全队列交付。 */
#include "windows-common.h"
#include "windows-files.h"
#include <napi.h>
#include <atomic>
#include <memory>
#include <thread>
#include <mutex>
#include <deque>

using namespace veriq;
/** 管道诊断只保留最近六十四条固定阶段事件和固定错误码，系统返回码在失败调用处采集；诊断队列不含端点、nonce、SID、帧内容或异常动态文本，读取后清空，不能影响既有授权检查和失败关闭路径。 */
struct PipeDiagnostic { const char* phase; std::string code; DWORD win32; DWORD checks; };
static std::mutex diagnosticMutex;
static std::deque<PipeDiagnostic> diagnostics;
static void recordFailure(const char* phase, const char* code, DWORD win32 = 0, DWORD checks = 0) noexcept {
    try {
        PipeDiagnostic record{phase, code, win32, checks};
        std::lock_guard<std::mutex> lock(diagnosticMutex);
        if (diagnostics.size() == 64) diagnostics.pop_front();
        diagnostics.push_back(std::move(record));
    } catch (...) {}
}
static void recordFailure(const char* phase, const NativeFailure& error) noexcept {
    recordFailure(phase, error.what(), error.win32, error.checks);
}
static void recordPhase(const char* phase) noexcept {
    recordFailure(phase, "NATIVE_PIPE_PHASE");
}
static std::wstring pipeName(const std::string& name) {
    require(name.rfind("\\\\.\\pipe\\veriq-", 0) == 0 && name.size() <= 180 &&
        name.substr(15).find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789-") == std::string::npos,
        "NATIVE_PIPE_NAME_INVALID");
    return wide(name);
}
static DWORD transfer(HANDLE pipe, HANDLE stopped, void* buffer, DWORD size, bool writing, DWORD timeout) {
    Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
    require(event.valid(), "NATIVE_IO_EVENT_FAILED");
    OVERLAPPED operation{}; operation.hEvent = event.value;
    DWORD count = 0;
    BOOL ok = writing ? WriteFile(pipe, buffer, size, &count, &operation) : ReadFile(pipe, buffer, size, &count, &operation);
    const DWORD submittedError = ok ? ERROR_SUCCESS : GetLastError();
    if (!ok && submittedError != ERROR_IO_PENDING) throw NativeFailure("NATIVE_PIPE_IO_FAILED", submittedError);
    if (!ok) {
        HANDLE waits[] = {stopped, event.value};
        DWORD waited = WaitForMultipleObjects(2, waits, FALSE, timeout);
        const DWORD waitError = waited == WAIT_FAILED ? GetLastError() : ERROR_SUCCESS;
        if (waited != WAIT_OBJECT_0 + 1) {
            CancelIoEx(pipe, &operation);
            GetOverlappedResult(pipe, &operation, &count, TRUE);
            throw NativeFailure(waited == WAIT_TIMEOUT ? "NATIVE_PIPE_TIMEOUT" : "NATIVE_PIPE_CLOSED", waitError);
        }
        requireWin32(GetOverlappedResult(pipe, &operation, &count, FALSE) != 0, "NATIVE_PIPE_IO_FAILED");
    }
    require(count > 0, "NATIVE_PIPE_EMPTY");
    return count;
}
static std::string readFrame(HANDLE pipe, HANDLE stopped, size_t limit, DWORD timeout) {
    std::string result;
    const auto deadline = GetTickCount64() + timeout;
    for (;;) {
        auto now = GetTickCount64();
        require(now < deadline, "NATIVE_PIPE_TIMEOUT");
        char bytes[4096];
        DWORD count = transfer(pipe, stopped, bytes, sizeof(bytes), false, static_cast<DWORD>(deadline - now));
        require(result.size() + count <= limit, "NATIVE_PIPE_LIMIT");
        result.append(bytes, count);
        const auto end = result.find('\n');
        if (end != std::string::npos) {
            require(end == result.size() - 1, "NATIVE_PIPE_FRAME_INVALID");
            wide(result);
            return result;
        }
    }
}
static void writeFrame(HANDLE pipe, HANDLE stopped, const std::string& bytes, DWORD timeout) {
    size_t offset = 0;
    const auto deadline = GetTickCount64() + timeout;
    while (offset < bytes.size()) {
        auto now = GetTickCount64();
        require(now < deadline, "NATIVE_PIPE_TIMEOUT");
        offset += transfer(pipe, stopped, const_cast<char*>(bytes.data() + offset),
            static_cast<DWORD>(bytes.size() - offset), true, static_cast<DWORD>(deadline - now));
    }
}
static void verifyPeer(HANDLE pipe, bool server) {
    ULONG pid = 0;
    requireWin32((server ? GetNamedPipeClientProcessId(pipe, &pid) : GetNamedPipeServerProcessId(pipe, &pid)) != 0, "NATIVE_PIPE_PEER_UNKNOWN");
    Handle peer(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
    requireWin32(peer.valid(), "NATIVE_PIPE_PEER_OPEN_FAILED");
    require(WaitForSingleObject(peer.value, 0) == WAIT_TIMEOUT && processSid(peer.value) == currentSid(), "NATIVE_PIPE_PEER_REJECTED");
    verifyPrivate(pipe);
}
/** 写入完成后保留管道直到客户端读完完整响应并关闭自有连接，使用已有有界重叠读取观察真正的断管；停止事件即使早于提交也会取消该次操作，额外请求字节与其它错误均拒绝，不再依赖同步刷新线程的单次取消。 */
static void awaitResponseClose(HANDLE pipe, HANDLE stopped) {
    char extra = 0;
    try {
        transfer(pipe, stopped, &extra, 1, false, 5000);
    } catch (const NativeFailure& error) {
        if (error.win32 == ERROR_BROKEN_PIPE && std::string(error.what()) == "NATIVE_PIPE_IO_FAILED") return;
        throw;
    }
    throw NativeFailure("NATIVE_PIPE_FRAME_INVALID");
}
struct Session {
    Handle pipe;
    Handle answered{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    std::mutex mutex;
    std::string request, response;
    std::atomic<bool> finished{false};
    explicit Session(HANDLE handle) : pipe(handle) { require(answered.valid(), "NATIVE_RESPONSE_EVENT_FAILED"); }
};
/** 私有服务器在构造时取得唯一首实例，后续监听句柄在旧实例释放之前创建，防止名字出现无主窗口；并发连接数量和回调队列都有固定上限，已完成线程逐次回收，关闭后才释放线程安全回调引用。 */
class PipeServer : public Napi::ObjectWrap<PipeServer> {
    Handle stopped{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
    Napi::ThreadSafeFunction callback;
    bool callbackOwned = false;
    std::thread listener;
    struct Client { std::shared_ptr<Session> session; std::thread thread; };
    std::vector<Client> clients;
    std::atomic<unsigned> active{0};
    std::atomic<bool> closed{false};
    std::wstring name;
    Handle first;
    HANDLE create(bool initial) {
        PrivateSecurity security;
        HANDLE handle = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED |
            (initial ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0), PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            32, 65536, 65536, 0, &security.attributes);
        requireWin32(handle != INVALID_HANDLE_VALUE, "NATIVE_PIPE_LISTEN_FAILED");
        return handle;
    }
    void serve(std::shared_ptr<Session> session) {
        const char* phase = "server.verifyPeer";
        try {
            recordPhase("server.session.started");
            verifyPeer(session->pipe.value, true);
            recordPhase("server.verifyPeer.complete");
            phase = "server.readFrame";
            session->request = readFrame(session->pipe.value, stopped.value, 65536, 5000);
            recordPhase("server.readFrame.complete");
            phase = "server.dispatch";
            auto* delivery = new std::shared_ptr<Session>(session);
            auto queued = callback.NonBlockingCall(delivery, [](Napi::Env env, Napi::Function receive, std::shared_ptr<Session>* value) {
                std::unique_ptr<std::shared_ptr<Session>> data(value);
                auto state = *data;
                if (!env || !receive || state->finished) return;
                auto reply = Napi::Function::New(env, [state](const Napi::CallbackInfo& info) {
                    try {
                        require(info.Length() == 1 && info[0].IsString(), "NATIVE_RESPONSE_INVALID");
                        auto response = info[0].As<Napi::String>().Utf8Value();
                        require(response.size() <= 32 * 1024 * 1024 && !response.empty() && response.back() == '\n', "NATIVE_RESPONSE_LIMIT");
                        std::lock_guard<std::mutex> lock(state->mutex);
                        if (state->finished || !state->response.empty()) return;
                        state->response = std::move(response);
                        SetEvent(state->answered.value);
                    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); }
                });
                receive.Call({Napi::String::New(env, state->request), reply});
            });
            if (queued != napi_ok) { delete delivery; throw NativeFailure("NATIVE_PIPE_CALLBACK_CLOSED"); }
            recordPhase("server.dispatch.queued");
            phase = "server.awaitResponse";
            HANDLE waits[] = {stopped.value, session->answered.value};
            require(WaitForMultipleObjects(2, waits, FALSE, 60000) == WAIT_OBJECT_0 + 1, "NATIVE_PIPE_RESPONSE_TIMEOUT");
            recordPhase("server.response.ready");
            std::string response;
            { std::lock_guard<std::mutex> lock(session->mutex); response = session->response; }
            phase = "server.writeFrame";
            writeFrame(session->pipe.value, stopped.value, response, 5000);
            recordPhase("server.writeFrame.complete");
            /** 独立测试编译体可在实际响应进入管道后控制会话线程的调度，以观察关闭取消先于下一次系统调用的真实窗口；正式目标不定义此宏，不生成测试调用，也不提供环境变量或普通导出启用它。 */
#ifdef VERIQ_TEST_RESPONSE_WRITTEN
            VERIQ_TEST_RESPONSE_WRITTEN(name);
#endif
            phase = "server.awaitResponseClose";
            awaitResponseClose(session->pipe.value, stopped.value);
            recordPhase("server.awaitResponseClose.complete");
        } catch (const NativeFailure& error) { recordFailure(phase, error); }
        catch (const std::exception&) { recordFailure(phase, "NATIVE_UNEXPECTED_EXCEPTION"); }
        catch (...) { recordFailure(phase, "NATIVE_UNKNOWN_EXCEPTION"); }
        session->finished = true;
        CancelIoEx(session->pipe.value, nullptr);
        recordPhase("server.disconnect.begin");
        if (DisconnectNamedPipe(session->pipe.value)) recordPhase("server.disconnect.complete");
        else recordFailure("server.disconnect", "NATIVE_PIPE_DISCONNECT_FAILED", GetLastError());
        /** JavaScript 可以长期保存旧回复函数，因此会话对象的共享引用不能继续占用已结束的管道实例；持有回复互斥锁后释放两个真实句柄，确保此前获准的回复已结束且迟到回复不会访问回收的事件。 */
        {
            std::lock_guard<std::mutex> lock(session->mutex);
            Handle completedPipe(std::exchange(session->pipe.value, INVALID_HANDLE_VALUE));
            Handle completedAnswer(std::exchange(session->answered.value, INVALID_HANDLE_VALUE));
        }
        --active;
    }
    void accept() {
        const char* phase = "server.accept";
        try {
            Handle pipe(std::exchange(first.value, INVALID_HANDLE_VALUE));
            while (WaitForSingleObject(stopped.value, 0) == WAIT_TIMEOUT) {
                phase = "server.accept";
                Handle connected(CreateEventW(nullptr, TRUE, FALSE, nullptr));
                require(connected.valid(), "NATIVE_ACCEPT_EVENT_FAILED");
                OVERLAPPED operation{}; operation.hEvent = connected.value;
                BOOL ok = ConnectNamedPipe(pipe.value, &operation);
                DWORD error = ok ? ERROR_SUCCESS : GetLastError();
                if (!ok && error == ERROR_IO_PENDING) {
                    HANDLE waits[] = {stopped.value, connected.value};
                    DWORD result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
                    DWORD count = 0;
                    if (result != WAIT_OBJECT_0 + 1) {
                        CancelIoEx(pipe.value, &operation);
                        GetOverlappedResult(pipe.value, &operation, &count, TRUE);
                        break;
                    }
                    requireWin32(GetOverlappedResult(pipe.value, &operation, &count, FALSE) != 0, "NATIVE_ACCEPT_FAILED");
                } else if (!ok && error != ERROR_PIPE_CONNECTED) throw NativeFailure("NATIVE_ACCEPT_FAILED", error);
                recordPhase("server.accept.complete");
                for (auto entry = clients.begin(); entry != clients.end();) {
                    if (entry->session->finished) { entry->thread.join(); entry = clients.erase(entry); }
                    else ++entry;
                }
                if (active >= 31) { DisconnectNamedPipe(pipe.value); continue; }
                phase = "server.createNext";
                Handle next(create(false));
                recordPhase("server.createNext.complete");
                phase = "server.startSession";
                auto session = std::make_shared<Session>(std::exchange(pipe.value, INVALID_HANDLE_VALUE));
                ++active;
                clients.push_back({session, std::thread([this, session] { serve(session); })});
                pipe.value = std::exchange(next.value, INVALID_HANDLE_VALUE);
            }
        } catch (const NativeFailure& error) { recordFailure(phase, error); SetEvent(stopped.value); }
        catch (const std::exception&) { recordFailure(phase, "NATIVE_UNEXPECTED_EXCEPTION"); SetEvent(stopped.value); }
        catch (...) { recordFailure(phase, "NATIVE_UNKNOWN_EXCEPTION"); SetEvent(stopped.value); }
    }
    /** 关闭同时覆盖正常实例和监听线程尚未构造的失败状态，先结束已有线程再释放实际获得的 TSFN 引用及首实例句柄；回调引用只中止一次，未成功分配的对象不调用 Abort，部分构造不依赖未来 GC 才归还资源。 */
    void stop() {
        if (closed.exchange(true)) return;
        if (stopped.valid()) SetEvent(stopped.value);
        if (listener.joinable()) listener.join();
        for (auto& client : clients) if (client.thread.joinable()) {
            CancelSynchronousIo(client.thread.native_handle());
            client.thread.join();
        }
        if (callbackOwned) { callbackOwned = false; callback.Abort(); }
        Handle firstPipe(std::exchange(first.value, INVALID_HANDLE_VALUE));
        Handle stopEvent(std::exchange(stopped.value, INVALID_HANDLE_VALUE));
    }
public:
    /** 创建监听前分别记录实际获得的管道与线程安全回调所有权，线程构造失败必须在向 JavaScript 抛错前释放它们；正式对象与测试注入都经过同一个异常清理分支，不把尚未启动线程误认为从未分配资源。 */
    explicit PipeServer(const Napi::CallbackInfo& info) : Napi::ObjectWrap<PipeServer>(info) {
        try {
            require(info.Length() == 2 && info[0].IsString() && info[1].IsFunction(), "NATIVE_SERVER_ARGUMENTS_INVALID");
            require(stopped.valid(), "NATIVE_STOP_EVENT_FAILED");
            name = pipeName(info[0].As<Napi::String>().Utf8Value());
            first.value = create(true);
            callback = Napi::ThreadSafeFunction::New(info.Env(), info[1].As<Napi::Function>(), "VeriQ private pipe", 32, 1);
            callbackOwned = true;
            /** 仅独立测试编译体在真实管道和回调分配后注入监听线程构造失败，普通构建不定义此宏且不生成故障调用；该阶段用于验证部分构造的资源释放，不能成为运行时环境开关或正式模块导出。 */
#ifdef VERIQ_TEST_FAIL_PIPE_LISTENER
            VERIQ_TEST_FAIL_PIPE_LISTENER();
#endif
            listener = std::thread([this] { accept(); });
        } catch (const std::exception& error) { stop(); Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); }
    }
    /** 析构不能以监听线程是否可 join 推断此前是否分配过 TSFN 或首实例管道，失败构造和显式关闭后的对象都进入幂等清理；已经释放的句柄和回调拥有标记阻止重复关闭与重复中止。 */
    ~PipeServer() { stop(); }
    Napi::Value close(const Napi::CallbackInfo& info) { stop(); return info.Env().Undefined(); }
    static Napi::Function definition(Napi::Env env) {
        return DefineClass(env, "PrivatePipeServer", {InstanceMethod("close", &PipeServer::close)});
    }
};
/** 客户端请求在 Node 工作池中执行并验证服务器真实用户身份与保护 ACL，采用独立读写截止时间和字节预算；只传递一帧请求和一帧响应，失败通过 Promise 拒绝返回而不重试业务命令或改变连接目标。 */
class Request : public Napi::AsyncWorker {
    Napi::Promise::Deferred deferred;
    std::wstring name;
    std::string request, response;
public:
    Request(Napi::Env env, std::wstring path, std::string frame) : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), name(std::move(path)), request(std::move(frame)) {}
    Napi::Promise promise() { return deferred.Promise(); }
    void Execute() override {
        const char* phase = "client.connect";
        try {
            Handle stopped(CreateEventW(nullptr, TRUE, FALSE, nullptr));
            require(stopped.valid(), "NATIVE_STOP_EVENT_FAILED");
            Handle pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
            requireWin32(pipe.valid(), "NATIVE_PIPE_CONNECT_FAILED");
            recordPhase("client.connect.complete");
            phase = "client.verifyPeer";
            verifyPeer(pipe.value, false);
            recordPhase("client.verifyPeer.complete");
            phase = "client.writeFrame";
            writeFrame(pipe.value, stopped.value, request, 5000);
            recordPhase("client.writeFrame.complete");
            phase = "client.readFrame";
            response = readFrame(pipe.value, stopped.value, 32 * 1024 * 1024, 65000);
            recordPhase("client.readFrame.complete");
        } catch (const NativeFailure& error) { recordFailure(phase, error); SetError(error.what()); }
        catch (const std::exception& error) { recordFailure(phase, "NATIVE_UNEXPECTED_EXCEPTION"); SetError(error.what()); }
    }
    void OnOK() override { deferred.Resolve(Napi::String::New(Env(), response)); }
    void OnError(const Napi::Error& error) override { deferred.Reject(error.Value()); }
};
static Napi::Value request(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 2 && info[0].IsString() && info[1].IsString(), "NATIVE_REQUEST_INVALID");
        auto name = pipeName(info[0].As<Napi::String>().Utf8Value());
        auto frame = info[1].As<Napi::String>().Utf8Value();
        require(frame.size() <= 65536 && !frame.empty() && frame.back() == '\n', "NATIVE_REQUEST_LIMIT");
        auto* operation = new Request(info.Env(), std::move(name), std::move(frame));
        auto promise = operation->promise(); operation->Queue(); return promise;
    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 进程查询保留已打开句柄直到 SID、创建时间和信号状态读取完毕，只有内核明确报告 PID 不存在才返回空值；访问拒绝等不确定状态必须抛错，不能用于证明未知进程已经退出或释放隔离容量。 */
static Napi::Value identity(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 1 && info[0].IsNumber(), "NATIVE_PID_INVALID");
        double number = info[0].As<Napi::Number>().DoubleValue();
        require(number >= 1 && number <= MAXDWORD && number == static_cast<DWORD>(number), "NATIVE_PID_INVALID");
        Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, static_cast<DWORD>(number)));
        if (!process.valid()) { require(GetLastError() == ERROR_INVALID_PARAMETER, "NATIVE_PROCESS_ACCESS_DENIED"); return info.Env().Null(); }
        auto result = Napi::Object::New(info.Env());
        result.Set("sid", utf8(processSid(process.value)));
        result.Set("startTime", creationTime(process.value));
        result.Set("running", WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT);
        return result;
    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 恢复停止同时持有守护和工作进程句柄核对当前 SID 与完整创建时间，再打开绑定二者及 nonce 的私有事件；独立真实字段不能跨 Attempt 拼接，此接口只请求现存 Job 所有者排空而不提供任意 PID 终止或成功回执。 */
static Napi::Value signalStop(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 5 && info[0].IsString() && info[1].IsNumber() && info[2].IsString() &&
            info[3].IsNumber() && info[4].IsString(), "NATIVE_STOP_INVALID");
        auto nonce = info[0].As<Napi::String>().Utf8Value();
        require(nonce.size() == 36 && nonce.find_first_not_of("0123456789abcdef-") == std::string::npos, "NATIVE_NONCE_INVALID");
        const auto guardianNumber = info[1].As<Napi::Number>().DoubleValue(), workerNumber = info[3].As<Napi::Number>().DoubleValue();
        require(guardianNumber >= 1 && guardianNumber <= MAXDWORD && guardianNumber == static_cast<DWORD>(guardianNumber) &&
            workerNumber >= 1 && workerNumber <= MAXDWORD && workerNumber == static_cast<DWORD>(workerNumber), "NATIVE_PID_INVALID");
        const auto pid = static_cast<DWORD>(guardianNumber), workerPid = static_cast<DWORD>(workerNumber);
        Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
        Handle worker(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, workerPid));
        const auto guardianTime = info[2].As<Napi::String>().Utf8Value(), workerTime = info[4].As<Napi::String>().Utf8Value();
        const auto sid = currentSid();
        require(process.valid() && worker.valid() && processSid(process.value) == sid && processSid(worker.value) == sid &&
            creationTime(process.value) == guardianTime && creationTime(worker.value) == workerTime &&
            WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT, "NATIVE_STOP_IDENTITY_CHANGED");
        const auto eventName = stopEventName(wide(nonce), pid, guardianTime, workerPid, workerTime);
        Handle event(OpenEventW(EVENT_MODIFY_STATE | READ_CONTROL, FALSE, eventName.c_str()));
        require(event.valid(), "NATIVE_STOP_EVENT_UNAVAILABLE");
        verifyPrivate(event.value, SE_KERNEL_OBJECT);
        require(SetEvent(event.value) != 0, "NATIVE_STOP_FAILED");
        return info.Env().Undefined();
    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 私有文件接口只把明确不存在映射为 Node 的 ENOENT，供首次配置创建处理；ACL、重解析与提交不确定性保留各自固定错误码，错误对象不附加配置内容或路径，也不把失败伪装成空数据。 */
static Napi::Value fileFailure(const Napi::CallbackInfo& info, const NativeFailure& failure) {
    auto error = Napi::Error::New(info.Env(), failure.what());
    if (std::string(failure.what()) == "NATIVE_PATH_UNAVAILABLE" &&
        (failure.win32 == ERROR_FILE_NOT_FOUND || failure.win32 == ERROR_PATH_NOT_FOUND)) error.Set("code", "ENOENT");
    error.Set("win32", static_cast<double>(failure.win32));
    error.ThrowAsJavaScriptException();
    return info.Env().Undefined();
}
/** 文件 ACL 入口只作用于当前用户拥有且整条祖先链无重解析点的对象，创建时即安装私有可继承目录权限；已有公共对象保持拒绝，不能借初始化路径把历史公开配置自动收紧并当成合法迁移。 */
static Napi::Value privatePath(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 2 && info[0].IsString() && info[1].IsBoolean(), "NATIVE_PATH_INVALID");
        ensurePrivatePath(wide(info[0].As<Napi::String>().Utf8Value()), info[1].As<Napi::Boolean>());
        return info.Env().Undefined();
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 私有新文件保持创建即独占和当前用户 DACL，写入与刷新都发生在已验证真实句柄上；普通接口不覆盖已有成员，配置替换使用下方独立有界入口，不能靠验证路径后再交回 JavaScript 重新打开完成。 */
static Napi::Value writePrivate(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 2 && info[0].IsString() && info[1].IsString(), "NATIVE_FILE_ARGUMENTS_INVALID");
        createPrivateFile(wide(info[0].As<Napi::String>().Utf8Value()), info[1].As<Napi::String>().Utf8Value());
        return info.Env().Undefined();
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 私有读取最多返回一 MiB 的原始 Buffer，目录、文件 ACL 和字节大小都在本次实际句柄上检查；JSON 解析仍由配置层负责，不提供任意句柄、无限文件读取或遇到权限错误后的路径回退。 */
static Napi::Value readPrivateFile(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 2 && info[0].IsString() && info[1].IsNumber(), "NATIVE_FILE_ARGUMENTS_INVALID");
        const double limit = info[1].As<Napi::Number>().DoubleValue();
        require(limit >= 0 && limit <= 1024 * 1024 && limit == static_cast<size_t>(limit), "NATIVE_FILE_LIMIT");
        const auto bytes = readPrivateBytes(wide(info[0].As<Napi::String>().Utf8Value()), static_cast<size_t>(limit));
        return Napi::Buffer<char>::Copy(info.Env(), bytes.data(), bytes.size());
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 替换入口只接受私有目录、正式成员名、宿主随机临时名和有界正文，原子提交由持有句柄的原生层完成；提交后刷新失败会明确抛出不确定性错误，上层不得因此重跑更新回调或声称原值已经回滚。 */
static Napi::Value replacePrivate(const Napi::CallbackInfo& info) {
    try {
        require((info.Length() == 4 || (info.Length() == 5 && info[4].IsBoolean())) && info[0].IsString() && info[1].IsString() && info[2].IsString() && info[3].IsString(), "NATIVE_FILE_ARGUMENTS_INVALID");
        replacePrivateFile(wide(info[0].As<Napi::String>().Utf8Value()), wide(info[1].As<Napi::String>().Utf8Value()),
            wide(info[2].As<Napi::String>().Utf8Value()), info[3].As<Napi::String>().Utf8Value(), info.Length() == 5 && info[4].As<Napi::Boolean>().Value());
        return info.Env().Undefined();
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 私有文件退休只接受一个经过父链与 ACL 校验的普通成员，实际删除由已持有文件句柄完成；只有系统明确不存在才映射为 ENOENT，不把访问拒绝当作成功，也不承诺物理擦除或断电目录持久化。 */
static Napi::Value removePrivate(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 1 && info[0].IsString(), "NATIVE_FILE_ARGUMENTS_INVALID");
        removePrivateFile(wide(info[0].As<Napi::String>().Utf8Value()));
        return info.Env().Undefined();
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 保险库扩展仅允许固定清单、恢复日志及随机记录成员，最大两兆字节承载原有一兆业务载荷的认证编码开销；通用配置入口继续保持一兆限制，拥有者、父链、真实句柄与原子提交规则完全复用而不放宽。 */
static void vaultMember(const std::wstring& path) {
    const FilePath parsed(path);
    require(parsed.parts.size() >= 2 && parsed.parts[parsed.parts.size() - 2] == L"vault", "NATIVE_VAULT_PATH_INVALID");
    const auto& name = parsed.parts.back();
    const bool record = name.size() == 48 && name.substr(0, 7) == L"record-" && name.substr(43) == L".json" &&
        name.substr(7, 36).find_first_not_of(L"0123456789abcdef-") == std::wstring::npos;
    require(record || name == L"profile.json" || name == L"profile-next.json" || name == L"transaction.json" || name == L"migration.json" || name == L"initialization.json", "NATIVE_VAULT_PATH_INVALID");
}
/** 保险库读取固定为两兆字节上限并返回实际同句柄读取的字节，调用方不能传入更大额度或其他用途名称；普通配置读取及其原有测试保持原入口，从而不会因信封编码增加而扩大一般文件授权。 */
static Napi::Value readVaultFile(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 1 && info[0].IsString(), "NATIVE_FILE_ARGUMENTS_INVALID");
        const auto path = wide(info[0].As<Napi::String>().Utf8Value());
        vaultMember(path);
        const auto bytes = readPrivateBytes(path, 2 * 1024 * 1024, 2 * 1024 * 1024);
        return Napi::Buffer<char>::Copy(info.Env(), bytes.data(), bytes.size());
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 保险库发布只增加固定用途密文的容量，不增加路径回退、任意原生操作或额外权限；同一父目录与源句柄完成刷新和重命名，既有提交不确定错误原样保留，由上层有限恢复日志处理。 */
static Napi::Value replaceVaultFile(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 4 && info[0].IsString() && info[1].IsString() && info[2].IsString() && info[3].IsString(), "NATIVE_FILE_ARGUMENTS_INVALID");
        const auto directory = wide(info[0].As<Napi::String>().Utf8Value());
        const auto name = wide(info[1].As<Napi::String>().Utf8Value());
        vaultMember(directory + L"\\" + name);
        replacePrivateFile(directory, name, wide(info[2].As<Napi::String>().Utf8Value()), info[3].As<Napi::String>().Utf8Value(), false, 2 * 1024 * 1024);
        return info.Env().Undefined();
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 保险库记录退休保留固定名称和两兆字节上限，在已校验父链与文件句柄中设置删除标志；未知失败不能转换为不存在，也不会改用 Node 路径删除以绕过已有严格的拥有者检查。 */
static Napi::Value removeVaultFile(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 1 && info[0].IsString(), "NATIVE_FILE_ARGUMENTS_INVALID");
        const auto path = wide(info[0].As<Napi::String>().Utf8Value());
        vaultMember(path);
        removePrivateFile(path, 2 * 1024 * 1024);
        return info.Env().Undefined();
    } catch (const NativeFailure& error) { return fileFailure(info, error); }
    catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** Cookie 退役入口仅接受本应用固定分区两个已知布局中的四个数据库成员，六十四兆上限只用于元数据核验而不读取秘密；父链、真实文件句柄、严格当前拥有者和无重解析规则全部沿用，未知错误不会转换为不存在。 */
static Napi::Value privateCookieFile(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 2 && info[0].IsString() && info[1].IsBoolean(), "NATIVE_FILE_ARGUMENTS_INVALID");
        const FilePath path(wide(info[0].As<Napi::String>().Utf8Value()));
        const size_t count = path.parts.size();
        require(count >= 3, "NATIVE_COOKIE_MEMBER_INVALID");
        const auto& name = path.parts.back();
        require(name == L"Cookies" || name == L"Cookies-wal" || name == L"Cookies-shm" || name == L"Cookies-journal", "NATIVE_COOKIE_MEMBER_INVALID");
        const size_t partition = path.parts[count - 2] == L"Network" ? count - 3 : count - 2;
        require(partition >= 1 && path.parts[partition] == L"veriq-host" && path.parts[partition - 1] == L"Partitions", "NATIVE_COOKIE_MEMBER_INVALID");
        const bool retire = info[1].As<Napi::Boolean>().Value();
        DirectoryChain parent(path, count - 1);
        parent.verifyPrivateDirectory();
        auto file = relativeFile(parent.handle(), name, READ_CONTROL | FILE_READ_ATTRIBUTES | (retire ? DELETE : 0),
            FILE_OPEN, FILE_NON_DIRECTORY_FILE, 0);
        verifyPrivateChild(file.value, parent);
        parent.validate();
        LARGE_INTEGER size{};
        requireWin32(GetFileSizeEx(file.value, &size) != 0, "NATIVE_COOKIE_METADATA_FAILED");
        require(size.QuadPart >= 0 && size.QuadPart <= 64LL * 1024 * 1024, "NATIVE_FILE_LIMIT");
        if (retire) {
            FILE_DISPOSITION_INFO remove{TRUE};
            requireWin32(SetFileInformationByHandle(file.value, FileDispositionInfo, &remove, sizeof(remove)) != 0, "NATIVE_COOKIE_RETIRE_FAILED");
            const HANDLE removed = std::exchange(file.value, INVALID_HANDLE_VALUE);
            requireWin32(CloseHandle(removed) != 0, "NATIVE_COOKIE_RETIRE_UNCONFIRMED");
        }
        return Napi::Boolean::New(info.Env(), true);
    } catch (const NativeFailure& error) {
        if (error.win32 == ERROR_FILE_NOT_FOUND || error.win32 == ERROR_PATH_NOT_FOUND) return Napi::Boolean::New(info.Env(), false);
        return fileFailure(info, error);
    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
/** 诊断读取只能返回当前进程最近有界的固定错误记录并清空缓冲区，不接收文件路径或筛选表达式；测试在资源关闭后收集这些记录定位原生阶段，原始客户端断言与清理异常仍独立保留，不能被诊断替代。 */
static Napi::Value takePipeDiagnostics(const Napi::CallbackInfo& info) {
    try {
        require(info.Length() == 0, "NATIVE_DIAGNOSTIC_ARGUMENTS_INVALID");
        std::deque<PipeDiagnostic> records;
        { std::lock_guard<std::mutex> lock(diagnosticMutex); records.swap(diagnostics); }
        auto result = Napi::Array::New(info.Env(), records.size());
        uint32_t index = 0;
        for (const auto& record : records) {
            auto value = Napi::Object::New(info.Env());
            value.Set("phase", record.phase);
            value.Set("code", record.code);
            value.Set("win32", record.win32);
            value.Set("checks", record.checks);
            result.Set(index++, value);
        }
        return result;
    } catch (const std::exception& error) { Napi::Error::New(info.Env(), error.what()).ThrowAsJavaScriptException(); return info.Env().Undefined(); }
}
static Napi::Object initialize(Napi::Env env, Napi::Object exports) {
    try {
        exports.Set("PrivatePipeServer", PipeServer::definition(env));
        exports.Set("request", Napi::Function::New(env, request));
        exports.Set("identity", Napi::Function::New(env, identity));
        exports.Set("signalStop", Napi::Function::New(env, signalStop));
        exports.Set("privatePath", Napi::Function::New(env, privatePath));
        exports.Set("writePrivate", Napi::Function::New(env, writePrivate));
        exports.Set("readPrivateFile", Napi::Function::New(env, readPrivateFile));
        exports.Set("readVaultFile", Napi::Function::New(env, readVaultFile));
        exports.Set("replaceVaultFile", Napi::Function::New(env, replaceVaultFile));
        exports.Set("removeVaultFile", Napi::Function::New(env, removeVaultFile));
        exports.Set("replacePrivate", Napi::Function::New(env, replacePrivate));
        exports.Set("removePrivate", Napi::Function::New(env, removePrivate));
        exports.Set("privateCookieFile", Napi::Function::New(env, privateCookieFile));
        exports.Set("takePipeDiagnostics", Napi::Function::New(env, takePipeDiagnostics));
        exports.Set("sid", Napi::String::New(env, utf8(currentSid())));
    } catch (const std::exception& error) { Napi::Error::New(env, error.what()).ThrowAsJavaScriptException(); }
    return exports;
}
NODE_API_MODULE(veriq_native, initialize)
