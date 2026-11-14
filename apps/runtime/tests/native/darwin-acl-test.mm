/** 本程序仅构造内存 SecAccess 模板和公开类型树，不创建、打开、读取或锁定任何持久钥匙串；跨进程快照只通过匿名管道传递并在父进程内比较，标准输出只报告固定结果而不泄漏签名主体内容。 */
#include "../../native/vault/darwin-acl.hpp"
#include <sys/wait.h>
#include <sys/event.h>
#include <mach-o/dyld.h>
#include <limits.h>
#include <functional>
#include <cerrno>

using namespace veriq;
namespace {
/** 状态回归只向生产共用的错误边界及分类器传入明确标注的合成公开 OSStatus，不调用钥匙串服务或假称已经观察到服务故障；测试核验原码传播、真实状态事实的分类约定及修改不确定优先级，失败只输出固定标识。 */
bool securityStatusRegression() {
    const auto captured = [](OSStatus code) {
        try { requireSecurity(code); return static_cast<OSStatus>(errSecSuccess); }
        catch (...) { return securityFailureCode(std::current_exception()); }
    };
    const SecKeychainStatus unlocked = kSecUnlockStateStatus | kSecReadPermStatus;
    bool correct = captured(errSecSuccess) == errSecSuccess;
    const OSStatus unavailable[] = {errSecNotAvailable, errSecNoDefaultKeychain, errSecNoSuchKeychain, errSecInvalidKeychain};
    for (OSStatus code : unavailable) {
        const OSStatus observed = captured(code);
        correct = observed == code && correct;
        correct = strcmp(securityFailureStatus(observed, errSecAuthFailed, 0, true, false), "unavailable") == 0 && correct;
        correct = strcmp(securityFailureStatus(errSecAuthFailed, code, 0, true, false), "unavailable") == 0 && correct;
    }
    OSStatus structural = errSecSuccess;
    try { require(false); }
    catch (...) { structural = securityFailureCode(std::current_exception()); }
    correct = structural == errSecAuthFailed && correct;
    correct = strcmp(securityFailureStatus(structural, errSecSuccess, unlocked, true, false), "failed") == 0 && correct;
    correct = strcmp(securityFailureStatus(errSecAuthFailed, errSecNotAvailable, 0, true, false), "unavailable") == 0 && correct;
    correct = strcmp(securityFailureStatus(errSecAuthFailed, errSecAuthFailed, 0, true, false), "failed") == 0 && correct;
    correct = strcmp(securityFailureStatus(errSecAuthFailed, errSecSuccess, 0, true, false), "locked") == 0 && correct;
    correct = strcmp(securityFailureStatus(errSecAuthFailed, errSecSuccess, 0, false, false), "failed") == 0 && correct;
    correct = strcmp(securityFailureStatus(errSecItemNotFound, errSecSuccess, unlocked, true, false), "failed") == 0 && correct;
    correct = strcmp(securityFailureStatus(errSecNotAvailable, errSecSuccess, 0, true, true), "mutation-unconfirmed") == 0 && correct;
    correct = strcmp(securityFailureStatus(errSecAuthFailed, errSecNotAvailable, 0, false, true), "mutation-unconfirmed") == 0 && correct;
    return correct;
}

/** 真正的父死亡检查由一个重新执行的专用父进程持有 helper 输入，直到祖先进程完成精确 PID 的内核退出观察注册才离开；父进程保留未回收的 child 关系，防止注册前 PID 被回收或用名称扫描替代真实所有权。 */
int pipeOwner(const char *self) {
    try {
        std::string helper(self);
        helper.replace(helper.find_last_of('/') + 1, std::string::npos, "veriq_agent");
        int input[2], output[2], capability[2];
        require(pipe(input) == 0 && pipe(output) == 0 && pipe(capability) == 0);
        const pid_t child = fork();
        require(child >= 0);
        if (child == 0) {
            if (dup2(input[0], 0) < 0 || dup2(output[1], 1) < 0 || dup2(capability[0], 3) < 0) _exit(2);
            for (int descriptor = 4; descriptor < getdtablesize(); ++descriptor) close(descriptor);
            char *arguments[] = {const_cast<char *>(helper.c_str()), nullptr};
            char path[] = "PATH=/usr/bin:/bin";
            char *environment[] = {path, nullptr};
            execve(helper.c_str(), arguments, environment);
            _exit(2);
        }
        close(input[0]); close(output[1]); close(capability[0]);
        const char setup[] = "{\"mode\":\"gate\"}\n";
        require(write(capability[1], setup, sizeof(setup) - 1) == sizeof(setup) - 1);
        close(capability[1]);
        require(write(input[1], "V1 probe\n", 9) == 9);
        char ready[14] {}; size_t offset = 0;
        while (offset < 14) {
            ssize_t count = read(output[0], ready + offset, 14 - offset);
            if (count < 0 && errno == EINTR) continue;
            require(count > 0); offset += count;
        }
        require(memcmp(ready, "V1 test-ready\n", 14) == 0);
        int status = 0;
        require(waitpid(child, &status, WNOHANG) == 0);
        require(write(1, &child, sizeof(child)) == sizeof(child));
        char acknowledged = 0;
        require(read(0, &acknowledged, 1) == 1 && acknowledged == 'y');
        _exit(0);
    } catch (...) { _exit(2); }
}

/** 祖先进程只观察直接创建的父进程所报告的 helper，并在父仍持有输入时注册 NOTE_EXIT；注册失败或提前退出都失败关闭，只有父实际退出与随后 helper 的内核退出事件同时成立才算父死亡保活测试通过。 */
void parentDeath(const char *self) {
    int input[2], output[2];
    require(pipe(input) == 0 && pipe(output) == 0);
    const pid_t owner = fork();
    require(owner >= 0);
    if (owner == 0) {
        if (dup2(input[0], 0) < 0 || dup2(output[1], 1) < 0) _exit(2);
        for (int descriptor = 3; descriptor < getdtablesize(); ++descriptor) close(descriptor);
        execl(self, self, "--owner", nullptr);
        _exit(2);
    }
    close(input[0]); close(output[1]);
    int queue = -1;
    try {
        pid_t helper = 0;
        require(read(output[0], &helper, sizeof(helper)) == sizeof(helper) && helper > 1);
        queue = kqueue(); require(queue >= 0);
        struct kevent change {}, observed {};
        EV_SET(&change, static_cast<uintptr_t>(helper), EVFILT_PROC, EV_ADD | EV_ENABLE | EV_ONESHOT, NOTE_EXIT, 0, nullptr);
        require(kevent(queue, &change, 1, nullptr, 0, nullptr) == 0);
        timespec immediate {0, 0};
        require(kevent(queue, nullptr, 0, &observed, 1, &immediate) == 0);
        require(write(input[1], "y", 1) == 1);
        close(input[1]); input[1] = -1;
        int status = 0;
        require(waitpid(owner, &status, 0) == owner && WIFEXITED(status) && WEXITSTATUS(status) == 0);
        timespec timeout {2, 0};
        require(kevent(queue, nullptr, 0, &observed, 1, &timeout) == 1 && observed.ident == static_cast<uintptr_t>(helper) &&
            observed.filter == EVFILT_PROC && !(observed.flags & EV_ERROR) && (observed.fflags & NOTE_EXIT));
        close(output[0]); close(queue);
    } catch (...) {
        if (input[1] >= 0) close(input[1]);
        close(output[0]); if (queue >= 0) close(queue);
        int status = 0; waitpid(owner, &status, 0);
        throw;
    }
}

/** 重新执行的是同一个固定测试二进制，子进程导出后立即退出，父进程要求实际 waitpid 成功且完整读取有界数据；该检查只证明新模板的重复性，不声称持久条目重新打开或签名升级已经兼容。 */
Bytes restartSnapshot(const char *self) {
    int descriptors[2];
    require(pipe(descriptors) == 0);
    const pid_t child = fork();
    require(child >= 0);
    if (child == 0) {
        close(descriptors[0]);
        if (dup2(descriptors[1], 1) < 0) _exit(2);
        close(descriptors[1]);
        execl(self, self, "--snapshot", nullptr);
        _exit(2);
    }
    close(descriptors[1]);
    Bytes result;
    std::array<uint8_t, 4096> bytes;
    for (;;) {
        const ssize_t count = read(descriptors[0], bytes.data(), bytes.size());
        if (count < 0 && errno == EINTR) continue;
        require(count >= 0 && result.size() + static_cast<size_t>(count) <= 1048576);
        if (!count) break;
        result.insert(result.end(), bytes.begin(), bytes.begin() + count);
    }
    close(descriptors[0]);
    int status = 0;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    return result;
}

/** 恶意结构测试在独立子进程中构造循环、别名和超限节点，断言检查器选择明确的失败退出而非无限递归或释放栈对象；这些合成对象只是内存算法负例，不被当作系统实际返回了损坏 ACL 的证据。 */
void rejectsTree(SecAccessRef expected, unsigned scenario) {
    const pid_t child = fork();
    require(child >= 0);
    if (child == 0) {
        RawAccess raw(expected);
        auto *node = static_cast<CSSM_LIST_ELEMENT *>(calloc(1, sizeof(CSSM_LIST_ELEMENT)));
        CSSM_LIST list {CSSM_LIST_TYPE_SEXPR, node, node};
        node->ElementType = CSSM_LIST_ELEMENT_WORDID;
        if (scenario == 0) node->NextElement = node;
        if (scenario == 1) list.Tail = nullptr;
        if (scenario == 2) node->ElementType = 0xffffffff;
        if (scenario == 3) {
            node->ElementType = CSSM_LIST_ELEMENT_DATUM;
            node->Element.Word.Length = 1048577;
            node->Element.Word.Data = reinterpret_cast<uint8_t *>(node);
        }
        if (scenario == 4) {
            node->ElementType = CSSM_LIST_ELEMENT_SUBLIST;
            node->Element.Sublist = list;
        }
        if (scenario == 5) raw.nodes = 4096;
        if (scenario == 6) list.ListType = 0xffffffff;
        if (scenario == 8) raw.allocations.resize(8192);
        if (scenario == 9) {
            raw.dataBytes = 1048576;
            node->ElementType = CSSM_LIST_ELEMENT_DATUM;
            node->Element.Word.Length = 1;
            node->Element.Word.Data = static_cast<uint8_t *>(malloc(1));
        }
        if (scenario == 10) {
            node->ElementType = CSSM_LIST_ELEMENT_DATUM;
            node->Element.Word.Length = 1;
            node->Element.Word.Data = reinterpret_cast<uint8_t *>(node) + 1;
        }
        Bytes out;
        raw.list(out, list, scenario == 7 ? 33 : 0);
        _exit(1);
    }
    int status = 0;
    require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 126);
}

