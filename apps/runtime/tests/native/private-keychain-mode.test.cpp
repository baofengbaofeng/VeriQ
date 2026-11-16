/** 此测试直接执行专用钥匙串夹具共用的真实 POSIX 权限守卫，通过自有临时目录观察修改、拒绝与描述符释放；它不调用 Security 框架，也不以 Linux 文件行为冒充任何实际 Mac 钥匙串验收结果。 */
#include "private-keychain-mode.hpp"
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <vector>

using veriq::test::PrivateKeychainMode;
using veriq::test::PrivateModeFailure;
namespace {
/** 断言失败只携带调用点的公开源码行号，默认内建参数在调用处求值且不重复求值原布尔表达式；异常仍派生自原来的 runtime_error，既有捕获语义保持一致，不读取 errno 或暴露断言涉及的实际文件属性。 */
struct AssertionFailure : std::runtime_error {
    const int line;
    /** 构造只保存断言调用处传入的公开行号并沿用原有固定异常标识，既不拼接表达式正文也不查询当前文件状态；上层诊断会将超出有限范围的行号标为未知，避免将其他整数解释成源码位置。 */
    explicit AssertionFailure(int value) : std::runtime_error("GUARD_TEST_FAILED"), line(value) {}
};
void check(bool value, int line = __builtin_LINE()) { if (!value) throw AssertionFailure(line); }

/** 每个案例只拥有一个新建随机目录和固定测试成员，成功时逐一清除本案例已结算的对象；异常时保留现场而不递归猜测删除，因此未知失败不会扩大到其他测试目录或系统账户文件。 */
struct Area {
    std::string directory;
    explicit Area() {
        char pattern[] = "/tmp/veriq-private-mode-XXXXXX";
        const char *value = mkdtemp(pattern);
        check(value != nullptr);
        directory = value;
    }
    /** 成员路径只由案例内部固定名称拼接，测试与被测守卫均不接受命令行路径或账户选择；额外名称仅用于制造同目录硬链接和可确定顺序的替换对象，不能指向外部已有文件。 */
    std::string path(const char *name = "owned.keychain-db") const { return directory + "/" + name; }
    /** 新文件先由持有描述符核对类型、当前属主和单链接，随后才建立案例要求的模式；SGID 输入必须先属于当前普通身份的主组，所有模式都在设置后精确复核，不能把 fchmod 返回成功误当成特殊位已经保留。 */
    void file(mode_t mode, const char *name = "owned.keychain-db") {
        const int fd = open(path(name).c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        check(fd >= 0);
        try {
            const uid_t owner = getuid();
            struct stat before {};
            check(fstat(fd, &before) == 0);
            check(S_ISREG(before.st_mode));
            check(before.st_uid == owner);
            check(before.st_nlink == 1);
            gid_t expectedGroup = before.st_gid;
            if ((mode & S_ISGID) != 0) {
                const gid_t primaryGroup = getgid();
                check(owner == geteuid());
                check(primaryGroup == getegid());
                /** 组调整仅限此处新建的 SGID 测试输入，目标来自当前主组且 UID 哨兵保持属主不变；原组已相等时不调用 fchown，调整必须先于 fchmod，以免所有权操作清除刚准备好的特殊权限位。 */
                if (before.st_gid != primaryGroup) check(fchown(fd, static_cast<uid_t>(-1), primaryGroup) == 0);
                struct stat grouped {};
                check(fstat(fd, &grouped) == 0);
                check(S_ISREG(grouped.st_mode));
                check(grouped.st_uid == owner);
                check(grouped.st_nlink == 1);
                check(grouped.st_dev == before.st_dev && grouped.st_ino == before.st_ino);
                check(grouped.st_gid == primaryGroup);
                expectedGroup = primaryGroup;
            }
            check(fchmod(fd, mode) == 0);
            struct stat after {};
            check(fstat(fd, &after) == 0);
            check(S_ISREG(after.st_mode));
            check(after.st_uid == owner);
            check(after.st_nlink == 1);
            check(after.st_dev == before.st_dev && after.st_ino == before.st_ino);
            check(after.st_gid == expectedGroup);
            check((after.st_mode & 07777) == mode);
        } catch (...) {
            /** 准备过程中任一拒绝都先单次释放已打开描述符再重新抛出原异常，清理返回值不能替换主失败；errno 保留进入清理时的值，关闭中断也不重试，成功路径的关闭检查则放在此捕获范围之外。 */
            const int saved = errno;
            (void)close(fd);
            errno = saved;
            throw;
        }
        check(close(fd) == 0);
    }
    /** 属性观察针对测试自身已经知道的成员执行不跟随链接的查询，断言只比较内存中的模式和时间字段；失败输出保持固定英文代码，不把路径、属主编号或其他文件身份写入持续集成日志。 */
    struct stat info(const char *name = "owned.keychain-db") const {
        struct stat value {};
        check(lstat(path(name).c_str(), &value) == 0);
        return value;
    }
    /** 成功清理按测试构造时的固定成员集合执行单次删除且检查返回值，目录成员使用 rmdir 处理；这不是递归清理器，出现未知对象或失败时立即保留剩余现场并令整个测试执行失败。 */
    void finish() {
        for (const char *name : {"owned.keychain-db", "original", "alias"}) {
            struct stat value {};
            if (lstat(path(name).c_str(), &value) == 0) {
                check((S_ISDIR(value.st_mode) ? rmdir(path(name).c_str()) : unlink(path(name).c_str())) == 0);
            } else check(errno == ENOENT);
        }
        check(rmdir(directory.c_str()) == 0);
    }
};

/** 拒绝断言只接受实际守卫抛出的固定失败类型，不吞掉测试断言或标准库异常；因此案例的成功表示该阶段真实拒绝，而不是任意错误恰好中断了路径或模拟的系统调用返回失败。 */
void refused(const std::function<void()> &action, int expectedError = 0) {
    bool observed = false;
    try { action(); } catch (const PrivateModeFailure &failure) {
        observed = true;
        check(failure.error == expectedError);
    }
    check(observed);
}

/** 描述符快照使用固定上限的真实 fcntl 查询而不依赖 Linux 的 proc 文件系统，空槽只接受 EBADF；案例在无后台线程的独立进程中执行，守卫的新描述符由最低空槽分配并落在此有界观察窗口内。 */
std::vector<int> descriptors() {
    std::vector<int> result;
    for (int fd = 0; fd < 256; ++fd) {
        if (fcntl(fd, F_GETFD) >= 0) result.push_back(fd);
        else check(errno == EBADF);
    }
    check(result.size() < 128);
    return result;
}

/** 正向案例逐一验证原属主位原样保留以及组和其他用户权限全部移除，私有输入还比较修改时间证明未重复执行 chmod；成功显式关闭后才清理文件，因此也覆盖守卫正常路径的单次关闭行为。 */
void validMode(mode_t initial) {
    Area area;
    area.file(initial);
    const auto before = area.info();
    const auto openBefore = descriptors();
    {
        PrivateKeychainMode guard(area.directory, getuid());
        guard.bindDirectory();
        guard.bindFile();
        guard.establishMode();
        guard.verifyIdentity();
        const auto after = area.info();
        check((after.st_mode & 07777) == (initial & 0700));
        if ((initial & 0077) == 0) {
#ifdef __APPLE__
            check(before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec
                && before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec);
#else
            check(before.st_ctim.tv_sec == after.st_ctim.tv_sec && before.st_ctim.tv_nsec == after.st_ctim.tv_nsec);
#endif
        }
        guard.close();
        check(descriptors() == openBefore);
    }
    check(descriptors() == openBefore);
    area.finish();
}

/** 非常规成员由本案例以真实文件操作构造，拒绝发生在打开或修改目标之前并再次核对原始模式；符号链接、FIFO、目录、硬链接和特殊权限位各自独立执行，避免一个早期失败掩盖其他分支。 */
void invalidMember(int kind) {
    Area area;
    if (kind == 0) {
        area.file(0644, "original");
        check(symlink("original", area.path().c_str()) == 0);
    } else if (kind == 1) check(mkfifo(area.path().c_str(), 0600) == 0);
    else if (kind == 2) check(mkdir(area.path().c_str(), 0700) == 0);
    else {
        area.file(kind >= 4 ? static_cast<mode_t>(0644 | (kind == 4 ? S_ISUID : kind == 5 ? S_ISGID : S_ISVTX)) : 0644);
        if (kind == 3) check(link(area.path().c_str(), area.path("alias").c_str()) == 0);
    }
    const mode_t before = area.info().st_mode;
    const auto openBefore = descriptors();
    {
        PrivateKeychainMode guard(area.directory, getuid());
        guard.bindDirectory();
        refused([&] { guard.bindFile(); });
    }
    check(descriptors() == openBefore);
    check(area.info().st_mode == before);
    if (kind == 0) check((area.info("original").st_mode & 07777) == 0644);
    area.finish();
}

/** 父目录的权限和预期身份在创建文件前就必须满足策略，测试用错误预期 UID 覆盖身份拒绝而不切换账户；权限案例只改变自己的随机目录并在拒绝后恢复，以便明确清理已知测试对象。 */
void invalidParent(int kind) {
    Area area;
    const mode_t mode = kind == 0 ? 0755 : kind == 1 ? 01700 : 0700;
    check(chmod(area.directory.c_str(), mode) == 0);
    const auto openBefore = descriptors();
    {
        PrivateKeychainMode guard(area.directory, kind == 2 ? getuid() + 1 : getuid());
        refused([&] { guard.bindDirectory(); });
    }
    check(descriptors() == openBefore);
    struct stat value {};
    check(lstat(area.directory.c_str(), &value) == 0 && (value.st_mode & 07777) == mode);
    check(chmod(area.directory.c_str(), 0700) == 0);
    area.finish();
}

/** 分阶段 API 让测试在确定边界替换命名对象，无须竞争线程或 sleep；绑定之后的父目录和成员替换都须拒绝，修改之后才发生的替换也不能通过身份验证，且替代文件从不受到守卫的权限修改。 */
void replacement(int kind) {
    Area area;
    area.file(0644);
    const std::string originalDirectory = area.directory + "-original";
    const auto openBefore = descriptors();
    {
        PrivateKeychainMode guard(area.directory, getuid());
        guard.bindDirectory();
        if (kind != 0) guard.bindFile();
        if (kind == 3) guard.establishMode();
        if (kind <= 1) {
            check(rename(area.directory.c_str(), originalDirectory.c_str()) == 0);
            check(mkdir(area.directory.c_str(), 0700) == 0);
            area.file(0660);
        } else {
            check(rename(area.path().c_str(), area.path("original").c_str()) == 0);
            area.file(0660);
        }
        if (kind == 0) refused([&] { guard.bindFile(); });
        else if (kind == 3) refused([&] { guard.verifyIdentity(); });
        else refused([&] { guard.establishMode(); });
        check((area.info().st_mode & 07777) == 0660);
        if (kind >= 2) check((area.info("original").st_mode & 07777) == (kind == 3 ? 0600 : 0644));
        else {
            struct stat value {};
            check(lstat((originalDirectory + "/owned.keychain-db").c_str(), &value) == 0 && (
                value.st_mode & 07777) == 0644);
        }
    }
    check(descriptors() == openBefore);
    area.finish();
    if (kind <= 1) {
        check(unlink((originalDirectory + "/owned.keychain-db").c_str()) == 0);
        check(rmdir(originalDirectory.c_str()) == 0);
    }
}

/** 异常释放案例分别在只持有父目录及同时持有文件时展开栈，真实缺失成员还检查即时 ENOENT；逻辑拒绝不得携带先前残留 errno，析构则必须保留进入异常清理时的原始错误号码。 */
void exceptionCleanup(int kind) {
    Area area;
    if (kind != 2) area.file(0644);
    const auto before = descriptors();
    try {
        PrivateKeychainMode guard(area.directory, getuid());
        guard.bindDirectory();
        if (kind == 2) guard.bindFile();
        if (kind == 1) guard.bindFile();
        errno = EDOM;
        throw std::runtime_error("TEST_UNWIND");
    } catch (const PrivateModeFailure &failure) {
        check(kind == 2 && failure.error == ENOENT && errno == ENOENT);
    } catch (const std::runtime_error &) { check(kind != 2 && errno == EDOM); }
    check(descriptors() == before);
    area.finish();
}

/** 失败输出只包含已完成数量、固定异常类别、断言公开源码行号及守卫本身捕获的 errno，其他异常不会读取进程残留错误码；这段诊断不推断当前案例名称或失败系统调用，也不打印异常正文及任何临时文件元数据。 */
enum class TestFailure { ASSERTION, GUARD, RUNTIME, STANDARD, UNKNOWN };
int failureDiagnostic(int completed, TestFailure kind, int error = -1, int line = -1) {
    const char *names[] = {"ASSERTION", "GUARD", "RUNTIME", "STANDARD", "UNKNOWN"};
    if (kind == TestFailure::ASSERTION && line > 0 && line <= 4095) {
        std::fprintf(stderr, "PRIVATE_MODE_GUARD_FAILED completed=%d class=%s errno=UNKNOWN line=%d\n", completed,
            names[static_cast<unsigned>(kind)], line);
    } else if (kind == TestFailure::GUARD && error >= 0 && error <= 4095) {
        std::fprintf(stderr, "PRIVATE_MODE_GUARD_FAILED completed=%d class=%s errno=%d line=UNKNOWN\n", completed,
            names[static_cast<unsigned>(kind)], error);
    } else {
        std::fprintf(stderr, "PRIVATE_MODE_GUARD_FAILED completed=%d class=%s errno=UNKNOWN line=UNKNOWN\n", completed,
            names[static_cast<unsigned>(kind)]);
    }
    return 1;
}
}

/** 独立入口执行固定有限案例集合并只输出通过数量或固定失败代码，不接受参数、不启动子进程；任何未预期异常都会立即终止剩余案例并保留当前临时对象，持续集成据此拒绝将部分通过视为验收。 */
int main() {
    int passed = 0;
    try {
        for (mode_t mode : {0644, 0660, 0444, 0741, 0600}) { validMode(mode); ++passed; }
        for (int kind = 0; kind < 7; ++kind) { invalidMember(kind); ++passed; }
        for (int kind = 0; kind < 3; ++kind) { invalidParent(kind); ++passed; }
        for (int kind = 0; kind < 4; ++kind) { replacement(kind); ++passed; }
        for (int kind = 0; kind < 3; ++kind) { exceptionCleanup(kind); ++passed; }
        std::printf("PRIVATE_MODE_GUARD_PASS %d\n", passed);
        return 0;
    } catch (const AssertionFailure &failure) {
        return failureDiagnostic(passed, TestFailure::ASSERTION, -1, failure.line);
    } catch (const PrivateModeFailure &failure) {
        return failureDiagnostic(passed, TestFailure::GUARD, failure.error);
    } catch (const std::runtime_error &) {
        return failureDiagnostic(passed, TestFailure::RUNTIME);
    } catch (const std::exception &) {
        return failureDiagnostic(passed, TestFailure::STANDARD);
    } catch (...) {
        return failureDiagnostic(passed, TestFailure::UNKNOWN);
    }
}
