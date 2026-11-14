/** Windows 保险库辅助程序只服务一个有界私有管道请求，以当前登录令牌调用成熟 Credential Manager 保存三十二字节随机密钥；没有任意命令、凭据枚举、用户切换或提示入口，控制输入关闭立即结束本进程以隔离可能等待系统服务的调用。 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <wincred.h>
#include <wincrypt.h>
#include <array>
#include <string>
#include <vector>
#include <thread>
#include <stdexcept>

namespace {
constexpr size_t frameLimit = 512;
using Key = std::array<BYTE, 32>;
void require(bool value) { if (!value) throw std::runtime_error("VAULT_REQUEST_FAILED"); }
void output(const std::string& value) {
    require(value.size() <= frameLimit);
    DWORD count = 0;
    require(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), value.data(), static_cast<DWORD>(value.size()), &count, nullptr) && count == value.size());
}
std::string failure(DWORD error) {
    if (error == ERROR_NOT_FOUND) return "missing";
    if (error == ERROR_NO_SUCH_LOGON_SESSION || error == ERROR_NOT_SUPPORTED || error == ERROR_SERVICE_NOT_ACTIVE) return "unavailable";
    return "failed";
}
bool uuid(const std::string& value) {
    if (value.size() != 36) return false;
    for (size_t i = 0; i < value.size(); ++i) {
        const char c = value[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
}
/** Credential Manager 的目标匹配可以忽略大小写，因此目标组件编码的是原 UUID 的每个 ASCII 字节而非直接使用 UUID 文本；规范小写十六进制表示保持大小写不同的输入为不同身份，原始绑定不被偷偷规范化或猜测最新版本。 */
std::wstring component(const std::string& value) {
    static constexpr wchar_t digits[] = L"0123456789abcdef";
    std::wstring result;
    for (const unsigned char c : value) { result += digits[c >> 4]; result += digits[c & 15]; }
    return result;
}
std::wstring target(const std::string& profile, const std::string& version) {
    require(uuid(profile) && uuid(version));
    return L"VeriQ/RuntimeVault/v1/" + component(profile) + L"/" + component(version);
}
/** 原始密钥字节的管道编码复用系统 Crypt32 的标准 Base64 实现，再作无填充 URL 字母替换；解码后必须重编码完全相等且长度恰为三十二，不能截断、接受非规范尾位或把二进制内容作为文本密钥使用。 */
std::string encode(const BYTE* bytes) {
    DWORD size = 0;
    require(CryptBinaryToStringA(bytes, 32, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, nullptr, &size) != 0);
    std::string text(size, '\0');
    require(CryptBinaryToStringA(bytes, 32, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, text.data(), &size) != 0);
    while (!text.empty() && (text.back() == '\0' || text.back() == '=')) text.pop_back();
    for (char& c : text) { if (c == '+') c = '-'; else if (c == '/') c = '_'; }
    require(text.size() == 43);
    return text;
}
Key decode(const std::string& text) {
    require(text.size() == 43 && text.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") == std::string::npos);
    std::string base64 = text + "=";
    for (char& c : base64) { if (c == '-') c = '+'; else if (c == '_') c = '/'; }
    Key key{};
    DWORD size = static_cast<DWORD>(key.size());
    require(CryptStringToBinaryA(base64.data(), static_cast<DWORD>(base64.size()), CRYPT_STRING_BASE64 | CRYPT_STRING_STRICT, key.data(), &size, nullptr, nullptr) != 0);
    require(size == key.size() && encode(key.data()) == text);
    SecureZeroMemory(base64.data(), base64.size());
    return key;
}
struct Credential {
    PCREDENTIALW value = nullptr;
    ~Credential() { if (value) { if (value->CredentialBlob && value->CredentialBlobSize) SecureZeroMemory(value->CredentialBlob, value->CredentialBlobSize); CredFree(value); } }
};
void checkCredential(const Credential& credential, const std::wstring& name) {
    const auto* value = credential.value;
    require(value && value->Type == CRED_TYPE_GENERIC && value->Persist == CRED_PERSIST_LOCAL_MACHINE && value->CredentialBlobSize == 32 && value->CredentialBlob && value->TargetName);
    require(CompareStringOrdinal(value->TargetName, -1, name.c_str(), -1, TRUE) == CSTR_EQUAL);
}
/** 同值写入先读取精确目标并比较全部密钥字节，冲突不能覆盖，真正不存在才进行一次 CredWrite；该逻辑不是跨客户端 CAS，生产档案仍负责持有排他事务和未知结果恢复，helper 不自动重试系统修改。 */
std::string execute(const std::vector<std::string>& parts) {
    require(parts.size() >= 2 && parts[0] == "V1");
    const std::string& operation = parts[1];
    if (operation == "probe") {
        require(parts.size() == 2);
        Credential value;
        if (CredReadW(L"VeriQ/RuntimeVault/v1/probe", CRED_TYPE_GENERIC, 0, &value.value)) return "V1 ready\n";
        const DWORD error = GetLastError();
        return error == ERROR_NOT_FOUND ? "V1 ready\n" : "V1 " + failure(error) + "\n";
    }
    require(operation == "get" || operation == "set" || operation == "delete");
    require(parts.size() == (operation == "set" ? 5u : 4u));
    const auto name = target(parts[2], parts[3]);
    if (operation == "delete") {
        if (CredDeleteW(name.c_str(), CRED_TYPE_GENERIC, 0)) return "V1 ok\n";
        /** 删除调用已经进入系统凭据服务，除明确不存在之外的错误不能证明服务未提交；保留不确定状态给档案恢复处理，不能把未知 RPC 或系统失败折叠成可安全重放的普通失败。 */
        return GetLastError() == ERROR_NOT_FOUND ? "V1 missing\n" : "V1 mutation-unconfirmed\n";
    }
    Credential previous;
    const bool found = CredReadW(name.c_str(), CRED_TYPE_GENERIC, 0, &previous.value) != 0;
    const DWORD error = found ? ERROR_SUCCESS : GetLastError();
    if (found) checkCredential(previous, name);
    else if (error != ERROR_NOT_FOUND) return "V1 " + failure(error) + "\n";
    if (operation == "get") return found ? "V1 ok " + encode(previous.value->CredentialBlob) + "\n" : "V1 missing\n";
    Key key = decode(parts[4]);
    if (found) {
        BYTE different = 0;
        for (size_t i = 0; i < key.size(); ++i) different |= key[i] ^ previous.value->CredentialBlob[i];
        SecureZeroMemory(key.data(), key.size());
        return different ? "V1 failed\n" : "V1 ok\n";
    }
    CREDENTIALW credential{};
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = const_cast<LPWSTR>(name.c_str());
    credential.CredentialBlobSize = static_cast<DWORD>(key.size());
    credential.CredentialBlob = key.data();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    const BOOL written = CredWriteW(&credential, 0);
    SecureZeroMemory(key.data(), key.size());
    /** CredWrite 已经收到一次完整修改请求，失败返回没有提供跨服务提交回执，因此所有未成功返回都保守保留提交不确定；调用方只能按原精确版本读回对账，不生成替代密钥或直接重放写入。 */
    return written ? "V1 ok\n" : "V1 mutation-unconfirmed\n";
}
}

