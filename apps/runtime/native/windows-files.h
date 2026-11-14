/** 私有文件适配只在已持有的目录句柄下逐组件打开或创建对象，验证后继续使用同一句柄读写；路径中的重解析点不能变成跳转权限，临时文件由创建者持有到原子提交和刷新结束，不向 JavaScript 暴露通用 NT 调用或原始句柄。 */
#pragma once
#include "windows-common.h"
#include <winternl.h>
#include <cstddef>
#include <cstring>

/** 用户态 SDK 的 winternl.h 未声明这个公开系统入口，因此这里只补齐官方固定签名；调用点仅允许已持有文件的相对名称提交，不向 JavaScript 导出信息类别、原始句柄或任意 NT 操作能力。 */
extern "C" NTSYSAPI NTSTATUS NTAPI NtSetInformationFile(HANDLE FileHandle, PIO_STATUS_BLOCK IoStatusBlock,
    PVOID FileInformation, ULONG Length, FILE_INFORMATION_CLASS FileInformationClass);

namespace veriq {
/** FileRenameInformation 使用官方 FILE_RENAME_INFORMATION 的 BOOLEAN 与计数 UTF16 布局，用户态 SDK 没有提供该结构时在内部精确定义；不混用 Win32 FILE_RENAME_INFO 的路径解释或扩展标志。 */
struct NativeFileRenameInformation {
    BOOLEAN ReplaceIfExists;
    HANDLE RootDirectory;
    ULONG FileNameLength;
    WCHAR FileName[1];
};
static_assert(offsetof(NativeFileRenameInformation, RootDirectory) == sizeof(HANDLE));
static_assert(offsetof(NativeFileRenameInformation, FileName) == 2 * sizeof(HANDLE) + sizeof(ULONG));
/** 单个成员名不能包含路径分隔、备用数据流或 Windows 会裁剪的尾随字符，所有层级都由已持有的父目录选择；临时名与正式名经过相同校验，避免相对打开重新引入目录穿越或隐含的设备命名解释。 */
inline void fileComponent(const std::wstring& name) {
    require(!name.empty() && name.size() <= 255 && name != L"." && name != L".." &&
        name.find_first_of(L"\\/:\"<>|?*") == std::wstring::npos && name.back() != L'.' && name.back() != L' ', "NATIVE_PATH_INVALID");
    for (wchar_t character : name) require(character >= 32, "NATIVE_PATH_INVALID");
}
/** 这里只把本机 DOS 路径规范成卷根与独立成员，目录解析随后逐级通过真实句柄完成；不接受 UNC、设备命名空间或映射网络盘，避免把远程文件系统的身份与持久化承诺冒充本机配置存储。 */
struct FilePath {
    std::wstring root;
    std::vector<std::wstring> parts;
    explicit FilePath(const std::wstring& input) {
        require(!input.empty() && input.size() < 32768, "NATIVE_PATH_INVALID");
        const DWORD size = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
        requireWin32(size > 0, "NATIVE_PATH_INVALID");
        require(size <= 32768, "NATIVE_PATH_INVALID");
        std::wstring path(size, L'\0');
        const DWORD written = GetFullPathNameW(input.c_str(), size, path.data(), nullptr);
        requireWin32(written > 0, "NATIVE_PATH_INVALID");
        require(written < size, "NATIVE_PATH_INVALID");
        path.resize(written);
        for (auto& character : path) if (character == L'/') character = L'\\';
        require(path.size() >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z')) &&
            path[1] == L':' && path[2] == L'\\', "NATIVE_LOCAL_PATH_REQUIRED");
        root = path.substr(0, 3);
        require(GetDriveTypeW(root.c_str()) != DRIVE_REMOTE, "NATIVE_LOCAL_PATH_REQUIRED");
        size_t offset = 3;
        while (offset < path.size()) {
            const auto end = path.find(L'\\', offset);
            auto part = path.substr(offset, end == std::wstring::npos ? end : end - offset);
            fileComponent(part);
            parts.push_back(std::move(part));
            if (end == std::wstring::npos) break;
            offset = end + 1;
        }
    }
};
/** 文件属性通过当前持有对象读取，目录与普通文件均拒绝重解析标签；这项检查不会再以字符串路径重新打开对象，因此之后的有界读取使用的仍是刚才验证的同一内核文件实体。 */
inline DWORD plainFile(HANDLE file) {
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    requireWin32(GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) != 0, "NATIVE_PATH_UNAVAILABLE");
    require(!(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), "NATIVE_REPARSE_REJECTED");
    require(GetFileType(file) == FILE_TYPE_DISK, "NATIVE_FILE_TYPE_INVALID");
    return attributes.FileAttributes;
}
/** NtCreateFile 仅用于已持有父句柄下的一个成员，禁止任何重解析并只接受同步成功状态；明确的不存在错误保留 Win32 映射供配置首次创建判断，其余状态不能当空文件或权限成功处理。 */
inline Handle relativeFile(HANDLE parent, const std::wstring& name, ACCESS_MASK access, ULONG disposition,
    ULONG options, ULONG sharing, PSECURITY_DESCRIPTOR security = nullptr) {
    fileComponent(name);
    UNICODE_STRING objectName{};
    objectName.Buffer = const_cast<PWSTR>(name.data());
    objectName.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
    objectName.MaximumLength = objectName.Length;
    OBJECT_ATTRIBUTES attributes{};
    attributes.Length = sizeof(attributes);
    attributes.RootDirectory = parent;
    attributes.ObjectName = &objectName;
    /** OBJ_DONT_REPARSE 与 STATUS_REPARSE_POINT_ENCOUNTERED 是公开 NT 对象属性合同中的固定值，部分用户态 SDK 未定义对应宏；这里只保留这两个语义常量，不接受调用者指定任意对象属性或状态覆盖。 */
    constexpr ULONG noReparse = 0x00001000;
    constexpr NTSTATUS encounteredReparse = static_cast<NTSTATUS>(0xC000050BUL);
    attributes.Attributes = OBJ_CASE_INSENSITIVE | noReparse;
    attributes.SecurityDescriptor = security;
    IO_STATUS_BLOCK statusBlock{};
    HANDLE raw = INVALID_HANDLE_VALUE;
    const NTSTATUS status = NtCreateFile(&raw, access | SYNCHRONIZE, &attributes, &statusBlock, nullptr,
        FILE_ATTRIBUTE_NORMAL, sharing, disposition, options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT, nullptr, 0);
    Handle result(raw);
    if (status == encounteredReparse) throw NativeFailure("NATIVE_REPARSE_REJECTED");
    if (status != 0) throw NativeFailure("NATIVE_PATH_UNAVAILABLE", RtlNtStatusToDosError(status));
    require(result.valid() && statusBlock.Status == 0, "NATIVE_PATH_UNAVAILABLE");
    plainFile(result.value);
    return result;
}
/** 卷根只负责启动本机对象遍历，之后每一级都是相对上一真实句柄打开；目录句柄保留到操作结束且不共享删除，重解析属性再次验证，稳定父对象而不依赖反复解释完整路径或仅禁止一次 rename。 */
class DirectoryChain {
    std::vector<Handle> directories;
public:
    /** 创建模式只给缺失目录安装当前 SID 可继承的保护 DACL，已有目录权限绝不自动修复；遍历中的公共系统祖先可以存在，但调用方选定的最终配置目录仍必须独立通过严格私有 ACL 校验。 */
    DirectoryChain(const FilePath& path, size_t count, bool create = false, ACCESS_MASK finalAccess = 0) {
        Handle volume(CreateFileW(path.root.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE | (count == 0 ? finalAccess : 0),
            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        requireWin32(volume.valid(), "NATIVE_PATH_UNAVAILABLE");
        require(plainFile(volume.value) & FILE_ATTRIBUTE_DIRECTORY, "NATIVE_DIRECTORY_REQUIRED");
        directories.push_back(std::move(volume));
        for (size_t index = 0; index < count; ++index) {
            PrivateSecurity security(false, true);
            auto next = relativeFile(handle(), path.parts[index], READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | (index + 1 == count ? finalAccess : 0),
                create ? FILE_OPEN_IF : FILE_OPEN, FILE_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                create ? security.attributes.lpSecurityDescriptor : nullptr);
            require(plainFile(next.value) & FILE_ATTRIBUTE_DIRECTORY, "NATIVE_DIRECTORY_REQUIRED");
            directories.push_back(std::move(next));
        }
        validate();
    }
    /** 返回值只供本编译单元内部的相对文件操作使用，链对象保留实际句柄所有权直到操作完成；JavaScript 层只能选择有限文件操作，不能取得该句柄或把它用于其它任意系统调用。 */
    HANDLE handle() const { return directories.back().value; }
    /** 重查所有已持有祖先的重解析属性可以发现持续的目录变更，但安全性同时来自相对父对象而非检查后再走路径；即使名称在外部被尝试改动，读取与提交也不会重新解析到另一个目录树。 */
    void validate() const {
        for (const auto& directory : directories)
            require(plainFile(directory.value) & FILE_ATTRIBUTE_DIRECTORY, "NATIVE_DIRECTORY_REQUIRED");
    }
};
/** 私有路径入口保留旧有检查接口，同时把目录创建和最终对象获取都接入稳定祖先链；已有公共目录或文件只会失败，创建新目录时的继承标志不会被用于给历史不可信对象悄悄收紧权限。 */
inline void ensurePrivatePath(const std::wstring& input, bool create) {
    const FilePath path(input);
    if (create || path.parts.empty()) {
        DirectoryChain directory(path, path.parts.size(), create);
        verifyPrivate(directory.handle());
    } else {
        DirectoryChain parent(path, path.parts.size() - 1);
        auto file = relativeFile(parent.handle(), path.parts.back(), READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_OPEN, 0, FILE_SHARE_READ | FILE_SHARE_WRITE);
        verifyPrivate(file.value);
        parent.validate();
    }
}
/** 配置读取在同一已验证句柄上完成大小检查与全部字节读取，不经过 Node 路径重开；读句柄拒绝并发原位写入但允许已验证写入者原子替换名称，因此本次读取仍获得旧文件的一份完整内容。 */
inline std::vector<char> readPrivateBytes(const std::wstring& input, size_t limit) {
    const FilePath path(input);
    require(!path.parts.empty() && limit <= 1024 * 1024, "NATIVE_FILE_LIMIT");
    DirectoryChain parent(path, path.parts.size() - 1);
    verifyPrivate(parent.handle());
    auto file = relativeFile(parent.handle(), path.parts.back(), READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_READ_DATA,
        FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_DELETE);
    verifyPrivate(file.value);
    LARGE_INTEGER size{};
    requireWin32(GetFileSizeEx(file.value, &size) != 0, "NATIVE_PRIVATE_READ_FAILED");
    require(size.QuadPart >= 0 && static_cast<ULONGLONG>(size.QuadPart) <= limit, "NATIVE_FILE_LIMIT");
    std::vector<char> bytes(static_cast<size_t>(size.QuadPart));
    size_t offset = 0;
    while (offset < bytes.size()) {
        DWORD count = 0;
        requireWin32(ReadFile(file.value, bytes.data() + offset, static_cast<DWORD>(bytes.size() - offset), &count, nullptr) != 0, "NATIVE_PRIVATE_READ_FAILED");
        require(count > 0, "NATIVE_FILE_CHANGED");
        offset += count;
    }
    parent.validate();
    return bytes;
}
/** 新私有文件由 CREATE 独占取得并在任何字节写入前核验 ACL，所有失败都仍持有自有文件句柄；该函数只保留既有不覆盖写入语义，配置替换另走明确的临时文件和原子提交路径。 */
inline void createPrivateFile(const std::wstring& input, const std::string& bytes) {
    const FilePath path(input);
    require(!path.parts.empty() && bytes.size() <= 1024 * 1024, "NATIVE_FILE_LIMIT");
    DirectoryChain parent(path, path.parts.size() - 1, false, FILE_ADD_FILE);
    verifyPrivate(parent.handle());
    PrivateSecurity security;
    auto file = relativeFile(parent.handle(), path.parts.back(), GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_CREATE, FILE_NON_DIRECTORY_FILE | FILE_WRITE_THROUGH, 0, security.attributes.lpSecurityDescriptor);
    verifyPrivate(file.value);
    parent.validate();
    writeAll(file.value, bytes);
    requireWin32(FlushFileBuffers(file.value) != 0, "NATIVE_PRIVATE_FLUSH_FAILED");
}
/** 原子替换始终使用同一临时文件句柄与已持有的目标目录，正式名称只是一段经校验的 basename；提交前异常删除自有临时对象，提交后的刷新失败明确保留不确定性，不回滚或重跑上层更新函数。 */
inline void replacePrivateFile(const std::wstring& directory, const std::wstring& name,
    const std::wstring& temporary, const std::string& bytes) {
    fileComponent(name); fileComponent(temporary);
    require(temporary.size() == 41 && temporary.front() == L'.' && temporary.substr(37) == L".tmp" &&
        temporary.substr(1, 36).find_first_not_of(L"0123456789abcdef-") == std::wstring::npos && name != temporary,
        "NATIVE_TEMPORARY_NAME_INVALID");
    require(bytes.size() <= 1024 * 1024, "NATIVE_FILE_LIMIT");
    const FilePath path(directory);
    DirectoryChain parent(path, path.parts.size(), false, FILE_ADD_FILE);
    verifyPrivate(parent.handle());
    try {
        auto previous = relativeFile(parent.handle(), name, READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
        verifyPrivate(previous.value);
    } catch (const NativeFailure& error) {
        if (error.win32 != ERROR_FILE_NOT_FOUND) throw;
    }
    PrivateSecurity security;
    auto file = relativeFile(parent.handle(), temporary, GENERIC_WRITE | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
        FILE_CREATE, FILE_NON_DIRECTORY_FILE | FILE_WRITE_THROUGH, 0, security.attributes.lpSecurityDescriptor);
    bool committed = false;
    try {
        verifyPrivate(file.value);
        parent.validate();
        writeAll(file.value, bytes);
        requireWin32(FlushFileBuffers(file.value) != 0, "NATIVE_PRIVATE_FLUSH_FAILED");
        const size_t size = offsetof(NativeFileRenameInformation, FileName) + name.size() * sizeof(wchar_t);
        std::vector<BYTE> storage(size);
        auto* rename = reinterpret_cast<NativeFileRenameInformation*>(storage.data());
        rename->ReplaceIfExists = TRUE;
        rename->RootDirectory = parent.handle();
        rename->FileNameLength = static_cast<DWORD>(name.size() * sizeof(wchar_t));
        std::memcpy(rename->FileName, name.data(), rename->FileNameLength);
        parent.validate();
        /** 同步文件句柄按官方 FileRenameInformation 类别提交计数名称，实际 NTSTATUS 和 IO_STATUS_BLOCK 都必须成功；异常的非失败状态不能假称未提交或删除临时对象，避免把未知结果当成可以重放的回滚。 */
        IO_STATUS_BLOCK statusBlock{};
        statusBlock.Status = static_cast<NTSTATUS>(0xC0000001UL);
        const NTSTATUS status = NtSetInformationFile(file.value, &statusBlock, rename,
            static_cast<ULONG>(size), static_cast<FILE_INFORMATION_CLASS>(10));
        if (status != 0) {
            if (status >= 0) committed = true;
            throw NativeFailure(committed ? "NATIVE_PRIVATE_COMMIT_UNCONFIRMED" : "NATIVE_PRIVATE_COMMIT_FAILED",
                RtlNtStatusToDosError(status));
        }
        committed = true;
        if (statusBlock.Status != 0)
            throw NativeFailure("NATIVE_PRIVATE_COMMIT_UNCONFIRMED", RtlNtStatusToDosError(statusBlock.Status));
        requireWin32(FlushFileBuffers(file.value) != 0, "NATIVE_PRIVATE_COMMIT_UNCONFIRMED");
    } catch (...) {
        if (!committed) {
            FILE_DISPOSITION_INFO remove{TRUE};
            if (!SetFileInformationByHandle(file.value, FileDispositionInfo, &remove, sizeof(remove)))
                throw NativeFailure("NATIVE_PRIVATE_CLEANUP_UNCONFIRMED", GetLastError());
        }
        throw;
    }
}
}
