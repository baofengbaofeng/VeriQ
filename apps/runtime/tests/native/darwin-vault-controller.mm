/** 专用钥匙串控制器只在操作者明确授权的可丢弃图形登录会话中创建随机自有存储，创建和删除可能改变该账户的持久偏好；普通流水线不会运行此入口，实际 UID 或会话事实本身不被当作可丢弃授权。 */
#include "../../native/vault/darwin-acl.hpp"
#include <Security/AuthSession.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <fcntl.h>
#include <poll.h>
#include <limits.h>
#include <cerrno>
#include <csignal>
#include <chrono>

using namespace veriq;
namespace {
const char *acknowledgement = "I authorize Keychain preference changes in this disposable login session.";
using Clock = std::chrono::steady_clock;

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
NSDictionary *sessionFacts() {
    char login[256] {};
    SecuritySessionId session = 0;
    SessionAttributeBits attributes = 0;
    require(getuid() != 0 && getuid() == geteuid() && getlogin_r(login, sizeof(login)) == 0);
    require(SessionGetInfo(callerSecuritySession, &session, &attributes) == errSecSuccess && session != 0);
    require((attributes & sessionHasGraphicAccess) && !(attributes & sessionIsRoot));
    return @{ @"uid": @(getuid()), @"login": [NSString stringWithUTF8String:login], @"session": @(session) };
}
void attest(NSDictionary *value, NSDictionary *facts) {
    require([value isKindOfClass:[NSDictionary class]] && [value[@"disposable"] isEqual:@YES]);
    require([value[@"acknowledgement"] isEqual:[NSString stringWithUTF8String:acknowledgement]]);
    for (NSString *key in @[@"uid", @"login", @"session"]) require([value[key] isEqual:facts[key]]);
}

/** 固定测试成员必须与控制器位于相同的真实构建目录，路径解析只在测试二进制内发生且不读取业务配置；父 PID 仅佐证继承关系，真正的存储授权仍来自显式会话声明和当前控制器拥有的随机目录。 */
std::string helperPath() {
    char executable[PATH_MAX], physical[PATH_MAX];
    uint32_t size = sizeof(executable);
    require(_NSGetExecutablePath(executable, &size) == 0 && realpath(executable, physical));
    std::string path(physical);
    require(path.substr(path.find_last_of('/') + 1) == "veriq_keychain_controller");
    path.replace(path.find_last_of('/') + 1, std::string::npos, "veriq_agent");
    struct stat info {};
    require(lstat(path.c_str(), &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 0022));
    return path;
}
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

/** 存储生命周期只属于一次已确认的测试会话，控制器从系统随机源生成二进制密码并始终保存在内存；清理必须先确认所有实际子进程退出，无法确认时保留文件及失败事实，不恢复或伪装用户原有偏好。 */
struct Fixture {
    Owned<SecKeychainRef> store;
    Secret password {32};
    std::string directory, path, helper;
    NSDictionary *facts = nil;
    std::set<pid_t> children;
    Bytes baseline;
    bool created = false;

    void create(NSDictionary *attestation) {
        require(!created && directory.empty());
        facts = sessionFacts();
        attest(attestation, facts);
        helper = helperPath();
        require(SecRandomCopyBytes(kSecRandomDefault, password.bytes.size(), password.bytes.data()) == errSecSuccess);
        char pattern[] = "/private/tmp/veriq-d1-XXXXXX";
        require(mkdtemp(pattern));
        directory = pattern;
        path = directory + "/owned.keychain-db";
        const OSStatus error = SecKeychainCreate(path.c_str(), static_cast<UInt32>(password.bytes.size()), password.bytes.data(), false, nullptr, &store.value);
        created = store.value != nullptr;
        require(error == errSecSuccess && created);
        char actual[PATH_MAX]; UInt32 length = sizeof(actual);
        require(SecKeychainGetPath(store.value, &length, actual) == errSecSuccess && std::string(actual, length) == path);
        struct stat info {};
        require(lstat(path.c_str(), &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 0077));
    }
    void cleanup() {
        require(children.empty());
        if (created) {
            require(SecKeychainDelete(store.value) == errSecSuccess);
            created = false;
        }
        if (!directory.empty()) {
            require(rmdir(directory.c_str()) == 0);
            directory.clear();
        }
        wipe(password.bytes.data(), password.bytes.size());
    }

