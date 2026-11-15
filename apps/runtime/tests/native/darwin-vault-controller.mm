/** 专用钥匙串控制器只在操作者明确授权的可丢弃图形登录会话中创建随机自有存储，创建和删除可能改变该账户的持久偏好；普通流水线不会运行此入口，实际 UID 或会话事实本身不被当作可丢弃授权。 */
#include "../../native/vault/darwin-acl.hpp"
#include "private-keychain-mode.hpp"
#include <Security/AuthSession.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <poll.h>
#include <limits.h>
#include <cerrno>
#include <csignal>
#include <chrono>
#include <memory>

using namespace veriq;
namespace {
const char *acknowledgement = "I authorize Keychain preference changes in this disposable login session.";
using Clock = std::chrono::steady_clock;

/** 诊断阶段只描述现有启动、创建与清理边界，枚举与过滤器逐项核对且不接受运行时名称；这些事实不构成存储删除证明，阶段记录缺失仍须保留未知而不能从进程退出推导系统状态。 */
enum class DiagnosticStage {
    STARTUP, NO_UI, RECEIVE, CREATE_STATE, LIVE_UID_LOGIN,
    LIVE_SECURITY_SESSION, LIVE_SESSION_BITS, ATTEST_DISPOSABLE, ATTEST_ACK,
    ATTEST_UID, ATTEST_LOGIN, ATTEST_SESSION, HELPER_REALPATH, HELPER_NAME,
    HELPER_STAT, RANDOM, DIRECTORY, DIRECTORY_BIND, KEYCHAIN_CREATE, KEYCHAIN_PATH,
    KEYCHAIN_BIND, KEYCHAIN_MODE, KEYCHAIN_IDENTITY,
    KEYCHAIN_STAT, CREATE_REPLY, CLEANUP_DELETE, CLEANUP_DIRECTORY,
};
NSString *const diagnosticNames[] = {
    @"STARTUP", @"NO_UI", @"RECEIVE", @"CREATE_STATE", @"LIVE_UID_LOGIN",
    @"LIVE_SECURITY_SESSION", @"LIVE_SESSION_BITS", @"ATTEST_DISPOSABLE", @"ATTEST_ACK",
    @"ATTEST_UID", @"ATTEST_LOGIN", @"ATTEST_SESSION", @"HELPER_REALPATH", @"HELPER_NAME",
    @"HELPER_STAT", @"RANDOM", @"DIRECTORY", @"DIRECTORY_BIND", @"KEYCHAIN_CREATE", @"KEYCHAIN_PATH",
    @"KEYCHAIN_BIND", @"KEYCHAIN_MODE", @"KEYCHAIN_IDENTITY",
    @"KEYCHAIN_STAT", @"CREATE_REPLY", @"CLEANUP_DELETE", @"CLEANUP_DIRECTORY",
};

/** 作用域观察器在原谓词执行前后写出固定 JSON，异常展开时仅标记当前阶段失败且从不捕获业务异常；写日志自身的错误被隔离并恢复 errno，原生调用次数、短路顺序和原始拒绝路径均不依赖观察是否成功。 */
class DiagnosticGate {
    inline static bool outputEnabled = false;
    DiagnosticStage stage;
    bool enabled, passed = false, hasStatus = false, hasErrno = false, hasStore = false;
    OSStatus statusValue = 0;
    int errnoValue = 0;
    bool created = false, storeReferencePresent = false;
    bool hasRegularFile = false, hasOwnerMatches = false, hasPrivateMode = false;
    bool regularFileValue = false, ownerMatchesValue = false, privateModeValue = false;
    void emit(NSString *state) noexcept {
        if (!enabled) return;
        const int savedErrno = errno;
        static size_t count = 0, total = 0;
        static NSMutableData *waiting = nil;
        try {
            @try {
                if (count < 96 && total < 8192) {
                    NSMutableDictionary *record = [@{@"schemaVersion": @1,
                        @"stage": diagnosticNames[static_cast<size_t>(stage)], @"state": state} mutableCopy];
                    if (hasStatus) record[@"osStatus"] = @(statusValue);
                    if (hasErrno) record[@"errno"] = @(errnoValue);
                    if (hasStore) { record[@"created"] = @(created); record[@"storeReferencePresent"] = @(storeReferencePresent); }
                    if (hasRegularFile) record[@"regularFile"] = @(regularFileValue);
                    if (hasOwnerMatches) record[@"ownerMatches"] = @(ownerMatchesValue);
                    if (hasPrivateMode) record[@"privateMode"] = @(privateModeValue);
                    NSData *json = [NSJSONSerialization dataWithJSONObject:record options:0 error:nullptr];
                    if (json && json.length < 512 && total + json.length + 1 <= 8192) {
                        NSMutableData *line = [json mutableCopy];
                        [line appendBytes:"\n" length:1];
                        ++count; total += line.length;
                        if (!outputEnabled) {
                            if (!waiting) waiting = [NSMutableData data];
                            [waiting appendData:line];
                        } else {
                            if (waiting) { (void)write(2, waiting.bytes, waiting.length); waiting = nil; }
                            (void)write(2, line.bytes, line.length);
                        }
                    }
                }
            } @catch (...) {}
        } catch (...) {}
        errno = savedErrno;
    }
public:
    /** 启动记录先留在有限内存中，只有原先那次忽略 SIGPIPE 的设置确实成功后才允许写管道；这避免观察器在处理已关闭 stderr 时提前终止进程，不调整原信号调用顺序或增加新的系统调用。 */
    static void enableOutput(bool safe) noexcept { outputEnabled = safe; }
    /** 进入记录只使用编译期阶段和布尔开关，普通后续请求不启用初始接收观察；构造器不执行安全或文件操作，失败观察也不向调用方抛出新的异常或改变既有请求的处理顺序。 */
    explicit DiagnosticGate(DiagnosticStage value, bool active = true) noexcept : stage(value), enabled(active) { emit(@"entered"); }
    /** 析构只补充尚未通过阶段的失败事实，不推断系统调用是否修改了存储，也不尝试清理或重试；因此原有 catch 先回复拒绝再清理的顺序以及外层可能强杀进程的竞争窗口保持原样。 */
    ~DiagnosticGate() noexcept { if (!passed) emit(@"failed"); }
    /** 通过标志只在原谓词已通过后更新，日志失败不会撤回原来的成功结果或伪造清理确认；调用者依旧必须等待原控制协议回执和测试完成，不能把这里的阶段记录当作独立验收结果。 */
    void pass() noexcept { passed = true; emit(@"passed"); }
    /** 系统状态从已执行的调用返回值立即保存，不再次调用任何 Security API 或查询错误描述；这里只记录有限数值供真实目标失败定位，原成功常量与后续短路谓词仍由调用点负责判断。 */
    OSStatus status(OSStatus value) noexcept { hasStatus = true; statusValue = value; return value; }
    /** POSIX 整数失败紧接原调用保存 errno，后续日志不会覆盖实际错误号码，也不会增加文件或身份查询；成功结果不输出可能属于旧调用的 errno，调用点继续按原有返回值与短路条件判定。 */
    int posix(int value) noexcept { if (value < 0) { hasErrno = true; errnoValue = errno; } return value; }
    /** 权限守卫只交回已在系统调用失败时保存的号码，零值表示没有 errno 的策略拒绝；诊断不得重新读取日志或析构可能改变的进程错误状态，也不得把固定异常正文或文件属性添加到记录。 */
    void privateModeError(int value) noexcept { if (value != 0) { hasErrno = true; errnoValue = value; } }
    /** 路径和目录函数的空指针失败只保存即时 errno，不保存指针值或路径正文，也不重复解析或创建；指针仍原样交回原条件，从而维持现有短路语义和失败发生时对象赋值的先后顺序。 */
    template <typename T> T *posix(T *value) noexcept { if (!value) { hasErrno = true; errnoValue = errno; } return value; }
    /** 登录查询按自身错误返回约定保留失败号码而不记录用户名，负返回兼容路径读取即时 errno；这里不追加身份读取或重查会话，实际 UID 与登录条件仍只执行原先已经允许的一次判断。 */
    int login(int value) noexcept { if (value != 0) { hasErrno = true; errnoValue = value > 0 ? value : errno; } return value; }
    /** 创建状态仅复制对象已经设置的标志与现有引用是否为空，绝不追加存储查询或转换成删除完成结论；尤其系统创建返回失败但引用存在时仍保留两个事实，让原有清理路径决定后续操作。 */
    void store(bool wasCreated, bool referencePresent) noexcept { hasStore = true; created = wasCreated; storeReferencePresent = referencePresent; }
    /** 文件类型事实仅保存原短路链已经求值的布尔结果并原样返回，不执行额外查询也不立即输出；后续条件未执行时保持字段缺失，终态记录因此能够区分类型失败与尚未观察到的属主和权限判断。 */
    bool regularFile(bool value) noexcept { hasRegularFile = true; regularFileValue = value; return value; }
    /** 属主事实只接收原有相等判断的结果而不读取身份或数值 UID，返回值不会改变短路方向；只有前面的文件类型判断通过才会到达此处，因此缺失字段仍表示未求值而不是错误的否定结论。 */
    bool ownerMatches(bool value) noexcept { hasOwnerMatches = true; ownerMatchesValue = value; return value; }
    /** 私有权限事实仅记录原有组和其他用户权限位谓词的布尔结果，既不修改模式也不导出数值模式；记录延迟到既有通过或析构失败边界，从而保留原始拒绝、异常展开与清理执行的先后关系。 */
    bool privateMode(bool value) noexcept { hasPrivateMode = true; privateModeValue = value; return value; }
};

/** 控制通道采用 Foundation 解析单行有界 JSON，原始输入在解析完成后由作用域清理且永不写入日志；所有错误只返回静态布尔状态，控制器不会把框架异常或包含请求正文的系统描述交给外部测试报告。 */
NSDictionary *receive() {
    Secret bytes;
    bytes.bytes.reserve(8192);
    for (;;) {
        uint8_t byte = 0;
        ssize_t count = read(0, &byte, 1);
        if (count < 0 && errno == EINTR) continue;
        if (count == 0 && bytes.bytes.empty()) return nil;
        require(count == 1 && bytes.bytes.size() < 8192);
        if (byte == '\n') break;
        bytes.bytes.push_back(byte);
    }
    id value = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes.bytes.data() length:bytes.bytes.size()] options:0 error:nullptr];
    require([value isKindOfClass:[NSDictionary class]]);
    return value;
}
/** 控制器回复由 Foundation 生成单行 JSON 并在写出前检查长度，调用点只能提供既定结果字段而不能附加异常原因；私有响应中可能含供测试内存核对的 V1 数据，因此外部调用器必须继续禁止将正文作为日志或断言差异输出。 */
void send(NSDictionary *value) {
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:value options:0 error:nullptr];
    require(bytes && bytes.length < 8192);
    const uint8_t *data = static_cast<const uint8_t *>(bytes.bytes);
    size_t offset = 0;
    while (offset < bytes.length) {
        ssize_t count = write(1, data + offset, bytes.length - offset);
        if (count < 0 && errno == EINTR) continue;
        require(count > 0); offset += count;
    }
    require(write(1, "\n", 1) == 1);
}
/** 会话事实来自真实 UID、登录名及公开 Security 会话 API，而不是可以重定向的 HOME 或配置用户名；只接受非 root 的图形登录会话，返回事实供操作者声明精确绑定，事实本身并不授权创建可丢弃存储。 */
NSDictionary *sessionFacts() {
    char login[256] {};
    SecuritySessionId session = 0;
    SessionAttributeBits attributes = 0;
    { DiagnosticGate gate(DiagnosticStage::LIVE_UID_LOGIN);
        require(getuid() != 0 && getuid() == geteuid() && gate.login(getlogin_r(login, sizeof(login))) == 0); gate.pass(); }
    { DiagnosticGate gate(DiagnosticStage::LIVE_SECURITY_SESSION);
        require(gate.status(SessionGetInfo(callerSecuritySession, &session, &attributes)) == errSecSuccess && session != 0); gate.pass(); }
    { DiagnosticGate gate(DiagnosticStage::LIVE_SESSION_BITS);
        require((attributes & sessionHasGraphicAccess) && !(attributes & sessionIsRoot)); gate.pass(); }
    return @{ @"uid": @(getuid()), @"login": [NSString stringWithUTF8String:login], @"session": @(session) };
}
/** 创建夹具之前必须同时具有操作者的明确可丢弃声明、固定副作用确认文本和逐字段相等的实际会话事实；只知道 UID 或可以运行 sudo 不满足这里的授权条件，拒绝发生在任何钥匙串创建调用之前。 */
void attest(NSDictionary *value, NSDictionary *facts) {
    { DiagnosticGate gate(DiagnosticStage::ATTEST_DISPOSABLE);
        require([value isKindOfClass:[NSDictionary class]] && [value[@"disposable"] isEqual:@YES]); gate.pass(); }
    { DiagnosticGate gate(DiagnosticStage::ATTEST_ACK);
        require([value[@"acknowledgement"] isEqual:[NSString stringWithUTF8String:acknowledgement]]); gate.pass(); }
    size_t index = 0;
    const DiagnosticStage stages[] = {DiagnosticStage::ATTEST_UID, DiagnosticStage::ATTEST_LOGIN, DiagnosticStage::ATTEST_SESSION};
    for (NSString *key in @[@"uid", @"login", @"session"]) {
        DiagnosticGate gate(stages[index++]); require([value[key] isEqual:facts[key]]); gate.pass();
    }
}

