import { Field, List, StringList, useValue, useSet } from "../resources/fields";
import { Button } from "@veriq/ui";
export function IdentityFields({
  path,
  role = false,
}: {
  path: string;
  role?: boolean;
}) {
  return (
    <>
      {role && (
        <Field name={`${path}.roleKey`} label="业务角色 key / Role key" />
      )}
      <Field
        name={`${path}.authAdapterVersionId`}
        label="认证适配器固定版本 / Auth adapter version UUID"
      />
      <Field name={`${path}.secretRef`} label="凭证引用 / Secret reference" />
      <Field
        name={`${path}.secretVersionId`}
        label="凭证固定版本 / Secret version UUID"
      />
      <StringList
        name={`${path}.allowedIdentityIds`}
        label="允许身份 ID / Allowed identity IDs"
      />
      <small>
        只保存固定版本引用，不包含密码或会话 / Version references only, no
        credentials or sessions.
      </small>
    </>
  );
}
export function EnvironmentFields() {
  const fixture = useValue<unknown>("content.document.fixtureIdentity"),
    set = useSet();
  return (
    <>
      <Field name="content.document.baseURL" label="前端 URL / Frontend URL" />
      <Field name="content.document.apiBaseURL" label="API URL" />
      <Field name="content.document.locale" label="语言 / Locale" />
      <Field name="content.document.timezone" label="时区 / Timezone" />
      <Field
        name="content.document.buildSha"
        label="应用构建 SHA / Build SHA"
        optional
      />
      <StringList
        name="content.document.allowedOrigins"
        label="允许来源 / Allowed origins"
      />
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
