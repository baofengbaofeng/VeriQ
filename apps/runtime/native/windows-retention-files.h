/**
 * 本机保留期退休只接受受信任清单列出的有限普通文件，正文按固定缓冲区交给系统 SHA256 后才删除同一实际句柄；只读缓存先通
 * 过真实目录句柄隔离到专用退休名字，之后才清除只读位，不扩大凭据或配置读取容量，也不向 JavaScript
 * 返回正文或句柄。
 */
#pragma once
#include "windows-files.h"
#include <wincrypt.h>
#include <map>
#include <set>
#include <algorithm>
#include <memory>

namespace veriq {
/**
 * 每个清单条目都由宿主已验签资源或已上传报告给出准确长度和摘要，原生再次核对普通单链接文件并流式读取；同句柄拒绝写共享
 * ，实际删除仍由这个已核验实体完成，不在检查后按完整路径重开。
 */
struct RetentionFile { std::wstring path; unsigned long long size; std::string sha256; };
inline std::string retentionDigest(HANDLE file, unsigned long long expected) {
    HCRYPTPROV provider = 0;
    HCRYPTHASH hash = 0;
    requireWin32(CryptAcquireContextW(&provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) != 0,
        "NATIVE_RETENTION_HASH_FAILED");
    try {
        requireWin32(CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash) != 0, "NATIVE_RETENTION_HASH_FAILED");
        unsigned long long total = 0;
        BYTE bytes[65536];
        for (;;) {
            DWORD count = 0;
            requireWin32(ReadFile(file, bytes, sizeof(bytes), &count, nullptr) != 0, "NATIVE_RETENTION_READ_FAILED");
            if (!count) break;
            total += count;
            require(total <= expected && CryptHashData(hash, bytes, count, 0) != 0, "NATIVE_RETENTION_HASH_FAILED");
        }
        require(total == expected, "NATIVE_RETENTION_SIZE_CHANGED");
        BYTE digest[32]; DWORD count = sizeof(digest);
        requireWin32(CryptGetHashParam(hash, HP_HASHVAL, digest, &count, 0) != 0, "NATIVE_RETENTION_HASH_FAILED");
        require(count == 32, "NATIVE_RETENTION_HASH_FAILED");
        const char* hex = "0123456789abcdef";
        std::string value;
        for (const auto byte : digest) { value += hex[byte >> 4]; value += hex[byte & 15]; }
        const BOOL hashClosed = CryptDestroyHash(hash); hash = 0;
        const BOOL providerClosed = CryptReleaseContext(provider, 0); provider = 0;
        require(hashClosed && providerClosed, "NATIVE_RETENTION_HASH_CLOSE_FAILED");
        return value;
    } catch (...) {
        if (hash) CryptDestroyHash(hash);
        if (provider) CryptReleaseContext(provider, 0);
        throw;
    }
}
/**
 * 系统文件标识与长度在流式摘要前后都必须稳定，硬链接、非当前用户、重解析或目录对象全部拒绝；只读属性只允许已隔离缓存清
 * 除，报告 evidence 原始目录不会因此被赋予改变权限或删除未知文件的能力。
 */
