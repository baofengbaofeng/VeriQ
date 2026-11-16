/** 文件型钥匙串的权限检查只使用公开 Security 与 CSSM 结构，把可信程序完整主体与当前辅助程序重新生成的模板比较；路径只是主体内部的一部分，不能单独代表签名身份或同用户调用者授权。 */
#pragma once
#include <Foundation/Foundation.h>
#include <Security/Security.h>
#include <Security/cssmtype.h>
#include <Security/cssmapple.h>
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>
#include <unistd.h>

namespace veriq {
/** 字节向量用于有界的公开主体比较表示，只有明确包含请求或密钥的实例才由 Secret 包装接管清理；该别名不执行加密、哈希或签名解析，也不把编码后的内容误称为可以安全写入日志的非秘密数据。 */
using Bytes = std::vector<uint8_t>;
constexpr size_t frameLimit = 512;
/** 本辅助程序的断言只携带固定错误标识并通过受保护的异常出口失败关闭，不把系统描述、请求字段或秘密材料拼接到异常文本；调用方负责根据修改是否开始区分普通失败与不确定结果。 */
inline void require(bool value) { if (!value) throw std::runtime_error("VAULT_REQUEST_FAILED"); }

/** Security 调用错误使用独立类型保存系统返回码，而结构或策略拒绝仍使用普通固定异常；该类型不生成系统描述或携带请求正文，只允许统一出口按原始状态分类，因此不会把秘密材料加入异常日志。 */
struct SecurityFailure final : std::exception {
    OSStatus code;
    /** 构造只保存已经返回的系统状态，不发起额外查询或将状态解释成成功回执；这样可以在释放本地引用后保留原始失败原因，最终是否锁定仍必须由当前请求持有的实际钥匙串引用核验。 */
    explicit SecurityFailure(OSStatus value) noexcept : code(value) {}
    /** 异常文本始终是固定英文标识，不把平台消息、路径或被拒绝的条目内容输出到调用者；具体错误码仅在同一进程的类型化分支内部使用，正常 V1 回复仍限制为已有的有限状态。 */
    const char *what() const noexcept override { return "VAULT_SECURITY_FAILED"; }
};

/** Security 调用在这个共用边界保留真实失败码，避免条目元数据成功后发生的服务故障被普通策略拒绝掩盖；成功不抛异常，结构检查仍使用独立断言，因此分类器只能把明确的系统不可用事实映射为 unavailable。 */
inline void requireSecurity(OSStatus error) { if (error != errSecSuccess) throw SecurityFailure(error); }

/** 统一错误出口只从已经捕获的类型化 Security 异常提取原始状态，普通结构或策略异常继续映射为通用拒绝；函数不查询任何存储，生产 catch 与非持久回归共享这段实现而不各自复制一套错误解释逻辑。 */
inline OSStatus securityFailureCode(std::exception_ptr error) noexcept {
    if (!error) return errSecAuthFailed;
    try { std::rethrow_exception(error); }
    catch (const SecurityFailure &failure) { return failure.code; }
    catch (...) { return errSecAuthFailed; }
}

/** 状态分类同时保留操作错误及同一持有引用的实际状态查询结果，修改不确定优先于所有其它状态；锁定必须有成功查询的真实标志，已知存储或服务不可用则可由任一实际系统调用证明，未知失败不推断缺失。 */
inline const char *securityFailureStatus(OSStatus operation, OSStatus stateError,
        SecKeychainStatus state, bool heldReference, bool mutation) {
    if (mutation) return "mutation-unconfirmed";
    if (heldReference && stateError == errSecSuccess && !(state & kSecUnlockStateStatus)) return "locked";
    if (operation == errSecNoDefaultKeychain || operation == errSecNoSuchKeychain ||
        operation == errSecNotAvailable || operation == errSecInvalidKeychain) return "unavailable";
    if (heldReference && (stateError == errSecNoDefaultKeychain || stateError == errSecNoSuchKeychain ||
        stateError == errSecNotAvailable || stateError == errSecInvalidKeychain)) return "unavailable";
    return "failed";
}
/** 明确属于本程序的可变缓冲通过 volatile 字节写入清理逻辑长度，避免编译器把结束生命周期前的覆盖优化掉；函数不访问已经释放的容量，也不承诺处理系统库或不可变对象保留的副本。 */
inline void wipe(void *data, size_t length) {
    volatile uint8_t *bytes = static_cast<volatile uint8_t *>(data);
    while (length--) *bytes++ = 0;
}

/** 所有 Create 与 Copy 返回的 CoreFoundation 引用均由独立作用域持有，借用的数组成员不转移所有权；禁止复制包装对象，避免错误分支重复释放同一个系统对象或过早释放正在查询的钥匙串引用。 */
template <class T> struct Owned {
    T value = nullptr;
    /** 默认构造保留空引用，供系统 Create 或 Copy 函数通过输出参数填入其新对象；调用方必须先检查返回状态和必要类型再使用，析构允许输出仍为空，因此早期错误无需人为制造或释放一个占位引用。 */
    Owned() = default;
    /** 带引用的构造表示接管调用方刚刚取得的 Create 或 Copy 结果，而不是增加借用引用的计数；只有已经属于调用方的引用才可传入，容器或返回字典里的借用成员必须先显式 retain。 */
    explicit Owned(T input) : value(input) {}
    Owned(const Owned &) = delete;
    Owned &operator=(const Owned &) = delete;
    /** 析构只释放本包装接管的一次引用，空结果允许安全退出构造失败的上层作用域；包装对象不可复制，因此同一系统引用不会因为普通 C++ 值传递而被两个析构路径重复释放。 */
    ~Owned() { if (value) CFRelease(value); }
};

/** 可变秘密缓冲由当前进程明确拥有，析构时清理实际逻辑长度并释放容器；这不承诺清理 Foundation 的内部临时副本，也不在 EOF 强制退出时与正在读取同一缓冲的系统函数竞争写入。 */
struct Secret {
    Bytes bytes;
    /** 构造按调用点指定的确定长度分配零初始化缓冲，尚不知道完整长度的帧会在写入之前预留固定上限；这样可以避免增长期间释放包含旧秘密片段的中间分配，而不把未初始化容量当作有效数据。 */
    explicit Secret(size_t size = 0) : bytes(size) {}
    Secret(const Secret &) = delete;
    Secret &operator=(const Secret &) = delete;
    /** 析构在 vector 真正释放内存之前覆盖当前全部有效字节，正常返回和 C++ 异常展开都走同一条清理路径；被 EOF 或系统信号强制终止的进程不会执行析构，因此此处不作强制死亡擦除保证。 */
    ~Secret() { wipe(bytes.data(), bytes.size()); }
};

/** Base64 等可变文本临时量同样可能包含完整密钥，因此用独立作用域包装确保字符串拼接抛出异常时也会覆盖；只接管已经生成的当前文本，不承诺清理 Foundation 创建的不可变编码对象。 */
struct SecretText {
    std::string value;
    /** 构造通过移动接管已有可变字符串的存储，使编码结果不需要再复制一份未受保护的堆缓冲；调用方随后只能在该作用域内使用 value，结束时由同一个包装负责覆盖实际有效字符。 */
    explicit SecretText(std::string text) : value(std::move(text)) {}
    SecretText(const SecretText &) = delete;
    SecretText &operator=(const SecretText &) = delete;
    /** 文本析构在标准字符串释放底层存储之前覆盖当前字符，即使后续拼接或系统调用抛出异常也会执行；它不依据内容判断是否敏感，因此错误分支不会因为某个编码步骤尚未完成而遗漏部分材料。 */
    ~SecretText() { wipe(value.data(), value.size()); }
};

/** 系统交互许可仅属于这个短命辅助进程，构造先保存原状态再禁止提示，正常和受保护异常路径恢复；主宿主不会调用这些接口，因此不会改变 Electron 或 Node 进程的交互状态。 */
struct NoUI {
    Boolean previous = false;
    /** 创建交互保护前必须成功取得原进程状态，再尝试禁用本进程交互；任一步骤失败都禁止继续进行钥匙串操作，因为无法建立无提示前提时不能猜测系统会自行拒绝弹窗。 */
    NoUI() {
        require(SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess);
        require(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess);
    }
    /** 正常离开保护作用域时恢复取得的原进程布尔值，不改写用户钥匙串设置或其他进程策略；恢复接口的结果不能撤销已经发生的存储操作，随后短命进程退出也不会留下持久交互开关。 */
    ~NoUI() { SecKeychainSetUserInteractionAllowed(previous); }
};

/** 新建模板明确列出当前可执行程序并固定描述符，模板中的标准所有者确认和公共加密权限仍由平台构造；返回对象由调用方释放，且任何实际写入之前都必须再次通过完整主体检查。 */
inline SecAccessRef restrictedAccess() {
    Owned<SecTrustedApplicationRef> application;
    require(SecTrustedApplicationCreateFromPath(nullptr, &application.value) == errSecSuccess);
    require(application.value != nullptr);
    const void *entry = application.value;
    Owned<CFArrayRef> applications(CFArrayCreate(nullptr, &entry, 1, &kCFTypeArrayCallBacks));
    require(applications.value != nullptr);
    Owned<SecAccessRef> access;
    require(SecAccessCreate(CFSTR("VeriQ Runtime Vault v1"), applications.value, &access.value) == errSecSuccess);
    require(access.value != nullptr);
    const SecAccessRef result = access.value;
    access.value = nullptr;
    return result;
}

/** 导出的 CSSM 内容按公开类型逐字段形成比较表示，整数采用固定顺序而不包含机器指针或结构填充；表示只在内存中用于相等检查，不解析签名散列、需求字节或平台私有主体的内部格式。 */
inline void number(Bytes &out, uint64_t value) {
    for (unsigned shift = 0; shift < 64; shift += 8) out.push_back(static_cast<uint8_t>(value >> shift));
}

/** 原始导出中的独立分配块必须在完整有界遍历后登记并且只释放一次，嵌入子表和尾指针是别名而非新分配；遇到无法安全证明所有权的形状直接结束本进程，让系统回收剩余内存而不是猜测释放路径。 */
struct RawAccess {
    CSSM_ACL_OWNER_PROTOTYPE *owner = nullptr;
    CSSM_ACL_ENTRY_INFO *entries = nullptr;
    uint32 count = 0;
    /** 每条分配记录保存可释放块的起始地址和完整范围，使检查器能发现不仅是重复起点还包括指向节点内部的部分重叠；长度为零的系统分配按最小一字节范围登记，释放时仍使用原始 malloc 返回地址。 */
    struct Allocation { void *pointer = nullptr; size_t length = 0; };
    std::vector<Allocation> allocations;
    size_t nodes = 0, dataBytes = 0;
    Bytes ownerSubject;
    /** 单个比较条目保留完整公开主体、授权集合、委托及标签等字段，来源句柄和外层顺序单独排除；所有不透明数据维持原字节表示，平台正常元数据条目也会完整导出而不是被跳过后假称没有其他权限。 */
    struct Entry {
        Bytes subject;
        Bytes validity;
        std::vector<CSSM_ACL_AUTHORIZATION_TAG> rights;
        CSSM_BOOL delegate = false;
        std::string tag;
    };
    std::vector<Entry> values;