/** 请求帧完全读入后另开只监视匿名控制输入的线程，额外数据或 EOF 都直接结束自有 helper；正常完成由进程退出关闭该线程，父宿主仍必须等待真实退出和管道关闭，不能把发出终止请求视为资源已经释放。 */
int wmain(int argc, wchar_t**) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    try {
        require(argc == 1);
        require(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) != 0);
        const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
        require(GetFileType(input) == FILE_TYPE_PIPE && GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) == FILE_TYPE_PIPE);
        std::string frame;
        for (;;) {
            char c = 0;
            DWORD count = 0;
            if (!ReadFile(input, &c, 1, &count, nullptr) || count != 1) ExitProcess(125);
            if (c == '\n') break;
            require(c >= 32 && c <= 126 && frame.size() + 1 < frameLimit);
            frame += c;
        }
        std::vector<std::string> parts;
        size_t start = 0;
        for (size_t i = 0; i <= frame.size(); ++i) {
            if (i == frame.size() || frame[i] == ' ') { require(i > start); parts.push_back(frame.substr(start, i - start)); start = i + 1; }
        }
        require(parts.size() <= 5);
        std::thread([input] { char extra = 0; DWORD count = 0; ReadFile(input, &extra, 1, &count, nullptr); ExitProcess(125); }).detach();
#ifdef VERIQ_VAULT_TEST_GATE
        /** 隔离测试目标只在真实控制监视建立后保持等待以观察宿主超时与父死亡，正式目标不编译此门闩；该分支不调用系统凭据 API，也不把人工等待伪装成系统服务实际发生的延迟或锁定。 */
        output("V1 test-ready\n");
        Sleep(INFINITE);
#else
        const auto response = execute(parts);
        SecureZeroMemory(frame.data(), frame.size());
        for (auto& part : parts) SecureZeroMemory(part.data(), part.size());
        output(response);
#endif
        return 0;
    } catch (...) { return 2; }
}
