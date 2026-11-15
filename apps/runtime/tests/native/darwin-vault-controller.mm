/** 专用钥匙串控制器只在操作者明确授权的可丢弃图形登录会话中创建随机自有存储，创建和删除可能改变该账户的持久偏好；普通流水线不会运行此入口，实际 UID 或会话事实本身不被当作可丢弃授权。 */
#include "../../native/vault/darwin-acl.hpp"
#include "../../native/vault/darwin-read-evidence.hpp"
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
    KEYCHAIN_STAT, CREATE_REPLY, CLEANUP_DELETE, CLEANUP_DIRECTORY, OP,
};
NSString *const diagnosticNames[] = {
    @"STARTUP", @"NO_UI", @"RECEIVE", @"CREATE_STATE", @"LIVE_UID_LOGIN",
    @"LIVE_SECURITY_SESSION", @"LIVE_SESSION_BITS", @"ATTEST_DISPOSABLE", @"ATTEST_ACK",
    @"ATTEST_UID", @"ATTEST_LOGIN", @"ATTEST_SESSION", @"HELPER_REALPATH", @"HELPER_NAME",
    @"HELPER_STAT", @"RANDOM", @"DIRECTORY", @"DIRECTORY_BIND", @"KEYCHAIN_CREATE", @"KEYCHAIN_PATH",
    @"KEYCHAIN_BIND", @"KEYCHAIN_MODE", @"KEYCHAIN_IDENTITY",
    @"KEYCHAIN_STAT", @"CREATE_REPLY", @"CLEANUP_DELETE", @"CLEANUP_DIRECTORY", @"OP",
};

/** 操作子阶段只在控制器内存中前进，进入和终态仍各写一条记录而不逐步输出；固定名称覆盖 seed、拒绝观察与首次移除的原有边界，不记录账户或密文，也不把尚未返回的调用推断成系统失败码。 */
enum class NativeSubstage {
    INPUT, ACCOUNT, KEY, POLICY, TRUSTED, ARRAY, ACCESS, EXTRA_TRUSTED, EXTRA_ARRAY,
    ACL, AUTH, ADD, HELPER_START, HELPER_COLLECT, HELPER_FRAME, HELPER_DECODE,
    READ, READ_TYPE, VALUE, SNAPSHOT_MATCH, SNAPSHOT_SHAPE, SNAPSHOT_ITEM, SNAPSHOT_ACCESS,
    SNAPSHOT_EXPORT, CIPHER_OPEN, CIPHER_STAT, CIPHER_READ, BASELINE, STATUS_BEFORE,
    EVENT_BEFORE, EVENT_DENIED, EVENT_AFTER, STATUS_AFTER, UNCHANGED_GUARD, DONE, ITEM_DELETE,
};
NSString *const nativeSubstageNames[] = {
    @"input", @"account", @"key", @"policy", @"trusted", @"array", @"access", @"extra-trusted", @"extra-array",
    @"acl", @"auth", @"add", @"helper-start", @"helper-collect", @"helper-frame", @"helper-decode",
    @"read", @"read-type", @"value", @"snapshot-match", @"snapshot-shape", @"snapshot-item", @"snapshot-access",
    @"snapshot-export", @"cipher-open", @"cipher-stat", @"cipher-read", @"baseline", @"status-before",
    @"event-before", @"event-denied", @"event-after", @"status-after", @"unchanged-guard", @"done", @"item-delete",
};
enum class NativeOperation { SEED, READ_DENIAL, REMOVE };
enum class NativeEventFailure { NONE, POLL_ERROR, READ_ERROR, EOF_CLOSED, MARKER, DEADLINE };
NSString *const nativeEventNames[] = {nil, @"poll-error", @"read-error", @"eof", @"marker", @"deadline"};

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
    NativeOperation operation = NativeOperation::SEED;
    NativeSubstage substage = NativeSubstage::INPUT;
    bool hasPredicate = false, predicateValue = false;
    NativeEventFailure eventFailure = NativeEventFailure::NONE;
    bool hasControllerReply = false;
    int controllerExit = -1;
    NSString *controllerReply = nil;
    void emit(NSString *state) noexcept {
        if (!enabled) return;
        const int savedErrno = errno;
        try {
            @try {
                {
                    NSMutableDictionary *record = [@{@"schemaVersion": @1,
                        @"stage": diagnosticNames[static_cast<size_t>(stage)], @"state": state} mutableCopy];
                    if (stage == DiagnosticStage::OP) {
                        record[@"nativeOperation"] = operation == NativeOperation::SEED ? @"seed" : operation == NativeOperation::READ_DENIAL ? @"read-denial" : @"remove";
                        record[@"substage"] = nativeSubstageNames[static_cast<size_t>(substage)];
                        if (hasControllerReply) {
                            record[@"controllerExit"] = controllerExit < 0 ? (id)@"NON_NORMAL_OR_UNKNOWN" : @(controllerExit);
                            record[@"controllerReply"] = controllerReply;
                        }
                        if (hasPredicate) record[@"predicate"] = @(predicateValue);
                        if (eventFailure != NativeEventFailure::NONE) record[@"eventFailure"] = nativeEventNames[static_cast<size_t>(eventFailure)];
                    }
                    if (hasStatus) record[@"osStatus"] = @(statusValue);
                    if (hasErrno) record[@"errno"] = @(errnoValue);
                    if (hasStore) { record[@"created"] = @(created); record[@"storeReferencePresent"] = @(storeReferencePresent); }
                    if (hasRegularFile) record[@"regularFile"] = @(regularFileValue);
                    if (hasOwnerMatches) record[@"ownerMatches"] = @(ownerMatchesValue);
                    if (hasPrivateMode) record[@"privateMode"] = @(privateModeValue);
                    writeRecord(record);
                }
            } @catch (...) {}
        } catch (...) {}
        errno = savedErrno;
    }
