/** Windows 原生边界统一使用当前用户 SID、受保护 DACL 与精确 FILETIME 身份；句柄通过唯一所有者释放，任何权限检查失败都会抛出稳定错误，不能退回公共管道或仅凭 PID 操作。 */
#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <string>
#include <vector>
#include <stdexcept>
#include <utility>

namespace veriq {
/** 原生失败携带固定源码错误码及调用当时的 Win32 状态，逻辑条件失败的系统码固定为零；附加位仅表示 ACL 检查结果，不保存路径、SID 或业务数据，使异步管道诊断不会因异常展开丢失真正失败原因。 */
class NativeFailure : public std::runtime_error {
public:
    DWORD win32;
    DWORD checks;
    NativeFailure(const char* code, DWORD system = 0, DWORD evidence = 0) : std::runtime_error(code), win32(system), checks(evidence) {}
};
/** 每个内核句柄在本层只具有一个释放者，移动操作清空原值，异常离开作用域时仍会关闭资源；无效句柄与空句柄统一拒绝使用，禁止把裸 HANDLE 数值传给 JavaScript 或当作 Node 文件描述符。 */
class Handle {
public:
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE handle = INVALID_HANDLE_VALUE) : value(handle) {}
    ~Handle() { if (valid()) CloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
    bool valid() const { return value != INVALID_HANDLE_VALUE && value != nullptr; }
};
inline void require(bool ok, const char* code) { if (!ok) throw NativeFailure(code); }
inline void requireWin32(bool ok, const char* code) { if (!ok) throw NativeFailure(code, GetLastError()); }
inline std::wstring wide(const std::string& text) {
    if (text.empty()) return {};
    int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    require(size > 0 && text.find('\0') == std::string::npos, "NATIVE_UTF8_INVALID");
    std::wstring result(size, L'\0');
    require(MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), size) == size, "NATIVE_UTF8_INVALID");
    return result;
}
inline std::string utf8(const std::wstring& text) {
    if (text.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    require(size > 0, "NATIVE_UTF16_INVALID");
    std::string result(size, '\0');
    require(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), result.data(), size, nullptr, nullptr) == size, "NATIVE_UTF16_INVALID");
    return result;
}
inline std::wstring processSid(HANDLE process) {
    HANDLE raw = nullptr;
    requireWin32(OpenProcessToken(process, TOKEN_QUERY, &raw) != 0, "NATIVE_TOKEN_UNAVAILABLE");
    Handle token(raw);
    DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    require(size > 0 && size <= 65536, "NATIVE_TOKEN_INVALID");
    std::vector<BYTE> data(size);
    requireWin32(GetTokenInformation(token.value, TokenUser, data.data(), size, &size) != 0, "NATIVE_TOKEN_INVALID");
    LPWSTR value = nullptr;
    requireWin32(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &value) != 0, "NATIVE_SID_INVALID");
    std::wstring sid(value);
    LocalFree(value);
    return sid;
}
inline std::wstring currentSid() { return processSid(GetCurrentProcess()); }
inline std::string creationTime(HANDLE process) {
    FILETIME creation{}, exit{}, kernel{}, user{};
    require(GetProcessTimes(process, &creation, &exit, &kernel, &user) != 0, "NATIVE_IDENTITY_UNAVAILABLE");
    ULARGE_INTEGER exact{};
    exact.LowPart = creation.dwLowDateTime;
    exact.HighPart = creation.dwHighDateTime;
    return std::to_string(exact.QuadPart);
}
/** 停止事件名同时绑定随机 nonce、守护与工作进程的 PID 和完整 FILETIME，双方必须用同一拥有关系生成名称；创建时间始终保留十进制字符串，不经过浮点转换，也不兼容仅凭 nonce 打开其他任务事件的旧名称。 */
inline std::wstring stopEventName(const std::wstring& nonce, DWORD guardianPid, const std::string& guardianTime,
    DWORD workerPid, const std::string& workerTime) {
    return L"Local\\VeriQ-stop-" + nonce + L"-" + std::to_wstring(guardianPid) + L"-" + wide(guardianTime) +
        L"-" + std::to_wstring(workerPid) + L"-" + wide(workerTime);
}
/** 创建对象时就安装当前用户独占的保护 DACL，目录可显式让当前 SID 权限继承到库创建的子对象；句柄默认不继承，只有显式子进程标准流允许继承，避免先创建公共文件再事后收紧的暴露窗口。 */
class PrivateSecurity {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
public:
    SECURITY_ATTRIBUTES attributes{};
    explicit PrivateSecurity(bool inherit = false, bool children = false) {
        const auto sid = currentSid();
        const auto sddl = L"O:" + sid + (children ? L"D:P(A;OICI;GA;;;" : L"D:P(A;;GA;;;") + sid + L")";
        require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0, "NATIVE_DACL_FAILED");
        attributes = {sizeof(SECURITY_ATTRIBUTES), descriptor, inherit ? TRUE : FALSE};
    }
    ~PrivateSecurity() { if (descriptor) LocalFree(descriptor); }
    PrivateSecurity(const PrivateSecurity&) = delete;
    PrivateSecurity& operator=(const PrivateSecurity&) = delete;
};
/** ACL 检查通过已打开句柄拒绝非当前用户所有者与额外允许项，默认仍要求保护且非继承的单一当前 SID；文件适配器仅在已持有私有父链时允许继承项，管道与内核对象不使用此例外。 */
inline void verifyPrivate(HANDLE handle, SE_OBJECT_TYPE type = SE_FILE_OBJECT, bool privateParent = false) {
    require(!privateParent || type == SE_FILE_OBJECT, "NATIVE_ACL_NOT_PRIVATE");
    PSID owner = nullptr;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    const DWORD securityError = GetSecurityInfo(handle, type, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor);
    if (securityError != ERROR_SUCCESS) throw NativeFailure("NATIVE_ACL_UNAVAILABLE", securityError);
    bool valid = false;
    LPWSTR ownerText = nullptr;
    LPWSTR aceText = nullptr;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    void* rawAce = nullptr;
    DWORD checks = owner ? 1 : 0;
    if (acl) checks |= 2;
    if (acl && acl->AceCount == 1) checks |= 4;
    if (owner && acl && acl->AceCount == 1 && ConvertSidToStringSidW(owner, &ownerText) &&
        GetSecurityDescriptorControl(descriptor, &control, &revision) && ((control & SE_DACL_PROTECTED) || privateParent) &&
        GetAce(acl, 0, &rawAce)) {
        checks |= 8;
        auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE) checks |= 16;
        if (!(ace->Header.AceFlags & INHERITED_ACE)) checks |= 32;
        if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && (!(ace->Header.AceFlags & INHERITED_ACE) || privateParent) &&
            ((control & SE_DACL_PROTECTED) || (ace->Header.AceFlags & INHERITED_ACE)) &&
            ConvertSidToStringSidW(&ace->SidStart, &aceText)) {
            const auto sid = currentSid();
            if (sid == ownerText) checks |= 64;
            if (sid == aceText) checks |= 128;
            valid = sid == ownerText && sid == aceText;
        }
    }
    if (control & SE_DACL_PROTECTED) checks |= 256;
    if (ownerText) LocalFree(ownerText);
    if (aceText) LocalFree(aceText);
    if (descriptor) LocalFree(descriptor);
    if (!valid) throw NativeFailure("NATIVE_ACL_NOT_PRIVATE", 0, checks);
}
inline void writeAll(HANDLE handle, const std::string& bytes) {
    size_t offset = 0;
    while (offset < bytes.size()) {
        DWORD written = 0;
        require(WriteFile(handle, bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &written, nullptr) && written > 0, "NATIVE_WRITE_FAILED");
        offset += written;
    }
}
inline std::wstring quote(const std::wstring& input) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t c : input) {
        if (c == L'\\') { ++slashes; continue; }
        result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
        slashes = 0;
        result += c;
    }
    result.append(slashes * 2, L'\\');
    return result + L"\"";
}
}