/** 附加权限条目通过公开 API 在脱离存储的模板上创建，任何通配、空集合或额外秘密授权都必须使验证失败；单独的标准加密元数据条目保持可接受，避免把平台正常模板误判成开放秘密访问。 */
void rejectsGrant(SecAccessRef expected, CFArrayRef rights) {
    Owned<SecAccessRef> changed(restrictedAccess());
    Owned<SecACLRef> added;
    require(SecACLCreateWithSimpleContents(changed.value, nullptr, CFSTR("VeriQ Runtime Vault v1"), 0, &added.value) == errSecSuccess);
    require(SecACLUpdateAuthorizations(added.value, rights) == errSecSuccess);
    require(!verifiedAccess(changed.value, expected));
}

/** 不透明代码主体的数据只在测试中逐字节改变而不解释私有签名格式，定位依据是公开的主体类型而非猜测路径或摘要布局；修改后的公开导入必须失败或被验证器拒绝，不能因为显示路径相同而忽略实际主体差异。 */
bool changeCodeDatum(CSSM_LIST &list, bool codeSubject = false) {
    if (list.Head && list.Head->ElementType == CSSM_LIST_ELEMENT_WORDID && list.Head->WordID == CSSM_ACL_SUBJECT_TYPE_CODE_SIGNATURE)
        codeSubject = true;
    for (auto *node = list.Head; node; node = node->NextElement) {
        if (codeSubject && node->ElementType == CSSM_LIST_ELEMENT_DATUM && node->Element.Word.Length) {
            node->Element.Word.Data[0] ^= 1;
            return true;
        }
        if (node->ElementType == CSSM_LIST_ELEMENT_SUBLIST && changeCodeDatum(node->Element.Sublist, codeSubject)) return true;
    }
    return false;
}