    /** 控制器只启动固定子程序并持有其 stdin 到实际完成，额外能力通过独立继承管道传递而不落入参数或环境；超时终止后仍核对 waitpid，未退出的子进程继续阻止删除存储，不能把发出信号当作清理成功。 */
    NSDictionary *run(NSDictionary *request) {
        require(created && [request[@"frame"] isKindOfClass:[NSString class]]);
        NSData *frame = [request[@"frame"] dataUsingEncoding:NSASCIIStringEncoding];
        require(frame && frame.length < 512);
        NSDictionary *configuration = @{ @"mode": @"store", @"disposable": @YES, @"uid": facts[@"uid"],
            @"session": facts[@"session"], @"parent": @(getpid()), @"path": [NSString stringWithUTF8String:path.c_str()],
            @"fault": request[@"fault"] ?: @"" };
        NSData *capability = [NSJSONSerialization dataWithJSONObject:configuration options:0 error:nullptr];
        require(capability && capability.length < 4096);
        int input[2], output[2], control[2];
        require(pipe(input) == 0 && pipe(output) == 0 && pipe(control) == 0);
        const pid_t child = fork();
        require(child >= 0);
        if (child == 0) {
            if (dup2(input[0], 0) < 0 || dup2(output[1], 1) < 0 || dup2(control[0], 3) < 0) _exit(2);
            const int null = open("/dev/null", O_WRONLY);
            if (null < 0 || dup2(null, 2) < 0) _exit(2);
            for (int fd : {input[0], input[1], output[0], output[1], control[0], control[1], null}) if (fd > 3) close(fd);
            const char *environment[] = {"PATH=/usr/bin:/bin", nullptr};
            char *arguments[] = {const_cast<char *>(helper.c_str()), nullptr};
            execve(helper.c_str(), arguments, const_cast<char **>(environment));
            _exit(2);
        }
        children.insert(child);
        close(input[0]); close(output[1]); close(control[0]);
        bool valid = write(control[1], capability.bytes, capability.length) == static_cast<ssize_t>(capability.length) && write(control[1], "\n", 1) == 1;
        close(control[1]);
        valid = valid && write(input[1], frame.bytes, frame.length) == static_cast<ssize_t>(frame.length);
        Secret result;
        result.bytes.reserve(512);
        const auto deadline = Clock::now() + std::chrono::milliseconds(4000);
        bool eof = false;
        while (valid && !eof && Clock::now() < deadline) {
            pollfd watched {output[0], POLLIN, 0};
            int ready = poll(&watched, 1, 25);
            if (ready < 0 && errno == EINTR) continue;
            if (ready < 0) { valid = false; break; }
            if (!ready) continue;
            uint8_t bytes[512];
            ssize_t count = read(output[0], bytes, sizeof(bytes));
            if (count < 0 && errno == EINTR) continue;
            if (count < 0 || result.bytes.size() + static_cast<size_t>(count) > 512) valid = false;
            else if (!count) eof = true;
            else result.bytes.insert(result.bytes.end(), bytes, bytes + count);
            wipe(bytes, sizeof(bytes));
        }
        close(input[1]); close(output[0]);
        if (!eof || !valid) kill(child, SIGKILL);
        int status = 0; bool exited = false;
        const auto stopDeadline = Clock::now() + std::chrono::milliseconds(750);
        while (Clock::now() < stopDeadline) {
            const pid_t observed = waitpid(child, &status, WNOHANG);
            if (observed == child) { exited = true; children.erase(child); break; }
            if (observed < 0 && errno != EINTR) break;
            poll(nullptr, 0, 5);
        }
        require(exited);
        NSString *response = [[NSString alloc] initWithBytes:result.bytes.data() length:result.bytes.size() encoding:NSASCIIStringEncoding];
        require(response);
        return @{ @"ok": @YES, @"exitConfirmed": @YES, @"code": @(WIFEXITED(status) ? WEXITSTATUS(status) : -1), @"response": response };
    }

