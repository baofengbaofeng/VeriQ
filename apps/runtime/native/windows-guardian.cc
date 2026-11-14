/** VeriQ Windows 守护进程把挂起的角色 Node 分配到禁止脱离的 Job 后才发出 READY；控制管道关闭会终止整个 Job，只有根进程句柄已信号且活动进程计数为零才持久写入排空证明。 */
#include "windows-common.h"
#include <atomic>
#include <mutex>
#include <thread>
#include <exception>
#include <iostream>

using namespace veriq;
static std::mutex outputMutex;
static void status(const std::string& record) {
    std::lock_guard<std::mutex> lock(outputMutex);
    writeAll(GetStdHandle(STD_OUTPUT_HANDLE), record + "\n");
}
static std::string hex(const char* bytes, DWORD count) {
    static const char alphabet[] = "0123456789abcdef";
    std::string result;
    result.reserve(count * 2);
    for (DWORD i = 0; i < count; ++i) {
        auto value = static_cast<unsigned char>(bytes[i]);
        result += alphabet[value >> 4]; result += alphabet[value & 15];
    }
    return result;
}
/** 同步取消可能发生在目标线程下一次 ReadFile 之前，因此反复取消并等待真实线程句柄信号，不能只请求一次就无限 join；所有线程共用原有 Job 排空截止时间，只有已经观察到线程退出才回收其 C++ 对象。 */
static bool finishThread(std::thread& thread, ULONGLONG deadline) {
    const HANDLE handle = thread.native_handle();
    for (;;) {
        const DWORD state = WaitForSingleObject(handle, 0);
        if (state == WAIT_OBJECT_0) { thread.join(); return true; }
        const auto now = GetTickCount64();
        if (state != WAIT_TIMEOUT || now >= deadline) return false;
        CancelSynchronousIo(handle);
        const auto remaining = deadline - now;
        const DWORD waited = WaitForSingleObject(handle, static_cast<DWORD>(remaining < 20 ? remaining : 20));
        if (waited == WAIT_OBJECT_0) { thread.join(); return true; }
        if (waited != WAIT_TIMEOUT) return false;
    }
}
int wmain(int argc, wchar_t** argv) {
    try {
        require(argc >= 4, "GUARDIAN_ARGUMENTS_INVALID");
        const std::wstring proofPath = argv[1], nonce = argv[2], executable = argv[3];
        require(nonce.size() == 36 && nonce.find_first_not_of(L"0123456789abcdef-") == std::wstring::npos, "GUARDIAN_NONCE_INVALID");
        const std::string token = utf8(nonce), sid = utf8(currentSid());
        PrivateSecurity security, inherited(true);
        Handle job(CreateJobObjectW(&security.attributes, nullptr));
        require(job.valid(), "GUARDIAN_JOB_FAILED");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0, "GUARDIAN_JOB_LIMIT_FAILED");
        Handle completion(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1));
        require(completion.valid(), "GUARDIAN_COMPLETION_FAILED");
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{job.value, completion.value};
        require(SetInformationJobObject(job.value, JobObjectAssociateCompletionPortInformation, &association, sizeof(association)) != 0, "GUARDIAN_COMPLETION_FAILED");
        HANDLE readOutput = nullptr, writeOutput = nullptr, readInput = nullptr, writeInput = nullptr;
        require(CreatePipe(&readOutput, &writeOutput, &inherited.attributes, 0) != 0, "GUARDIAN_OUTPUT_FAILED");
        Handle outputRead(readOutput), outputWrite(writeOutput);
        require(CreatePipe(&readInput, &writeInput, &inherited.attributes, 0) != 0, "GUARDIAN_INPUT_FAILED");
        Handle inputRead(readInput), inputWrite(writeInput);
        require(SetHandleInformation(outputRead.value, HANDLE_FLAG_INHERIT, 0) && SetHandleInformation(inputWrite.value, HANDLE_FLAG_INHERIT, 0), "GUARDIAN_HANDLE_FLAGS_FAILED");
        SIZE_T attributeBytes = 0;
        InitializeProcThreadAttributeList(nullptr, 1, 0, &attributeBytes);
        std::vector<BYTE> attributes(attributeBytes);
        auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
        require(InitializeProcThreadAttributeList(list, 1, 0, &attributeBytes) != 0, "GUARDIAN_ATTRIBUTES_FAILED");
        HANDLE handles[] = {inputRead.value, outputWrite.value};
        require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr) != 0, "GUARDIAN_HANDLE_LIST_FAILED");
        STARTUPINFOEXW startup{};
        startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = inputRead.value;
        startup.StartupInfo.hStdOutput = outputWrite.value;
        startup.StartupInfo.hStdError = outputWrite.value;
        startup.lpAttributeList = list;
        std::wstring command = quote(executable);
        for (int i = 4; i < argc; ++i) command += L" " + quote(argv[i]);
        require(command.size() < 32767, "GUARDIAN_COMMAND_LIMIT");
        PROCESS_INFORMATION created{};
        BOOL ok = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            nullptr, nullptr, &startup.StartupInfo, &created);
        DeleteProcThreadAttributeList(list);
        require(ok != 0, "GUARDIAN_CREATE_FAILED");
        Handle worker(created.hProcess), workerThread(created.hThread);
        if (!AssignProcessToJobObject(job.value, worker.value)) {
            TerminateProcess(worker.value, 127);
            WaitForSingleObject(worker.value, 5000);
            throw std::runtime_error("GUARDIAN_ASSIGN_FAILED");
        }
        CloseHandle(std::exchange(outputWrite.value, INVALID_HANDLE_VALUE));
        CloseHandle(std::exchange(inputRead.value, INVALID_HANDLE_VALUE));
        const auto workerTime = creationTime(worker.value), guardianTime = creationTime(GetCurrentProcess());
        /** 工作进程已经挂起归属 Job 且双进程身份可读后，才创建绑定这一完整关系的停止事件并准备 READY；创建失败会由 Job 句柄关闭终止尚未放行的工作进程，不留下可被其他 Attempt nonce 交叉命中的事件。 */
        const auto eventName = stopEventName(nonce, GetCurrentProcessId(), guardianTime, created.dwProcessId, workerTime);
        Handle stop(CreateEventW(&security.attributes, TRUE, FALSE, eventName.c_str()));
        require(stop.valid() && GetLastError() != ERROR_ALREADY_EXISTS, "GUARDIAN_STOP_EVENT_FAILED");
        const std::string identity = "\"nonce\":\"" + token + "\",\"sid\":\"" + sid + "\",\"workerPid\":" + std::to_string(created.dwProcessId) +
            ",\"workerStartTime\":\"" + workerTime + "\",\"guardianPid\":" + std::to_string(GetCurrentProcessId()) + ",\"guardianStartTime\":\"" + guardianTime + "\"";
        status("{\"type\":\"READY\"," + identity + "}");
        std::atomic<bool> closed{false};
        std::thread control([&] {
            try {
                std::string line;
                bool resumed = false, sentStart = false;
                char byte = 0;
                DWORD count = 0;
                while (!closed && ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &count, nullptr) && count) {
                    if (byte != '\n') { require(line.size() < 128, "GUARDIAN_CONTROL_LIMIT"); line += byte; continue; }
                    if (line == "START " + token && !resumed) {
                        require(ResumeThread(workerThread.value) != static_cast<DWORD>(-1), "GUARDIAN_RESUME_FAILED");
                        resumed = true;
                    } else if (line == "BUSINESS_START " + token && resumed && !sentStart) {
                        writeAll(inputWrite.value, "START " + token + "\n"); sentStart = true;
                    } else if (line == "STOP " + token) break;
                    else throw std::runtime_error("GUARDIAN_CONTROL_INVALID");
                    line.clear();
                }
            } catch (...) {}
            SetEvent(stop.value);
        });
        std::thread output([&] {
            try {
                char buffer[4096]; DWORD count = 0; size_t total = 0;
                while (ReadFile(outputRead.value, buffer, sizeof(buffer), &count, nullptr) && count) {
                    total += count;
                    require(total <= 65536, "GUARDIAN_OUTPUT_LIMIT");
                    status("{\"type\":\"OUTPUT\",\"nonce\":\"" + token + "\",\"hex\":\"" + hex(buffer, count) + "\"}");
                }
            } catch (...) { SetEvent(stop.value); }
        });
        HANDLE waits[] = {stop.value, worker.value};
        WaitForMultipleObjects(2, waits, FALSE, INFINITE);
        const bool terminated = TerminateJobObject(job.value, 137) != 0;
        bool drained = false;
        const ULONGLONG deadline = GetTickCount64() + 5000;
        while (GetTickCount64() < deadline) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
            if (QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) &&
                accounting.ActiveProcesses == 0 && WaitForSingleObject(worker.value, 0) == WAIT_OBJECT_0) { drained = true; break; }
            DWORD message = 0; ULONG_PTR key = 0; LPOVERLAPPED overlap = nullptr;
            GetQueuedCompletionStatus(completion.value, &message, &key, &overlap, 50);
        }
        closed = true;
        /** 截止时间内仍不能证明本进程线程退出时，不写任何 DRAINED 并只终止守护自身，让自有 Job 句柄按既有策略关闭；宿主保持未知容量隔离，异常退出和真正完成排空明确区分，不能把计时器到期伪造成成功。 */
        if (!finishThread(control, deadline) || !finishThread(output, deadline)) {
            TerminateProcess(GetCurrentProcess(), 125);
            std::terminate();
        }
        if (!terminated || !drained) return 125;
        DWORD exitCode = 0;
        require(GetExitCodeProcess(worker.value, &exitCode) != 0, "GUARDIAN_EXIT_FAILED");
        const std::string proof = "{\"version\":1,\"state\":\"DRAINED\"," + identity + "}";
        const std::wstring temporary = proofPath + L"." + nonce + L".tmp";
        Handle file(CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
        require(file.valid(), "GUARDIAN_PROOF_CREATE_FAILED");
        writeAll(file.value, proof);
        require(FlushFileBuffers(file.value) != 0, "GUARDIAN_PROOF_FLUSH_FAILED");
        CloseHandle(std::exchange(file.value, INVALID_HANDLE_VALUE));
        require(MoveFileExW(temporary.c_str(), proofPath.c_str(), MOVEFILE_WRITE_THROUGH) != 0, "GUARDIAN_PROOF_COMMIT_FAILED");
        status("{\"type\":\"EXIT\",\"nonce\":\"" + token + "\",\"code\":" + std::to_string(exitCode) + "}");
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 126;
    }
}