/** 公开 CSSM 导入仅用于创建脱离存储的恶意权限候选，逐项改变所有者、委托、未知权利或完整代码主体后观察真实验证结果；这些候选不持久化，也不声称已经模拟了签名升级或系统隐藏有效期条件。 */
void rejectsAlteration(SecAccessRef expected, unsigned scenario) {
    RawAccess raw(expected);
    CSSM_ACL_ENTRY_PROTOTYPE *secret = nullptr, *metadata = nullptr;
    for (uint32 index = 0; index < raw.count; ++index) {
        auto &entry = raw.entries[index].EntryPublicInfo;
        for (uint32 right = 0; right < entry.Authorization.NumberOfAuthTags; ++right) {
            if (entry.Authorization.AuthTags[right] == CSSM_ACL_AUTHORIZATION_DECRYPT) secret = &entry;
            if (entry.Authorization.AuthTags[right] == CSSM_ACL_AUTHORIZATION_ENCRYPT) metadata = &entry;
        }
    }
    require(secret && metadata);
    if (scenario == 0) raw.owner->Delegate = CSSM_TRUE;
    if (scenario == 1) secret->Delegate = CSSM_TRUE;
    if (scenario == 2) raw.owner->TypedSubject.Head->WordID = CSSM_ACL_SUBJECT_TYPE_ANY;
    if (scenario == 3) secret->Authorization.AuthTags[0] = 0x7fffffff;
    if (scenario == 4) require(changeCodeDatum(secret->TypedSubject));
    if (scenario == 5) metadata->TypedSubject.Head->WordID = 0x7fffffff;
    Owned<SecAccessRef> changed;
    const OSStatus imported = SecAccessCreateFromOwnerAndACL(raw.owner, raw.count, raw.entries, &changed.value);
    require(imported != errSecSuccess || (changed.value && !verifiedAccess(changed.value, expected)));
}

