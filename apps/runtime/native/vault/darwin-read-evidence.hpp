/** 测试读取诊断共用同一写入实现与有限阶段类型，控制器的无存储自测直接调用这些代码而不是复制预期输出；此文件仅由测试 helper 与控制器包含，生产二进制不会获得额外描述符或读取接口。 */
#pragma once
#include <Foundation/Foundation.h>
#include <Security/Security.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <climits>

namespace veriq::test {
enum class ReadPhase { ENTRY, NO_UI, STORE, STATUS, PERMISSION, ACCOUNT, DISPATCH, CHANNEL, BEFORE, READ, AFTER, ARRAY, UNIQUE, DATA32, ENCODING, DONE };
inline NSString *const readPhaseNames[] = { @"entry", @"no-ui", @"store", @"status", @"permission", @"account", @"dispatch", @"channel", @"before", @"read", @"after", @"array", @"unique", @"data32", @"encoding", @"done" };

/** 诊断写入只尝试一次有界非阻塞发送，独立套接字的禁止 SIGPIPE 选项保护已关闭读端；长度错误、已满或失效端点只丢失证据，调用前 errno 始终恢复且不重试、不等待也不改变原操作结果。 */
inline void writeReadPacket(int fd, const void *bytes, size_t length) noexcept {
    const int saved = errno;
    const int one = 1;
    if (fd >= 5 && length > 0 && length <= 512 && setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one)) == 0)
        (void)send(fd, bytes, length, MSG_DONTWAIT);
    errno = saved;
}

/** 读取观察器只保存原表达式返回的整数与布尔前缀，在析构或拒绝标记前输出一次固定事实；字段不存在表示尚未执行，观察器不能查询系统错误说明、持有结果数据或在异常展开时替换原始异常。 */
class ReadEvidence {
    int descriptor = -1;
    bool denial = false;
    ReadPhase phase = ReadPhase::ENTRY;
    bool hasBefore = false, hasRead = false, hasAfter = false, hasUnlocked = false;
    OSStatus before = 0, readStatus = 0, after = 0;
    bool unlockedBefore = false, unlockedAfter = false;
    int predicates[4] {-1, -1, -1, -1};
public:
    /** 只接受控制器配置中的专用测试模式与严格整数描述符，端点必须位于标准通道之外且已经设置非阻塞；解析和传输验证失败时观察器保持无效，但原配置验证及 Security 执行仍由原函数负责。 */
    explicit ReadEvidence(NSDictionary *config) noexcept {
        const int saved = errno;
        try { @try {
            id value = config[@"readEvidenceFd"];
            const bool inspect = [config[@"inspection"] isEqual:@YES];
            const bool denied = [config[@"observeReadDenial"] isEqual:@YES];
            if ([config[@"mode"] isEqual:@"store"] && inspect != denied &&
                [value isKindOfClass:[NSNumber class]] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID()) {
                const double number = [value doubleValue];
                if (number >= 5 && number <= INT_MAX && number == [value intValue]) {
                    const int fd = [value intValue];
                    struct stat info {};
                    const int flags = fcntl(fd, F_GETFL);
                    if (flags >= 0 && (flags & O_NONBLOCK) && fstat(fd, &info) == 0 && S_ISSOCK(info.st_mode)) {
                        descriptor = fd; denial = denied;
                    }
                }
            }
        } @catch (...) {} } catch (...) {}
        errno = saved;
    }
    ReadEvidence(const ReadEvidence &) = delete;
    /** 析构只结算本观察器拥有的私有端点，显式发送后描述符已经移走因此不会再次关闭；这个边界覆盖 NoUI、存储守卫和读取形状异常，原返回值与异常身份不依赖写入是否成功。 */
    ~ReadEvidence() noexcept { emit(); }
    /** 阶段前进发生在原操作之前，既不查询状态也不触发输出，先前真正返回的读取事实仍留在独立槽中；当前谓词尚未求值时对应槽保持缺失，因此不会借用上一条调用的布尔值。 */
    void step(ReadPhase value) noexcept { phase = value; }
    /** 状态代理只接收原有 Security 调用的实际返回整数，再原样交回原判断表达式；三个状态槽分别绑定拒绝前、读取和拒绝后，不把初始守卫状态误记为秘密读取结果。 */
    OSStatus status(ReadPhase value, OSStatus result) noexcept {
        phase = value;
        if (value == ReadPhase::BEFORE) { hasBefore = true; before = result; }
        if (value == ReadPhase::READ) { hasRead = true; readStatus = result; }
        if (value == ReadPhase::AFTER) { hasAfter = true; after = result; }
        return result;
    }
    /** 四个形状槽只记录已求值的原始短路谓词，后续未执行槽保持未知且不触碰 CF 对象；编码槽由现有编码器内部条件写入，避免把编码异常误称为已经得到规范三十二字节回复。 */
    bool predicate(ReadPhase value, bool result) noexcept {
        phase = value;
        const int slot = static_cast<int>(value) - static_cast<int>(ReadPhase::ARRAY);
        if (slot >= 0 && slot < 4) predicates[slot] = result ? 1 : 0;
        return result;
    }
    /** 解锁布尔值直接来自原 U 标记判定的相同结果，不新增状态查询或改变标记字节；只有三个调用都返回后才登记完整组合，发送发生在原 marker 写入之前以便错误标记路径也能读取证据。 */
    void unlocked(bool first, bool last) noexcept { hasUnlocked = true; unlockedBefore = first; unlockedAfter = last; phase = ReadPhase::DONE; }
    /** 输出重建白名单字典后只发送一条不超过五百一十二字节的记录并关闭自有端点，Foundation 或 POSIX 失败均局限于诊断；没有重试或备用日志，原始数据与框架异常不可能进入此记录。 */
    void emit() noexcept {
        if (descriptor < 0) return;
        const int saved = errno, fd = descriptor;
        descriptor = -1;
        try {
            @try {
                NSMutableDictionary *record = [@{@"source": @"TEST_HELPER", @"read": denial ? @"denial" : @"inspection",
                    @"phase": readPhaseNames[static_cast<size_t>(phase)]} mutableCopy];
                if (hasBefore) record[@"beforeStatus"] = @(before);
                if (hasRead) record[@"readStatus"] = @(readStatus);
                if (hasAfter) record[@"afterStatus"] = @(after);
                if (hasUnlocked) { record[@"unlockedBefore"] = @(unlockedBefore); record[@"unlockedAfter"] = @(unlockedAfter); }
                NSArray *names = @[@"array", @"unique", @"data32", @"encoding"];
                for (size_t index = 0; index < 4; ++index) if (predicates[index] >= 0) record[names[index]] = @(predicates[index] != 0);
                NSData *json = [NSJSONSerialization dataWithJSONObject:record options:0 error:nullptr];
                if (json && json.length < 512) {
                    NSMutableData *line = [json mutableCopy]; [line appendBytes:"\n" length:1];
                    writeReadPacket(fd, line.bytes, line.length);
                }
            } @catch (...) {}
        } catch (...) {}
        (void)close(fd);
        errno = saved;
    }
};
}
