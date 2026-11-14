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
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>

namespace veriq {
using Bytes = std::vector<uint8_t>;
constexpr size_t frameLimit = 512;
inline void require(bool value) { if (!value) throw std::runtime_error("VAULT_REQUEST_FAILED"); }
inline void wipe(void *data, size_t length) {
    volatile uint8_t *bytes = static_cast<volatile uint8_t *>(data);
    while (length--) *bytes++ = 0;
}

/** 所有 Create 与 Copy 返回的 CoreFoundation 引用均由独立作用域持有，借用的数组成员不转移所有权；禁止复制包装对象，避免错误分支重复释放同一个系统对象或过早释放正在查询的钥匙串引用。 */
template <class T> struct Owned {
    T value = nullptr;
    Owned() = default;
    explicit Owned(T input) : value(input) {}
    Owned(const Owned &) = delete;
    Owned &operator=(const Owned &) = delete;
    ~Owned() { if (value) CFRelease(value); }
};

/** 可变秘密缓冲由当前进程明确拥有，析构时清理实际逻辑长度并释放容器；这不承诺清理 Foundation 的内部临时副本，也不在 EOF 强制退出时与正在读取同一缓冲的系统函数竞争写入。 */
struct Secret {
    Bytes bytes;
    explicit Secret(size_t size = 0) : bytes(size) {}
    Secret(const Secret &) = delete;
    Secret &operator=(const Secret &) = delete;
    ~Secret() { wipe(bytes.data(), bytes.size()); }
};

/** 系统交互许可仅属于这个短命辅助进程，构造先保存原状态再禁止提示，正常和受保护异常路径恢复；主宿主不会调用这些接口，因此不会改变 Electron 或 Node 进程的交互状态。 */
struct NoUI {
    Boolean previous = false;
    NoUI() {
        require(SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess);
        require(SecKeychainSetUserInteractionAllowed(false) == errSecSuccess);
    }
    ~NoUI() { SecKeychainSetUserInteractionAllowed(previous); }
};

/** 新建模板明确列出当前可执行程序并固定描述符，模板中的标准所有者确认和公共加密权限仍由平台构造；返回对象由调用方释放，且任何实际写入之前都必须再次通过完整主体检查。 */
inline SecAccessRef restrictedAccess() {
    Owned<SecTrustedApplicationRef> application;
    require(SecTrustedApplicationCreateFromPath(nullptr, &application.value) == errSecSuccess);
    const void *entry = application.value;
    Owned<CFArrayRef> applications(CFArrayCreate(nullptr, &entry, 1, &kCFTypeArrayCallBacks));
    require(applications.value != nullptr);
    SecAccessRef access = nullptr;
    require(SecAccessCreate(CFSTR("VeriQ Runtime Vault v1"), applications.value, &access) == errSecSuccess);
    return access;
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
    std::vector<void *> allocations;
    size_t nodes = 0, dataBytes = 0;
    Bytes ownerSubject;
    struct Entry {
        Bytes subject;
        Bytes validity;
        std::vector<CSSM_ACL_AUTHORIZATION_TAG> rights;
        CSSM_BOOL delegate = false;
        std::string tag;
    };
    std::vector<Entry> values;

    static void safe(bool value) { if (!value) _exit(126); }
    void allocation(void *pointer) {
        if (!pointer) return;
        safe(allocations.size() < 8192 && std::find(allocations.begin(), allocations.end(), pointer) == allocations.end());
        allocations.push_back(pointer);
    }
    void datum(Bytes &out, const CSSM_DATA &value) {
        safe(value.Length <= 1048576 && dataBytes <= 1048576 - value.Length);
        safe(value.Length == 0 || value.Data != nullptr);
        allocation(value.Data);
        dataBytes += value.Length;
        number(out, value.Length);
        if (value.Length) out.insert(out.end(), value.Data, value.Data + value.Length);
    }
    void list(Bytes &out, const CSSM_LIST &value, size_t depth = 0) {
        safe(depth <= 32 && value.ListType <= CSSM_LIST_TYPE_SEXPR);
        safe((value.Head == nullptr) == (value.Tail == nullptr));
        number(out, value.ListType);
        const CSSM_LIST_ELEMENT *last = nullptr;
        for (CSSM_LIST_ELEMENT *node = value.Head; node; node = node->NextElement) {
            safe(++nodes <= 4096);
            allocation(node);
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
        allocation(owner); allocation(entries);
        list(ownerSubject, owner->TypedSubject);
        safe(owner->Delegate == CSSM_FALSE || owner->Delegate == CSSM_TRUE);
        for (uint32 index = 0; index < count; ++index) {
            const auto &raw = entries[index].EntryPublicInfo;
            Entry entry;
            list(entry.subject, raw.TypedSubject);
            safe(raw.Authorization.NumberOfAuthTags <= 64);
            safe(raw.Authorization.NumberOfAuthTags == 0 || raw.Authorization.AuthTags);
            allocation(raw.Authorization.AuthTags);
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
    ~RawAccess() { for (auto iterator = allocations.rbegin(); iterator != allocations.rend(); ++iterator) free(*iterator); }
};

/** 标准模板中的秘密权限与元数据权限分别分类，任何空授权、通配授权或未识别授权都必须拒绝；完整秘密主体需要精确匹配模板，而仅含平台元数据的条目不因其空应用列表被错误认作任意应用可读取秘密。 */
inline bool secretRight(CSSM_ACL_AUTHORIZATION_TAG right) {
    return right == CSSM_ACL_AUTHORIZATION_DECRYPT || right == CSSM_ACL_AUTHORIZATION_SIGN ||
        right == CSSM_ACL_AUTHORIZATION_MAC || right == CSSM_ACL_AUTHORIZATION_DERIVE ||
        right == CSSM_ACL_AUTHORIZATION_EXPORT_CLEAR || right == CSSM_ACL_AUTHORIZATION_EXPORT_WRAPPED;
}
inline bool metadataRight(CSSM_ACL_AUTHORIZATION_TAG right) {
    return right == CSSM_ACL_AUTHORIZATION_ENCRYPT || right == CSSM_ACL_AUTHORIZATION_DB_READ ||
        right == CSSM_ACL_AUTHORIZATION_INTEGRITY || right == CSSM_ACL_AUTHORIZATION_PARTITION_ID;
}
inline bool equivalent(const RawAccess::Entry &left, const RawAccess::Entry &right) {
    return left.subject == right.subject && left.rights == right.rights && left.delegate == right.delegate &&
        left.validity == right.validity && left.tag == right.tag;
}

/** 高层授权枚举先确认每个条目的公开权利类型，底层再核对完整主体避免 CopyData 仅返回路径的问题；所有者与额外改变权限的条目同样不能放宽，验证只读且从不修复或归一化持久条目。 */
inline bool verifiedAccess(SecAccessRef candidate, SecAccessRef expected) {
    Owned<CFArrayRef> list;
    if (SecAccessCopyACLList(candidate, &list.value) != errSecSuccess || !list.value || CFArrayGetCount(list.value) > 64) return false;
    for (CFIndex index = 0; index < CFArrayGetCount(list.value); ++index) {
        auto acl = static_cast<SecACLRef>(const_cast<void *>(CFArrayGetValueAtIndex(list.value, index)));
        if (!acl || CFGetTypeID(acl) != SecACLGetTypeID()) return false;
        Owned<CFArrayRef> rights(SecACLCopyAuthorizations(acl));
        if (!rights.value || CFArrayGetCount(rights.value) == 0 || CFArrayGetCount(rights.value) > 64) return false;
        for (CFIndex right = 0; right < CFArrayGetCount(rights.value); ++right) {
            CFTypeRef value = CFArrayGetValueAtIndex(rights.value, right);
            if (!value || CFGetTypeID(value) != CFStringGetTypeID() || CFEqual(value, kSecACLAuthorizationAny)) return false;
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
            if (std::none_of(wanted.values.begin(), wanted.values.end(), [&](const auto &value) { return equivalent(entry, value); })) return false;
            if (std::find(entry.rights.begin(), entry.rights.end(), CSSM_ACL_AUTHORIZATION_DECRYPT) != entry.rights.end()) decrypt = true;
        } else {
            if (entry.delegate != CSSM_FALSE || entry.validity != Bytes(16, 0)) return false;
        }
    }
    return decrypt;
}
}