/** 固定测试成员必须与控制器位于相同的真实构建目录，路径解析只在测试二进制内发生且不读取业务配置；父 PID 仅佐证继承关系，真正的存储授权仍来自显式会话声明和当前控制器拥有的随机目录。 */
std::string helperPath() {
    char executable[PATH_MAX], physical[PATH_MAX];
    uint32_t size = sizeof(executable);
    { DiagnosticGate gate(DiagnosticStage::HELPER_REALPATH);
        require(_NSGetExecutablePath(executable, &size) == 0 && gate.posix(realpath(executable, physical))); gate.pass(); }
    std::string path(physical);
    { DiagnosticGate gate(DiagnosticStage::HELPER_NAME);
        require(path.substr(path.find_last_of('/') + 1) == "veriq_keychain_controller"); gate.pass(); }
    path.replace(path.find_last_of('/') + 1, std::string::npos, "veriq_agent");
    struct stat info {};
    { DiagnosticGate gate(DiagnosticStage::HELPER_STAT);
        require(gate.posix(lstat(path.c_str(), &info)) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 0022)); gate.pass(); }
    return path;
}
/** 控制器自行验证两个精确 UUID 并按原字节编码账户，不能直接接收任意 Keychain account 或服务名称；这些规则与 helper 的 V1 作用域一致，确保注入负例、读回与删除始终属于本次请求声明的测试条目。 */
NSString *account(NSDictionary *request) {
    std::string result;
    const char *digits = "0123456789abcdef";
    for (NSString *field in @[@"profile", @"version"]) {
        id value = request[field];
        require([value isKindOfClass:[NSString class]] && [value length] == 36);
        const char *text = [value UTF8String];
        require(text && strlen(text) == 36);
        for (size_t index = 0; index < 36; ++index) {
            const unsigned char c = text[index];
            if (index == 8 || index == 13 || index == 18 || index == 23) require(c == '-');
            else require((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'));
            result.push_back(digits[c >> 4]); result.push_back(digits[c & 15]);
        }
        if ([field isEqual:@"profile"]) result.push_back('/');
    }
    return [NSString stringWithUTF8String:result.c_str()];
}

/** 自有测试存储的完整密文文件只读入内存比较，以观察拒绝路径是否修改持久状态，内容不写入证据或临时副本；该比较不是解密读回证明，实际三十二字节读回仍由正常辅助程序的独立进程请求验证。 */
Bytes ciphertext(const std::string &path) {
    const int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    require(fd >= 0);
    struct stat info {};
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_size < 0 || info.st_size > 1048576) {
        close(fd); throw std::runtime_error("VAULT_FIXTURE_FILE_INVALID");
    }
    Bytes bytes(static_cast<size_t>(info.st_size));
    size_t offset = 0;
    while (offset < bytes.size()) {
        ssize_t count = read(fd, bytes.data() + offset, bytes.size() - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { close(fd); throw std::runtime_error("VAULT_FIXTURE_FILE_INVALID"); }
        offset += count;
    }
    close(fd);
    return bytes;
}

/** 每组管道由局部对象持有尚未交出的端点，创建后续端点或 fork 失败时也会关闭已经取得的描述符；子进程只继承标准输入输出、配置管道和专用屏障，其他控制器端点不会延长另一个 helper 的父存活时间。 */
struct Pair {
    int fd[2] {-1, -1};
    /** 构造只分配匿名本地管道或双向屏障套接字，不创建路径或命名服务；两个端点保持在同一所有权对象中直到明确交出，因此后续准备失败不会遗留一个仍持有 helper 控制输入的写端。 */
    explicit Pair(bool socket = false) { require((socket ? socketpair(AF_UNIX, SOCK_STREAM, 0, fd) : pipe(fd)) == 0); }
    Pair(const Pair &) = delete;
    /** 析构只关闭仍记录在本对象里的端点，已经 take 交出的描述符由 Child 或另一个明确作用域负责；这种单次转移避免重复 close 意外关闭后来被系统复用编号的其他控制连接。 */
    ~Pair() { for (int descriptor : fd) if (descriptor >= 0) close(descriptor); }
    /** 端点转移返回原描述符并立即将本地槽位置为无效，从而把关闭责任交给实际使用该端点的对象；索引只由固定内部调用点提供，不从 JSON 请求读取，也不允许外部选择任意进程文件描述符。 */
    int take(size_t index) { const int result = fd[index]; fd[index] = -1; return result; }
};

/** 单个测试子进程的句柄保存真实 fork 关系和所有私有端点，析构先结束输入再有界等待退出；若内核尚未确认退出，PID 仍留在控制器的所有权集合中并阻止删除存储，不能把已发送终止信号写成清理成功。 */
struct Child {
    std::set<pid_t> &owners;
    pid_t pid = -1;
    int input = -1, output = -1, control = -1, status = 0;
    bool exited = false, waitLost = false;
    Secret response;
    /** 子进程对象绑定控制器的所有权集合并预留最大响应容量，后续积累秘密输出不需要反复释放旧缓冲；此时尚未 fork，因此构造失败不会产生需要终止但已经丢失句柄的子进程。 */
    explicit Child(std::set<pid_t> &value) : owners(value) { response.bytes.reserve(512); }
    Child(const Child &) = delete;
    /** 回收前首先用 waitpid 核对仍然持有真实 child 关系，只有关系仍存在时才允许发送终止信号；失去等待关系时保留未知状态并禁止再次按这个 PID 发信号，以免编号复用后影响不相关进程。 */
    void reap(bool terminate) {
        if (pid <= 0 || exited || waitLost) return;
        const pid_t initial = waitpid(pid, &status, WNOHANG);
        if (initial == pid) { exited = true; owners.erase(pid); return; }
        if (initial < 0 && errno != EINTR) { waitLost = true; return; }
        if (terminate) kill(pid, SIGKILL);
        const auto deadline = Clock::now() + std::chrono::milliseconds(600);
        while (Clock::now() < deadline) {
            const pid_t observed = waitpid(pid, &status, WNOHANG);
            if (observed == pid) { exited = true; owners.erase(pid); return; }
            if (observed < 0 && errno != EINTR) { waitLost = true; return; }
            poll(nullptr, 0, 5);
        }
    }
    /** 析构关闭私有输入使 EOF 监视能够结束 helper，然后有界回收直接子进程并清理响应缓冲；如果内核仍未确认退出，所有权集合继续保留记录，因此上层不能成功删除或声称清理了尚在使用的存储。 */
    ~Child() {
        if (input >= 0) close(input);
        if (output >= 0) close(output);
        if (control >= 0) close(control);
        reap(true);
    }
    /** 退出码只从已经 waitpid 确认的正常退出状态提取，信号死亡或未确认退出统一保留独立的负值；该值供测试判断是否收到完整回复，不把信号请求、EOF 关闭或成功写入管道当成系统操作成功。 */
    int code() const { return exited && WIFEXITED(status) ? WEXITSTATUS(status) : -1; }
    /** 屏障确认只读取当前 child 的私有控制套接字并受共享单调时钟期限约束，错误字节和提前关闭都导致测试失败；调用点只期待真实缺失后的就绪标记，不通过轮询钥匙串或等待固定时间猜测竞争窗口。 */
    void event(char expected, Clock::time_point deadline) {
        while (Clock::now() < deadline) {
            pollfd watched {control, POLLIN, 0};
            const int ready = poll(&watched, 1, 25);
            if (ready < 0 && errno == EINTR) continue;
            require(ready >= 0);
            if (!ready) continue;
            char value = 0;
            require(read(control, &value, 1) == 1 && value == expected);
            return;
        }
        require(false);
    }
    /** 新增结果标记来自 helper 已经返回的实际 SecItemAdd 状态，只接受成功或重复两个固定字节；它不是 V1 修改回执的替代品，控制器仍必须收齐正式回复并确认两个进程退出后才能报告竞争验证结果。 */
    char outcome(Clock::time_point deadline) {
        while (Clock::now() < deadline) {
            pollfd watched {control, POLLIN, 0};
            const int ready = poll(&watched, 1, 25);
            if (ready < 0 && errno == EINTR) continue;
            require(ready >= 0);
            if (!ready) continue;
            char value = 0;
            require(read(control, &value, 1) == 1 && (value == 'A' || value == 'D'));
            return value;
        }
        require(false); return 0;
    }
    /** 标准输出按固定上限收集到可清理缓冲，只有管道 EOF 和真实退出都成立才返回给调用方；读取错误、超限或期限结束会触发受保护的 child 清理，不能把收到部分 V1 文本当成完整的确定性结果。 */
    void collect(Clock::time_point deadline) {
        bool eof = false;
        while (!eof && Clock::now() < deadline) {
            pollfd watched {output, POLLIN, 0};
            const int ready = poll(&watched, 1, 25);
            if (ready < 0 && errno == EINTR) continue;
            require(ready >= 0);
            if (!ready) continue;
            Secret chunk(512);
            ssize_t count = read(output, chunk.bytes.data(), chunk.bytes.size());
            if (count < 0 && errno == EINTR) continue;
            require(count >= 0 && response.bytes.size() + static_cast<size_t>(count) <= 512);
            if (!count) eof = true;
            else response.bytes.insert(response.bytes.end(), chunk.bytes.begin(), chunk.bytes.begin() + count);
        }
        reap(!eof);
        require(eof && exited);
    }
    /** 响应相等先比较全部长度再比较全部字节，调用方只传入固定状态文本或留在内存中的期望密钥编码；这里只返回布尔结果，不生成包含实际材料的差异对象，因此断言失败不会把秘密内容打印到测试日志。 */
    bool equals(const char *value) const {
        return response.bytes.size() == strlen(value) && memcmp(response.bytes.data(), value, response.bytes.size()) == 0;
    }
};

/** 语义快照分别保存系统返回的非秘密属性与公开导出的完整 ACL 表示，属性中的临时引用被移除以避免把对象地址误认作变化；两部分都只在控制器内存中比较，原始主体、路径与属性不会被写入测试输出。 */
struct ItemSnapshot {
    NSDictionary *attributes = nil;
    Bytes policy;
};

/** 存储生命周期只属于一次已确认的测试会话，控制器从系统随机源生成二进制密码并始终保存在内存；清理必须先确认所有实际子进程退出，无法确认时保留文件及失败事实，不恢复或伪装用户原有偏好。 */
struct Fixture {
    Owned<SecKeychainRef> store;
    Secret password {32};
    std::string directory, path, helper;
    NSDictionary *facts = nil;
    std::set<pid_t> children;
    Bytes baseline;
    ItemSnapshot baselineState;
    Secret baselineValue;
    NSString *baselineAccount = nil;
    bool controllerReader = false;
    bool created = false;

    /** 实际创建必须发生在会话声明核验和固定 helper 路径解析之后，密码来自系统随机源且只保存在当前对象；路径由 mkdtemp 生成，创建返回的实际路径和文件所有权必须再次相符，任何偏好副作用只属于已授权账户。 */
    void create(NSDictionary *attestation) {
        { DiagnosticGate gate(DiagnosticStage::CREATE_STATE);
            gate.store(created, store.value != nullptr); require(!created && directory.empty()); gate.pass(); }
        facts = sessionFacts();
        attest(attestation, facts);
        helper = helperPath();
        { DiagnosticGate gate(DiagnosticStage::RANDOM);
            require(gate.status(SecRandomCopyBytes(kSecRandomDefault, password.bytes.size(), password.bytes.data())) == errSecSuccess); gate.pass(); }
        char pattern[] = "/private/tmp/veriq-d1-XXXXXX";
        { DiagnosticGate gate(DiagnosticStage::DIRECTORY); require(gate.posix(mkdtemp(pattern))); gate.pass(); }
        directory = pattern;
        path = directory + "/owned.keychain-db";
        const uid_t expectedOwner = getuid();
        test::PrivateKeychainMode privateMode(directory, expectedOwner);
        /** 守卫各阶段只在原生创建路径内调用，失败号码来自守卫捕获的实际系统调用而不是当前残留 errno；异常继续交给原来的拒绝及清理流程，观察器既不重试也不改变已创建标志的归属。 */
        const auto guarded = [&](DiagnosticStage stage, auto operation) {
            DiagnosticGate gate(stage);
            try { operation(); }
            catch (const test::PrivateModeFailure &failure) { gate.privateModeError(failure.error); throw; }
            gate.pass();
        };
        guarded(DiagnosticStage::DIRECTORY_BIND, [&] { privateMode.bindDirectory(); });
        { DiagnosticGate gate(DiagnosticStage::KEYCHAIN_CREATE);
            const OSStatus error = gate.status(SecKeychainCreate(path.c_str(), static_cast<UInt32>(password.bytes.size()), password.bytes.data(), false, nullptr, &store.value));
            created = store.value != nullptr;
            gate.store(created, store.value != nullptr);
            require(error == errSecSuccess && created); gate.pass(); }
        char actual[PATH_MAX]; UInt32 length = sizeof(actual);
        { DiagnosticGate gate(DiagnosticStage::KEYCHAIN_PATH);
            require(gate.status(SecKeychainGetPath(store.value, &length, actual)) == errSecSuccess && std::string(actual, length) == path); gate.pass(); }
        guarded(DiagnosticStage::KEYCHAIN_BIND, [&] { privateMode.bindFile(); });
        guarded(DiagnosticStage::KEYCHAIN_MODE, [&] { privateMode.establishMode(); });
        guarded(DiagnosticStage::KEYCHAIN_IDENTITY, [&] { privateMode.verifyIdentity(); });
        struct stat info {};
        { DiagnosticGate gate(DiagnosticStage::KEYCHAIN_STAT);
            require(gate.posix(lstat(path.c_str(), &info)) == 0 && gate.regularFile(S_ISREG(info.st_mode)) && gate.ownerMatches(info.st_uid == getuid()) && gate.privateMode(!(info.st_mode & 0077))); gate.pass(); }
        /** 原有属性阶段只证明其自身短路链通过，随后显式关闭失败仍使整个创建请求拒绝且不会启动 helper；关闭错误不混入已完整求值的三个属性事实，异常析构继续保留首错而不重复关闭。 */
        privateMode.close();
    }
    /** 清理首先要求跟踪集合为空，然后只删除本对象成功创建并仍持有引用的测试钥匙串和随机目录；任一步骤失败都会阻止成功回执，密码及基线秘密在正常路径覆盖，不恢复其他用户存储或搜索列表状态。 */
    void cleanup() {
        require(children.empty());
        if (created) {
            DiagnosticGate gate(DiagnosticStage::CLEANUP_DELETE);
            gate.store(created, store.value != nullptr);
            require(gate.status(SecKeychainDelete(store.value)) == errSecSuccess);
            created = false;
            gate.store(created, store.value != nullptr); gate.pass();
        }
        if (!directory.empty()) {
            DiagnosticGate gate(DiagnosticStage::CLEANUP_DIRECTORY);
            require(gate.posix(rmdir(directory.c_str())) == 0);
            directory.clear(); gate.pass();
        }
        wipe(password.bytes.data(), password.bytes.size());
        wipe(baselineValue.bytes.data(), baselineValue.bytes.size());
    }

    /** 控制器只启动固定子程序并持有其 stdin 到实际完成，额外配置和屏障使用独立继承端点且不进入参数或环境；所有句柄在异常路径由所有权对象关闭，真实子进程未退出时仍阻止删除其可能正在使用的存储。 */
    std::unique_ptr<Child> start(NSDictionary *request, bool barrier = false, bool inspection = false, bool observeReadDenial = false) {
        require(created && [request[@"frame"] isKindOfClass:[NSString class]]);
        require(!(observeReadDenial && (barrier || inspection)));
        NSData *frame = [request[@"frame"] dataUsingEncoding:NSASCIIStringEncoding];
        require(frame && frame.length < 512);
        NSDictionary *configuration = @{ @"mode": @"store", @"disposable": @YES, @"uid": facts[@"uid"],
            @"session": facts[@"session"], @"parent": @(getpid()), @"path": [NSString stringWithUTF8String:path.c_str()],
            @"fault": request[@"fault"] ?: @"", @"barrier": @(barrier), @"inspection": @(inspection),
            @"observeReadDenial": @(observeReadDenial) };
        NSData *capability = [NSJSONSerialization dataWithJSONObject:configuration options:0 error:nullptr];
        require(capability && capability.length < 4096);
        Pair input, output, configurationPipe, barrierPipe(true);
        auto child = std::make_unique<Child>(children);
        child->pid = fork();
        require(child->pid >= 0);
        if (child->pid == 0) {
            if (dup2(input.fd[0], 0) < 0 || dup2(output.fd[1], 1) < 0 ||
                dup2(configurationPipe.fd[0], 3) < 0 || dup2(barrierPipe.fd[1], 4) < 0) _exit(2);
            const int null = open("/dev/null", O_WRONLY);
            if (null < 0 || dup2(null, 2) < 0) _exit(2);
            for (int fd = 5; fd < getdtablesize(); ++fd) close(fd);
            char pathEnvironment[] = "PATH=/usr/bin:/bin";
            char *environment[] = {pathEnvironment, nullptr};
            char *arguments[] = {const_cast<char *>(helper.c_str()), nullptr};
            execve(helper.c_str(), arguments, environment);
            _exit(2);
        }
        children.insert(child->pid);
        child->input = input.take(1);
        child->output = output.take(0);
        child->control = barrierPipe.take(0);
        require(write(configurationPipe.fd[1], capability.bytes, capability.length) == static_cast<ssize_t>(capability.length));
        require(write(configurationPipe.fd[1], "\n", 1) == 1);
        require(write(child->input, frame.bytes, frame.length) == static_cast<ssize_t>(frame.length));
        return child;
    }

    /** 普通专用存储调用只交付有限 V1 响应和已经核验的退出事实，测试故障导致的异常退出保留原始不确定性；控制器不会将子程序未返回的修改推断为失败回滚，也不会自动重发同一新增或删除操作。 */
    NSDictionary *run(NSDictionary *request) {
        auto child = start(request);
        child->collect(Clock::now() + std::chrono::milliseconds(3800));
        NSString *response = [[NSString alloc] initWithBytes:child->response.bytes.data() length:child->response.bytes.size() encoding:NSASCIIStringEncoding];
        require(response);
        return @{ @"ok": @YES, @"exitConfirmed": @YES, @"code": @(child->code()), @"response": response };
    }

    /** 两个真实请求必须分别观察到缺失并在新增前等待，控制器收齐两个确认才同时释放屏障；随后只接受一条真实新增与一条重复结果，并按获胜请求的精确密钥读回，因而不同密钥竞争也不能静默覆盖。 */
    NSDictionary *race(NSDictionary *request) {
        account(request);
        NSArray *keys = request[@"keys"];
        require([keys isKindOfClass:[NSArray class]] && keys.count == 2);
        for (id key : keys) require([key isKindOfClass:[NSString class]] && [key length] == 43);
        const auto frame = [&](NSString *key) {
            return [NSString stringWithFormat:@"V1 set %@ %@ %@\n", request[@"profile"], request[@"version"], key];
        };
        const auto deadline = Clock::now() + std::chrono::milliseconds(3700);
        auto first = start(@{@"frame": frame(keys[0])}, true);
        auto second = start(@{@"frame": frame(keys[1])}, true);
        first->event('R', deadline);
        second->event('R', deadline);
        require(write(first->control, "G", 1) == 1 && write(second->control, "G", 1) == 1);
        const char one = first->outcome(deadline), two = second->outcome(deadline);
        require((one == 'A' && two == 'D') || (one == 'D' && two == 'A'));
        first->collect(deadline); second->collect(deadline);
        const bool same = [keys[0] isEqual:keys[1]];
        Child &winner = one == 'A' ? *first : *second;
        Child &loser = one == 'D' ? *first : *second;
        const bool outcomes = winner.code() == 0 && winner.equals("V1 ok\n") && loser.code() == 0 && loser.equals(same ? "V1 ok\n" : "V1 failed\n");
        auto readback = start(@{@"frame": [NSString stringWithFormat:@"V1 get %@ %@\n", request[@"profile"], request[@"version"]]});
        readback->collect(deadline);
        NSString *expected = [NSString stringWithFormat:@"V1 ok %@\n", one == 'A' ? keys[0] : keys[1]];
        const bool matches = readback->code() == 0 && readback->equals(expected.UTF8String);
        return @{@"ok": @YES, @"absent": @2, @"added": @1, @"duplicate": @1, @"exited": @2,
            @"outcomes": @(outcomes), @"readback": @(matches)};
    }

    /** 持久条目快照先限定当前测试存储、固定服务与精确账户，再要求唯一属性和引用结果；公开访问策略通过独立导出记录而不是重用生产通过判定，因此后续拒绝检查不能靠同一个错误验证器自证没有变化。 */
    ItemSnapshot snapshot(NSDictionary *request) {
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: account(request),
            (__bridge id)kSecMatchSearchList: @[(__bridge id)store.value],
            (__bridge id)kSecReturnRef: @YES, (__bridge id)kSecReturnAttributes: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitAll};
        Owned<CFTypeRef> result;
        require(SecItemCopyMatching((__bridge CFDictionaryRef)query, &result.value) == errSecSuccess);
        require(result.value && CFGetTypeID(result.value) == CFArrayGetTypeID() && CFArrayGetCount(static_cast<CFArrayRef>(result.value)) == 1);
        CFTypeRef raw = CFArrayGetValueAtIndex(static_cast<CFArrayRef>(result.value), 0);
        require(raw && CFGetTypeID(raw) == CFDictionaryGetTypeID());
        CFTypeRef item = CFDictionaryGetValue(static_cast<CFDictionaryRef>(raw), kSecValueRef);
        require(item && CFGetTypeID(item) == SecKeychainItemGetTypeID());
        Owned<SecAccessRef> access;
        require(SecKeychainItemCopyAccess(static_cast<SecKeychainItemRef>(const_cast<void *>(item)), &access.value) == errSecSuccess);
        NSMutableDictionary *attributes = [(__bridge NSDictionary *)raw mutableCopy];
        [attributes removeObjectForKey:(__bridge id)kSecValueRef];
        ItemSnapshot value;
        value.attributes = [attributes copy]; value.policy = accessSnapshot(access.value);
        return value;
    }

    /** 秘密材料的独立读回由 ACL 实际允许的夹具主体执行，普通负例使用同一测试 helper 的只读检查而拒绝 helper 的负例使用控制器；任何系统读取错误直接使证明失败，不能把只看到密文文件未变当作值已经核验。 */
    void inspect(NSDictionary *request, Secret &value) {
        if (controllerReader) {
            NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: account(request),
                (__bridge id)kSecMatchSearchList: @[(__bridge id)store.value], (__bridge id)kSecReturnData: @YES};
            Owned<CFTypeRef> result;
            require(SecItemCopyMatching((__bridge CFDictionaryRef)query, &result.value) == errSecSuccess);
            require(result.value && CFGetTypeID(result.value) == CFDataGetTypeID() && CFDataGetLength(static_cast<CFDataRef>(result.value)) == 32);
            value.bytes.resize(32);
            memcpy(value.bytes.data(), CFDataGetBytePtr(static_cast<CFDataRef>(result.value)), 32);
        } else {
            auto child = start(@{@"frame": [NSString stringWithFormat:@"V1 get %@ %@\n", request[@"profile"], request[@"version"]]}, false, true);
            child->collect(Clock::now() + std::chrono::milliseconds(3500));
            require(child->code() == 0 && child->response.bytes.size() == 50 && memcmp(child->response.bytes.data(), "V1 ok ", 6) == 0 && child->response.bytes.back() == '\n');
            NSString *encoded = [[NSString alloc] initWithBytes:child->response.bytes.data() + 6 length:43 encoding:NSASCIIStringEncoding];
            encoded = [[[encoded stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"] stringByAppendingString:@"="];
            NSData *decoded = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
            require(decoded.length == 32);
            value.bytes.resize(32); memcpy(value.bytes.data(), decoded.bytes, 32);
        }
    }

    /** 拒绝前后的证明同时比较真实解密字节、完整公开 ACL 表示及非秘密属性，主密文文件比较仅作为附加事实；测试持有最初账户绑定并拒绝替换 scope，因此无法用读取另一个未变化条目来掩盖目标的修改。 */
    NSDictionary *unchanged(NSDictionary *request) {
        require(created && baselineAccount && [baselineAccount isEqual:account(request)]);
        Secret current;
        inspect(request, current);
        const ItemSnapshot state = snapshot(request);
        return @{@"ok": @YES, @"valueUnchanged": @(current.bytes == baselineValue.bytes),
            @"aclUnchanged": @(state.policy == baselineState.policy),
            @"attributesUnchanged": @([state.attributes isEqualToDictionary:baselineState.attributes]),
            @"primaryCiphertextUnchanged": @(baseline == ciphertext(path))};
    }

    /** 系统拒绝观察仅用于控制器可读取而 helper 被拒绝的既有基线条目，启动前后独立查询控制器持有存储的真实解锁状态；私有端须证明实际读调用及前后解锁，随后核对正常退出与原值、公开 ACL 和属性均未变化。 */
    NSDictionary *readDenial(NSDictionary *request) {
        require(created && controllerReader && baselineAccount && [baselineAccount isEqual:account(request)]);
        SecKeychainStatus before = 0, after = 0;
        require(SecKeychainGetStatus(store.value, &before) == errSecSuccess && (before & kSecUnlockStateStatus));
        auto child = start(@{@"frame": [NSString stringWithFormat:@"V1 get %@ %@\n", request[@"profile"], request[@"version"]]}, false, false, true);
        const auto deadline = Clock::now() + std::chrono::milliseconds(3500);
        child->event('U', deadline);
        child->event('D', deadline);
        child->event('U', deadline);
        child->collect(deadline);
        require(child->code() == 0 && child->equals("V1 failed\n"));
        require(SecKeychainGetStatus(store.value, &after) == errSecSuccess && (after & kSecUnlockStateStatus));
        NSDictionary *proof = unchanged(request);
        return @{@"ok": @YES, @"readAttempted": @YES, @"osDenied": @YES,
            @"helperUnlockedBefore": @YES, @"helperUnlockedAfter": @YES,
            @"controllerUnlockedBefore": @YES, @"controllerUnlockedAfter": @YES,
            @"exitConfirmed": @YES, @"classifiedFailed": @YES,
            @"valueUnchanged": proof[@"valueUnchanged"], @"aclUnchanged": proof[@"aclUnchanged"],
            @"attributesUnchanged": proof[@"attributesUnchanged"]};
    }

    /** 权限拒绝负例使用真正的私有钥匙串条目，模板以测试 helper 身份创建后仅在夹具中增加或替换受测权限；生产程序永远不能调用这些修改入口，拒绝后的检查比较整个持久密文文件而不修复被拒绝的条目。 */
    void seed(NSDictionary *request) {
        require(created);
        NSString *name = account(request);
        NSData *key = [[NSData alloc] initWithBase64EncodedString:request[@"key"] options:0];
        require(key.length == 32);
        NSString *policy = request[@"policy"];
        require([@[@"broad", @"empty", @"any", @"second", @"owner", @"mixed", @"unknown", @"denied"] containsObject:policy]);
        Owned<SecTrustedApplicationRef> application;
        require(SecTrustedApplicationCreateFromPath([policy isEqual:@"denied"] ? nullptr : helper.c_str(), &application.value) == errSecSuccess);
        const void *value = application.value;
        Owned<CFArrayRef> applications(CFArrayCreate(nullptr, &value, 1, &kCFTypeArrayCallBacks));
        Owned<SecAccessRef> access;
        require(SecAccessCreate(CFSTR("VeriQ Runtime Vault v1"), applications.value, &access.value) == errSecSuccess);
        if (![policy isEqual:@"denied"]) {
            Owned<SecACLRef> extra;
            Owned<SecTrustedApplicationRef> other;
            Owned<CFArrayRef> principals;
            if ([policy isEqual:@"second"]) {
                require(SecTrustedApplicationCreateFromPath(nullptr, &other.value) == errSecSuccess);
                const void *principal = other.value;
                principals.value = CFArrayCreate(nullptr, &principal, 1, &kCFTypeArrayCallBacks);
                require(principals.value);
            }
            require(SecACLCreateWithSimpleContents(access.value, principals.value, CFSTR("VeriQ Runtime Vault v1"), 0, &extra.value) == errSecSuccess);
            CFArrayRef rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationDecrypt];
            if ([policy isEqual:@"empty"]) rights = (__bridge CFArrayRef)@[];
            if ([policy isEqual:@"any"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationAny];
            if ([policy isEqual:@"owner"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationChangeACL];
            if ([policy isEqual:@"mixed"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationDecrypt, (__bridge id)kSecACLAuthorizationKeychainItemRead];
            if ([policy isEqual:@"unknown"]) rights = (__bridge CFArrayRef)@[@"VERIQ_UNKNOWN_RIGHT"];
            require(SecACLUpdateAuthorizations(extra.value, rights) == errSecSuccess);
        }
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: name,
            (__bridge id)kSecUseKeychain: (__bridge id)store.value, (__bridge id)kSecAttrAccess: (__bridge id)access.value,
            (__bridge id)kSecValueData: key};
        require(SecItemAdd((__bridge CFDictionaryRef)query, nullptr) == errSecSuccess);
        controllerReader = [policy isEqual:@"denied"];
        inspect(request, baselineValue);
        require(baselineValue.bytes.size() == key.length && memcmp(baselineValue.bytes.data(), key.bytes, key.length) == 0);
        baselineState = snapshot(request);
        baselineAccount = name;
        baseline = ciphertext(path);
    }
    /** 单条负例的移除限定当前自有存储与固定产品服务，并重新验证账户作用域，避免循环测试中残留上一个被拒绝条目；这是控制器的夹具清理能力，生产 helper 仍须通过完整 ACL 验证才能执行自己的删除。 */
    void remove(NSDictionary *request) {
        require(created);
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: account(request),
            (__bridge id)kSecMatchSearchList: @[(__bridge id)store.value]};
        require(SecItemDelete((__bridge CFDictionaryRef)query) == errSecSuccess);
    }
};
}

/** 控制器正常 EOF 时只清理自身已经创建的测试存储，任何权限、会话或配置失败都以固定结果退出；进程被强制终止时可能保留加密夹具文件，这种情况必须作为未完成清理处理而不能宣称已撤销之前的系统修改。 */
int main(int argc, char **) {
    @autoreleasepool {
        Fixture fixture;
        try {
            DiagnosticGate startup(DiagnosticStage::STARTUP);
            require(argc == 1);
            rlimit core {0, 0}; require(startup.posix(setrlimit(RLIMIT_CORE, &core)) == 0);
            const auto pipeSignal = signal(SIGPIPE, SIG_IGN);
            signal(SIGCHLD, SIG_DFL);
            DiagnosticGate::enableOutput(pipeSignal != SIG_ERR);
            startup.pass();
            DiagnosticGate noUIStage(DiagnosticStage::NO_UI);
            NoUI noUI;
            noUIStage.pass();
            bool initialEnvelope = true;
            for (;;) {
                @autoreleasepool {
                    DiagnosticGate envelope(DiagnosticStage::RECEIVE, initialEnvelope);
                    NSDictionary *request = receive();
                    if (!request) { envelope.pass(); break; }
                    NSString *operation = request[@"operation"];
                    require([operation isKindOfClass:[NSString class]]);
                    envelope.pass(); initialEnvelope = false;
                    if ([operation isEqual:@"session"]) { send(sessionFacts()); continue; }
                    bool createReply = false;
                    if ([operation isEqual:@"create"]) { fixture.create(request[@"attestation"]); createReply = true; }
                    else if ([operation isEqual:@"run"]) { send(fixture.run(request)); continue; }
                    else if ([operation isEqual:@"race"]) { send(fixture.race(request)); continue; }
                    else if ([operation isEqual:@"lock"]) require(fixture.created && SecKeychainLock(fixture.store.value) == errSecSuccess);
                    else if ([operation isEqual:@"unlock"]) require(fixture.created && SecKeychainUnlock(fixture.store.value, static_cast<UInt32>(fixture.password.bytes.size()), fixture.password.bytes.data(), true) == errSecSuccess);
                    else if ([operation isEqual:@"seed"]) fixture.seed(request);
                    else if ([operation isEqual:@"remove"]) fixture.remove(request);
                    else if ([operation isEqual:@"unchanged"]) { send(fixture.unchanged(request)); continue; }
                    else if ([operation isEqual:@"read-denial"]) { send(fixture.readDenial(request)); continue; }
                    else if ([operation isEqual:@"cleanup"]) fixture.cleanup();
                    else require(false);
                    DiagnosticGate reply(DiagnosticStage::CREATE_REPLY, createReply);
                    send(@{@"ok": @YES});
                    reply.pass();
                }
            }
            fixture.cleanup();
            return 0;
        } catch (...) {
            try { send(@{@"ok": @NO}); } catch (...) {}
            try { NoUI noUI; fixture.cleanup(); } catch (...) {}
            return 2;
        }
    }
}