    /** 原始系统导出的形状若超出安全遍历约定就立即终止整个单请求进程，不能展开不可信图形去猜测释放地址；固定退出码不含结构正文，调用者仍将可能已经发出的修改视为不确定。 */
    static void safe(bool value) { if (!value) _exit(126); }
    /** 分配台账把每个独立 malloc 块登记一次，并拒绝重复地址及超过固定预算的图形；Tail 和嵌入的 Sublist 不调用此入口，因此合法的结构内别名不会被误当成第二份可释放内存。 */
    void allocation(void *pointer, size_t length) {
        if (!pointer) return;
        const uintptr_t start = reinterpret_cast<uintptr_t>(pointer);
        const size_t span = std::max<size_t>(length, 1);
        safe(allocations.size() < 8192 && start <= UINTPTR_MAX - span);
        for (const auto &known : allocations) {
            const uintptr_t previous = reinterpret_cast<uintptr_t>(known.pointer);
            safe(!(start < previous + known.length && previous < start + span));
        }
        allocations.push_back({pointer, span});
    }
    /** 不透明字节串先验证指针与长度并累计整个导出的字节预算，再完整复制所有字节进入比较表示；不依据内容猜测路径或代码签名字段，也不截断超大数据让恶意前缀看起来等于可信模板。 */
    void datum(Bytes &out, const CSSM_DATA &value) {
        safe(value.Length <= 1048576 && dataBytes <= 1048576 - value.Length);
        safe(value.Length == 0 || value.Data != nullptr);
        allocation(value.Data, value.Length);
        dataBytes += value.Length;
        number(out, value.Length);
        if (value.Length) out.insert(out.end(), value.Data, value.Data + value.Length);
    }
    /** 类型树按公开的元素联合逐个遍历并记录原有兄弟次序，节点和数据统一进入所有权台账；递归深度、节点总数及真实尾节点同时核对，循环或复用子图在解引用下一层之前被明确拒绝。 */
    void list(Bytes &out, const CSSM_LIST &value, size_t depth = 0) {
        safe(depth <= 32 && value.ListType <= CSSM_LIST_TYPE_SEXPR);
        safe((value.Head == nullptr) == (value.Tail == nullptr));
        number(out, value.ListType);
        const CSSM_LIST_ELEMENT *last = nullptr;
        for (CSSM_LIST_ELEMENT *node = value.Head; node; node = node->NextElement) {
            safe(++nodes <= 4096);
            allocation(node, sizeof(*node));
            number(out, 1);
            number(out, node->ElementType);
            number(out, node->WordID);
            switch (node->ElementType) {
                case CSSM_LIST_ELEMENT_WORDID: break;
                case CSSM_LIST_ELEMENT_DATUM: datum(out, node->Element.Word); break;
                case CSSM_LIST_ELEMENT_SUBLIST: list(out, node->Element.Sublist, depth + 1); break;
                default: safe(false);
            }
            last = node;
        }
        safe(last == value.Tail);
        number(out, 0);
    }