    /** 权限拒绝负例使用真正的私有钥匙串条目，模板以测试 helper 身份创建后仅在夹具中增加或替换受测权限；生产程序永远不能调用这些修改入口，拒绝后的检查比较整个持久密文文件而不修复被拒绝的条目。 */
    void seed(NSDictionary *request) {
        require(created);
        NSString *name = account(request);
        NSData *key = [[NSData alloc] initWithBase64EncodedString:request[@"key"] options:0];
        require(key.length == 32);
        NSString *policy = request[@"policy"];
        require([@[@"broad", @"empty", @"any", @"second", @"owner", @"denied"] containsObject:policy]);
        Owned<SecTrustedApplicationRef> application;
        require(SecTrustedApplicationCreateFromPath([policy isEqual:@"denied"] ? nullptr : helper.c_str(), &application.value) == errSecSuccess);
        const void *value = application.value;
        Owned<CFArrayRef> applications(CFArrayCreate(nullptr, &value, 1, &kCFTypeArrayCallBacks));
        Owned<SecAccessRef> access;
        require(SecAccessCreate(CFSTR("VeriQ Runtime Vault v1"), applications.value, &access.value) == errSecSuccess);
        if (![policy isEqual:@"denied"]) {
            Owned<SecACLRef> extra;
            require(SecACLCreateWithSimpleContents(access.value, nullptr, CFSTR("VeriQ Runtime Vault v1"), 0, &extra.value) == errSecSuccess);
            CFArrayRef rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationDecrypt];
            if ([policy isEqual:@"empty"]) rights = (__bridge CFArrayRef)@[];
            if ([policy isEqual:@"any"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationAny];
            if ([policy isEqual:@"owner"]) rights = (__bridge CFArrayRef)@[(__bridge id)kSecACLAuthorizationChangeACL];
            require(SecACLUpdateAuthorizations(extra.value, rights) == errSecSuccess);
        }
        NSDictionary *query = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: name,
            (__bridge id)kSecUseKeychain: (__bridge id)store.value, (__bridge id)kSecAttrAccess: (__bridge id)access.value,
            (__bridge id)kSecValueData: key};
        require(SecItemAdd((__bridge CFDictionaryRef)query, nullptr) == errSecSuccess);
        baseline = ciphertext(path);
    }
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
            require(argc == 1);
            rlimit core {0, 0}; require(setrlimit(RLIMIT_CORE, &core) == 0);
            signal(SIGPIPE, SIG_IGN);
            NoUI noUI;
            for (;;) {
                @autoreleasepool {
                    NSDictionary *request = receive();
                    if (!request) break;
                    NSString *operation = request[@"operation"];
                    require([operation isKindOfClass:[NSString class]]);
                    if ([operation isEqual:@"session"]) { send(sessionFacts()); continue; }
                    if ([operation isEqual:@"create"]) fixture.create(request[@"attestation"]);
                    else if ([operation isEqual:@"run"]) { send(fixture.run(request)); continue; }
                    else if ([operation isEqual:@"lock"]) require(fixture.created && SecKeychainLock(fixture.store.value) == errSecSuccess);
                    else if ([operation isEqual:@"unlock"]) require(fixture.created && SecKeychainUnlock(fixture.store.value, static_cast<UInt32>(fixture.password.bytes.size()), fixture.password.bytes.data(), true) == errSecSuccess);
                    else if ([operation isEqual:@"seed"]) fixture.seed(request);
                    else if ([operation isEqual:@"remove"]) fixture.remove(request);
                    else if ([operation isEqual:@"unchanged"]) { require(fixture.created); send(@{@"ok": @YES, @"unchanged": @(fixture.baseline == ciphertext(fixture.path))}); continue; }
                    else if ([operation isEqual:@"cleanup"]) fixture.cleanup();
                    else require(false);
                    send(@{@"ok": @YES});
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
