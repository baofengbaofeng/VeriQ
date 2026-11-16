/**
 * SQLite 私有会话只持有固定本地数据库用途的祖先链，Node24 SQLite 在该链仍活跃时打开原始数据库并自行执行 WAL/FULL 提交；这里核验普通单链接文件及当前 SID，不把 Windows 目录句柄刷新伪装成持久化
 * 能力，也不操作 SQL 或 Job 停止证明。
 */
#pragma once
#include "windows-files.h"
#include <memory>

namespace veriq {
/** 固定目录能力禁止共享删除以保持从卷根到最终数据库目录的命名绑定，数据库本体只在缺失时创建且不截断已有内容；辅助文件由 SQLite 继承当前用户私有目录 ACL，既有宽权限或重解析对象一律拒绝而不修复。 */
class PrivateSqliteDirectory {
    std::unique_ptr<DirectoryChain> directory;
    std::wstring filename;
public:
    /** 只有两种宿主数据库名与对应固定用途目录能够进入此类，祖先链创建沿用当前 SID 可继承 DACL；普通配置、保险库或业务文件无法通过这个入口获得更大的文件额度、持久声明或任意路径退休能力。 */
    PrivateSqliteDirectory(const std::wstring& input, const std::wstring& name, bool create = true) : filename(name) {
        const FilePath path(input);
        require(!path.parts.empty() && (name == L"veriq-online.sqlite" || name == L"veriq.sqlite"),
            "NATIVE_SQLITE_PURPOSE_INVALID");
        directory = std::make_unique<DirectoryChain>(path, path.parts.size(), create, create ? FILE_ADD_FILE : 0);
        directory->verifyPrivateDirectory();
        PrivateSecurity security;
        {
            bool body = false;
            for (const auto& suffix : {L"", L"-wal", L"-shm", L"-journal"}) {
                try {
                    auto observed = relativeFile(directory->handle(), filename + suffix,
                        READ_CONTROL | FILE_READ_ATTRIBUTES,
                        FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
                    verifyPrivateChild(observed.value, *directory); checked(observed.value);
                    if (suffix[0] == L'\0') body = true;
                    else require(body, "NATIVE_SQLITE_ORPHAN_AUXILIARY");
                    const HANDLE checkedFile = std::exchange(observed.value, INVALID_HANDLE_VALUE);
                    requireWin32(CloseHandle(checkedFile) != 0, "NATIVE_SQLITE_CLOSE_UNCONFIRMED");
                } catch (const NativeFailure& error) { if (error.win32 != ERROR_FILE_NOT_FOUND) throw; }
            }
            if (!create) {
                if (!body) throw NativeFailure("NATIVE_PATH_UNAVAILABLE", ERROR_FILE_NOT_FOUND);
                validate(); return;
            }
        }
        auto file = relativeFile(directory->handle(), filename,
            GENERIC_READ | GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_OPEN_IF, FILE_NON_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE,
            security.attributes.lpSecurityDescriptor);
        verifyPrivateChild(file.value, *directory);
        checked(file.value);
        const HANDLE created = std::exchange(file.value, INVALID_HANDLE_VALUE);
        requireWin32(CloseHandle(created) != 0, "NATIVE_SQLITE_CLOSE_UNCONFIRMED");
        validate();
    }
    /** 同一真实文件的链接数和大小均用已打开句柄读取，拒绝把外部硬链接数据库或超额 WAL 当成本档案状态；此检查不读取数据库正文，也不扩大一般私有配置或凭据信封原来的读取限额。 */
    static void checked(HANDLE file) {
        require(!(plainFile(file) & FILE_ATTRIBUTE_DIRECTORY), "NATIVE_SQLITE_FILE_INVALID");
        BY_HANDLE_FILE_INFORMATION info{};
        requireWin32(GetFileInformationByHandle(file, &info) != 0, "NATIVE_SQLITE_METADATA_FAILED");
        require(info.nNumberOfLinks == 1 && info.nFileSizeHigh == 0 && info.nFileSizeLow <= 512 * 1024 * 1024,
            "NATIVE_SQLITE_FILE_LIMIT");
    }
    /** 每次 SQLite 打开、事务提交及读历史前均重新核验四个精确名字，缺失的辅助文件是合法生命周期但缺失本体不是；原生父链继续保活，未知权限、文件类型、拥有者或关闭错误阻止调用方继续派生。 */
    void validate() const {
        require(directory != nullptr, "NATIVE_SQLITE_SESSION_CLOSED");
        directory->validate();
        directory->verifyPrivateDirectory();
        for (const auto& suffix : {L"", L"-wal", L"-shm", L"-journal"}) {
            try {
                auto file = relativeFile(directory->handle(), filename + suffix, READ_CONTROL | FILE_READ_ATTRIBUTES,
                    FILE_OPEN, FILE_NON_DIRECTORY_FILE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
                verifyPrivateChild(file.value, *directory);
                checked(file.value);
                const HANDLE observed = std::exchange(file.value, INVALID_HANDLE_VALUE);
                requireWin32(CloseHandle(observed) != 0, "NATIVE_SQLITE_CLOSE_UNCONFIRMED");
            } catch (const NativeFailure& error) {
                if (suffix[0] == L'\0' || error.win32 != ERROR_FILE_NOT_FOUND) throw;
            }
        }
    }
    /** 显式关闭逐一释放整条实际祖先链并保留第一个系统关闭错误，先撤销本对象的能力再报错；垃圾回收只兜底释放资源，不能被调用方解释为 SQLite 已提交或原生停止已经得到证明。 */
    void close() {
        auto owned = std::move(directory);
        if (owned) owned->close();
    }
};
}