public:
    /** 所有阶段与读取诊断共享原有条数和字节预算，记录在父控制器内重建后才进入同一输出器；新增读取记录不另开日志通路，原来的等待缓冲、单行限制和信号安全启用条件保持一致。 */
    static void writeRecord(NSDictionary *record) noexcept {
        if (!record) return;
        const int savedErrno = errno;
        static size_t count = 0, total = 0;
        static NSMutableData *waiting = nil;
        try { @try {
            if (count < 96 && total < 8192) {
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
        } @catch (...) {} } catch (...) {}
        errno = savedErrno;
    }
    /** 启动记录先留在有限内存中，只有原先那次忽略 SIGPIPE 的设置确实成功后才允许写管道；这避免观察器在处理已关闭 stderr 时提前终止进程，不调整原信号调用顺序或增加新的系统调用。 */
    static void enableOutput(bool safe) noexcept { outputEnabled = safe; }
    /** 进入记录只使用编译期阶段和布尔开关，普通后续请求不启用初始接收观察；构造器不执行安全或文件操作，失败观察也不向调用方抛出新的异常或改变既有请求的处理顺序。 */
    explicit DiagnosticGate(DiagnosticStage value, bool active = true) noexcept : stage(value), enabled(active) { emit(@"entered"); }
    /** 析构只补充尚未通过阶段的失败事实，不推断系统调用是否修改了存储，也不尝试清理或重试；因此原有 catch 先回复拒绝再清理的顺序以及外层可能强杀进程的竞争窗口保持原样。 */
    ~DiagnosticGate() noexcept { if (!passed) emit(@"failed"); }
    /** 通过标志只在原谓词已通过后更新，移除终态保留当前删除阶段与真实返回码而其余操作仍清空到 done；日志失败不撤回业务结果，调用者仍须等待原控制协议回执和测试完成。 */
    void pass() noexcept { if (stage == DiagnosticStage::OP && operation != NativeOperation::REMOVE) step(this, NativeSubstage::DONE); passed = true; emit(@"passed"); }
    /** 每次被观察操作仅构造一次作用域，先写无结果入口再复用当前子阶段槽，首次移除由所属夹具传入接纳位；未接纳调用不输出，异常沿原路径展开，未收到终态仍保留未知而不猜测系统结果。 */
    explicit DiagnosticGate(NativeOperation value, bool active = true) noexcept : stage(DiagnosticStage::OP), enabled(active), operation(value),
        substage(value == NativeOperation::READ_DENIAL ? NativeSubstage::BASELINE : NativeSubstage::INPUT) { emit(@"entered"); }
    /** 前进子阶段只修改有限内存槽并清除上一步返回事实，不执行系统查询、分配或日志输出；共享帮助函数没有观察器时保持空操作，因此正常命令不会产生额外诊断或借用前次 seed 的事实。 */
    static void step(DiagnosticGate *gate, NativeSubstage value) noexcept {
        if (!gate) return;
        gate->substage = value;
        gate->hasStatus = gate->hasErrno = gate->hasPredicate = gate->hasControllerReply = false;
        gate->eventFailure = NativeEventFailure::NONE;
    }
    /** 收集完成后的退出及回复分类来自控制器已经持有的原对象，字节只在内存中分类且不复制进记录；该事实槽仅绑定 helper-frame 阶段，后续前进会清除，不填充 Node 未运行命令的 helper 字段。 */
    static void reply(DiagnosticGate *gate, int code, NSString *shape) noexcept {
        if (gate) { gate->hasControllerReply = true; gate->controllerExit = code; gate->controllerReply = shape; }
    }
    /** 原谓词的完整短路表达式只求值一次再原样返回，未执行的后续条件不产生单独事实；保留真值也允许随后内存分配抛错，从而不能把作用域失败误写成谓词本身已经返回假。 */
    static bool predicate(DiagnosticGate *gate, bool value) noexcept {
        if (gate) { gate->hasPredicate = true; gate->predicateValue = value; }
        return value;
    }
    /** 状态代理只包裹原本就会执行的 Security 调用返回值，没有观察器时直接交还数值；它不调用错误描述或重试，不改变原比较常量，后续原谓词仍然控制失败与短路执行方向。 */
    static OSStatus status(DiagnosticGate *gate, OSStatus value) noexcept { return gate ? gate->status(value) : value; }
    /** 文件调用返回原整数类型并仅在失败时保存即时 errno，每次成功会清除先前被 EINTR 重试的错误；循环读取、关闭次序和异常正文保持原样，正返回值不携带任何文件内容或身份事实。 */
    template <typename T> static T fileResult(DiagnosticGate *gate, T value) noexcept {
        if (gate) { gate->hasErrno = value < 0; if (value < 0) gate->errnoValue = errno; }
        return value;
    }
    /** 事件分类只使用本次原 poll 或 read 的返回值及原字节比较结果，类别由固定调用点提供而非输入文本；只有系统调用失败才保存即时 errno，EOF、错误标记和期限耗尽均不能伪造 helper 退出码。 */
    static void event(DiagnosticGate *gate, NativeEventFailure failure, bool syscall = false) noexcept {
        if (gate) { gate->eventFailure = failure; gate->hasErrno = syscall; if (syscall) gate->errnoValue = errno; }
    }
    /** 事件读取代理不追加读取且完整保留原读返回值，原来的等于一判断仍决定是否继续比较标记；负返回与 EOF 只产生有限失败类别，不导出读到的字节或将通道关闭解释为子进程正常退出。 */
    static ssize_t eventRead(DiagnosticGate *gate, ssize_t value) noexcept {
        if (value < 0) event(gate, NativeEventFailure::READ_ERROR, true);
        else if (value == 0) event(gate, NativeEventFailure::EOF_CLOSED);
        return value;
    }
    /** 标记比较只接收原短路链实际执行的相等布尔结果，错误时记录固定类别而不保存 expected 或实际字节；调用方的 require 继续抛出原来的异常，观察器不改变该事件的成功条件或等待期限。 */
    static bool eventMarker(DiagnosticGate *gate, bool value) noexcept { if (!value) event(gate, NativeEventFailure::MARKER); return value; }
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
Bytes ciphertext(const std::string &path, DiagnosticGate *gate = nullptr) {
    DiagnosticGate::step(gate, NativeSubstage::CIPHER_OPEN);
    const int fd = DiagnosticGate::fileResult(gate, open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
    require(fd >= 0);
    struct stat info {};
    DiagnosticGate::step(gate, NativeSubstage::CIPHER_STAT);
    if (DiagnosticGate::fileResult(gate, fstat(fd, &info)) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_size < 0 || info.st_size > 1048576) {
        close(fd); throw std::runtime_error("VAULT_FIXTURE_FILE_INVALID");
    }
    Bytes bytes(static_cast<size_t>(info.st_size));
    size_t offset = 0;
    DiagnosticGate::step(gate, NativeSubstage::CIPHER_READ);
    while (offset < bytes.size()) {
        ssize_t count = DiagnosticGate::fileResult(gate, read(fd, bytes.data() + offset, bytes.size() - offset));
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

/** 首次选择器只保存两个固定测试模式的接纳位，未选中调用不占用额度且后续同类调用不再开通道；自测直接驱动这一实例以证明每夹具最多两次，不能把后来未采集的读取误写成已经观测。 */
class ReadAdmission {
    bool inspected = false, denied = false;
public:
    /** 接纳只改变内存布尔位并返回是否属于第一次合法模式，两个模式同时出现或同时缺失不会被接受；该选择发生在原 helper 启动路径中，不依赖查询结果、协议输出或外部输入中的序号。 */
    bool take(bool inspection, bool denial) noexcept {
        if (inspection == denial) return false;
        bool &used = inspection ? inspected : denied;
        if (used) return false;
        used = true;
        return true;
    }
};

/** 控制器私有读取通道在原四组端点之后分配并将双方复制到五以上空闲编号，新增描述符不会覆盖配置或屏障；创建失败只留下缺失证据，不向原启动路径抛错或增加等待与重试。 */
class ReadChannel {
    int reader = -1, writer = -1;
    bool selected = false, denial = false, eof = false, bad = false, finished = false;
    unsigned char bytes[513] {};
    size_t used = 0;
    /** 解码只接受严格数字、布尔及阶段前缀并重新构建有限字典，额外字段或读取类型不匹配全部拒绝；原始包永不交给日志，Foundation 异常仅影响诊断可用性而不能改变控制器业务错误。 */
    NSDictionary *decode() {
        if (!used || used > 512 || bytes[used - 1] != '\n') return nil;
        for (size_t index = 0; index + 1 < used; ++index) if (bytes[index] == '\n') return nil;
        id raw = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:bytes length:used - 1] options:0 error:nullptr];
        if (![raw isKindOfClass:[NSDictionary class]]) return nil;
        NSDictionary *value = raw;
        if (![value[@"source"] isEqual:@"TEST_HELPER"] || ![value[@"read"] isEqual:denial ? @"denial" : @"inspection"]) return nil;
        NSString *phase = value[@"phase"];
        NSArray *common = @[@"entry", @"no-ui", @"store", @"status", @"permission", @"account", @"dispatch"];
        NSArray *phases = denial ? @[@"channel", @"before", @"read", @"after", @"done"] : @[@"read", @"array", @"unique", @"data32", @"encoding", @"done"];
        const bool lookupFlow = value[@"lookupStatus"] != nil || [phase isEqual:@"lookup"];
        if (lookupFlow) phases = denial ? @[@"lookup", @"array", @"unique", @"before", @"read", @"after", @"done"] : @[@"lookup", @"array", @"unique", @"read", @"data32", @"encoding", @"done"];
        if (![phase isKindOfClass:[NSString class]] || (![phases containsObject:phase] && (lookupFlow || ![common containsObject:phase]))) return nil;
        NSMutableArray *fields = [NSMutableArray array];
        NSString *optional = nil;
        /** 新流程先接受同次元数据查询的数组和完整唯一目标谓词，再允许独立秘密读取状态出现；旧记录没有查询槽时仍使用原来的阶段前缀，查询失败或形状失败绝不被补成授权拒绝事实。 */
        if (lookupFlow) {
            [fields addObject:@"lookupStatus"];
            if (![phase isEqual:@"lookup"]) {
                if (![value[@"lookupStatus"] isEqual:@0]) return nil;
                NSArray *predicates = @[@"array", @"unique"];
                const NSUInteger position = [predicates indexOfObject:phase];
                const NSUInteger index = position == NSNotFound ? 2 : position;
                for (NSUInteger n = 0; n < std::min(index + 1, static_cast<NSUInteger>(2)); ++n) {
                    NSString *key = predicates[n];
                    if (n < index && value[key] != (__bridge id)kCFBooleanTrue) return nil;
                    if (value[key]) [fields addObject:key];
                    else if (n < index) return nil;
                }
            }
            if (!denial && [@[@"read", @"data32", @"encoding", @"done"] containsObject:phase]) {
                [fields addObject:@"readStatus"];
                NSArray *predicates = @[@"data32", @"encoding"];
                const NSUInteger index = [phase isEqual:@"done"] ? 2 : [predicates indexOfObject:phase];
                if (index != NSNotFound) {
                    if (![value[@"readStatus"] isEqual:@0]) return nil;
                    for (NSUInteger n = 0; n < std::min(index + 1, static_cast<NSUInteger>(2)); ++n) {
                        NSString *key = predicates[n];
                        if (n < index && value[key] != (__bridge id)kCFBooleanTrue) return nil;
                        if (value[key]) [fields addObject:key];
                        else if (n < index) return nil;
                    }
                }
            }
        }
        if (denial) {
            if ([@[@"before", @"read", @"after", @"done"] containsObject:phase]) [fields addObject:@"beforeStatus"];
            if ([@[@"read", @"after", @"done"] containsObject:phase]) [fields addObject:@"readStatus"];
            if ([@[@"after", @"done"] containsObject:phase]) [fields addObject:@"afterStatus"];
            if ([phase isEqual:@"done"]) [fields addObjectsFromArray:@[@"unlockedBefore", @"unlockedAfter"]];
        } else if (!lookupFlow) {
            if ([phases containsObject:phase]) [fields addObject:@"readStatus"];
            NSArray *predicates = @[@"array", @"unique", @"data32", @"encoding"];
            const NSUInteger index = [phase isEqual:@"done"] ? 4 : [predicates indexOfObject:phase];
            if (index != NSNotFound) {
                if (![value[@"readStatus"] isEqual:@0]) return nil;
                for (NSUInteger n = 0; n < std::min(index + 1, static_cast<NSUInteger>(4)); ++n) {
                    NSString *key = predicates[n];
                    if (n < index && value[key] != (__bridge id)kCFBooleanTrue) return nil;
                    if (value[key]) [fields addObject:key];
                    else if (n < index) return nil;
                }
            }
        }
        if ([phase isEqual:@"lookup"]) optional = @"lookupStatus";
        if ([phase isEqual:@"before"]) optional = @"beforeStatus";
        if ([phase isEqual:@"read"]) optional = @"readStatus";
        if ([phase isEqual:@"after"]) optional = @"afterStatus";
        for (id key in value) if (![@[@"source", @"read", @"phase"] containsObject:key] && ![fields containsObject:key]) return nil;
        NSMutableDictionary *safe = [@{@"source": @"TEST_HELPER", @"phase": phase} mutableCopy];
        for (NSString *key in fields) {
            id number = value[key];
            if (!number) { if ([key isEqual:optional]) continue; return nil; }
            if (![number isKindOfClass:[NSNumber class]]) return nil;
            const bool boolean = CFGetTypeID((__bridge CFTypeRef)number) == CFBooleanGetTypeID();
            if ([key hasSuffix:@"Status"]) {
                const double actual = [number doubleValue];
                if (boolean || actual < INT32_MIN || actual > INT32_MAX || actual != [number longLongValue]) return nil;
                safe[key] = @([number intValue]);
            } else {
                if (!boolean) return nil;
                safe[key] = @([number boolValue]);
            }
        }
        if (([safe[@"unlockedBefore"] isEqual:@YES] && ![safe[@"beforeStatus"] isEqual:@0]) ||
            ([safe[@"unlockedAfter"] isEqual:@YES] && ![safe[@"afterStatus"] isEqual:@0])) return nil;
        return safe;
    }
public:
    /** 默认通道没有任何已分配资源也没有隐含选择，普通 helper 调用因此保持原有文件描述符集合；只有首次模式选择之后的 prepare 才尝试建立私有传输，失败仍留在同一个对象中结算。 */
    ReadChannel() = default;
    ReadChannel(const ReadChannel &) = delete;
    /** 单个夹具的首次 admission 由 Fixture 决定，通道仅负责该次选中启动的描述符生命周期；两端非阻塞和 CLOEXEC 先配置完成才交付，任何中途错误都关闭已分配端点并恢复原 errno。 */
    void prepare(bool denied) noexcept {
        selected = true; denial = denied;
        const int saved = errno;
        int pair[2] {-1, -1};
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0) {
            reader = fcntl(pair[0], F_DUPFD_CLOEXEC, 5);
            writer = fcntl(pair[1], F_DUPFD_CLOEXEC, 5);
            close(pair[0]); close(pair[1]);
            if (reader < 0 || writer < 0 || fcntl(reader, F_SETFL, O_NONBLOCK) < 0 || fcntl(writer, F_SETFL, O_NONBLOCK) < 0) {
                if (reader >= 0) close(reader);
                if (writer >= 0) close(writer);
                reader = writer = -1;
            }
        }
        errno = saved;
    }
    /** 子进程仅保留本次动态写端且清除其执行关闭标志，其余父端仍由既有关闭循环处理；编号由内核分配且不参与零到四的 dup2 映射，所以新增能力不能重用或覆盖现有控制流。 */
    int childWriter() const noexcept { return writer; }
    /** 父进程在 fork 后立即关闭自身写端，让 helper 显式发送并关闭后能够观察到正常 EOF；无效端点保持空操作，单次关闭将槽归零以避免后续析构误关系统复用的编号。 */
    void closeWriter() noexcept { const int saved = errno; if (writer >= 0) close(writer); writer = -1; errno = saved; }
    /** 每次现有事件或收集边界最多尝试两次非阻塞读取，总缓冲最多五百一十三字节以检测超长；没有新增 poll、睡眠或 EOF 等待，已满缓冲直接判拒绝且所有系统错误都恢复调用前 errno。 */
    void drain() noexcept {
        if (reader < 0 || eof || bad || finished) return;
        const int saved = errno;
        for (int attempt = 0; attempt < 2 && !eof && !bad; ++attempt) {
            const ssize_t count = recv(reader, bytes + used, sizeof(bytes) - used, MSG_DONTWAIT);
            if (count > 0) { used += static_cast<size_t>(count); if (used == sizeof(bytes)) bad = true; }
            else if (count == 0) eof = true;
            else { if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) bad = true; break; }
        }
        errno = saved;
    }
    /** 终态只返回来源明确的有限记录，已接纳但尚无 EOF 的数据标记不完整而不是猜测 helper 状态；解析异常与多包额外字节直接拒绝，原包随后覆盖，调用方最多输出一次且不救援业务结果。 */
    NSDictionary *finish() noexcept {
        if (!selected || finished) return nil;
        const int saved = errno;
        NSDictionary *result = nil;
        drain(); finished = true;
        try {
            @try {
                NSDictionary *helper = (!bad && eof && used) ? decode() : nil;
                const bool truncated = used && bytes[used - 1] != '\n';
                NSString *transport = bad || (eof && used && !helper && !truncated) ? @"REJECTED" : helper ? @"AVAILABLE" : used ? @"INCOMPLETE" : @"MISSING";
                NSMutableDictionary *record = [@{@"schemaVersion": @1, @"stage": @"HR", @"state": @"observed", @"source": @"NATIVE_CONTROLLER",
                    @"read": denial ? @"denial" : @"inspection", @"admission": @"FIRST", @"transport": transport} mutableCopy];
                if (helper) record[@"helper"] = helper;
                result = record;
            } @catch (...) {}
        } catch (...) {}
        wipe(bytes, sizeof(bytes));
        errno = saved;
        return result;
    }
    /** 析构只释放仍属于当前通道的端点并覆盖最多五百一十三字节的候选缓冲，不运行任何业务清理；终态由 Child 在原始关闭和回收之前结算，因此不会为了诊断延长 helper 的原退出期限。 */
    ~ReadChannel() noexcept {
        const int saved = errno;
        if (reader >= 0) close(reader);
        if (writer >= 0) close(writer);
        wipe(bytes, sizeof(bytes));
        errno = saved;
    }
};

