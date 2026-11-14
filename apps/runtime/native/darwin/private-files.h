/** Darwin 私有文件基础只向固定可信宿主提供有限目录与普通文件操作，所有成员访问锚定已验证描述符而不重新解析父路径；公开 POSIX 刷新失败始终传播，不把内容可读或路径存在视为提交持久成功。
 * 每个拥有者独占关闭责任，原始整数仅在明确 stdio 映射时借给 CLI 使用。
 * 错误只携带固定阶段、英文代码及 errno，不记录文件名、路径或正文。
 * 测试调度仅存在于独立编译目标，正式 addon 不读取环境变量启用故障。
 */
#pragma once
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/acl.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace veriq::darwin {
constexpr size_t maximumBytes = 2 * 1024 * 1024;
constexpr size_t maximumEntries = 8192;
constexpr unsigned retryLimit = 64;

/** 稳定错误保留真实系统失败的阶段和编号，只有内核明确 ENOENT 才可被上层视为成员缺失；提交不确定使用独立代码覆盖缺失分类，防止发布后刷新错误被吞成首次创建路径。
 * 自定义边界错误使用 errno 零，避免伪造一个未发生的系统错误。
 * what 只返回稳定代码，任何日志都不会意外包含秘密正文或配置路径。
 */
struct Failure : std::runtime_error {
    std::string phase;
    int number;
    Failure(std::string code, std::string at, int value = 0)
        : std::runtime_error(std::move(code)), phase(std::move(at)), number(value) {}
};
/** 边界条件错误使用实现给定的固定阶段并保持 errno 为零，区分主动拒绝与内核 I/O 失败；调用者不能把模式错误或大小越界转换成 ENOENT 后继续创建或删除其他成员。
 * 条件由当前已持有的对象或有限参数得出，不执行路径重开。
 * 代码使用单一固定字符串，避免动态拼接名称或正文。
 * 调用栈由 Node-API 外层统一转换，不跨 ABI 泄漏 C++ 异常。
 */
inline void require(bool condition, const char* phase) {
    if (!condition) throw Failure("DARWIN_PRIVATE_INVALID", phase);
}
/** 系统失败在紧邻调用的位置捕获 errno 并附上固定阶段，只有真实编号为 ENOENT 才返回相应缺失代码；提交完成后的调用者会再覆盖为 COMMIT_UNCONFIRMED，防止误入幂等缺失路径。
 * 显式 number 参数用于 close 后保存的编号，不读取后来测试回调修改的 errno。
 * EINVAL、EACCES 和不支持的 fsync 全部保留失败。
 * 不把错误说明、系统路径或秘密内容附加到异常。
 */
inline void systemFailure(const char* phase, int number = errno) {
    throw Failure(number == ENOENT ? "ENOENT" : "DARWIN_PRIVATE_IO", phase, number);
}

/** 独立故障目标在真实系统操作旁注入有限动作，正式构建没有调度状态或测试导出；读写短操作仍进入同一循环，观察点允许测试在已打开 inode 上制造实际变化而非伪造元数据检查结果。
 * 动作零表示调用真实系统操作，动作一表示 EINTR，动作二表示短操作，动作三表示零进展。
 * 阶段错误由测试实现抛出 Failure，生产预处理后只留下无状态的零动作函数。
 */
#ifdef VERIQ_DARWIN_PRIVATE_TESTS
int testPoint(const char* phase, int fd);
#else
inline int testPoint(const char*, int = -1) { return 0; }
#endif

/** 文件描述符从构造开始属于单个原生对象，显式关闭先撤销内部整数再调用 close；即使 close 返回 EINTR 也不重试，因为描述符可能已释放且被别的线程重新使用。
 * 析构只做最终资源兜底，不替代显式关闭错误或提交确认。
 * 拷贝被禁止，移动仅转移所有权；不存在任意调用方整数的公开构造接口。
 */
class Descriptor {
    int value_ = -1;
public:
    /** 描述符只由当前公开 POSIX 操作成功返回后交给本类拥有，默认负一代表尚未取得资源；所有权不能复制，后续 File 与 Directory 均只能移动已有原生拥有者而非采用 JavaScript 提供的整数。
     * 默认状态允许构造前置失败自然退出而无需关闭任意数字。
     * 此内部构造函数没有对应 Node-API 导出。
     */
    explicit Descriptor(int value = -1) : value_(value) {}
    Descriptor(const Descriptor&) = delete;
    Descriptor& operator=(const Descriptor&) = delete;
    Descriptor(Descriptor&& other) noexcept : value_(other.take()) {}
    /** 移动赋值仅用于逐级目录打开后替换已明确关闭的父拥有者，源对象立即撤销数字状态；析构式兜底用于异常资源释放，不提供业务层可依赖的关闭成功或持久提交确认。
     * 常规调用先执行 parent.close，目标为空时这里不再执行系统 close。
     * 自移动不改变对象，避免把仍拥有的描述符提前释放。
     */
    Descriptor& operator=(Descriptor&& other) noexcept {
        if (this != &other) {
            if (value_ >= 0) ::close(value_);
            value_ = other.take();
        }
        return *this;
    }
    /** 析构只兜底释放仍属于此对象的描述符，不能抛异常覆盖原始失败，也不重试可能已经释放的数字；正式成功路径需要的关闭均显式执行并检查，因此析构从不被用作提交持久性证据。
     * 已执行 close 或 take 的对象保持负一，不触碰后来复用的数字。
     * 文件对象被垃圾回收只能释放资源，不能证明所属 CLI 已结束。
     */
    ~Descriptor() { if (value_ >= 0) ::close(value_); }
    /** 读取原始整数仅允许仍活的拥有者继续操作，关闭后的访问立即返回固定错误；本方法不复制或转移所有权，只有 File 的受限 getter 会将借用数字暴露给可信父层 stdio 映射。
     * 目录整数始终留在原生层，不能作为通用文件系统授权导出。
     */
    int get() const { require(value_ >= 0, "descriptor.closed"); return value_; }
    /** 转移操作先把自身设为无描述符状态再返回旧值，用于移动拥有者或把独立游标交给 fdopendir；没有重试窗口，也不依赖稍后的析构来撤销原对象对该数字的所有权。
     * fdopendir 成功后只有 DIR 负责关闭它接收的同一描述符。
     */
    int take() noexcept { return std::exchange(value_, -1); }
    /** 显式关闭先撤销自身描述符状态再调用内核一次，必要错误在数字已失效状态下传播；测试观察发生在真实关闭之后，确保错误路径与重复 close 都不会关闭被其他调用复用的新文件。
     * close 的 EINTR 也不重试，遵守描述符复用风险的单次调用约束。
     * phase 由调用点区分普通关闭与发布后必要关闭。
     */
    void close(const char* phase = "close") {
        const int value = take();
        if (value < 0) return;
        const int result = ::close(value);
        const int saved = errno;
        testPoint(phase, value);
        if (result != 0) systemFailure(phase, saved);
    }
};

/** UTF8 校验按实际文件名字节进行，拒绝过长编码、代理区、越界码点及截断序列；目录枚举不会把不能严格解码的名字替换成新字符后重新定位另一个文件。
 * ASCII 的零字节另由组件约束拒绝，其他合法 UTF8 不做路径规范化。
 * 多字节下界防止同一分隔符以非标准编码绕过单组件规则。
 */
inline bool utf8(const std::string& value) {
    for (size_t i = 0; i < value.size();) {
        const auto first = static_cast<uint8_t>(value[i++]);
        if (first < 0x80) continue;
        size_t count;
        uint32_t code;
        if (first >= 0xc2 && first <= 0xdf) { count = 1; code = first & 0x1f; }
        else if (first >= 0xe0 && first <= 0xef) { count = 2; code = first & 0x0f; }
        else if (first >= 0xf0 && first <= 0xf4) { count = 3; code = first & 7; }
        else return false;
        const size_t length = count;
        /** 当前首字节已经确定剩余长度，先验证整个序列位于有界名称内再读取后续字节；每个后续字节必须带固定前缀位，否则拒绝而不让畸形 UTF8 变成另一个合法名字。
         * length 保存原始序列长度，后面的下界判定不能使用已经递减的 count。
         * code 使用无符号三十二位，最长四字节累加不会溢出。
         * 每轮都至少消费一个首字节，非法序列立即返回失败。
         */
        if (i + count > value.size()) return false;
        while (count--) {
            const auto next = static_cast<uint8_t>(value[i++]);
            if ((next & 0xc0) != 0x80) return false;
            code = (code << 6) | (next & 0x3f);
        }
        if ((length == 2 && code < 0x800) || (length == 3 && code < 0x10000) ||
            (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return false;
    }
    return true;
}
/** 单组件校验以 UTF8 实际字节数限制为二百五十五，拒绝空名字、点目录、两类分隔符和内嵌零；同一规则也用于枚举出来的内核名字，非法成员不能被解码替换或绕过检查后悄悄过滤。
 * 反斜线在 Darwin 虽可作为普通字符，但跨平台用途边界仍明确拒绝。
 * 允许合法非 ASCII 名字不等于业务用途授权，正式 TS 白名单仍更严格。
 * 此处不调用 realpath 或任何字符串路径规范化。
 */
inline void component(const std::string& name) {
    require(!name.empty() && name.size() <= 255 && name != "." && name != ".." &&
        name.find_first_of(std::string("/\\\0", 3)) == std::string::npos && utf8(name), "name");
}

/** 系统调用只在有限次数内重试真实 EINTR，其他错误立即保留阶段返回；持续被打断也会以 EINTR 失败，避免同步宿主线程无限忙等或把中断当作已经完成的刷新。
 * openat 的所有调用者显式传入 NOFOLLOW 与 CLOEXEC，不依赖后续路径复查。
 * mode 参数仅在独占创建时生效，读取和已有目录绝不修权限。
 */
inline int openAt(int parent, const char* name, int flags, mode_t mode, const char* phase) {
    for (unsigned attempt = 0; attempt < retryLimit; attempt++) {
        const int fd = ::openat(parent, name, flags, mode);
        if (fd >= 0) return fd;
        if (errno != EINTR) systemFailure(phase);
    }
    systemFailure(phase, EINTR);
    return -1;
}
/** 元数据查询总是针对已打开的同一描述符，有限重试仅处理真实 EINTR，其他内核错误立即上报；读取、创建和退休都使用该结果判定实际 inode，不能用检查前的字符串路径身份代替。
 * 返回值先清零，系统失败时不会把未初始化字段当作私有对象。
 * 持续中断达到固定上限后仍返回 EINTR 失败，不吞成空文件。
 * 查询没有写入、修权限或删除副作用。
 */
inline struct stat metadata(int fd) {
    struct stat info{};
    for (unsigned attempt = 0; attempt < retryLimit; attempt++) {
        if (::fstat(fd, &info) == 0) return info;
        if (errno != EINTR) systemFailure("stat");
    }
    systemFailure("stat", EINTR);
    return info;
}
/** 普通文件授权同时检查类型、当前 uid、含特殊位在内的精确六百模式、单链接与非负有限大小；两兆原生硬上限不会被较大的 JavaScript 数字绕过，调用者更小的用途额度在同次判定中生效。
 * FIFO、目录、设备和符号链接都不能成为普通日志或保险库成员。
 * 单链接约束避免在当前目录外通过另一名字写入同一 inode。
 * 零字节文件允许存在，limit 本身仍必须为正有限额度。
 */
inline void regular(const struct stat& info, size_t limit) {
    require(limit >= 1 && limit <= maximumBytes, "read.limit");
    require(S_ISREG(info.st_mode) && info.st_uid == ::getuid() &&
        (info.st_mode & 07777) == 0600 && info.st_nlink == 1 && info.st_size >= 0 &&
        static_cast<uint64_t>(info.st_size) <= limit, "file.private");
}
/** Darwin 的扩展 ACL 可以在精确 Unix 私有模式之外授予访问，因此最终目录和普通文件必须在同一 fd 上另核 ACL；只接受不存在、空列表或完整有界且全部 DENY 的列表，任何 ALLOW 包括继承或仅继承项都拒绝。
 * 查询使用公开 acl_get_fd_np，不按路径重开、不解析用户组、不修改现有 ACL。
 * 已验证 fd 上 ENOENT 仅表示 FILESEC_ACL 属性不存在，在内部消化而不变成凭据文件缺失。
 * Darwin 的 acl_get_entry 成功返回零，末尾返回负一与 EINVAL，不能照搬 Linux 一与零规则。
 * 先 acl_valid 再迭代最多 ACL_MAX_ENTRIES 项，未知 tag、查询、验证及释放错误全部保持失败。
 * DENY 只能收紧权限，后续读写若被其阻止仍保留真实系统失败，不尝试修复或删除 ACL。
 */
inline void verifyPrivateAcl(int fd) {
    testPoint("acl.get", fd);
    errno = 0;
    acl_t acl = ::acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    /** ACL 不存在与文件不存在是两种不同事实，这里已经持有且核验文件描述符，因此空指针伴随 ENOENT 只在此处解释为缺少扩展 ACL；任何其他编号都保持 ACL 检查失败，不能从业务读取接口返回 undefined。
     * 有效的空 ACL 则会返回非空对象，后面的迭代器走单独空列表分支。
     * 这项兼容来自 Darwin FILESEC_ACL 属性的公开实现语义。
     * 不会因为 ACL 查询失败去调用路径 stat 或重新打开文件。
     * errno 在调用前清零，错误对象不会带上先前系统操作残留编号。
     * 测试构建可在此查询阶段注入错误，生产没有环境故障开关。
     */
    if (!acl) {
        if (errno == ENOENT) return;
        throw Failure("DARWIN_PRIVATE_ACL", "acl.get", errno);
    }
    struct Owner {
        /** ACL 分配对象需要使用 acl_free 而不是标准 free 释放，局部拥有者确保验证或迭代异常时仍执行清理；成功分支在显式释放前撤销 value，避免释放失败后析构再次释放同一内存。
         * ACL 存储只是元数据快照，不包含文件正文。
         * 失败清理不修改实际文件的 ACL 或访问模式。
         * 显式成功释放另检查返回值，不用析构兜底冒充成功。
         * 局部拥有者生命周期限制在同一次同步检查内。
         * 释放后不再访问 acl_entry_t，因为条目借用该 ACL 存储。
         */
        acl_t value;
        ~Owner() { if (value) ::acl_free(value); }
    } owner{acl};
    testPoint("acl.valid", fd);
    if (::acl_valid(acl) != 0) throw Failure("DARWIN_PRIVATE_ACL", "acl.valid", errno);
    for (size_t index = 0;; index++) {
        /** 条目迭代遵循 Darwin 零表示成功的约定，只有完成 acl_valid 后的负一加 EINVAL 被视为末尾；已获取第一百二十九个条目说明超过公开硬上限，立即拒绝而不把截断后的 DENY 子集当成完整列表。
         * FIRST 与 NEXT 由实际索引选择，不使用 Linux 的布尔成功判断。
         * 每次调用前清零 errno，真实成功不会被旧 EINVAL 误当作列表终止。
         * 空 ACL 的第一次 FIRST 返回末尾，因此不会读取未初始化 entry。
         * tag 查询发生在成功获得且限额内的条目上。
         * 不分析 principal UUID，因为任何 ALLOW 都在本策略内拒绝。
         */
        acl_entry_t entry;
        testPoint("acl.entry", fd);
        errno = 0;
        const int result = ::acl_get_entry(acl, index == 0 ? ACL_FIRST_ENTRY : ACL_NEXT_ENTRY, &entry);
        if (result == -1 && errno == EINVAL) break;
        if (result != 0) throw Failure("DARWIN_PRIVATE_ACL", "acl.entry", errno);
        require(index < ACL_MAX_ENTRIES, "acl.limit");
        acl_tag_t tag;
        /** DENY 项只可能收紧现有 Unix 权限，因此允许保留正常系统继承的拒绝删除规则；任何 ALLOW 即使指向拥有者或只用于后代继承也拒绝，防止新建临时秘密成员继承潜在额外访问能力。
         * 未知 tag 与读取 tag 失败不能作为无授权条目跳过。
         * 本策略不枚举用户或用户组，也不依赖当前组成员关系快照。
         * 允许 DENY 不保证后续系统调用成功，被拒绝的真实操作仍会失败。
         * 没有 ACL 重写、清空或 chmod 修复路径。
         * 同样策略用于目录、已有成员及新建临时和日志文件。
         */
        testPoint("acl.tag", fd);
        if (::acl_get_tag_type(entry, &tag) != 0) throw Failure("DARWIN_PRIVATE_ACL", "acl.tag", errno);
        require(tag == ACL_EXTENDED_DENY, "acl.allow");
    }
    owner.value = nullptr;
    /** 所有条目都完成检查之后才执行显式 acl_free 并检查其返回值，测试注入也发生在真实释放之后；释放错误保持固定 ACL 失败，读取不能因为授权查询资源释放异常而返回成功内容。
     * saved 在测试观察前捕获，防止回调修改 errno 掩盖原始编号。
     * owner 已经撤销指针，不会在异常展开时再次释放同一对象。
     * 这不是文件 close，不影响后续 File 对象保有的真实描述符。
     * 失败不修复或删除被检查文件，原字节和元数据保持。
     * 后续读操作仍会在读取结束再次完整核验 ACL。
     */
    const int released = ::acl_free(acl);
    const int saved = errno;
    testPoint("acl.free", fd);
    if (released != 0) throw Failure("DARWIN_PRIVATE_ACL", "acl.free", saved);
}

/** 持久提交逐阶段调用公开 POSIX fsync 并只在实际返回零时继续，EINVAL 或文件系统不支持也保持拒绝；有限 EINTR 重试不能把测试注入或真实持续中断当作已经完成的文件或父目录刷新。
 * 文件刷新与目录刷新采用各自固定阶段，故障证据可以定位发布前后位置。
 * 不使用 F_FULLFSYNC 替代目录刷新，也不承诺物理介质掉电保证。
 * 测试动作只影响独立目标的这个调用点，生产函数直接调用内核。
 */
inline void sync(int fd, const char* phase) {
    for (unsigned attempt = 0; attempt < retryLimit; attempt++) {
        const int action = testPoint(phase, fd);
        if (action == 1) { errno = EINTR; }
        else if (::fsync(fd) == 0) return;
        if (errno != EINTR) systemFailure(phase);
    }
    systemFailure(phase, EINTR);
}

/** 读取前后比较同一描述符的完整授权元数据及修改时间，不重新按名字打开；额外读取原长度后一字节检测增长，短读、截断或同长度修改均不能作为稳定完整日志返回。
 * pread 固定 offset，不推进 CLI 或父层共享的文件游标。
 * 分配长度先受当前调用者限额及两兆硬上限检查，负数不能转换成巨大无符号长度。
 * 修改时间使用 Darwin 纳秒字段，未读取的 atime 不参与变化判断。
 */
inline bool same(const struct stat& a, const struct stat& b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_uid == b.st_uid &&
        a.st_mode == b.st_mode && a.st_nlink == b.st_nlink && a.st_size == b.st_size &&
        a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
        a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
        a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec &&
        a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
/** 有界读取先核元数据再分配准确长度，在原始 inode 上完成正文与尾字节检查后复核变化；即使名称被替换也继续读取原描述符，任何观察到的大小、权限、链接或时间变化都会阻止返回成功。
 * 进展循环将短读累加到固定终点，零进展表示截断而非可接受 EOF。
 * 成功读取后的额外字节检查区分原长度 EOF 与持续增长。
 * 测试观察点位于真实查询之后，可以验证实际并发文件变化。
 */
inline std::vector<uint8_t> read(int fd, size_t limit) {
    const auto before = metadata(fd);
    regular(before, limit);
    verifyPrivateAcl(fd);
    testPoint("read.after-stat", fd);
    std::vector<uint8_t> bytes(static_cast<size_t>(before.st_size));
    size_t offset = 0;
    unsigned interrupted = 0;
    while (offset < bytes.size()) {
        /** 读取循环始终以已核验原长度作为终点，短操作只减少本轮请求并累加实际进展；连续中断计数在真实读取后清零，达到固定阈值的 EINTR 则保留为失败而不持续占用宿主线程。
         * count 为零意味着在原预期长度之前遇到 EOF，不能交付部分日志。
         * action 只在独立测试目标改变请求方式，生产每次请求剩余有限字节。
         * offset 同时用作 Buffer 位置与 pread 文件位置，不依赖共享 offset。
         */
        const int action = testPoint("read", fd);
        const size_t amount = action == 2 ? 1 : bytes.size() - offset;
        const ssize_t count = action == 1 ? (errno = EINTR, -1) :
            action == 3 ? 0 : ::pread(fd, bytes.data() + offset, amount, offset);
        if (count < 0 && errno == EINTR && ++interrupted < retryLimit) continue;
        if (count < 0) systemFailure("read");
        require(count > 0, "read.short");
        offset += static_cast<size_t>(count);
        interrupted = 0;
    }
    testPoint("read.after-bytes", fd);
    /** 原长度后的单字节探测可以发现读取期间增长的文件，随后再核同一 inode 的完整授权字段和纳秒时间；两次检查缺一不可，否则仅比较长度会接受同长度覆盖或稍后出现的新尾部。
     * 空文件也执行尾字节与元数据复核，不通过特殊空值路径绕过变化检查。
     * 尾读取仍只在固定次数内处理 EINTR，其他错误保留 read.tail 阶段。
     * 返回字节只在尾部确实 EOF 且元数据一致后发生。
     */
    uint8_t extra;
    ssize_t tail = -1;
    for (unsigned attempt = 0; attempt < retryLimit; attempt++) {
        tail = ::pread(fd, &extra, 1, offset);
        if (tail >= 0 || errno != EINTR) break;
    }
    if (tail < 0) systemFailure("read.tail");
    require(tail == 0 && same(before, metadata(fd)), "read.changed");
    verifyPrivateAcl(fd);
    return bytes;
}

/** 普通文件对象只持有由私有目录独占创建的已验证描述符，父层借用整数用于受控 CLI 的显式 stdio 映射；File 对象必须保活到实际退出与最终日志验证结束，不以临时 EOF 或超时替代生命周期。
 * read 总是在原 inode 上定位读取，即使原路径后来被重命名或换成其他内容。
 * close 幂等且没有调用方可指定的目标整数，关闭责任不转移给 C1。
 */
class File {
    Descriptor fd_;
public:
    /** 文件拥有者只在目录独占创建和必要刷新已完成后构造，接收的是移动原生资源而非裸数字；描述符包含读写能力用于 CLI 单写者及父层定位读取，关闭责任始终跟随此 File 对象。
     * 目录对象结束不影响这个独立拥有者。
     * 终结器仅资源兜底，宿主仍须明确保活及关闭。
     */
    explicit File(Descriptor&& fd) : fd_(std::move(fd)) {}
    /** 文件数字只借给固定可信父层用于显式 stdio 映射，取得数字不转移 File 的所有权；关闭后 getter 拒绝，避免把已经可能复用的数字继续交给未来 CLI 当成原日志能力。
     * Node stdio 目标槽与父数字不同，调用者必须使用真实目标槽填写标记。
     */
    int fd() const { return fd_.get(); }
    /** 父层读取始终使用最初交付的同一 inode 且不移动共享 offset，必要的 owner、模式、单链接和长度检查每次重新执行；未等实际 CLI 退出就读到暂时 EOF 不在此 API 中升级为最终停止证明。
     * 调用者的 C1 一兆日志额度仍应显式传入。
     */
    std::vector<uint8_t> read(size_t limit) { return darwin::read(fd_.get(), limit); }
    /** 关闭只释放此 File 当前拥有的原始描述符，重复调用没有副作用且错误后也不恢复整数状态；宿主必须在实际 CLI 退出和最终验证后调用，不能用关闭父层 fd 替代子进程退出事实。
     * C1 自身只借用数字，不替父层执行这个关闭。
     */
    void close() { fd_.close(); }
};
struct Entries { std::vector<std::string> names; bool overflow = false; };

/** 目录对象从根逐级获得无链接目录描述符，祖先只要求真实目录，最终目录另核当前 uid 与精确七百权限；持有后所有操作仅使用该描述符，所以父路径重命名或旧路径替换链接不改变授权锚点。
 * create=false 从不 mkdir、chmod 或清理历史；create=true 也不修改已存在对象的模式。
 * 构造器只在原生内部接收已经验证的 Descriptor，JavaScript 没有整数采用入口。
 */
class Directory {
    Descriptor fd_;
    /** 成员打开一次即绑定后续核验与读取的同一普通文件描述符，NOFOLLOW 拒绝链接而 NONBLOCK 避免 FIFO 阻塞；CLOEXEC 阻止未显式映射的句柄泄漏，所有权限与大小判断均来自实际 fd。
     * 打开失败保留 errno，只有实际 ENOENT 可以解释为成员缺失。
     * 参数先完成单组件检查，不能通过名称离开已授权目录。
     * 核验失败由 RAII 释放句柄，不修复原文件元数据。
     */
    Descriptor checked(const std::string& name, size_t limit) {
        component(name);
        Descriptor file(openAt(fd_.get(), name.c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC,
            0, "member.open"));
        regular(metadata(file.get()), limit);
        verifyPrivateAcl(file.get());
        return file;
    }
    /** 发布和删除前检查目录中同名条目的 dev 与 ino 是否仍属于已持有对象，fstatat 明确不跟随链接；真实消失只返回身份不匹配，其余查询错误保持失败，不能删除或发布一个被换名的陌生对象。
     * 文件内容变化不是名字身份，完整读取的变化检查另在 read 中执行。
     * 本函数不打开新路径，也不移动目录授权锚点。
     */
    bool matches(const std::string& name, const struct stat& expected) {
        struct stat actual{};
        if (::fstatat(fd_.get(), name.c_str(), &actual, AT_SYMLINK_NOFOLLOW) != 0) {
            if (errno == ENOENT) return false;
            systemFailure("member.identity");
        }
        return actual.st_dev == expected.st_dev && actual.st_ino == expected.st_ino;
    }
    /** 失败清理仅删除本次独占创建且当前同名仍匹配的未发布 inode，身份变化时保留新对象；清理删除后也刷新父目录，失败由调用者报告不确定，不扫描或清理任何旧 staging 或历史成员。
     * 此函数永远不接收已经发布为正式名字的对象。
     * 不匹配时直接返回，避免把其他写入者的新内容当作本次残留。
     * 刷新失败不会通过另一个普通路径重试删除。
     */
    void cleanup(const std::string& name, const struct stat& owned) {
        if (!matches(name, owned)) return;
        if (::unlinkat(fd_.get(), name.c_str(), 0) != 0) systemFailure("temporary.cleanup");
        sync(fd_.get(), "temporary.cleanup-sync");
    }
public:
    /** 目录内部构造只移动逐级核验完成的描述符，未完成的路径链无法从 JavaScript 构造此对象；所有后续操作相对这个 inode 执行，保留原路径字符串并不是权限来源或文件查找后备。
     * 父路径后来重命名不改变此拥有者身份。
     */
    explicit Directory(Descriptor&& fd) : fd_(std::move(fd)) {}
    /** 绝对路径从根逐级 openat 并拒绝任何链接，create 为真才尝试七百模式 mkdirat，EEXIST 仍必须重新安全打开；最终当前 uid 与精确七百模式不符合就失败，不修权限或自动解析系统别名。
     * 根和系统祖先不要求私有 uid 或模式，否则合法用户目录无法遍历。
     * 每级 fstat 确认目录身份，O_DIRECTORY 与 NOFOLLOW 同时约束实际打开。
     * 关闭旧父描述符成功后才移动到下一层，失败不会继续创建后代。
     * 路径整体和每个组件都有长度限制，解析没有无限或递归遍历。
     */
    static std::unique_ptr<Directory> open(const std::string& path, bool create) {
        require(!path.empty() && path[0] == '/' && path.size() <= 4096 &&
            path.find('\0') == std::string::npos && utf8(path), "directory.path");
        Descriptor parent(openAt(AT_FDCWD, "/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0, "directory.root"));
        require(S_ISDIR(metadata(parent.get()).st_mode), "directory.root-type");
        size_t start = 1;
        while (start < path.size()) {
            /** 路径解析只提取下一个有限组件并在触碰文件系统之前验证名字，拒绝内部双斜杠或点组件；绝对根拥有者保留到下一层目录实际打开和检查成功，不依赖字符串拼接形成新的授权路径。
             * end 为未找到时 substr 自动取剩余有界路径。
             * start 只在成功向下一层移动后推进，不递归处理用户路径。
             * 尾部单斜杠不创建额外空目录，最终仍核同一个真实目录。
             */
            const size_t end = path.find('/', start);
            const auto part = path.substr(start, end == std::string::npos ? end : end - start);
            component(part);
            if (create) {
                /** mkdirat 只在显式创建模式调用，并从创建时请求七百权限；EEXIST 只是允许继续真实打开检查，既不代表该项是目录也不表示 owner 或权限已经可信，已有链接仍在随后的 openat 被拒绝。
                 * umask 只能收紧新对象模式，最终精确模式不符仍失败。
                 * 被持续打断的创建在上限后失败，不返回部分成功会话。
                 * 只读调用完全不进入此分支，因此不会修改已有历史目录。
                 */
                int result;
                unsigned attempts = 0;
                do { result = ::mkdirat(parent.get(), part.c_str(), 0700); }
                while (result != 0 && errno == EINTR && ++attempts < retryLimit);
                if (result != 0 && errno != EEXIST) systemFailure("directory.mkdir");
            }
            Descriptor next(openAt(parent.get(), part.c_str(),
                O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC, 0, "directory.open"));
            require(S_ISDIR(metadata(next.get()).st_mode), "directory.type");
            parent.close();
            parent = std::move(next);
            if (end == std::string::npos) break;
            start = end + 1;
        }
        const auto info = metadata(parent.get());
        require(S_ISDIR(info.st_mode) && info.st_uid == ::getuid() &&
            (info.st_mode & 07777) == 0700, "directory.private");
        verifyPrivateAcl(parent.get());
        return std::make_unique<Directory>(std::move(parent));
    }
    /** 目录读取把单个成员描述符从检查持有到完整有界读取和显式关闭结束，中途不按名字重开；读取成功但必要关闭失败也传播错误，不让宿主把未完成的资源操作当成完整可用的记录观察。
     * 返回值是独立字节向量，文件句柄不泄漏给普通调用者。
     * 正式用途 JSON 和 UTF8 解码留给已有 TS 消费者。
     */
        auto file = checked(name, limit);
        auto bytes = darwin::read(file.get(), limit);
        file.close("read.close");
        return bytes;
    }

    /** 每次枚举通过 openat 点目录得到独立游标，不能 dup 原描述符后共享偏移；观察至多 limit 加一条来区分空与溢出，每条都以不跟随链接的 fstatat 检查，不按名字或类型过滤异常。
     * limit 零也会观察首项，未知成员不能因此制造空目录。
     * 非普通、错误 uid、公开模式或硬链接直接失败，避免允许名字下藏入其他对象。
     * 返回有界名字和 overflow，业务层继续执行自己的语法及四千或八千扫描额度。
     */
    Entries entries(size_t limit) {
        require(limit <= maximumEntries, "entries.limit");
        Descriptor cursor(openAt(fd_.get(), ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC,
            0, "entries.open"));
        DIR* raw = ::fdopendir(cursor.get());
        if (!raw) systemFailure("entries.fdopendir");
        cursor.take();
        std::unique_ptr<DIR, decltype(&::closedir)> stream(raw, ::closedir);
        Entries result;
        for (;;) {
            /** readdir 前清零 errno 以区分真实末尾与扫描错误，遇到内核点目录只跳过固定两项；其他名字均继续执行组件及 fstatat 检查，目录增长也最多观察限额外一个而不无限收集。
             * 不使用 dirent.d_type 作为普通文件证明，因为文件系统可能返回未知类型。
             * 独立 DIR 拥有自己的描述符和偏移，原目录锚点不参与游标推进。
             * 扫描异常由 unique_ptr 关闭游标，成功路径额外检查 closedir 返回值。
             */
            errno = 0;
            const auto* entry = ::readdir(raw);
            if (!entry) {
                if (errno) systemFailure("entries.read");
                break;
            }
            const std::string name(entry->d_name);
            if (name == "." || name == "..") continue;
            component(name);
            struct stat info{};
            if (::fstatat(fd_.get(), name.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0)
                systemFailure("entries.stat");
            regular(info, maximumBytes);
            auto observed = checked(name, maximumBytes);
            require(same(info, metadata(observed.get())), "entries.changed");
            observed.close("entries.member-close");
            /** 先核当前条目元数据再判断是否超出额度，保证多出来的异常项不会被当成可忽略尾部；达到 limit 时只设置 overflow 而不把额外名字推入返回数组，调用者仍能确定观察不完整。
             * limit 零在这里立即标记非空，而空目录会自然到达末尾。
             * 保留内核枚举顺序，业务测试不能依赖排序丢弃未知项。
             * overflow 为失败事实，正式 Records 与 Vault 各自决定拒绝或返回 false。
             */
            if (result.names.size() == limit) { result.overflow = true; break; }
            result.names.push_back(name);
        }
        stream.release();
        if (::closedir(raw) != 0) systemFailure("entries.close");
        return result;
    }

    /** 独占创建只返回已刷新文件和父目录的普通私有对象，任何交付前故障仅清理仍匹配本次 inode 的成员；若清理或必要关闭也失败则报告提交不确定，不能删除已有同名成员或声称交付成功。
     * 新文件带 O_RDWR 以支持所属 CLI 写入和父层定位读取，CLOEXEC 禁止普通隐式继承。
     * O_EXCL 拒绝重名，已有文件不会因当前调用被截断或重新授权。
     */
    std::unique_ptr<File> createExclusive(const std::string& name) {
        component(name);
        Descriptor file(openAt(fd_.get(), name.c_str(),
            O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600, "create.open"));
        const auto owned = metadata(file.get());
        try {
            regular(owned, maximumBytes);
            verifyPrivateAcl(file.get());
            sync(file.get(), "create.file-sync");
            /** 新建普通文件在交付之前完成文件和父目录两次必要刷新，父目录失败也不会交付可被宿主误当持久日志的 File；失败清理仍只针对这次确切 inode，并检查清理自身的目录刷新。
             * createExclusive 没有覆盖路径，所有同名残留都保留 O_EXCL 失败。
             * O_RDWR 描述符既支持 CLI 写入也支持父层定位读取。
             * 交付后不再由 Directory 管理这个独立 File 生命周期。
             */
            sync(fd_.get(), "create.directory-sync");
            return std::make_unique<File>(std::move(file));
        } catch (...) {
            try { cleanup(name, owned); file.close(); }
            catch (const Failure& error) { throw Failure("COMMIT_UNCONFIRMED", error.phase, error.number); }
            throw;
        }
    }

    /** 原子替换分别核已有成员的小额度和新正文两兆硬上限，完整写入独占随机临时 inode 后依次刷新文件、renameat 发布及刷新父目录；发布后的任何必要关闭或刷新错误明确保持提交不确定。
     * 发布前只清理本次 inode，旧 staging 或被替换的临时名字不会被误删。
     * 发布后不回滚内容，不重放写入，也不删除已经成为正式成员的 inode。
     * 短写和 EINTR 进入有限进展循环，零写或持续中断都失败而非忙等。
     */
    void replace(const std::string& name, const std::string& temporary,
            const uint8_t* bytes, size_t length, size_t existingLimit) {
        component(name);
        component(temporary);
        require(length <= maximumBytes && existingLimit >= 1 && existingLimit <= maximumBytes,
            "replace.limit");
        require(temporary.size() == 41 && temporary.front() == '.' && temporary.substr(37) == ".tmp" &&
            name != temporary, "replace.temporary");
        for (size_t i = 1; i < 37; i++) {
            const bool hyphen = i == 9 || i == 14 || i == 19 || i == 24;
            require(hyphen ? temporary[i] == '-' :
                ((temporary[i] >= '0' && temporary[i] <= '9') ||
                 (temporary[i] >= 'a' && temporary[i] <= 'f')), "replace.temporary");
        }
        /** 现有目标先按调用者更小用途额度核验并明确关闭，只有实际 ENOENT 允许首次创建；任何 owner、类型、模式、链接或长度错误均保留，不能借写入新正文顺便修复一个旧的越界成员。
         * 这项检查不扩大新正文硬上限，也不将旧文件读入内存。
         * 已有成员必要关闭失败发生在创建临时文件之前。
         * Vault 的小配置额度通过 existingLimit 单独传入此处。
         */
        try { auto old = checked(name, existingLimit); old.close(); }
        catch (const Failure& error) { if (std::string(error.what()) != "ENOENT") throw; }
        Descriptor file(openAt(fd_.get(), temporary.c_str(),
            O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600, "replace.open"));
        const auto owned = metadata(file.get());
        bool published = false;
        try {
            regular(owned, maximumBytes);
            verifyPrivateAcl(file.get());
            size_t offset = 0;
            unsigned interrupted = 0;
            while (offset < length) {
                /** 写入仅发生在本次独占临时 inode，有限短写循环要求每轮取得实际进展；零返回立即失败，EINTR 仅在固定上限内重试，任何错误都尚未修改正式目标并交由确切 inode 清理处理。
                 * 以 length 减 offset 计算剩余字节，不按文件系统报告扩张写入量。
                 * 每次真实进展后重置中断计数，正常短写仍能完成完整正文。
                 * 空正文跳过写循环但仍执行文件刷新和原子发布。
                 */
                const int action = testPoint("replace.write", file.get());
                const size_t amount = action == 2 ? 1 : length - offset;
                const ssize_t count = action == 1 ? (errno = EINTR, -1) : action == 3 ? 0 :
                    ::write(file.get(), bytes + offset, amount);
                if (count < 0 && errno == EINTR && ++interrupted < retryLimit) continue;
                if (count < 0) systemFailure("replace.write");
                require(count > 0, "replace.write-zero");
                offset += static_cast<size_t>(count);
                interrupted = 0;
            }
            sync(file.get(), "replace.file-sync");
            /** 正文刷新完成后再次确认临时名字仍指向本次 inode，随后只用同目录 renameat 发布；published 仅在内核成功返回后设为真，父目录刷新和必要关闭的异常会统一转成提交不确定而不删除新内容。
             * 失败前保留旧正式内容，失败后不尝试回滚或自动再次发布。
             * 同名临时成员被替换时拒绝发布，清理也不会删除替代者。
             * 内核 renameat 失败保留确切阶段和 errno。
             */
            require(matches(temporary, owned), "replace.identity");
            testPoint("replace.rename", file.get());
            if (::renameat(fd_.get(), temporary.c_str(), fd_.get(), name.c_str()) != 0)
                systemFailure("replace.rename");
            published = true;
            sync(fd_.get(), "replace.directory-sync");
            file.close("replace.close");
        } catch (const Failure& error) {
            if (published) throw Failure("COMMIT_UNCONFIRMED", error.phase, error.number);
            try { cleanup(temporary, owned); file.close(); }
            catch (const Failure& cleanupError) {
                throw Failure("COMMIT_UNCONFIRMED", cleanupError.phase, cleanupError.number);
            }
            throw;
        }
    }

    /** 退休先打开并核验私有普通成员，再比较同名 dev 与 ino 后 unlinkat，最后刷新父目录；只有实际打开 ENOENT 由上层解释为幂等缺失，删除后的刷新或必要关闭错误均保留不确定而不回滚。
     * 删除仅作用于单个已核名字，不递归、不修权限、不物理擦除正文。
     * 检查与操作都相对原目录描述符，旧父路径上的替代目录不参与授权。
     */
    void remove(const std::string& name, size_t limit) {
        auto file = checked(name, limit);
        const auto owned = metadata(file.get());
        require(matches(name, owned), "remove.identity");
        bool removed = false;
        try {
            /** 退休在同名 inode 比较后调用相对目录 unlinkat，只有成功返回才标记 removed；后续父目录刷新或关闭失败无法证明持久退休，因此必须保留不确定而不能以读不到文件作为完成依据。
             * 删除前故障不触碰原文件字节或名字。
             * 删除后不重新创建旧文件作为回滚，因为那会制造另一 inode。
             * 目标是普通单成员，不传递递归删除标志。
             */
            testPoint("remove.unlink", file.get());
            if (::unlinkat(fd_.get(), name.c_str(), 0) != 0) systemFailure("remove.unlink");
            removed = true;
            sync(fd_.get(), "remove.directory-sync");
            file.close("remove.close");
        } catch (const Failure& error) {
            if (removed) throw Failure("COMMIT_UNCONFIRMED", error.phase, error.number);
            throw;
        }
    }
    /** 目录结束只关闭自身持有的授权锚点，不递归删除成员或关闭已经独立交付的 File；描述符撤销后成员操作统一拒绝，重复 close 幂等，不凭原路径再打开一个替代目录继续会话。
     * 关闭错误保持可观察，不自动重试可能复用的整数。
     */
    void close() { fd_.close(); }
};
}
