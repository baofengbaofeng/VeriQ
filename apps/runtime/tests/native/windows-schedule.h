/** 此头文件只供默认关闭的原生测试目标使用，测试事件遵循真实当前用户 SID 私有 ACL 和随机 nonce；生产 guardian 与 addon 都不包含本文件，测试不依赖全局环境开关或向普通产品接口增加调度权限。 */
#pragma once
#include "../../native/windows-common.h"

namespace veriq_test {
/** 每个测试阶段只允许固定名称并绑定本次随机 nonce，创建或打开后再次核验真实私有 ACL；句柄所有权由 RAII 保存，其他用户的对象或被抢占成非私有的事件都不能作为调度握手使用。 */
inline veriq::Handle scheduleEvent(const std::wstring& nonce, const std::wstring& phase) {
    veriq::require(nonce.size() == 36 && nonce.find_first_not_of(L"0123456789abcdef-") == std::wstring::npos, "NATIVE_TEST_NONCE_INVALID");
    veriq::require(phase == L"read-ready" || phase == L"cancel-missed" || phase == L"read-release", "NATIVE_TEST_PHASE_INVALID");
    veriq::PrivateSecurity security;
    const auto name = L"Local\\VeriQ-test-schedule-" + nonce + L"-" + phase;
    veriq::Handle event(CreateEventW(&security.attributes, TRUE, FALSE, name.c_str()));
    veriq::require(event.valid(), "NATIVE_TEST_EVENT_FAILED");
    veriq::verifyPrivate(event.value, SE_KERNEL_OBJECT);
    return event;
}
}