/** 单个测试子进程的句柄保存真实 fork 关系和所有私有端点，析构先结束输入再有界等待退出；若内核尚未确认退出，PID 仍留在控制器的所有权集合中并阻止删除存储，不能把已发送终止信号写成清理成功。 */
struct Child {
    std::set<pid_t> &owners;
    pid_t pid = -1;
    int input = -1, output = -1, control = -1, status = 0;
    bool exited = false, waitLost = false;
    Secret response;
    ReadChannel evidence;
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
        DiagnosticGate::writeRecord(evidence.finish());
        if (input >= 0) close(input);
        if (output >= 0) close(output);
        if (control >= 0) close(control);
        reap(true);
    }
    /** 退出码只从已经 waitpid 确认的正常退出状态提取，信号死亡或未确认退出统一保留独立的负值；该值供测试判断是否收到完整回复，不把信号请求、EOF 关闭或成功写入管道当成系统操作成功。 */
    int code() const { return exited && WIFEXITED(status) ? WEXITSTATUS(status) : -1; }
    /** 回复分类仅检查现有完整缓冲的有限形状，不解码或导出密钥；OK_FRAME_SHAPE 与原帧谓词相同只表示长度和边界符合，编码是否合法仍由原来的后续解析器决定。 */
    NSString *replyClass() const noexcept {
        if (response.bytes.empty()) return @"EMPTY";
        if (response.bytes.size() == 50 && memcmp(response.bytes.data(), "V1 ok ", 6) == 0 && response.bytes.back() == '\n') return @"OK_FRAME_SHAPE";
        for (const char *value : {"V1 ok\n", "V1 ready\n", "V1 missing\n", "V1 locked\n", "V1 unavailable\n", "V1 failed\n", "V1 mutation-unconfirmed\n"}) if (equals(value)) return @"KNOWN_V1_STATUS";
        return @"OTHER";
    }
    /** 屏障确认只读取当前 child 的私有控制套接字并受共享单调时钟期限约束，错误字节和提前关闭都导致测试失败；调用点只期待真实缺失后的就绪标记，不通过轮询钥匙串或等待固定时间猜测竞争窗口。 */
    void event(char expected, Clock::time_point deadline, DiagnosticGate *gate = nullptr) {
        while (Clock::now() < deadline) {
            evidence.drain();
            pollfd watched {control, POLLIN, 0};
            const int ready = poll(&watched, 1, 25);
            if (ready < 0 && errno == EINTR) continue;
            if (ready < 0) DiagnosticGate::event(gate, NativeEventFailure::POLL_ERROR, true);
            require(ready >= 0);
            if (!ready) continue;
            char value = 0;
            require(DiagnosticGate::eventRead(gate, read(control, &value, 1)) == 1 && DiagnosticGate::eventMarker(gate, value == expected));
            return;
        }
        DiagnosticGate::event(gate, NativeEventFailure::DEADLINE);
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
            evidence.drain();
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
        evidence.drain();
        require(eof && exited);
    }
    /** 响应相等先比较全部长度再比较全部字节，调用方只传入固定状态文本或留在内存中的期望密钥编码；这里只返回布尔结果，不生成包含实际材料的差异对象，因此断言失败不会把秘密内容打印到测试日志。 */
    bool equals(const char *value) const {
        return response.bytes.size() == strlen(value) && memcmp(response.bytes.data(), value, response.bytes.size()) == 0;
    }
};

