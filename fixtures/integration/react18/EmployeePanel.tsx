import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";
import { VeriqButton } from "./VeriqButton";

/** 持久化记录只包含公开业务标识和展示名称，测试行键使用服务端 id，不使用数组位置、姓名或任何认证 token；React key 与
 * DOM recordKey 同时设置但承担不同职责。
 */
export interface Employee {
    id: string;
    name: string;
}

async function employees(code: string, signal: AbortSignal): Promise<Employee[]> {
    // 查询遵守当前正常应用会话，不从组件属性接收高权限 fixture token；AbortSignal 交给 fetch，旧数据范围卸载时可以取消
    // 请求，避免旧响应覆盖新的业务范围。Query key 同时包含 code，
    // 使每个独立夹具的缓存隔离，不共享上一轮测试记录。失败仅抛固定诊断，原始请求头、业务响应和会话 Cookie
    // 不进入异常文本。示例结果来自真正 HTTP GET，页面不会把 mutation 参数伪装成持久化数据。
    const response = await fetch(`/employees?${new URLSearchParams({ code })}`, { signal });
    if (!response.ok) throw new Error("Employee query failed");
    const body: { items: Employee[] } = await response.json();
    return body.items;
}

/** 该集成组件接收公开夹具 code 与普通富文本说明，由应用提供 QueryClientProvider 和 i18nextProvider；code
 * 仅关联受控数据，不包含清理令牌，所有网络请求走正常业务会话。
 * 示例文件用于接入现有 Vite6/Tailwind3 项目，不创建第二套前端包或锁文件。
 * descriptionHtml 是不可信展示内容，清洗后仍放在固定业务锚点内。
 * 实际测试环境的语言和时区由发布环境固定，组件不偷偷修改全局设置。
 */
export function EmployeePanel({
    code,
    descriptionHtml,
}: {
    code: string;
    descriptionHtml: string;
}) {
    const { t } = useTranslation();
    const cache = useQueryClient();
    const [name, setName] = useState("");
    const list = useQuery({
        queryKey: ["employee", code],
        queryFn: ({ signal }) => employees(code, signal),
    });
    const save = useMutation({
        retry: false,
        mutationFn: async () => {
            const response = await fetch("/employees", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ code, name }),
            });
            if (!response.ok) throw new Error("Employee save failed");
            return response.json() as Promise<{ id: string; status: string }>;
        },
        onSuccess: async () => {
            // 保存成功后等待当前夹具范围的真实 GET 更新，表格不提前插入尚未读取的乐观行；成功提示只表达写接口结果，
            // 持久化验收还必须刷新和检查服务端记录。
            // mutation 禁止自动重试，连接丢失时保留结果未知，不再重复提交业务副作用。
            // invalidateQueries 使用精确 key，后台其它夹具查询不会冒充本次业务关联请求。
            // 网络观察器仍应匹配 method、path 和 code，不能仅凭 GET 出现就判断保存完成。
            await cache.invalidateQueries({ queryKey: ["employee", code], exact: true });
        },
    });
    const submit = (event: FormEvent) => {
        event.preventDefault();
        save.mutate();
    };
    const safeHtml = DOMPurify.sanitize(descriptionHtml, {
        ALLOWED_TAGS: ["p", "strong", "em", "ul", "li", "a"],
        ALLOWED_ATTR: ["href"],
        ALLOW_DATA_ATTR: false,
    });
    return (
        <main data-testid="employee.page">
            <div
                data-testid="employee.description"
                dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
            <form data-testid="employee.form" onSubmit={submit}>
                <label htmlFor="employee-name">{t("employee.name")}</label>
                <input
                    id="employee-name"
                    data-testid="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={160}
                />
                <VeriqButton type="submit" data-testid="save" disabled={save.isPending}>
                    {t("employee.save")}
                </VeriqButton>
            </form>
            <p role="status" data-testid="result">
                {save.isPending
                    ? t("employee.saving")
                    : save.isError
                      ? t("employee.saveError")
                      : save.isSuccess
                        ? t("employee.saved")
                        : ""}
            </p>
            {list.isPending && <p data-testid="employee.loading">{t("employee.loading")}</p>}
            {list.isError && (
                <p role="alert" data-testid="employee.queryError">
                    {t("employee.queryError")}
                </p>
            )}
            <table data-testid="employee.table" aria-busy={list.isFetching}>
                <caption>{t("employee.persisted")}</caption>
                <tbody>
                    {list.data?.map((employee) => (
                        <tr
                            key={employee.id}
                            data-testid="employee.row"
                            data-record-key={employee.id}
                        >
                            <td data-testid="employee.name">{employee.name}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <Dialog.Root>
                <Dialog.Trigger asChild>
                    <VeriqButton data-testid="employee.help">{t("employee.help")}</VeriqButton>
                </Dialog.Trigger>
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 bg-black/40" />
                    <Dialog.Content
                        data-testid="employee.dialog"
                        className="fixed left-1/4 top-1/4 rounded bg-white p-4"
                    >
                        <Dialog.Title>{t("employee.help")}</Dialog.Title>
                        <Dialog.Description>{t("employee.helpDescription")}</Dialog.Description>
                        <Dialog.Close asChild>
                            <VeriqButton data-testid="employee.dialog.close">
                                {t("common.close")}
                            </VeriqButton>
                        </Dialog.Close>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </main>
    );
}