    /** Apple 的公开导出使用 malloc 分别复制主体节点与授权数组，所有出口统一经过本包装回收；计数及长度在解引用前检查，无法识别的图形不以部分遍历继续服务下一条请求，因为辅助程序本来只处理单次请求。 */
    explicit RawAccess(SecAccessRef access) try {
        allocations.reserve(8192);
        require(SecAccessGetOwnerAndACL(access, &owner, &count, &entries) == errSecSuccess);
        safe(owner && count <= 64 && (count == 0 || entries));
        allocation(owner, sizeof(*owner)); allocation(entries, count * sizeof(*entries));
        list(ownerSubject, owner->TypedSubject);
        safe(owner->Delegate == CSSM_FALSE || owner->Delegate == CSSM_TRUE);
        for (uint32 index = 0; index < count; ++index) {
            const auto &raw = entries[index].EntryPublicInfo;
            Entry entry;
            list(entry.subject, raw.TypedSubject);
            safe(raw.Authorization.NumberOfAuthTags <= 64);
            safe(raw.Authorization.NumberOfAuthTags == 0 || raw.Authorization.AuthTags);
            allocation(raw.Authorization.AuthTags, raw.Authorization.NumberOfAuthTags * sizeof(
                CSSM_ACL_AUTHORIZATION_TAG));
            for (uint32 right = 0; right < raw.Authorization.NumberOfAuthTags; ++right)
                entry.rights.push_back(raw.Authorization.AuthTags[right]);
            std::sort(entry.rights.begin(), entry.rights.end());
            /** 公开 SecAccess 导出会重建 ACL 原型并清空平台内部的时间字段，因此这里仅比较实际导出的有效期表示；这不能证明底层存储没有隐藏的时间条件，真实访问仍由系统执行且不满足条件时保持失败关闭。 */
            datum(entry.validity, raw.TimeRange.StartDate);
            datum(entry.validity, raw.TimeRange.EndDate);
            safe(raw.Delegate == CSSM_FALSE || raw.Delegate == CSSM_TRUE);
            entry.delegate = raw.Delegate;
            const size_t length = strnlen(raw.EntryTag, sizeof(raw.EntryTag));
            safe(length < sizeof(raw.EntryTag));
            entry.tag.assign(raw.EntryTag, length);
            values.push_back(std::move(entry));
        }
    } catch (...) { _exit(126); }
    RawAccess(const RawAccess &) = delete;
    RawAccess &operator=(const RawAccess &) = delete;
    /** 只有完整有界导出构造成功后才执行逐块释放，台账已排除了重复指针因此不需要重新递归原始结构；逆序释放保证内层字节和节点先于外层数组回收，完全不使用 CFRelease 或 C++ delete 释放这些块。 */
    ~RawAccess() { for (auto iterator = allocations.rbegin(); iterator != allocations.rend(); ++iterator) free(
        iterator->pointer); }
};

/** 标准模板中的秘密权限与元数据权限分别分类，任何空授权、通配授权或未识别授权都必须拒绝；完整秘密主体需要精确匹配模板，而仅含平台元数据的条目不因其空应用列表被错误认作任意应用可读取秘密。 */
inline bool secretRight(CSSM_ACL_AUTHORIZATION_TAG right) {
    return right == CSSM_ACL_AUTHORIZATION_DECRYPT || right == CSSM_ACL_AUTHORIZATION_SIGN ||
        right == CSSM_ACL_AUTHORIZATION_MAC || right == CSSM_ACL_AUTHORIZATION_DERIVE ||
        right == CSSM_ACL_AUTHORIZATION_EXPORT_CLEAR || right == CSSM_ACL_AUTHORIZATION_EXPORT_WRAPPED;
}
/** 元数据分类仅列出公开已知的加密、条目属性读取和平台完整性权限，不包含任何明文导出或解密权利；混合条目中只要出现秘密权利，后续就必须验证完整受限主体而不能借元数据分类绕过检查。 */
inline bool metadataRight(CSSM_ACL_AUTHORIZATION_TAG right) {
    return right == CSSM_ACL_AUTHORIZATION_ENCRYPT || right == CSSM_ACL_AUTHORIZATION_DB_READ ||
        right == CSSM_ACL_AUTHORIZATION_INTEGRITY || right == CSSM_ACL_AUTHORIZATION_PARTITION_ID;
}
/** 两个权限条目的相等要求完整主体、排序后的授权集合、委托标记、公开有效期和条目标签全部相同；句柄和条目在数组中的顺序没有身份意义，但任何内部主体差异都不能作为升级兼容例外忽略。 */
inline bool equivalent(const RawAccess::Entry &left, const RawAccess::Entry &right) {
    return left.subject == right.subject && left.rights == right.rights && left.delegate == right.delegate &&
        left.validity == right.validity && left.tag == right.tag;
}

/** 权限快照包含完整公开导出的所有者及每个条目，条目顺序和随机句柄不作为身份而主体内部次序严格保留；该表示只用于独立测试的内存对账，不写入生产协议、日志或磁盘，也不宣称包含未公开的时间策略。 */
inline Bytes accessSnapshot(SecAccessRef access) {
    RawAccess raw(access);
    Bytes result;
    number(result, raw.ownerSubject.size());
    result.insert(result.end(), raw.ownerSubject.begin(), raw.ownerSubject.end());
    number(result, raw.owner->Delegate);
    std::vector<Bytes> entries;
    for (const auto &entry : raw.values) {
        Bytes item;
        number(item, entry.subject.size());
        item.insert(item.end(), entry.subject.begin(), entry.subject.end());
        number(item, entry.delegate);
        number(item, entry.rights.size());
        for (auto right : entry.rights) number(item, right);
        item.insert(item.end(), entry.validity.begin(), entry.validity.end());
        number(item, entry.tag.size());
        item.insert(item.end(), entry.tag.begin(), entry.tag.end());
        entries.push_back(std::move(item));
    }
    std::sort(entries.begin(), entries.end());
    number(result, entries.size());
    for (const auto &entry : entries) { number(result, entry.size()); result.insert(result.end(), entry.begin(),
        entry.end()); }
    return result;
}

/** 高层授权枚举先确认每个条目的公开权利类型，底层再核对完整主体避免 CopyData 仅返回路径的问题；所有者与额外改变权限的条目同样不能放宽，验证只读且从不修复或归一化持久条目。 */
inline bool verifiedAccess(SecAccessRef candidate, SecAccessRef expected) {
    Owned<CFArrayRef> list;
    if (SecAccessCopyACLList(candidate, &list.value) != errSecSuccess || !list.value || CFGetTypeID(
        list.value) != CFArrayGetTypeID() || CFArrayGetCount(list.value) > 64) return false;
    for (CFIndex index = 0; index < CFArrayGetCount(list.value); ++index) {
        auto acl = static_cast<SecACLRef>(const_cast<void *>(CFArrayGetValueAtIndex(list.value, index)));
        if (!acl || CFGetTypeID(acl) != SecACLGetTypeID()) return false;
        Owned<CFArrayRef> rights(SecACLCopyAuthorizations(acl));
        if (!rights.value || CFGetTypeID(rights.value) != CFArrayGetTypeID() || CFArrayGetCount(rights.value) == 0
            || CFArrayGetCount(rights.value) > 64) return false;
        bool trustedRequired = false;
        for (CFIndex right = 0; right < CFArrayGetCount(rights.value); ++right) {
            CFTypeRef value = CFArrayGetValueAtIndex(rights.value, right);
            if (!value || CFGetTypeID(value) != CFStringGetTypeID() || CFEqual(value,
                kSecACLAuthorizationAny)) return false;
            for (CFStringRef secret : {kSecACLAuthorizationDecrypt, kSecACLAuthorizationSign, kSecACLAuthorizationMAC,
                kSecACLAuthorizationDerive, kSecACLAuthorizationExportClear, kSecACLAuthorizationExportWrapped})
                if (CFEqual(value, secret)) trustedRequired = true;
        }
        Owned<CFArrayRef> applications;
        Owned<CFStringRef> description;
        SecKeychainPromptSelector prompt = 0;
        if (SecACLCopyContents(acl, &applications.value, &description.value, &prompt) != errSecSuccess) return false;
        if (applications.value && (CFGetTypeID(applications.value) != CFArrayGetTypeID() || CFArrayGetCount(
            applications.value) > 64)) return false;
        if (trustedRequired) {
            if (!applications.value || CFArrayGetCount(applications.value) != 1) return false;
            CFTypeRef principal = CFArrayGetValueAtIndex(applications.value, 0);
            if (!principal || CFGetTypeID(principal) != SecTrustedApplicationGetTypeID()) return false;
        }
    }
    RawAccess actual(candidate), wanted(expected);
    if (actual.ownerSubject != wanted.ownerSubject || actual.owner->Delegate != wanted.owner->Delegate) return false;
    bool decrypt = false;
    for (const auto &entry : actual.values) {
        if (entry.rights.empty()) return false;
        bool sensitive = false;
        for (auto right : entry.rights) {
            if (secretRight(right)) sensitive = true;
            else if (!metadataRight(right)) return false;
        }
        if (sensitive) {
            if (std::none_of(wanted.values.begin(), wanted.values.end(), [&](const auto &value) { return equivalent(
                entry, value); })) return false;
            if (std::find(entry.rights.begin(), entry.rights.end(), CSSM_ACL_AUTHORIZATION_DECRYPT) != entry.rights.end(
                )) decrypt = true;
        } else {
            if (entry.delegate != CSSM_FALSE || entry.validity != Bytes(16, 0)) return false;
        }
    }
    return decrypt;
}
}