/** 无存储自测只创建匿名本地套接字并调用实际共用写入器和控制器读端，有限坏包与背压验证不触发任何 Security API；只有全部断言通过才写固定成功标记，构建驱动还须核对真实退出和精确输出。 */
int readEvidenceSelftest() {
    try {
        const auto config = [](int fd, bool denied = false) {
            return @{@"mode": @"store", @"inspection": @(!denied), @"observeReadDenial": @(denied), @"readEvidenceFd": @(fd)};
        };
        const auto check = [](bool value) { if (!value) throw std::runtime_error("READ_EVIDENCE_SELFTEST_FAILED"); };
        {
            ReadAdmission admission;
            check(!admission.take(false, false) && !admission.take(true, true));
            check(admission.take(true, false) && !admission.take(true, false));
            check(admission.take(false, true) && !admission.take(false, true));
        }
        {
            ReadChannel channel; channel.prepare(false);
            const int writer = fcntl(channel.childWriter(), F_DUPFD_CLOEXEC, 5);
            check(writer >= 5); channel.closeWriter();
            test::ReadEvidence observation(config(writer));
            observation.status(test::ReadPhase::READ, 0);
            observation.predicate(test::ReadPhase::ARRAY, true);
            observation.predicate(test::ReadPhase::UNIQUE, true);
            observation.predicate(test::ReadPhase::DATA32, true);
            observation.predicate(test::ReadPhase::ENCODING, true);
            observation.step(test::ReadPhase::DONE);
            errno = EDOM; observation.emit(); check(errno == EDOM);
            NSDictionary *record = channel.finish();
            check([record[@"transport"] isEqual:@"AVAILABLE"] && [record[@"helper"][@"encoding"] isEqual:@YES]);
            check(channel.finish() == nil);
        }
        {
            ReadChannel channel; channel.prepare(true);
            const int writer = fcntl(channel.childWriter(), F_DUPFD_CLOEXEC, 5);
            check(writer >= 5); channel.closeWriter();
            test::ReadEvidence observation(config(writer, true));
            observation.status(test::ReadPhase::BEFORE, 0);
            observation.status(test::ReadPhase::READ, -25293);
            observation.status(test::ReadPhase::AFTER, 0);
            observation.unlocked(true, true); observation.emit();
            NSDictionary *record = channel.finish();
            check([record[@"transport"] isEqual:@"AVAILABLE"] && [record[@"helper"][@"readStatus"] isEqual:@(-25293)]);
        }
        /** 每个独立观察器重新从查询阶段开始，分别覆盖元数据错误、形状拒绝、真实读取槽及完整终态；这些合成状态仅验证实际写入器和解码器的来源分离，不调用 Security 或宣称本机系统授权成功。 */
        for (bool denied : {false, true}) for (int variant = 0; variant < 7; ++variant) {
            ReadChannel channel; channel.prepare(denied);
            const int writer = fcntl(channel.childWriter(), F_DUPFD_CLOEXEC, 5);
            check(writer >= 5); channel.closeWriter();
            test::ReadEvidence observation(config(writer, denied));
            observation.step(test::ReadPhase::LOOKUP);
            if (variant > 0) observation.status(test::ReadPhase::LOOKUP, variant == 1 ? -25293 : 0);
            if (variant > 1) observation.predicate(test::ReadPhase::ARRAY, variant != 2);
            if (variant > 2) observation.predicate(test::ReadPhase::UNIQUE, variant != 3);
            if (variant > 3) {
                if (denied) observation.status(test::ReadPhase::BEFORE, 0);
                observation.status(test::ReadPhase::READ, variant == 4 ? -50 : denied ? -25293 : 0);
                if (variant > 4) {
                    if (denied) {
                        observation.status(test::ReadPhase::AFTER, 0);
                        observation.unlocked(true, true);
                    } else {
                        observation.predicate(test::ReadPhase::DATA32, variant != 5);
                        if (variant == 6) {
                            observation.predicate(test::ReadPhase::ENCODING, true);
                            observation.step(test::ReadPhase::DONE);
                        }
                    }
                }
            }
            observation.emit();
            NSDictionary *record = channel.finish();
            NSDictionary *facts = record[@"helper"];
            check([record[@"transport"] isEqual:@"AVAILABLE"]);
            check(variant == 0 ? !facts[@"lookupStatus"] : [facts[@"lookupStatus"] isEqual:@(variant == 1 ? -25293 : 0)]);
            if (variant < 4) check(!facts[@"readStatus"] && !facts[@"beforeStatus"] && !facts[@"unlockedBefore"]);
            else check([facts[@"readStatus"] isEqual:@(variant == 4 ? -50 : denied ? -25293 : 0)]);
            if (variant == 6) check([facts[@"unique"] isEqual:@YES] && [facts[denied ? @"unlockedAfter" : @"encoding"] isEqual:@YES]);
        }
        for (bool denied : {false, true}) for (NSDictionary *invalid in @[
            @{@"phase": @"lookup", @"lookupStatus": @(-25293), @"readStatus": @(-25293)},
            @{@"phase": @"array", @"lookupStatus": @(-50), @"array": @NO},
            @{@"phase": @"unique", @"lookupStatus": @0, @"array": @NO, @"unique": @YES},
            @{@"phase": @"read", @"lookupStatus": @0, @"array": @YES, @"unique": @NO, @"readStatus": @(-25293)},
            @{@"phase": @"lookup", @"lookupStatus": @YES},
            @{@"phase": @"lookup", @"lookupStatus": @"0"},
            @{@"phase": @"lookup", @"lookupStatus": @0, @"key": @"SECRET_CANARY"}
        ]) {
            ReadChannel channel; channel.prepare(denied);
            NSMutableDictionary *record = [invalid mutableCopy];
            record[@"source"] = @"TEST_HELPER"; record[@"read"] = denied ? @"denial" : @"inspection";
            NSData *json = [NSJSONSerialization dataWithJSONObject:record options:0 error:nullptr];
            check(json && json.length < 512);
            NSMutableData *line = [json mutableCopy]; [line appendBytes:"\n" length:1];
            test::writeReadPacket(channel.childWriter(), line.bytes, line.length); channel.closeWriter();
            NSDictionary *result = channel.finish();
            check([result[@"transport"] isEqual:@"REJECTED"] && !result[@"helper"]);
        }
        const char *valid = "{\"read\":\"inspection\",\"source\":\"TEST_HELPER\",\"phase\":\"entry\"}\n";
        for (int variant = 0; variant < 8; ++variant) {
            ReadChannel channel; channel.prepare(false); check(channel.childWriter() >= 5);
            if (variant == 0) test::writeReadPacket(channel.childWriter(), "{}\n", 3);
            if (variant == 1) {
                const std::string extra = std::string(valid) + valid;
                test::writeReadPacket(channel.childWriter(), extra.data(), extra.size());
            }
            if (variant == 2) {
                const std::string overlong(512, 'x');
                test::writeReadPacket(channel.childWriter(), overlong.data(), overlong.size());
                test::writeReadPacket(channel.childWriter(), "\n", 1);
            }
            if (variant == 3) test::writeReadPacket(channel.childWriter(), "{", 1);
            if (variant == 5) test::writeReadPacket(channel.childWriter(), valid, strlen(valid));
            if (variant == 6) {
                const char *extra = "{\"read\":\"inspection\",\"source\":\"TEST_HELPER\",\"phase\":\"entry\",\"key\":\"SECRET_CANARY\"}\n";
                test::writeReadPacket(channel.childWriter(), extra, strlen(extra));
            }
            if (variant == 7) {
                const std::string extra = std::string(valid) + " \n";
                test::writeReadPacket(channel.childWriter(), extra.data(), extra.size());
            }
            if (variant != 5) channel.closeWriter();
            errno = ERANGE;
            NSDictionary *record = channel.finish(); check(errno == ERANGE);
            NSString *expected = variant == 4 ? @"MISSING" : (variant == 3 || variant == 5) ? @"INCOMPLETE" : @"REJECTED";
            check([record[@"transport"] isEqual:expected] && !record[@"helper"]);
        }
        {
            Pair sockets(true);
            const int writer = fcntl(sockets.fd[1], F_DUPFD_CLOEXEC, 5);
            check(writer >= 5 && fcntl(writer, F_SETFL, O_NONBLOCK) == 0);
            close(sockets.take(0)); close(sockets.take(1));
            test::ReadEvidence observation(config(writer));
            const bool original = false; errno = EDOM; observation.emit();
            check(!original && errno == EDOM);
            const int sentinel = 7;
            bool caught = false;
            try {
                test::ReadEvidence missing(config(-1));
                throw &sentinel;
            } catch (const int *identity) { caught = identity == &sentinel; }
            check(caught);
        }
        {
            ReadChannel channel; channel.prepare(false);
            const int writer = fcntl(channel.childWriter(), F_DUPFD_CLOEXEC, 5);
            check(writer >= 5);
            const unsigned char filler[512] {};
            bool full = false;
            for (int attempt = 0; attempt < 4096; ++attempt) {
                if (::send(writer, filler, sizeof(filler), MSG_DONTWAIT) < 0) { full = errno == EAGAIN || errno == EWOULDBLOCK; break; }
            }
            check(full); channel.closeWriter();
            test::ReadEvidence observation(config(writer));
            const bool original = true; errno = ERANGE; observation.emit();
            check(original && errno == ERANGE);
            check([channel.finish()[@"transport"] isEqual:@"REJECTED"]);
        }
        {
            std::set<pid_t> owners;
            Child child(owners);
            check(child.code() == -1 && [child.replyClass() isEqual:@"EMPTY"]);
            child.exited = true; child.status = 2 << 8; check(child.code() == 2);
            child.status = 0; check(child.code() == 0);
            child.status = SIGKILL; check(child.code() == -1);
            const auto response = [&](const std::string &text) { child.response.bytes.assign(text.begin(), text.end()); };
            response("V1 failed\n"); check([child.replyClass() isEqual:@"KNOWN_V1_STATUS"]);
            response("V1 ok " + std::string(43, 'A') + "\n"); check([child.replyClass() isEqual:@"OK_FRAME_SHAPE"]);
            response("V1 invalid\n"); check([child.replyClass() isEqual:@"OTHER"]);
        }
        const char marker[] = "DARWIN_READ_EVIDENCE_SELFTEST_PASSED\n";
        return write(1, marker, sizeof(marker) - 1) == sizeof(marker) - 1 ? 0 : 2;
    } catch (...) { return 2; }
}

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
    ReadAdmission readAdmission;
    bool removeObserved = false;
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
        NSMutableDictionary *configuration = [@{ @"mode": @"store", @"disposable": @YES, @"uid": facts[@"uid"],
            @"session": facts[@"session"], @"parent": @(getpid()), @"path": [NSString stringWithUTF8String:path.c_str()],
            @"fault": request[@"fault"] ?: @"", @"barrier": @(barrier), @"inspection": @(inspection),
            @"observeReadDenial": @(observeReadDenial) } mutableCopy];
        Pair input, output, configurationPipe, barrierPipe(true);
        auto child = std::make_unique<Child>(children);
        if (readAdmission.take(inspection, observeReadDenial)) {
            child->evidence.prepare(observeReadDenial);
            if (child->evidence.childWriter() >= 5) {
                const int saved = errno;
                @try { configuration[@"readEvidenceFd"] = @(child->evidence.childWriter()); } @catch (...) {}
                errno = saved;
            }
        }
        NSData *capability = [NSJSONSerialization dataWithJSONObject:configuration options:0 error:nullptr];
        require(capability && capability.length < 4096);
        child->pid = fork();
        require(child->pid >= 0);
        if (child->pid == 0) {
            if (dup2(input.fd[0], 0) < 0 || dup2(output.fd[1], 1) < 0 ||
                dup2(configurationPipe.fd[0], 3) < 0 || dup2(barrierPipe.fd[1], 4) < 0) _exit(2);
            const int null = open("/dev/null", O_WRONLY);
            if (null < 0 || dup2(null, 2) < 0) _exit(2);
            const int diagnostic = child->evidence.childWriter();
            if (diagnostic >= 5 && fcntl(diagnostic, F_SETFD, 0) < 0) close(diagnostic);
            for (int fd = 5; fd < getdtablesize(); ++fd) if (fd != diagnostic) close(fd);
            char pathEnvironment[] = "PATH=/usr/bin:/bin";
            char *environment[] = {pathEnvironment, nullptr};
            char *arguments[] = {const_cast<char *>(helper.c_str()), nullptr};
            execve(helper.c_str(), arguments, environment);
            _exit(2);
        }
        child->evidence.closeWriter();
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
    ItemSnapshot snapshot(NSDictionary *request, DiagnosticGate *gate = nullptr) {
        DiagnosticGate::step(gate, NativeSubstage::SNAPSHOT_MATCH);
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: account(request),
            (__bridge id)kSecMatchSearchList: @[(__bridge id)store.value],
            (__bridge id)kSecReturnRef: @YES, (__bridge id)kSecReturnAttributes: @YES,
            (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitAll};
        Owned<CFTypeRef> result;
        require(DiagnosticGate::status(gate, SecItemCopyMatching((__bridge CFDictionaryRef)query, &result.value)) == errSecSuccess);
        DiagnosticGate::step(gate, NativeSubstage::SNAPSHOT_SHAPE);
        require(DiagnosticGate::predicate(gate, result.value && CFGetTypeID(result.value) == CFArrayGetTypeID() && CFArrayGetCount(static_cast<CFArrayRef>(result.value)) == 1));
        CFTypeRef raw = CFArrayGetValueAtIndex(static_cast<CFArrayRef>(result.value), 0);
        require(DiagnosticGate::predicate(gate, raw && CFGetTypeID(raw) == CFDictionaryGetTypeID()));
        DiagnosticGate::step(gate, NativeSubstage::SNAPSHOT_ITEM);
        CFTypeRef item = CFDictionaryGetValue(static_cast<CFDictionaryRef>(raw), kSecValueRef);
        require(DiagnosticGate::predicate(gate, item && CFGetTypeID(item) == SecKeychainItemGetTypeID()));
        Owned<SecAccessRef> access;
        DiagnosticGate::step(gate, NativeSubstage::SNAPSHOT_ACCESS);
        require(DiagnosticGate::status(gate, SecKeychainItemCopyAccess(static_cast<SecKeychainItemRef>(const_cast<void *>(item)), &access.value)) == errSecSuccess);
        DiagnosticGate::step(gate, NativeSubstage::SNAPSHOT_EXPORT);
        NSMutableDictionary *attributes = [(__bridge NSDictionary *)raw mutableCopy];
        [attributes removeObjectForKey:(__bridge id)kSecValueRef];
        ItemSnapshot value;
        value.attributes = [attributes copy]; value.policy = accessSnapshot(access.value);
        return value;
    }

    /** 秘密材料的独立读回由 ACL 实际允许的夹具主体执行，普通负例使用同一测试 helper 的只读检查而拒绝 helper 的负例使用控制器；任何系统读取错误直接使证明失败，不能把只看到密文文件未变当作值已经核验。 */
    void inspect(NSDictionary *request, Secret &value, DiagnosticGate *gate = nullptr) {
        if (controllerReader) {
            DiagnosticGate::step(gate, NativeSubstage::READ);
            NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
                (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: account(request),
                (__bridge id)kSecMatchSearchList: @[(__bridge id)store.value], (__bridge id)kSecReturnData: @YES};
            Owned<CFTypeRef> result;
            require(DiagnosticGate::status(gate, SecItemCopyMatching((__bridge CFDictionaryRef)query, &result.value)) == errSecSuccess);
            DiagnosticGate::step(gate, NativeSubstage::READ_TYPE);
            require(DiagnosticGate::predicate(gate, result.value && CFGetTypeID(result.value) == CFDataGetTypeID() && CFDataGetLength(static_cast<CFDataRef>(result.value)) == 32));
            value.bytes.resize(32);
            memcpy(value.bytes.data(), CFDataGetBytePtr(static_cast<CFDataRef>(result.value)), 32);
        } else {
            DiagnosticGate::step(gate, NativeSubstage::HELPER_START);
            auto child = start(@{@"frame": [NSString stringWithFormat:@"V1 get %@ %@\n", request[@"profile"], request[@"version"]]}, false, true);
            DiagnosticGate::step(gate, NativeSubstage::HELPER_COLLECT);
            child->collect(Clock::now() + std::chrono::milliseconds(3500));
            DiagnosticGate::step(gate, NativeSubstage::HELPER_FRAME);
            DiagnosticGate::reply(gate, child->code(), child->replyClass());
            require(DiagnosticGate::predicate(gate, child->code() == 0 && child->response.bytes.size() == 50 && memcmp(child->response.bytes.data(), "V1 ok ", 6) == 0 && child->response.bytes.back() == '\n'));
            DiagnosticGate::step(gate, NativeSubstage::HELPER_DECODE);
            NSString *encoded = [[NSString alloc] initWithBytes:child->response.bytes.data() + 6 length:43 encoding:NSASCIIStringEncoding];
            encoded = [[[encoded stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"] stringByAppendingString:@"="];
            NSData *decoded = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
            require(DiagnosticGate::predicate(gate, decoded.length == 32));
            value.bytes.resize(32); memcpy(value.bytes.data(), decoded.bytes, 32);
        }
    }

    /** 拒绝前后的证明同时比较真实解密字节、完整公开 ACL 表示及非秘密属性，主密文文件比较仅作为附加事实；测试持有最初账户绑定并拒绝替换 scope，因此无法用读取另一个未变化条目来掩盖目标的修改。 */
    NSDictionary *unchanged(NSDictionary *request, DiagnosticGate *gate = nullptr) {
        DiagnosticGate::step(gate, NativeSubstage::UNCHANGED_GUARD);
        require(DiagnosticGate::predicate(gate, created && baselineAccount && [baselineAccount isEqual:account(request)]));
        Secret current;
        inspect(request, current, gate);
        const ItemSnapshot state = snapshot(request, gate);
        return @{@"ok": @YES, @"valueUnchanged": @(current.bytes == baselineValue.bytes),
            @"aclUnchanged": @(state.policy == baselineState.policy),
            @"attributesUnchanged": @([state.attributes isEqualToDictionary:baselineState.attributes]),
            @"primaryCiphertextUnchanged": @(baseline == ciphertext(path, gate))};
    }

    /** 系统拒绝观察仅用于控制器可读取而 helper 被拒绝的既有基线条目，启动前后独立查询控制器持有存储的真实解锁状态；私有端须证明实际读调用及前后解锁，随后核对正常退出与原值、公开 ACL 和属性均未变化。 */
    NSDictionary *readDenial(NSDictionary *request) {
        DiagnosticGate observation(NativeOperation::READ_DENIAL);
        DiagnosticGate *gate = &observation;
        require(DiagnosticGate::predicate(gate, created && controllerReader && baselineAccount && [baselineAccount isEqual:account(request)]));
        SecKeychainStatus before = 0, after = 0;
        DiagnosticGate::step(gate, NativeSubstage::STATUS_BEFORE);
        require(DiagnosticGate::status(gate, SecKeychainGetStatus(store.value, &before)) == errSecSuccess && (before & kSecUnlockStateStatus));
        DiagnosticGate::step(gate, NativeSubstage::HELPER_START);
        auto child = start(@{@"frame": [NSString stringWithFormat:@"V1 get %@ %@\n", request[@"profile"], request[@"version"]]}, false, false, true);
        const auto deadline = Clock::now() + std::chrono::milliseconds(3500);
        DiagnosticGate::step(gate, NativeSubstage::EVENT_BEFORE);
        child->event('U', deadline, gate);
        DiagnosticGate::step(gate, NativeSubstage::EVENT_DENIED);
        child->event('D', deadline, gate);
        DiagnosticGate::step(gate, NativeSubstage::EVENT_AFTER);
        child->event('U', deadline, gate);
        DiagnosticGate::step(gate, NativeSubstage::HELPER_COLLECT);
        child->collect(deadline);
        DiagnosticGate::step(gate, NativeSubstage::HELPER_FRAME);
        DiagnosticGate::reply(gate, child->code(), child->replyClass());
        require(DiagnosticGate::predicate(gate, child->code() == 0 && child->equals("V1 failed\n")));
        DiagnosticGate::step(gate, NativeSubstage::STATUS_AFTER);
        require(DiagnosticGate::status(gate, SecKeychainGetStatus(store.value, &after)) == errSecSuccess && (after & kSecUnlockStateStatus));
        NSDictionary *proof = unchanged(request, gate);
        NSDictionary *result = @{@"ok": @YES, @"readAttempted": @YES, @"osDenied": @YES,
            @"helperUnlockedBefore": @YES, @"helperUnlockedAfter": @YES,
            @"controllerUnlockedBefore": @YES, @"controllerUnlockedAfter": @YES,
            @"exitConfirmed": @YES, @"classifiedFailed": @YES,
            @"valueUnchanged": proof[@"valueUnchanged"], @"aclUnchanged": proof[@"aclUnchanged"],
            @"attributesUnchanged": proof[@"attributesUnchanged"]};
        observation.pass();
        return result;
    }

    /** 权限拒绝负例使用真正的私有钥匙串条目，模板以测试 helper 身份创建后仅在夹具中增加或替换受测权限；生产程序永远不能调用这些修改入口，拒绝后的检查比较整个持久密文文件而不修复被拒绝的条目。 */
    void seed(NSDictionary *request) {
        DiagnosticGate observation(NativeOperation::SEED);
        DiagnosticGate *gate = &observation;
        require(DiagnosticGate::predicate(gate, created));
        DiagnosticGate::step(gate, NativeSubstage::ACCOUNT);
        NSString *name = account(request);
        DiagnosticGate::step(gate, NativeSubstage::KEY);
        NSData *key = [[NSData alloc] initWithBase64EncodedString:request[@"key"] options:0];
        require(DiagnosticGate::predicate(gate, key.length == 32));
        DiagnosticGate::step(gate, NativeSubstage::POLICY);
        NSString *policy = request[@"policy"];
        require(DiagnosticGate::predicate(gate, [@[@"broad", @"empty", @"any", @"second", @"owner", @"mixed", @"unknown", @"denied"] containsObject:policy]));
        Owned<SecTrustedApplicationRef> application;
        DiagnosticGate::step(gate, NativeSubstage::TRUSTED);
        require(DiagnosticGate::status(gate, SecTrustedApplicationCreateFromPath([policy isEqual:@"denied"] ? nullptr : helper.c_str(), &application.value)) == errSecSuccess);
        const void *value = application.value;
        DiagnosticGate::step(gate, NativeSubstage::ARRAY);
        Owned<CFArrayRef> applications(CFArrayCreate(nullptr, &value, 1, &kCFTypeArrayCallBacks));
        Owned<SecAccessRef> access;
        DiagnosticGate::step(gate, NativeSubstage::ACCESS);
        require(DiagnosticGate::status(gate, SecAccessCreate(CFSTR("VeriQ Runtime Vault v1"), applications.value, &access.value)) == errSecSuccess);
        if (![policy isEqual:@"denied"]) {
            Owned<SecACLRef> extra;
            Owned<SecTrustedApplicationRef> other;
            Owned<CFArrayRef> principals;
            if ([policy isEqual:@"second"]) {
                DiagnosticGate::step(gate, NativeSubstage::EXTRA_TRUSTED);
                require(DiagnosticGate::status(gate, SecTrustedApplicationCreateFromPath(nullptr, &other.value)) == errSecSuccess);
                const void *principal = other.value;
                DiagnosticGate::step(gate, NativeSubstage::EXTRA_ARRAY);
                principals.value = CFArrayCreate(nullptr, &principal, 1, &kCFTypeArrayCallBacks);
                require(DiagnosticGate::predicate(gate, principals.value));
            }
            DiagnosticGate::step(gate, NativeSubstage::ACL);
            require(DiagnosticGate::status(gate, SecACLCreateWithSimpleContents(access.value, principals.value, CFSTR("VeriQ Runtime Vault v1"), 0, &extra.value)) == errSecSuccess);
            CFArrayRef rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationDecrypt];
            if ([policy isEqual:@"empty"]) rights = (__bridge CFArrayRef)@[];
            if ([policy isEqual:@"any"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationAny];
            if ([policy isEqual:@"owner"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationChangeACL];
            if ([policy isEqual:@"mixed"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationDecrypt, (__bridge id)kSecACLAuthorizationKeychainItemRead];
            if ([policy isEqual:@"unknown"]) rights = (__bridge CFArrayRef)@[@"VERIQ_UNKNOWN_RIGHT"];
            DiagnosticGate::step(gate, NativeSubstage::AUTH);
            require(DiagnosticGate::status(gate, SecACLUpdateAuthorizations(extra.value, rights)) == errSecSuccess);
        }
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: name,
            (__bridge id)kSecUseKeychain: (__bridge id)store.value, (__bridge id)kSecAttrAccess: (__bridge id)access.value,
            (__bridge id)kSecValueData: key};
        DiagnosticGate::step(gate, NativeSubstage::ADD);
        require(DiagnosticGate::status(gate, SecItemAdd((__bridge CFDictionaryRef)query, nullptr)) == errSecSuccess);
        controllerReader = [policy isEqual:@"denied"];
        inspect(request, baselineValue, gate);
        DiagnosticGate::step(gate, NativeSubstage::VALUE);
        require(DiagnosticGate::predicate(gate, baselineValue.bytes.size() == key.length && memcmp(baselineValue.bytes.data(), key.bytes, key.length) == 0));
        baselineState = snapshot(request, gate);
        baselineAccount = name;
        baseline = ciphertext(path, gate);
        observation.pass();
    }
    /** 单条负例移除仍限定自有存储、固定服务与精确账户，首次调用仅在原删除前后记录至多两条事实；调用前守卫失败不产生系统状态，删除返回值只求一次且原拒绝条件与控制器清理能力保持不变。 */
    void remove(NSDictionary *request) {
        DiagnosticGate observation(NativeOperation::REMOVE, !removeObserved);
        removeObserved = true;
        require(created);
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: account(request),
            (__bridge id)kSecMatchSearchList: @[(__bridge id)store.value]};
        DiagnosticGate::step(&observation, NativeSubstage::ITEM_DELETE);
        require(DiagnosticGate::status(&observation, SecItemDelete((__bridge CFDictionaryRef)query)) == errSecSuccess);
        observation.pass();
    }
};
}

/** 控制器正常 EOF 时只清理自身已经创建的测试存储，任何权限、会话或配置失败都以固定结果退出；进程被强制终止时可能保留加密夹具文件，这种情况必须作为未完成清理处理而不能宣称已撤销之前的系统修改。 */
int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "--read-evidence-selftest") == 0) return readEvidenceSelftest();
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
