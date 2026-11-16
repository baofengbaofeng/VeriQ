/** 此守卫仅供新建专用测试钥匙串使用，在持有目录和文件描述符时收紧固定成员的权限并核对命名身份；它不处理生产存储、ACL 或旁路文件，也不声称多次 POSIX 观察能够对抗同 UID 的并发替换。 */
#pragma once
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <stdexcept>
#include <string>
#include <utility>

namespace veriq::test {
/** 失败对象只保存紧接失败系统调用读取的 errno，纯策略拒绝使用零表示没有系统错误；固定异常正文不携带路径、模式或身份，控制器可以把非零号码交给已有有限诊断而不泄漏文件信息。 */
struct PrivateModeFailure : std::runtime_error {
    const int error;
    /** 构造器接收调用点已经保存的错误号码，标准异常文本始终为固定英文标识；即使构造过程需要分配内存，也不会重新读取可能变化的 errno 或把上一次成功调用遗留的号码写入本次失败。 */
    explicit PrivateModeFailure(int value) : std::runtime_error("PRIVATE_KEYCHAIN_MODE_REFUSED"), error(value) {}
};

/** 阶段式对象把目录绑定、文件绑定、权限建立与最终身份核验分开，供真实控制器在已有创建及路径校验之后调用；固定成员名称不来自请求，预期 UID 由控制器的原生身份读取并保持不变。 */
class PrivateKeychainMode {
    /** 描述符仅由守卫内部持有且不可复制，槽位取走后永不重新接管同一编号；析构释放与显式成功关闭共用单次消费操作，避免 close 中断后重试误关闭后来复用编号的其他对象。 */
    class Descriptor {
        int value = -1;
    public:
        /** 空描述符从无效槽位开始，绑定函数只有在系统打开成功后才交接实际编号；默认构造不进行文件操作，从而使后续构造异常不会产生尚未登记所有权或必须靠外层猜测释放的资源。 */
        Descriptor() = default;
        Descriptor(const Descriptor &) = delete;
        Descriptor &operator=(const Descriptor &) = delete;
        /** 异常展开时只尽力关闭自己仍持有的一个描述符，保留进入析构前的 errno 且不抛新异常；先前属性或权限拒绝因此始终是主错误，关闭失败不会替换它或诱发再次使用同一编号。 */
        ~Descriptor() noexcept {
            const int saved = errno;
            (void)closeOnce();
            errno = saved;
        }
        /** 读取只返回当前内部槽位供固定系统调用使用，不转移关闭责任也不允许调用方指定任意编号；对象在阶段机中保持有效直到最终关闭，使属性查询始终针对原先绑定的同一个持有对象。 */
        int get() const noexcept { return value; }
        /** 接管仅由完成打开检查的绑定阶段调用一次，阶段机阻止重复绑定覆盖仍有效的槽位；赋值本身不抛异常，确保成功打开与资源进入作用域所有权之间没有会遗失描述符的额外操作。 */
        void take(int fd) noexcept { value = fd; }
        /** 单次关闭先使槽位失效再进入内核，返回值和即时 errno 由调用者决定是否作为成功路径拒绝；即便 EINTR 使系统关闭状态不确定，也绝不重试或让析构再次关闭可能已复用的编号。 */
        int closeOnce() noexcept {
            const int fd = value;
            value = -1;
            return fd >= 0 ? ::close(fd) : 0;
        }
    };
    Descriptor directoryFd, fileFd;
    const std::string directory;
    const uid_t owner;
    struct stat boundDirectory {}, boundFile {};
    mode_t target = 0;
    int phase = 0;
    static constexpr const char *member = "owned.keychain-db";