inline void retireRetentionFile(const DirectoryChain& parent, const std::wstring& name, const RetentionFile& expected,
    bool isolated) {
    auto file = relativeFile(parent.handle(), name, GENERIC_READ | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES | (
        isolated ? FILE_WRITE_ATTRIBUTES : 0),
        FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_SHARE_READ);
    verifyPrivateChild(file.value, parent);
    BY_HANDLE_FILE_INFORMATION before{};
    requireWin32(GetFileInformationByHandle(file.value, &before) != 0, "NATIVE_RETENTION_METADATA_FAILED");
    const unsigned long long size = (static_cast<unsigned long long>(before.nFileSizeHigh) << 32) | before.nFileSizeLow;
    require(before.nNumberOfLinks == 1 && size == expected.size && size <= 32 * 1024 * 1024 &&
        retentionDigest(file.value, size) == expected.sha256, "NATIVE_RETENTION_FILE_CHANGED");
    BY_HANDLE_FILE_INFORMATION after{};
    requireWin32(GetFileInformationByHandle(file.value, &after) != 0, "NATIVE_RETENTION_METADATA_FAILED");
    require(before.dwVolumeSerialNumber == after.dwVolumeSerialNumber && before.nFileIndexHigh == after.nFileIndexHigh
        &&
        before.nFileIndexLow == after.nFileIndexLow && before.nFileSizeHigh == after.nFileSizeHigh
            && before.nFileSizeLow == after.nFileSizeLow &&
        before.ftLastWriteTime.dwHighDateTime == after.ftLastWriteTime.dwHighDateTime
            && before.ftLastWriteTime.dwLowDateTime == after.ftLastWriteTime.dwLowDateTime,
        "NATIVE_RETENTION_FILE_CHANGED");
    if (isolated && (after.dwFileAttributes & FILE_ATTRIBUTE_READONLY)) {
        FILE_BASIC_INFO attributes{};
        requireWin32(GetFileInformationByHandleEx(file.value, FileBasicInfo, &attributes, sizeof(attributes)) != 0,
            "NATIVE_RETENTION_METADATA_FAILED");
        attributes.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;
        requireWin32(SetFileInformationByHandle(file.value, FileBasicInfo, &attributes, sizeof(attributes)) != 0,
            "NATIVE_RETENTION_ATTRIBUTE_FAILED");
    }
    parent.validate();
    FILE_DISPOSITION_INFO remove{TRUE};
    requireWin32(SetFileInformationByHandle(file.value, FileDispositionInfo, &remove, sizeof(remove)) != 0,
        "NATIVE_RETENTION_REMOVE_FAILED");
    const HANDLE removed = std::exchange(file.value, INVALID_HANDLE_VALUE);
    requireWin32(CloseHandle(removed) != 0, "NATIVE_RETENTION_REMOVE_UNCONFIRMED");
}
/**
 * 原始证据入口的目录后缀固定为 offline/work/Attempt/evidence，文件名字只能是一段报告清单成员；它没有递归或权限修复行为
 * ，真实缺失由外层明确映射幂等完成，其他读取、摘要或关闭错误保持失败。
 */
inline void retirePrivateEvidence(const std::wstring& input, const RetentionFile& expected) {
    const FilePath path(input);
    const auto size = path.parts.size();
    require(size >= 5 && path.parts[size - 5] == L"offline" && path.parts[size - 4] == L"work" &&
        (path.parts[size - 2] == L"evidence" || (path.parts[size - 2] == L"metadata" && path.parts.back(
            ) == L"report-display.json")), "NATIVE_RETENTION_PURPOSE_INVALID");
    DirectoryChain parent(path, size - 1);
    parent.verifyPrivateDirectory();
    retireRetentionFile(parent, path.parts.back(), expected, false);
    parent.close();
}
/**
 * 清单路径只能在隔离缓存根内逐级打开，每个中间目录保持祖先链且不共享删除；先枚举全部有限对象确认没有清单外文件，再删除
 * 允许成员，因此未知子目录、链接或额外内容会保留整个退休现场而不是被递归 rm。
 */