/** 两个真实可信应用对象形成比单 helper 模板更宽的主体，验证器必须拒绝整个备选授权而不是只找到一个匹配程序就放行；第二个应用仅作为内存身份对象，不执行该程序，也不改变任何钥匙串或系统信任设置。 */
void rejectsSecondPrincipal(SecAccessRef expected) {
    Owned<SecTrustedApplicationRef> self, other;
    require(SecTrustedApplicationCreateFromPath(nullptr, &self.value) == errSecSuccess);
    require(SecTrustedApplicationCreateFromPath("/usr/bin/true", &other.value) == errSecSuccess);
    const void *values[] = {self.value, other.value};
    Owned<CFArrayRef> applications(CFArrayCreate(nullptr, values, 2, &kCFTypeArrayCallBacks));
    Owned<SecAccessRef> changed;
    require(SecAccessCreate(CFSTR("VeriQ Runtime Vault v1"), applications.value, &changed.value) == errSecSuccess);
    require(!verifiedAccess(changed.value, expected));
}
}

/** 测试入口只接受内部快照、合成状态回归或无参数检查，系统 API 局限于内存权限对象及真实子进程；失败只返回静态退出码和固定标识，父调用者据此保留未验证状态，不输出原始 ACL、路径或系统异常文本。 */
int main(int argc, char **argv) {
    if (argc == 2 && std::string(argv[1]) == "--status-regression") {
        const bool passed = securityStatusRegression();
        const char *result = passed ? "SECURITY_STATUS_CHECKS_PASSED\n" : "SECURITY_STATUS_CHECKS_FAILED\n";
        if (write(1, result, strlen(result)) != static_cast<ssize_t>(strlen(result))) return 2;
        return passed ? 0 : 1;
    }
    if (argc == 2 && std::string(argv[1]) == "--owner") return pipeOwner(argv[0]);
    @autoreleasepool {
        try {
            NoUI noUI;
            Owned<SecAccessRef> expected(restrictedAccess());
            require(verifiedAccess(expected.value, expected.value));
            if (argc == 2 && std::string(argv[1]) == "--snapshot") {
                const Bytes bytes = accessSnapshot(expected.value);
                size_t offset = 0;
                while (offset < bytes.size()) {
                    ssize_t count = write(1, bytes.data() + offset, bytes.size() - offset);
                    if (count < 0 && errno == EINTR) continue;
                    require(count > 0); offset += count;
                }
                return 0;
            }
            require(argc == 1);
            char source[PATH_MAX], path[PATH_MAX];
            uint32_t length = sizeof(source);
            require(_NSGetExecutablePath(source, &length) == 0 && realpath(source, path));
            parentDeath(path);
            require(restartSnapshot(path) == restartSnapshot(path));
            for (unsigned index = 0; index < 11; ++index) rejectsTree(expected.value, index);
            for (unsigned index = 0; index < 6; ++index) rejectsAlteration(expected.value, index);
            rejectsSecondPrincipal(expected.value);
            rejectsGrant(expected.value, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationDecrypt]);
            rejectsGrant(expected.value, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationAny]);
            rejectsGrant(expected.value, (__bridge CFArrayRef)@[]);
            rejectsGrant(expected.value, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationChangeOwner]);
            rejectsGrant(expected.value, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationChangeACL]);
            rejectsGrant(expected.value, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationDecrypt, (__bridge id)kSecACLAuthorizationKeychainItemRead]);
            rejectsGrant(expected.value, (__bridge CFArrayRef)@[@"VERIQ_UNKNOWN_RIGHT"]);
            Owned<SecAccessRef> metadata(restrictedAccess());
            Owned<SecACLRef> added;
            require(SecACLCreateWithSimpleContents(metadata.value, nullptr, CFSTR("VeriQ Runtime Vault v1"), 0, &added.value) == errSecSuccess);
            require(SecACLUpdateAuthorizations(added.value, (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationEncrypt]) == errSecSuccess);
            require(verifiedAccess(metadata.value, expected.value));
            const char passed[] = "ACL_MEMORY_CHECKS_PASSED\n";
            require(write(1, passed, sizeof(passed) - 1) == sizeof(passed) - 1);
            return 0;
        } catch (...) { return 2; }
    }
}
