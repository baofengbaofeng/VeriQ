/** 保留期专用原生操作只处理已上传报告的精确证据和受信任缓存清单，流式摘要核验后才退休同一 inode；只读包必须先原子移动到持久退休命名空间，随后才改变其目录权限，已有配置与凭据的一般两兆读取额度保持不变。 */
#pragma once
#include "private-files.h"
#include <CommonCrypto/CommonDigest.h>
#include <map>
#include <set>
#include <algorithm>

namespace veriq::VERIQ_DARWIN_NAMESPACE {
/** 清单条目只携带有限相对路径、长度与系统 SHA256 摘要，正文永远不返回 JavaScript；每次删除都在原始普通单链接 inode 上完成身份、ACL、大小与摘要核验，未知对象或预算超限保留现场。 */
struct RetentionFile { std::string path; uint64_t size; std::string sha256; };

/** 路径遍历持有各级无链接目录直至操作结束，最终私有根必须属于当前 uid 且精确七百模式；缓存的五百目录只允许从已核验并隔离的根相对打开，不能通过修改原始路径权限绕过首次授权。 */
class RetentionParents {
    std::vector<Descriptor> parents;
public:
    explicit RetentionParents(const std::string& path) {
        require(!path.empty() && path[0] == '/' && path.size() <= 4096 && utf8(path), "retention.path");
        parents.emplace_back(openAt(AT_FDCWD, "/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0,
            "retention.root"));
        size_t start = 1;
        while (start < path.size()) {
            const auto end = path.find('/', start);
            const auto part = path.substr(start, end == std::string::npos ? end : end - start);
            component(part);
            parents.emplace_back(openAt(fd(), part.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0,
                "retention.parent"));
            require(S_ISDIR(metadata(fd()).st_mode), "retention.parent-type");
            if (end == std::string::npos) break;
            start = end + 1;
        }
        const auto info = metadata(fd());
        require(S_ISDIR(info.st_mode) && info.st_uid == ::getuid() && (info.st_mode & 07777) == 0700,
            "retention.parent-private");
        verifyPrivateAcl(fd());
    }
    int fd() const { return parents.back().get(); }
    void close() {
        std::exception_ptr first;
        for (auto item = parents.rbegin(); item != parents.rend(); ++item) {
            try { item->close("retention.parent-close"); } catch (...) { if (!first) first = std::current_exception(); }
        }
        if (first) std::rethrow_exception(first);
    }
};

/** 摘要循环只使用六十四 KiB 栈缓冲区与固定预期长度，尾字节检查和前后元数据比较发现并发改写；同一文件描述符贯穿核验与退休，不以另一次字符串读取结果为删除授权，也不分配整个证据大小的 Buffer。 */
inline std::string retentionDigest(int fd, uint64_t expected) {
    CC_SHA256_CTX context;
    require(CC_SHA256_Init(&context) == 1, "retention.hash");
    uint8_t bytes[65536]; uint64_t offset = 0;
    while (offset < expected) {
        const auto amount = static_cast<size_t>(std::min<uint64_t>(sizeof(bytes), expected - offset));
        ssize_t count = -1;
        for (unsigned retry = 0; retry < retryLimit; retry++) {
            count = ::pread(fd, bytes, amount, static_cast<off_t>(offset));
            if (count >= 0 || errno != EINTR) break;
        }
        if (count < 0) systemFailure("retention.read");
        require(count > 0 && CC_SHA256_Update(&context, bytes, static_cast<CC_LONG>(count)) == 1, "retention.hash");
        offset += static_cast<uint64_t>(count);
    }
    uint8_t tail; ssize_t count = -1;
    for (unsigned retry = 0; retry < retryLimit; retry++) {
        count = ::pread(fd, &tail, 1, static_cast<off_t>(expected));
        if (count >= 0 || errno != EINTR) break;
    }
    if (count < 0) systemFailure("retention.tail");
    require(count == 0, "retention.growth");
    uint8_t digest[CC_SHA256_DIGEST_LENGTH];
    require(CC_SHA256_Final(digest, &context) == 1, "retention.hash");
    const char* hex = "0123456789abcdef"; std::string value;
    for (const auto byte : digest) { value += hex[byte >> 4]; value += hex[byte & 15]; }
    return value;
}

/** 单成员退休只接受当前 uid 的六百证据或隔离缓存四百文件，文件必须单链接且长度、摘要及同名 inode 全部匹配；unlink 后刷新父目录，必要刷新或关闭失败保留提交不确定，不重建旧文件或按路径回滚。 */
inline void retireRetentionFile(int parent, const std::string& name, const RetentionFile& expected, bool isolated) {
    component(name);
    Descriptor file(openAt(parent, name.c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, 0, "retention.file"));
    const auto before = metadata(file.get());
    require(S_ISREG(before.st_mode) && before.st_uid == ::getuid() && before.st_nlink == 1 && before.st_size >= 0 &&
        static_cast<uint64_t>(before.st_size) == expected.size && expected.size <= 32 * 1024 * 1024 &&
        ((before.st_mode & 07777) == 0600 || (isolated && (before.st_mode & 07777) == 0400)), "retention.file-private");
    verifyPrivateAcl(file.get());
    require(retentionDigest(file.get(), expected.size) == expected.sha256 && same(before, metadata(file.get())),
        "retention.file-changed");
    struct stat named{};
    if (::fstatat(parent, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0) systemFailure("retention.identity");
    require(named.st_dev == before.st_dev && named.st_ino == before.st_ino, "retention.identity");
    bool removed = false;
    try {
        if (::unlinkat(parent, name.c_str(), 0) != 0) systemFailure("retention.unlink");
        removed = true;
        sync(parent, "retention.directory-sync");
        file.close("retention.file-close");
    } catch (const Failure& error) {
        if (removed) throw Failure("COMMIT_UNCONFIRMED", error.phase, error.number);
        throw;
    }
}

/** 报告证据的原始路径必须以固定 offline/work/Attempt/evidence/成员结尾，父链持有到删除和刷新结束；这里只允许一段已声明文件名，不访问凭据、引擎或任意工作目录文件，也不通过大额度读取接口返回正文。 */
inline void retirePrivateEvidence(const std::string& path, const RetentionFile& expected) {
    const auto end = path.rfind('/'); require(end != std::string::npos, "retention.evidence-path");
    const auto parent = path.substr(0, end), name = path.substr(end + 1);
    const auto suffix = parent.rfind("/offline/work/");
    require(suffix != std::string::npos && parent.size() >= suffix + 23 && parent.substr(suffix + 14).find(
        '/') != std::string::npos &&
        (parent.substr(parent.size() - 9) == "/evidence" || (parent.substr(parent.size() - 9) == "/metadata"
            && name == "report-display.json")), "retention.evidence-path");
    const auto attempt = parent.substr(suffix + 14, parent.size() - suffix - 23);
    component(attempt); require(attempt.find('/') == std::string::npos, "retention.evidence-path");
    RetentionParents directory(parent);
    retireRetentionFile(directory.fd(), name, expected, false);
    directory.close();
}

/** 缓存树退休先检查有限库存再原子隔离，持有目标目录 inode 后只通过 openat 访问其子项；递归深度、总对象、总字节均有硬边界，任何链接、清单外成员或错误拥有者都会保留退休现场，不使用递归路径 rm 或修改仍在原命名空间的只读
* 树。 */
inline void retirePrivateInventory(const std::string& input, const std::string& original, const std::string& retiring,
    const std::vector<RetentionFile>& files) {
    component(original); component(retiring);
    require(original.size() == 36 && original.find_first_not_of("0123456789abcdef-") == std::string::npos &&
        retiring == ".veriq-retiring-" + original && input.size() >= 8 && input.substr(input.size() - 8) == "/bundles"
            &&
        files.size() <= 4098, "retention.cache-purpose");
    std::map<std::string, RetentionFile> inventory; std::set<std::string> directories;
    uint64_t bytes = 0;
    for (const auto& file : files) {
        require(file.path.size() <= 240 && !file.path.empty() && file.path.find('\\') == std::string::npos &&
            file.size <= 32 * 1024 * 1024 && file.sha256.size() == 64 && file.sha256.find_first_not_of(
                "0123456789abcdef") == std::string::npos,
            "retention.inventory");
        size_t start = 0; unsigned depth = 0;
        for (;;) {
            const auto end = file.path.find('/', start);
            component(file.path.substr(start, end == std::string::npos ? end : end - start));
            require(++depth <= 16, "retention.depth");
            if (end == std::string::npos) break;
            directories.insert(file.path.substr(0, end)); start = end + 1;
        }
        require(inventory.emplace(file.path, file).second, "retention.duplicate");
        bytes += file.size; require(bytes <= 128 * 1024 * 1024, "retention.bytes");
    }
    RetentionParents parent(input);
    struct stat source{}, isolated{};
    const int sourceResult = ::fstatat(parent.fd(), original.c_str(), &source, AT_SYMLINK_NOFOLLOW);
    const int sourceError = errno;
    const int isolatedResult = ::fstatat(parent.fd(), retiring.c_str(), &isolated, AT_SYMLINK_NOFOLLOW);
    const int isolatedError = errno;
    if (sourceResult != 0 && sourceError != ENOENT) systemFailure("retention.source", sourceError);
    if (isolatedResult != 0 && isolatedError != ENOENT) systemFailure("retention.isolated", isolatedError);
    require(sourceResult != 0 || isolatedResult != 0, "retention.namespace-conflict");
    if (sourceResult != 0 && isolatedResult != 0) { parent.close(); return; }
    const auto name = sourceResult == 0 ? original : retiring;
    Descriptor tree(openAt(parent.fd(), name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0,
        "retention.tree"));
    const auto owned = metadata(tree.get());
    require(S_ISDIR(owned.st_mode) && owned.st_uid == ::getuid() &&
        ((owned.st_mode & 07777) == 0500 || (owned.st_mode & 07777) == 0700), "retention.tree-private");
    verifyPrivateAcl(tree.get());
    if (sourceResult == 0) {
        require(owned.st_dev == source.st_dev && owned.st_ino == source.st_ino, "retention.source-changed");
        if (::renameatx_np(parent.fd(), original.c_str(), parent.fd(), retiring.c_str(), RENAME_EXCL) != 0)
            systemFailure("retention.isolate");
        sync(parent.fd(), "retention.isolate-sync");
    }
    size_t count = 0;
    const auto walk = [&](const auto& visit, int directory, const std::string& relative, bool remove) -> void {
        const auto info = metadata(directory);
        require(S_ISDIR(info.st_mode) && info.st_uid == ::getuid() &&
            ((info.st_mode & 07777) == 0500 || (info.st_mode & 07777) == 0700), "retention.directory-private");
        verifyPrivateAcl(directory);
        if (remove && ::fchmod(directory, 0700) != 0) systemFailure("retention.make-writable");
        Descriptor cursor(openAt(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0,
            "retention.cursor"));
        DIR* raw = ::fdopendir(cursor.get());
        if (!raw) systemFailure("retention.cursor");
        cursor.take();
        std::unique_ptr<DIR, int(*)(DIR*)> entries(raw, ::closedir);
        std::vector<std::string> names;
        for (;;) {
            errno = 0; const auto* entry = ::readdir(raw);
            if (!entry) { if (errno) systemFailure("retention.enumerate"); break; }
            const std::string child(entry->d_name);
            if (child == "." || child == "..") continue;
            component(child); require(++count <= 8192, "retention.count"); names.push_back(child);
        }
        const int closed = ::closedir(entries.release());
        if (closed != 0) systemFailure("retention.cursor-close");
        for (const auto& child : names) {
            const auto path = relative.empty() ? child : relative + "/" + child;
            struct stat named{};
            if (::fstatat(directory, child.c_str(), &named, AT_SYMLINK_NOFOLLOW) != 0) systemFailure("retention.child");
            if (S_ISDIR(named.st_mode)) {
                require(directories.count(path) == 1, "retention.unknown-directory");
                Descriptor nested(openAt(directory, child.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0,
                    "retention.nested"));
                const auto held = metadata(nested.get());
                require(held.st_dev == named.st_dev && held.st_ino == named.st_ino, "retention.child-changed");
                visit(visit, nested.get(), path, remove);
                if (remove) {
                    struct stat current{};
                    if (::fstatat(directory, child.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0) systemFailure(
                        "retention.directory-identity");
                    require(current.st_dev == held.st_dev && current.st_ino == held.st_ino, "retention.child-changed");
                    if (::unlinkat(directory, child.c_str(), AT_REMOVEDIR) != 0) systemFailure("retention.rmdir");
                    sync(directory, "retention.directory-sync");
                }
                nested.close("retention.directory-close");
            } else {
                const auto found = inventory.find(path);
                require(found != inventory.end() && S_ISREG(named.st_mode) && named.st_uid == ::getuid()
                    && named.st_nlink == 1 &&
                    named.st_size >= 0 && static_cast<uint64_t>(named.st_size) == found->second.size &&
                    ((named.st_mode & 07777) == 0400 || (named.st_mode & 07777) == 0600), "retention.unknown-file");
                if (remove) retireRetentionFile(directory, child, found->second, true);
            }
        }
    };
    walk(walk, tree.get(), "", false); count = 0;
    walk(walk, tree.get(), "", true);
    struct stat current{};
    if (::fstatat(parent.fd(), retiring.c_str(), &current, AT_SYMLINK_NOFOLLOW) != 0) systemFailure(
        "retention.tree-identity");
    require(current.st_dev == owned.st_dev && current.st_ino == owned.st_ino, "retention.tree-changed");
    if (::unlinkat(parent.fd(), retiring.c_str(), AT_REMOVEDIR) != 0) systemFailure("retention.tree-remove");
    sync(parent.fd(), "retention.tree-sync");
    tree.close("retention.tree-close"); parent.close();
}
}