inline void retirePrivateInventory(const std::wstring& input, const std::wstring& original,
    const std::wstring& retiring,
    const std::vector<RetentionFile>& files) {
    fileComponent(original); fileComponent(retiring);
    require(original.size() == 36 && original.find_first_not_of(L"0123456789abcdef-") == std::wstring::npos &&
        retiring.size() == 52 && retiring.substr(0, 16) == L".veriq-retiring-" && retiring.substr(16) == original,
        "NATIVE_RETENTION_NAME_INVALID");
    const FilePath root(input);
    require(!root.parts.empty() && root.parts.back() == L"bundles" && files.size() <= 4098,
        "NATIVE_RETENTION_PURPOSE_INVALID");
    DirectoryChain parent(root, root.parts.size(), false, FILE_ADD_SUBDIRECTORY);
    parent.verifyPrivateDirectory();
    bool hasOriginal = false, hasRetiring = false;
    const auto exists = [&](const std::wstring& name) {
        try {
            auto file = relativeFile(parent.handle(), name, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_OPEN,
                FILE_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
            verifyPrivateChild(file.value, parent); return true;
        } catch (const NativeFailure& error) { if (error.win32 == ERROR_FILE_NOT_FOUND) return false; throw; }
    };
    hasOriginal = exists(original); hasRetiring = exists(retiring);
    require(!(hasOriginal && hasRetiring), "NATIVE_RETENTION_NAMESPACE_CONFLICT");
    if (!hasOriginal && !hasRetiring) { parent.close(); return; }
    std::unique_ptr<Handle> heldTree;
    if (hasOriginal) {
        auto tree = relativeFile(parent.handle(), original, DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_OPEN, FILE_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE);
        verifyPrivateChild(tree.value, parent);
        const size_t size = offsetof(NativeFileRenameInformation, FileName) + retiring.size() * sizeof(wchar_t);
        std::vector<BYTE> storage(size);
        auto* rename = reinterpret_cast<NativeFileRenameInformation*>(storage.data());
        rename->ReplaceIfExists = FALSE; rename->RootDirectory = parent.handle();
        rename->FileNameLength = static_cast<DWORD>(retiring.size() * sizeof(wchar_t));
        std::memcpy(rename->FileName, retiring.data(), rename->FileNameLength);
        IO_STATUS_BLOCK statusBlock{};
        const auto status = NtSetInformationFile(tree.value, &statusBlock, rename, static_cast<ULONG>(size),
            static_cast<FILE_INFORMATION_CLASS>(10));
        require(status == 0 && statusBlock.Status == 0, "NATIVE_RETENTION_ISOLATION_UNCONFIRMED");
        heldTree = std::make_unique<Handle>(std::move(tree));
    } else {
        heldTree = std::make_unique<Handle>(relativeFile(parent.handle(), retiring,
            DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_OPEN, FILE_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE));
        verifyPrivateChild(heldTree->value, parent);
    }
    const std::wstring base = input + L"\\" + retiring;
    std::map<std::wstring, RetentionFile> inventory;
    std::set<std::wstring> directories;
    unsigned long long bytes = 0;
    for (const auto& file : files) {
        require(file.size <= 32 * 1024 * 1024 && file.sha256.size() == 64 && file.sha256.find_first_not_of(
            "0123456789abcdef") == std::string::npos,
            "NATIVE_RETENTION_INVENTORY_INVALID");
        std::wstring path = file.path;
        require(!path.empty() && path.size() <= 240 && path.find(L'\\') == std::wstring::npos,
            "NATIVE_RETENTION_INVENTORY_INVALID");
        size_t start = 0; unsigned depth = 0;
        for (;;) {
            const auto end = path.find(L'/', start);
            fileComponent(path.substr(start, end == std::wstring::npos ? end : end - start));
            require(++depth <= 16, "NATIVE_RETENTION_INVENTORY_INVALID");
            if (end == std::wstring::npos) break;
            directories.insert(path.substr(0, end)); start = end + 1;
        }
        require(inventory.emplace(path, file).second, "NATIVE_RETENTION_INVENTORY_INVALID");
        bytes += file.size; require(bytes <= 128 * 1024 * 1024, "NATIVE_RETENTION_INVENTORY_LIMIT");
    }
    size_t seen = 0;
    const auto scan = [&](const auto& walk, const std::wstring& relative) -> void {
        const auto full = relative.empty() ? base : base + L"\\" + relative;
        const FilePath path(full);
        DirectoryChain directory(path, path.parts.size(), false, FILE_LIST_DIRECTORY,
            true); directory.verifyPrivateDirectory();
        std::vector<BYTE> buffer(65536);
        bool restart = true;
        for (;;) {
            const BOOL ok = GetFileInformationByHandleEx(directory.handle(),
                restart ? FileIdBothDirectoryRestartInfo : FileIdBothDirectoryInfo, buffer.data(), static_cast<DWORD>(
                    buffer.size()));
            restart = false;
            if (!ok) { if (GetLastError() == ERROR_NO_MORE_FILES) break; throw NativeFailure(
                "NATIVE_RETENTION_ENUMERATION_FAILED", GetLastError()); }
            auto* entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(buffer.data());
            for (;;) {
                const std::wstring name(entry->FileName, entry->FileNameLength / sizeof(wchar_t));
                if (name != L"." && name != L"..") {
                    require(++seen <= 8192 && !(entry->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT),
                        "NATIVE_RETENTION_UNKNOWN_MEMBER");
                    const auto child = relative.empty() ? name : relative + L"/" + name;
                    if (entry->FileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
                        require(directories.count(child) == 1, "NATIVE_RETENTION_UNKNOWN_MEMBER"); walk(walk, child);
                    } else require(inventory.count(child) == 1, "NATIVE_RETENTION_UNKNOWN_MEMBER");
                }
                if (!entry->NextEntryOffset) break;
                entry = reinterpret_cast<FILE_ID_BOTH_DIR_INFO*>(reinterpret_cast<BYTE*>(
                    entry) + entry->NextEntryOffset);
            }
        }
        directory.close();
    };
    scan(scan, L"");
    for (const auto& [relative, expected] : inventory) {
        std::wstring full = base + L"\\" + relative;
        std::replace(full.begin(), full.end(), L'/', L'\\');
        try {
            const FilePath path(full); DirectoryChain directory(path, path.parts.size() - 1, false, 0,
                true); directory.verifyPrivateDirectory();
            retireRetentionFile(directory, path.parts.back(), expected, true);
            directory.close();
        } catch (const NativeFailure& error) { if (error.win32 != ERROR_FILE_NOT_FOUND
            && error.win32 != ERROR_PATH_NOT_FOUND) throw; }
    }
    std::vector<std::wstring> ordered(directories.begin(), directories.end());
    std::sort(ordered.begin(), ordered.end(), [](const auto& a, const auto& b) { return a.size() > b.size(); });
    for (auto relative : ordered) {
        std::wstring full = relative.empty() ? base : base + L"\\" + relative;
        std::replace(full.begin(), full.end(), L'/', L'\\');
        try {
            const FilePath path(full); DirectoryChain directory(path, path.parts.size() - 1, false, 0,
                true); directory.verifyPrivateDirectory();
            auto tree = relativeFile(directory.handle(), path.parts.back(),
                DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
                FILE_OPEN, FILE_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
            verifyPrivateChild(tree.value, directory);
            FILE_DISPOSITION_INFO remove{TRUE};
            requireWin32(SetFileInformationByHandle(tree.value, FileDispositionInfo, &remove, sizeof(remove)) != 0,
                "NATIVE_RETENTION_REMOVE_FAILED");
            const HANDLE removed = std::exchange(tree.value, INVALID_HANDLE_VALUE);
            requireWin32(CloseHandle(removed) != 0, "NATIVE_RETENTION_REMOVE_UNCONFIRMED");
            directory.close();
        } catch (const NativeFailure& error) { if (error.win32 != ERROR_FILE_NOT_FOUND
            && error.win32 != ERROR_PATH_NOT_FOUND) throw; }
    }
    FILE_DISPOSITION_INFO removeRoot{TRUE};
    requireWin32(SetFileInformationByHandle(heldTree->value, FileDispositionInfo, &removeRoot, sizeof(removeRoot)) != 0,
        "NATIVE_RETENTION_REMOVE_FAILED");
    const HANDLE removedRoot = std::exchange(heldTree->value, INVALID_HANDLE_VALUE);
    requireWin32(CloseHandle(removedRoot) != 0, "NATIVE_RETENTION_REMOVE_UNCONFIRMED");
    parent.close();
}
}