    static void require(bool valid) { if (!valid) throw PrivateModeFailure(0); }
    static void checked(int result) {
        if (result < 0) { const int error = errno; throw PrivateModeFailure(error); }
    }
    static bool identity(const struct stat &left, const struct stat &right) {
        return left.st_dev == right.st_dev && left.st_ino == right.st_ino;
    }
    void privateDirectory(const struct stat &value) const {
        require(S_ISDIR(value.st_mode) && value.st_uid == owner && (value.st_mode & 07777) == 0700);
    }
    void regularFile(const struct stat &value) const {
        require(S_ISREG(value.st_mode) && value.st_uid == owner && value.st_nlink == 1 && !(value.st_mode & 07000));
    }
    void sameFile(const struct stat &value, mode_t mode) const {
        regularFile(value);
        require(identity(value, boundFile) && (value.st_mode & 07777) == mode);
    }
    /** 每次目录复核都同时查询已持有描述符和不跟随末级链接的原始名称，二者必须仍是绑定的私有目录；不修复权限或替代路径，观察到任何身份或权限变化即拒绝后续文件操作。 */
    void verifyDirectory() const {
        struct stat held {}, named {};
        checked(fstat(directoryFd.get(), &held));
        privateDirectory(held);
        require(identity(held, boundDirectory));
        checked(lstat(directory.c_str(), &named));
        privateDirectory(named);
        require(identity(named, boundDirectory));
    }
    /** 文件复核分别观察持有对象与目录描述符下的固定名称，比较单链接、类型、属主、身份和完整权限位；时间戳不参与身份相等判断，因为合法 fchmod 本来就会改变文件元数据时间。 */
    void verifyFile(mode_t mode) const {
        struct stat held {}, named {};
        checked(fstat(fileFd.get(), &held));
        sameFile(held, mode);
        checked(fstatat(directoryFd.get(), member, &named, AT_SYMLINK_NOFOLLOW));
        sameFile(named, mode);
    }
public:
    /** 构造仅保存控制器已经生成的目录和从当前原生身份取得的预期 UID，不执行文件操作或接收成员选择；目录打开推迟到明确诊断阶段，使构造失败和系统调用失败保持各自原有的异常传播边界。 */
    PrivateKeychainMode(std::string path, uid_t expectedOwner) : directory(std::move(path)), owner(expectedOwner) {}
    PrivateKeychainMode(const PrivateKeychainMode &) = delete;
    PrivateKeychainMode &operator=(const PrivateKeychainMode &) = delete;

    /** 目录绑定发生于 mkdtemp 之后及 Security 创建之前，nofollow 与目录标志阻止接受末级符号链接或普通文件；取得的描述符立即归入作用域所有权，后续任何属性拒绝都会在异常展开时单次关闭。 */
    void bindDirectory() {
        require(phase == 0);
        const int fd = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        checked(fd);
        directoryFd.take(fd);
        checked(fstat(fd, &boundDirectory));
        privateDirectory(boundDirectory);
        verifyDirectory();
        phase = 1;
    }
    /** 文件绑定只在原有创建成功与精确路径校验成功之后调用，先检查目录锚点下的不跟随条目再只读打开；非阻塞标志防止替换成 FIFO 时阻塞，打开后的身份和权限必须与先前条目完全一致。 */
    void bindFile() {
        require(phase == 1);
        verifyDirectory();
        checked(fstatat(directoryFd.get(), member, &boundFile, AT_SYMLINK_NOFOLLOW));
        regularFile(boundFile);
        const int fd = openat(directoryFd.get(), member, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
        checked(fd);
        fileFd.take(fd);
        verifyFile(boundFile.st_mode & 07777);
        target = boundFile.st_mode & 0700;
        phase = 2;
    }
    /** 权限建立紧接父目录和成员重新核验之后，仅对已持有文件描述符执行一次 fchmod；目标取观察到的属主位且只移除组和其他用户权限，已私有文件保持无操作，失败不会回退路径 chmod 或重试。 */
    void establishMode() {
        require(phase == 2);
        verifyDirectory();
        verifyFile(boundFile.st_mode & 07777);
        if ((boundFile.st_mode & 0077) != 0) checked(fchmod(fileFd.get(), target));
        phase = 3;
    }
    /** 修改之后重新核对持有文件、目录中的固定成员以及原始父目录名称，权限必须精确等于目标而不是仅检查私有位；通过仍需控制器执行原有独立 lstat 短路链，本守卫不能替代该最终后置条件。 */
    void verifyIdentity() {
        require(phase == 3);
        verifyFile(target);
        verifyDirectory();
        phase = 4;
    }
    /** 正常路径在控制器最后属性检查之后显式关闭两个描述符，任一关闭错误都会令创建拒绝且保留首个即时 errno；槽位在 close 前失效以禁止 EINTR 重试或重复关闭，异常路径析构不会覆盖已有主错误。 */
    void close() {
        require(phase == 4);
        int error = 0;
        if (fileFd.closeOnce() < 0) error = errno;
        if (directoryFd.closeOnce() < 0 && error == 0) error = errno;
        phase = 5;
        if (error != 0) { errno = error; throw PrivateModeFailure(error); }
    }
};
}
