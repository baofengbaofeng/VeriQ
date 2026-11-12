/**
 * 环境 DSL 表单字段：业务角色身份引用只存固定版本 UUID，从不内嵌密码或会话。allowedIdentityIds 为字符串列表。
 * 与 IdentityManager 配合；secretRef 仅引用凭证元数据。
 */

import { Field, List, StringList, useValue, useSet } from "../resources/fields";
import { Button } from "@veriq/ui";
/**
 * 在给定 RHF path 下编辑 authAdapter/secret 版本引用与 allowedIdentityIds。
 * role=true 时额外要求 roleKey；注释提示禁止保存明文。
 */
export function IdentityFields({ path, role = false }: { path: string; role?: boolean }) {
    return (
        <>
            {role && <Field name={`${path}.roleKey`} label="业务角色 key / Role key" />}
            <Field
                name={`${path}.authAdapterVersionId`}
                label="认证适配器固定版本 / Auth adapter version UUID"
            />
            <Field name={`${path}.secretRef`} label="凭证引用 / Secret reference" />
            <Field name={`${path}.secretVersionId`} label="凭证固定版本 / Secret version UUID" />
            <StringList
                name={`${path}.allowedIdentityIds`}
                label="允许身份 ID / Allowed identity IDs"
            />
            <small>
                只保存固定版本引用，不包含密码或会话 / Version references only, no credentials or
                sessions.
            </small>
        </>
    );
}
/**
 * 环境文档根字段：夹具身份、角色映射与浏览器相关配置入口。fixtureIdentity 可为空对象；fixtureIdentity 允许先用空对象占位再补全。
 * 读写仅经 useValue/useSet；保存由资源编辑器工具栏触发。
 */
export function EnvironmentFields() {
    const fixture = useValue<unknown>("content.document.fixtureIdentity"),
        set = useSet();
    return (
        <>
            <Field name="content.document.baseURL" label="前端 URL / Frontend URL" />
            <Field name="content.document.apiBaseURL" label="API URL" />
            <Field name="content.document.locale" label="语言 / Locale" />
            <Field name="content.document.timezone" label="时区 / Timezone" />
            <Field name="content.document.buildSha" label="应用构建 SHA / Build SHA" optional />
            <StringList name="content.document.allowedOrigins" label="允许来源 / Allowed origins" />
            <List
                name="content.document.roles"
                title="业务角色身份 / Business role identities"
                initial={() => ({
                    roleKey: "reader",
                    authAdapterVersionId: "",
                    secretRef: "business",
                    secretVersionId: "",
                    allowedIdentityIds: [],
                })}
            >
                {(path) => <IdentityFields path={path} role />}
            </List>
            {fixture ? (
                <>
                    <Field name="content.document.fixtureBaseURL" label="Fixture URL" />
                    <IdentityFields path="content.document.fixtureIdentity" />
                    <Button
                        tone="danger"
                        onClick={() => {
                            set("content.document.fixtureIdentity", undefined);
                            set("content.document.fixtureBaseURL", undefined);
                        }}
                    >
                        移除 Fixture 身份 / Remove fixture identity
                    </Button>
                </>
            ) : (
                <Button
                    tone="secondary"
                    onClick={() => {
                        set("content.document.fixtureIdentity", {
                            authAdapterVersionId: "",
                            secretRef: "fixture",
                            secretVersionId: "",
                            allowedIdentityIds: [],
                        });
                        set("content.document.fixtureBaseURL", "http://localhost:3000");
                    }}
                >
                    添加独立 Fixture 身份 / Add fixture identity
                </Button>
            )}
        </>
    );
}
