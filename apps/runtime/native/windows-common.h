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
inline void require(bool ok, const char* code) { if (!ok) throw std::runtime_error(code); }
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
    require(OpenProcessToken(process, TOKEN_QUERY, &raw) != 0, "NATIVE_TOKEN_UNAVAILABLE");
    Handle token(raw);
    DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    require(size > 0 && size <= 65536, "NATIVE_TOKEN_INVALID");
    std::vector<BYTE> data(size);
    require(GetTokenInformation(token.value, TokenUser, data.data(), size, &size) != 0, "NATIVE_TOKEN_INVALID");
    LPWSTR value = nullptr;
    require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid, &value) != 0, "NATIVE_SID_INVALID");
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
/** 创建对象时就安装当前用户独占且禁止继承的 DACL，避免先创建公共对象再收紧权限的竞态；只有显式传入的子进程标准流允许继承，Job、停止事件和私有持久文件默认都不能被业务后代持有。 */
class PrivateSecurity {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
public:
    SECURITY_ATTRIBUTES attributes{};
    explicit PrivateSecurity(bool inherit = false) {
        const auto sid = currentSid();
        const auto sddl = L"O:" + sid + L"D:P(A;;GA;;;" + sid + L")";
        require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0, "NATIVE_DACL_FAILED");
        attributes = {sizeof(SECURITY_ATTRIBUTES), descriptor, inherit ? TRUE : FALSE};
    }
    ~PrivateSecurity() { if (descriptor) LocalFree(descriptor); }
    PrivateSecurity(const PrivateSecurity&) = delete;
    PrivateSecurity& operator=(const PrivateSecurity&) = delete;
};
/** ACL 检查通过已打开句柄进行，拒绝可重解析目标与非当前用户所有者；只有单一当前用户允许项且 DACL 受保护才算私有，不能把 chmod 在 Windows 上的成功当作访问隔离证据。 */
inline void verifyPrivate(HANDLE handle, SE_OBJECT_TYPE type = SE_FILE_OBJECT) {
    PSID owner = nullptr;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(GetSecurityInfo(handle, type, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor) == ERROR_SUCCESS, "NATIVE_ACL_UNAVAILABLE");
    bool valid = false;
    LPWSTR ownerText = nullptr;
    LPWSTR aceText = nullptr;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    void* rawAce = nullptr;
    if (owner && acl && acl->AceCount == 1 && ConvertSidToStringSidW(owner, &ownerText) &&
        GetSecurityDescriptorControl(descriptor, &control, &revision) && (control & SE_DACL_PROTECTED) &&
        GetAce(acl, 0, &rawAce)) {
        auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
        if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && !(ace->Header.AceFlags & INHERITED_ACE) &&
            ConvertSidToStringSidW(&ace->SidStart, &aceText)) {
            const auto sid = currentSid();
            valid = sid == ownerText && sid == aceText;
        }
    }
    if (ownerText) LocalFree(ownerText);
    if (aceText) LocalFree(aceText);
    if (descriptor) LocalFree(descriptor);
    require(valid, "NATIVE_ACL_NOT_PRIVATE");
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
