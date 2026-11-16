/** Mac 文件型保险库辅助程序每次只处理一条现有 V1 请求并持有一次选定的钥匙串引用，所有身份、权限和二进制长度检查均在返回秘密之前完成；它不负责安装授权、用户界面或既有档案的密钥替换决策。 */
#include "darwin-acl.hpp"
#ifdef VERIQ_VAULT_TESTING
#include "darwin-read-evidence.hpp"
#endif
#include <Security/AuthSession.h>
#include <cerrno>
#include <csignal>
#include <thread>
#include <sys/stat.h>
#include <sys/resource.h>

using namespace veriq;
namespace {
bool mutating = false;

/** 帧中的 UUID 按原始 ASCII 大小写验证后逐字节编码，避免平台比较规则合并不同的档案或版本；这里不接受别名、最新版本搜索或来自环境变量的服务名，因此所有请求都保持同一固定产品命名空间。 */
bool uuid(const std::string &value) {
    if (value.size() != 36) return false;
    for (size_t index = 0; index < value.size(); ++index) {
        const char c = value[index];
        if (index == 8 || index == 13 || index == 18 || index == 23) { if (c != '-') return false; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
}
/** 账户组件使用每个原始 ASCII 字节的规范小写十六进制表示，编码结果自身不含分隔符也不会受平台字符串大小写折叠影响；这里保留 UUID 的原始字符身份，而不是把输入先转成统一大小写再产生可能冲突的名称。 */
std::string component(const std::string &value) {
    const char *digits = "0123456789abcdef";
    std::string result;
    for (uint8_t byte : value) { result.push_back(digits[byte >> 4]); result.push_back(digits[byte & 15]); }
    return result;
}
/** 固定账户名称只由已经验证的档案和版本组成，中间唯一斜杠分隔两个等长十六进制组件；不会搜索相近版本或最新版本，也不允许请求传入额外服务名，因此读取与删除均能重复绑定同一个逻辑条目。 */
NSString *account(const std::string &profile, const std::string &version) {
    require(uuid(profile) && uuid(version));
    return [NSString stringWithUTF8String:(component(profile) + "/" + component(version)).c_str()];
}

/** Base64 转换复用 Foundation 的成熟实现，URL 字母替换之后重编码核对全部文本并严格限定三十二字节；任何非规范尾位、填充、字符或长度在接触 Security 之前拒绝，不自行实现编码器或密码算法。 */
std::string encode(const uint8_t *bytes
#ifdef VERIQ_VAULT_TESTING
    , test::ReadEvidence *observation = nullptr
#endif
) {
    NSString *encoded = [[NSData dataWithBytes:bytes length:32] base64EncodedStringWithOptions:0];
    encoded = [[encoded stringByReplacingOccurrencesOfString:@"+" withString:@"-"] stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
    encoded = [encoded stringByReplacingOccurrencesOfString:@"=" withString:@""];
#ifdef VERIQ_VAULT_TESTING
    const bool valid = encoded && [encoded lengthOfBytesUsingEncoding:NSASCIIStringEncoding] == 43;
    require(observation ? observation->predicate(test::ReadPhase::ENCODING, valid) : valid);
#else
    require(encoded && [encoded lengthOfBytesUsingEncoding:NSASCIIStringEncoding] == 43);
#endif
    return encoded.UTF8String;
}
/** 解码入口要求精确长度和 URL 安全字母表，Foundation 返回的字节还必须是三十二字节且重编码完全相等；验证失败时传入的作用域缓冲仍由析构覆盖，非规范尾位不能通过宽松的系统解码器进入存储请求。 */
void decode(const std::string &text, Secret &key) {
    require(text.size() == 43 && text.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") == std::string::npos);
    NSString *base64 = [NSString stringWithUTF8String:text.c_str()];
    base64 = [[[base64 stringByReplacingOccurrencesOfString:@"-" withString:@"+"] stringByReplacingOccurrencesOfString:@"_" withString:@"/"] stringByAppendingString:@"="];
    NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
    require(data.length == 32);
    key.bytes.resize(32);
    memcpy(key.bytes.data(), data.bytes, 32);
    SecretText canonical(encode(key.bytes.data()));
    const bool equal = canonical.value == text;
    require(equal);
}

/** 用户是否锁定只能由当前请求已经持有的同一钥匙串引用证明，交互被拒绝但仍然解锁属于失败而不是锁定；已知的默认存储或服务缺失单独返回不可用，未知错误永不变成条目不存在。 */
std::string status(SecKeychainRef keychain, OSStatus error, bool mutation = false) {
    if (mutation) return securityFailureStatus(error, errSecParam, 0, keychain != nullptr, true);
    SecKeychainStatus state = 0;
    const OSStatus stateError = keychain ? SecKeychainGetStatus(keychain, &state) : errSecParam;
    return securityFailureStatus(error, stateError, state, keychain != nullptr, false);
}
/** 查询字典始终包含本次实际持有的唯一钥匙串引用与固定服务及精确账户，调用点只能增加返回类型或当前条目引用等约束；默认全局搜索列表不会参与查询，也不允许通过缺省字段扩大到其他产品或其他存储。 */
NSMutableDictionary *query(SecKeychainRef keychain, NSString *name) {
    return [@{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: name,
        (__bridge id)kSecMatchSearchList: @[(__bridge id)keychain]} mutableCopy];
}

/** 精确查询先只取属性和条目引用而不要求秘密数据，匹配数量必须唯一且返回属性必须逐项相等；随后完整验证该引用的访问策略，避免先读秘密再根据成功读取推断权限足够严格的循环证明。 */
OSStatus findItem(SecKeychainRef keychain, NSString *name, SecAccessRef expected, Owned<SecKeychainItemRef> &item) {
    NSMutableDictionary *request = query(keychain, name);
    request[(__bridge id)kSecReturnRef] = @YES;
    request[(__bridge id)kSecReturnAttributes] = @YES;
    request[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitAll;
    Owned<CFTypeRef> result;
    const OSStatus error = SecItemCopyMatching((__bridge CFDictionaryRef)request, &result.value);
    if (error != errSecSuccess) return error;
    require(result.value && CFGetTypeID(result.value) == CFArrayGetTypeID());
    CFArrayRef array = static_cast<CFArrayRef>(result.value);
    require(CFArrayGetCount(array) == 1);
    CFTypeRef raw = CFArrayGetValueAtIndex(array, 0);
    require(raw && CFGetTypeID(raw) == CFDictionaryGetTypeID());
    CFDictionaryRef attributes = static_cast<CFDictionaryRef>(raw);
    CFTypeRef returnedService = CFDictionaryGetValue(attributes, kSecAttrService);
    CFTypeRef returnedAccount = CFDictionaryGetValue(attributes, kSecAttrAccount);
    require(returnedService && returnedAccount && CFEqual(returnedService, CFSTR("VeriQ/RuntimeVault/v1")) && CFEqual(returnedAccount, (__bridge CFStringRef)name));
    CFTypeRef reference = CFDictionaryGetValue(attributes, kSecValueRef);
    require(reference && CFGetTypeID(reference) == SecKeychainItemGetTypeID());
    item.value = static_cast<SecKeychainItemRef>(const_cast<void *>(CFRetain(reference)));
    Owned<SecAccessRef> access;
    requireSecurity(SecKeychainItemCopyAccess(item.value, &access.value));
    require(access.value != nullptr);
    require(verifiedAccess(access.value, expected));
    return errSecSuccess;
}
/** 秘密读取复用已经核验的条目引用并同时保留精确存储和账户约束，避免属性检查后通过重新泛查读到另一个候选；返回值必须是完整 CFData 且长度恰为三十二，否则由上层根据修改阶段保留失败或不确定状态。 */
void readKey(SecKeychainRef keychain, NSString *name, SecKeychainItemRef item, Secret &key) {
    NSMutableDictionary *request = query(keychain, name);
    request[(__bridge id)kSecMatchItemList] = @[(__bridge id)item];
    request[(__bridge id)kSecReturnData] = @YES;
    Owned<CFTypeRef> result;
    requireSecurity(SecItemCopyMatching((__bridge CFDictionaryRef)request, &result.value));
    require(result.value && CFGetTypeID(result.value) == CFDataGetTypeID() && CFDataGetLength(static_cast<CFDataRef>(result.value)) == 32);
    key.bytes.resize(32);
    memcpy(key.bytes.data(), CFDataGetBytePtr(static_cast<CFDataRef>(result.value)), 32);
}

#ifdef VERIQ_VAULT_TESTING
/** 专用测试目标仅从继承的私有管道接收控制器配置，生产编译完全删除此分支；独立存储还须匹配真实父进程、用户、安全会话及文件所有权，普通协议测试只使用不触及存储的等待门闩。 */
NSDictionary *testConfiguration() {
    Secret bytes;
    bytes.bytes.reserve(4096);
    for (;;) {
        uint8_t byte;
        ssize_t count = read(3, &byte, 1);
        if (count < 0 && errno == EINTR) continue;
        require(count == 1 && bytes.bytes.size() < 4096);
        if (byte == '\n') break;
        bytes.bytes.push_back(byte);
    }
    close(3);
    NSData *data = [NSData dataWithBytes:bytes.bytes.data() length:bytes.bytes.size()];
    id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nullptr];
    require([parsed isKindOfClass:[NSDictionary class]]);
    return parsed;
}
/** 专用存储入口仅在测试编译中存在，要求当前 UID、安全会话、父关系和随机夹具文件形状全部相符；它只打开控制器已经创建的自有文件而不创建或选择默认存储，且这些检查不被宣称为任意同用户进程隔离。 */
SecKeychainRef testStore(NSDictionary *config) {
    require([config[@"mode"] isEqual:@"store"] && [config[@"disposable"] isEqual:@YES]);
    require([config[@"uid"] unsignedLongLongValue] == getuid() && getuid() == geteuid() && getuid() != 0);
    require([config[@"parent"] longLongValue] == getppid());
    SecuritySessionId session = 0;
    SessionAttributeBits attributes = 0;
    require(SessionGetInfo(callerSecuritySession, &session, &attributes) == errSecSuccess && session != 0);
    require([config[@"session"] unsignedLongLongValue] == session && (attributes & sessionHasGraphicAccess));
    NSString *path = config[@"path"];
    require([path isKindOfClass:[NSString class]] && path.length < 1024 && [path hasPrefix:@"/private/tmp/veriq-d1-"] && [path hasSuffix:@"/owned.keychain-db"]);
    struct stat info {};
    require(lstat(path.fileSystemRepresentation, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid() && !(info.st_mode & 0077));
    Owned<SecKeychainRef> keychain;
    require(SecKeychainOpen(path.fileSystemRepresentation, &keychain.value) == errSecSuccess && keychain.value);
    const SecKeychainRef result = keychain.value;
    keychain.value = nullptr;
    return result;
}

/** 测试读取先在同一私有存储中取全部元数据与引用，唯一谓词同时核验数量、字典、精确服务账户及引用类型；此处不调用生产 ACL 准入，以便负例仍能独立向系统请求秘密，借用引用在容器释放前增加一次持有。 */
SecKeychainItemRef testReadItem(SecKeychainRef keychain, NSString *name, test::ReadEvidence &observation) {
    NSMutableDictionary *request = query(keychain, name);
    request[(__bridge id)kSecReturnRef] = @YES;
    request[(__bridge id)kSecReturnAttributes] = @YES;
    request[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitAll;
    Owned<CFTypeRef> result;
    observation.step(test::ReadPhase::LOOKUP);
    require(observation.status(test::ReadPhase::LOOKUP, SecItemCopyMatching((__bridge CFDictionaryRef)request, &result.value)) == errSecSuccess);
    observation.step(test::ReadPhase::ARRAY);
    require(observation.predicate(test::ReadPhase::ARRAY, result.value && CFGetTypeID(result.value) == CFArrayGetTypeID()));
    CFArrayRef values = static_cast<CFArrayRef>(result.value);
    CFTypeRef reference = nullptr;
    const auto exactItem = [&] {
        if (CFArrayGetCount(values) != 1) return false;
        CFTypeRef raw = CFArrayGetValueAtIndex(values, 0);
        if (!raw || CFGetTypeID(raw) != CFDictionaryGetTypeID()) return false;
        CFDictionaryRef attributes = static_cast<CFDictionaryRef>(raw);
        CFTypeRef service = CFDictionaryGetValue(attributes, kSecAttrService);
        CFTypeRef accountName = CFDictionaryGetValue(attributes, kSecAttrAccount);
        if (!service || CFGetTypeID(service) != CFStringGetTypeID() ||
            !accountName || CFGetTypeID(accountName) != CFStringGetTypeID() ||
            !CFEqual(service, CFSTR("VeriQ/RuntimeVault/v1")) || !CFEqual(accountName, (__bridge CFStringRef)name)) return false;
        reference = CFDictionaryGetValue(attributes, kSecValueRef);
        return reference && CFGetTypeID(reference) == SecKeychainItemGetTypeID();
    };
    observation.step(test::ReadPhase::UNIQUE);
    require(observation.predicate(test::ReadPhase::UNIQUE, exactItem()));
    return static_cast<SecKeychainItemRef>(const_cast<void *>(CFRetain(reference)));
}

/** 只有专用控制器启动的测试编译目标可以执行此只读检查，先验证全部元数据中的唯一精确条目再按持有引用读取；系统实际返回的单个 CFData 必须恰为三十二字节，诊断数组及唯一事实属于此前真实元数据守卫。 */
std::string inspectValue(SecKeychainRef keychain, NSString *name, test::ReadEvidence &observation) {
    Owned<SecKeychainItemRef> item(testReadItem(keychain, name, observation));
    NSMutableDictionary *request = query(keychain, name);
    request[(__bridge id)kSecMatchItemList] = @[(__bridge id)item.value];
    request[(__bridge id)kSecReturnData] = @YES;
    Owned<CFTypeRef> result;
    observation.step(test::ReadPhase::READ);
    require(observation.status(test::ReadPhase::READ, SecItemCopyMatching((__bridge CFDictionaryRef)request, &result.value)) == errSecSuccess);
    CFTypeRef data = result.value;
    observation.step(test::ReadPhase::DATA32);
    require(observation.predicate(test::ReadPhase::DATA32, data && CFGetTypeID(data) == CFDataGetTypeID() && CFDataGetLength(static_cast<CFDataRef>(data)) == 32));
    observation.step(test::ReadPhase::ENCODING);
    SecretText encoded(encode(CFDataGetBytePtr(static_cast<CFDataRef>(data)), &observation));
    std::string response = "V1 ok " + encoded.value + "\n";
    observation.step(test::ReadPhase::DONE);
    return response;
}

/** 专用拒绝观察直接向系统请求精确条目的秘密数据，不经过生产策略验证器，前后均查询同一实际引用的解锁状态；只有明确授权拒绝或禁止交互错误算拒绝，私有控制端仅发送布尔事实，意外读到的数据不编码或输出。 */
std::string observeReadDenial(SecKeychainRef keychain, NSString *name, test::ReadEvidence &observation) {
    observation.step(test::ReadPhase::CHANNEL);
    struct stat channel {};
    require(fstat(4, &channel) == 0 && S_ISSOCK(channel.st_mode));
    Owned<SecKeychainItemRef> item(testReadItem(keychain, name, observation));
    NSMutableDictionary *request = query(keychain, name);
    request[(__bridge id)kSecMatchItemList] = @[(__bridge id)item.value];
    request[(__bridge id)kSecReturnData] = @YES;
    SecKeychainStatus before = 0, after = 0;
    observation.step(test::ReadPhase::BEFORE);
    const OSStatus beforeError = observation.status(test::ReadPhase::BEFORE, SecKeychainGetStatus(keychain, &before));
    Owned<CFTypeRef> result;
    observation.step(test::ReadPhase::READ);
    const OSStatus error = observation.status(test::ReadPhase::READ, SecItemCopyMatching((__bridge CFDictionaryRef)request, &result.value));
    observation.step(test::ReadPhase::AFTER);
    const OSStatus afterError = observation.status(test::ReadPhase::AFTER, SecKeychainGetStatus(keychain, &after));
    const bool denied = error == errSecAuthFailed || error == errSecInteractionNotAllowed || error == errSecInteractionRequired;
    const char facts[] = {
        beforeError == errSecSuccess && (before & kSecUnlockStateStatus) ? 'U' : 'F',
        denied ? 'D' : 'F',
        afterError == errSecSuccess && (after & kSecUnlockStateStatus) ? 'U' : 'F'
    };
    observation.unlocked(facts[0] == 'U', facts[2] == 'U');
    observation.emit();
    require(write(4, facts, sizeof(facts)) == sizeof(facts));
    return "V1 " + status(keychain, error) + "\n";
}

/** 竞争测试的屏障只使用额外继承的私有控制套接字，V1 输入仍由 EOF 监视线程独占；就绪字节仅在真实缺失查询之后发出，控制器释放前不调用新增，任何异常都会结束本次操作而不是猜测另一进程状态。 */
void raceBarrier() {
    struct stat info {};
    require(fstat(4, &info) == 0 && S_ISSOCK(info.st_mode));
    require(write(4, "R", 1) == 1);
    char release = 0;
    ssize_t count;
    do { count = read(4, &release, 1); } while (count < 0 && errno == EINTR);
    require(count == 1 && release == 'G');
}
#endif

/** 一次写入只有在真实缺失时发送，重复竞争不会覆盖既有值而是重新查询同一作用域核对；修改调用开始后的异常包括读回或 ACL 核验失败都保留不确定状态，正常读取错误则依据同一引用重新检查真实锁定状态。 */
std::string execute(const std::vector<std::string> &parts, Secret &incoming) {
#ifdef VERIQ_VAULT_TESTING
    NSDictionary *configuration = testConfiguration();
    test::ReadEvidence observation(configuration);
    if ([configuration[@"mode"] isEqual:@"gate"]) {
        const char ready[] = "V1 test-ready\n";
        require(write(STDOUT_FILENO, ready, sizeof(ready) - 1) == sizeof(ready) - 1);
        for (;;) pause();
    }
#ifdef VERIQ_VAULT_RED_STUB
    return "V1 failed\n";
#endif
    if ([configuration[@"mode"] isEqual:@"validate"]) return "V1 ok\n";
#endif
#ifdef VERIQ_VAULT_TESTING
    observation.step(test::ReadPhase::NO_UI);
#endif
    NoUI noUI;
    Owned<SecKeychainRef> keychain;
#ifdef VERIQ_VAULT_TESTING
    observation.step(test::ReadPhase::STORE);
    keychain.value = testStore(configuration);
    OSStatus error = errSecSuccess;
#else
    OSStatus error = SecKeychainCopyDefault(&keychain.value);
#endif
    if (error != errSecSuccess || !keychain.value) return "V1 " + status(keychain.value, error) + "\n";
    try {
        SecKeychainStatus state = 0;
#ifdef VERIQ_VAULT_TESTING
        observation.step(test::ReadPhase::STATUS);
#endif
        error = SecKeychainGetStatus(keychain.value, &state);
        if (error != errSecSuccess || !(state & kSecUnlockStateStatus)) return "V1 " + status(keychain.value, error) + "\n";
#ifdef VERIQ_VAULT_TESTING
        observation.step(test::ReadPhase::PERMISSION);
#endif
        if (!(state & kSecReadPermStatus)) return "V1 failed\n";
        if (parts[1] == "probe") return "V1 ready\n";
#ifdef VERIQ_VAULT_TESTING
        observation.step(test::ReadPhase::ACCOUNT);
#endif
        NSString *name = account(parts[2], parts[3]);
#ifdef VERIQ_VAULT_TESTING
        observation.step(test::ReadPhase::DISPATCH);
        if ([configuration[@"observeReadDenial"] isEqual:@YES]) {
            require(parts[1] == "get");
            return observeReadDenial(keychain.value, name, observation);
        }
        if ([configuration[@"inspection"] isEqual:@YES]) {
            require(parts[1] == "get");
            return inspectValue(keychain.value, name, observation);
        }
#endif
        Owned<SecAccessRef> expected(restrictedAccess());
        require(verifiedAccess(expected.value, expected.value));
        Owned<SecKeychainItemRef> item;
        error = findItem(keychain.value, name, expected.value, item);
        if (error != errSecSuccess && error != errSecItemNotFound) return "V1 " + status(keychain.value, error) + "\n";
        if (parts[1] == "delete") {
            if (error == errSecItemNotFound) return "V1 missing\n";
            require(state & kSecWritePermStatus);
            NSMutableDictionary *request = query(keychain.value, name);
            request[(__bridge id)kSecMatchItemList] = @[(__bridge id)item.value];
            mutating = true;
            error = SecItemDelete((__bridge CFDictionaryRef)request);
#ifdef VERIQ_VAULT_TESTING
            if ([configuration[@"fault"] isEqual:@"after-delete"]) _exit(127);
#endif
            return error == errSecSuccess ? "V1 ok\n" : "V1 mutation-unconfirmed\n";
        }
        Secret previous;
        if (item.value) readKey(keychain.value, name, item.value, previous);
        if (parts[1] == "get") {
            if (!item.value) return "V1 missing\n";
            SecretText encoded(encode(previous.bytes.data()));
            std::string response = "V1 ok " + encoded.value + "\n";
            return response;
        }
        if (item.value) return previous.bytes == incoming.bytes ? "V1 ok\n" : "V1 failed\n";
        require(state & kSecWritePermStatus);
#ifdef VERIQ_VAULT_TESTING
        const bool racing = [configuration[@"barrier"] isEqual:@YES];
        if (racing) raceBarrier();
#endif
        NSDictionary *request = @{(__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
            (__bridge id)kSecAttrService: @"VeriQ/RuntimeVault/v1", (__bridge id)kSecAttrAccount: name,
            (__bridge id)kSecUseKeychain: (__bridge id)keychain.value, (__bridge id)kSecAttrAccess: (__bridge id)expected.value,
            (__bridge id)kSecValueData: [NSData dataWithBytes:incoming.bytes.data() length:incoming.bytes.size()]};
        mutating = true;
        error = SecItemAdd((__bridge CFDictionaryRef)request, nullptr);
        if (error != errSecSuccess && error != errSecDuplicateItem) return "V1 mutation-unconfirmed\n";
        const bool duplicate = error == errSecDuplicateItem;
#ifdef VERIQ_VAULT_TESTING
        if (racing) require(write(4, duplicate ? "D" : "A", 1) == 1);
        if ([configuration[@"fault"] isEqual:@"after-add"]) _exit(127);
#endif
        Owned<SecKeychainItemRef> inserted;
        require(findItem(keychain.value, name, expected.value, inserted) == errSecSuccess);
        readKey(keychain.value, name, inserted.value, previous);
        return previous.bytes == incoming.bytes ? "V1 ok\n" : duplicate ? "V1 failed\n" : "V1 mutation-unconfirmed\n";
    } catch (...) {
        return "V1 " + status(keychain.value, securityFailureCode(std::current_exception()), mutating) + "\n";
    }
}
}

/** 主入口要求匿名管道和空参数，帧完整后先安装 EOF 与额外字节监视再进入任何 Security 操作；原始材料只留在私有管道与内存，正常退出清理本程序拥有的缓冲，强制死亡仅代表进程终止而非修改回滚。 */
int main(int argc, char **) {
    @autoreleasepool {
        Secret frame;
        frame.bytes.reserve(frameLimit);
        std::vector<std::string> parts;
        std::string response;
        try {
            require(argc == 1);
            rlimit core {0, 0};
            require(setrlimit(RLIMIT_CORE, &core) == 0);
            signal(SIGPIPE, SIG_IGN);
            struct stat input {}, output {};
            require(fstat(0, &input) == 0 && fstat(1, &output) == 0 &&
                (S_ISFIFO(input.st_mode) || S_ISSOCK(input.st_mode)) && (S_ISFIFO(output.st_mode) || S_ISSOCK(output.st_mode)));
            for (;;) {
                uint8_t byte = 0;
                ssize_t count = read(0, &byte, 1);
                if (count < 0 && errno == EINTR) continue;
                if (count != 1) _exit(125);
                if (byte == '\n') break;
                require(byte >= 32 && byte <= 126 && frame.bytes.size() + 1 < frameLimit);
                frame.bytes.push_back(byte);
            }
            std::thread([] {
                uint8_t byte;
                while (read(0, &byte, 1) < 0 && errno == EINTR) {}
                _exit(125);
            }).detach();
            size_t start = 0;
            for (size_t index = 0; index <= frame.bytes.size(); ++index) {
                if (index == frame.bytes.size() || frame.bytes[index] == ' ') {
                    require(index > start && parts.size() < 5);
                    parts.emplace_back(reinterpret_cast<const char *>(frame.bytes.data() + start), index - start);
                    start = index + 1;
                }
            }
            require(parts.size() >= 2 && parts[0] == "V1");
            const bool probe = parts[1] == "probe", set = parts[1] == "set";
            require(probe || set || parts[1] == "get" || parts[1] == "delete");
            require(parts.size() == (probe ? 2 : set ? 5 : 4));
            if (!probe) require(uuid(parts[2]) && uuid(parts[3]));
            Secret key;
            if (set) decode(parts[4], key);
            response = execute(parts, key);
            require(response.size() <= frameLimit);
            size_t offset = 0;
            while (offset < response.size()) {
                ssize_t count = write(1, response.data() + offset, response.size() - offset);
                if (count < 0 && errno == EINTR) continue;
                require(count > 0);
                offset += count;
            }
            for (auto &part : parts) wipe(part.data(), part.size());
            wipe(response.data(), response.size());
            return 0;
        } catch (...) {
            for (auto &part : parts) wipe(part.data(), part.size());
            wipe(response.data(), response.size());
            return 2;
        }
    }
}
