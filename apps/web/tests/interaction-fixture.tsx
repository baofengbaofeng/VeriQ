/**
 * 浏览器夹具仅组合实际抽屉、字段、输入和共享确认框，保留生产样式与严格模式，不复制焦点或对话框实现。
 * 本入口只由开发服务器按测试路径加载，未注册到产品路由，也未加入发布构建入口。
 * 合成资源没有后端；确认次数作为用户可见状态验证按钮确实收到普通指针操作。
 */
import { lazy, StrictMode, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ConfirmDialog } from "@veriq/ui";
import { Button } from "../src/components/Button";
import { Field } from "../src/components/Field";
import { Input, Textarea } from "../src/components/Input";
import { Select, SelectItem } from "../src/components/Select";
import { Sheet } from "../src/components/Sheet";
import { AgentModelControls } from "../src/features/agent/ModelSettings";
import { CloudAgentAdapter } from "../src/features/agent/adapters";
import { CloudAiAdapter } from "../src/features/ai/adapters";
import { CloudReportAdapter } from "../src/features/reports/adapters";
import { OperationFeedbackProvider } from "../src/operation-feedback";
import { DatasetFields, newStaticDataset } from "../src/features/resources/DatasetFields";
import { CloudResourceAdapter } from "../src/features/resources/adapters";
import { ChoiceFilter } from "../src/features/workspaces/ChoiceFilter";
import { SettingsPanel, SettingsTabList } from "../src/features/workspaces/SettingsTabs";
import { canExportWorkspaceTable, DataTable, TablePagination, TableSearch, useTableView } from "../src/table-view";
import "../src/menu-focus";
import "../src/features/agent/agent.css";
import "../src/features/resources/resources.css";
import "../src/style.css";
import "../src/admin.css";
import "../src/web-theme.css";

const FocusEditor = lazy(async () => ({ default: (await import("../src/features/resources/Monaco")).Monaco }));
const FixtureAgent = lazy(async () => ({
    default: (await import("../src/features/agent/AgentWorkspaceView")).AgentWorkspaceView,
}));
const ResourceDirectory = lazy(async () => ({
    default: (await import("../src/features/resources/ResourcePage")).ResourceWorkspaceView,
}));

/**
 * 目录夹具在严格模式挂载生产资源列表，请求由浏览器测试拦截，保证重放时使用真实查询和取消信号。
 */
function ResourceDirectoryFixture() {
    const workspace = {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Synthetic resource workspace",
        key: "synthetic-resource-workspace",
        role: "OWNER",
        archived: false,
        createdAt: "2026-01-01T00:00:00Z",
    } as const;
    const [adapter] = useState(() => new CloudResourceAdapter(workspace.id));
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    return (
        <BrowserRouter>
            <QueryClientProvider client={client}>
                <OperationFeedbackProvider>
                    <Suspense>
                        <ResourceDirectory
                            workspace={workspace}
                            adapter={adapter}
                            fixedKind="DATASET"
                            webConsole
                            library
                        />
                    </Suspense>
                </OperationFeedbackProvider>
            </QueryClientProvider>
        </BrowserRouter>
    );
}

/**
 * 会话与设置夹具挂载真实组件和传输适配器，由测试拦截合成工作区的请求，避免测试从开发数据库读取或写入记录。
 */
function AgentFixture({
    conversation = false,
    wide = false,
    sheet = false,
}: {
    conversation?: boolean;
    wide?: boolean;
    sheet?: boolean;
}) {
    const workspace = {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Synthetic model workspace",
        key: "synthetic-model-workspace",
        role: "OWNER",
        archived: false,
        createdAt: "2026-01-01T00:00:00Z",
    } as const;
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    const [adapter] = useState(() => new CloudAgentAdapter(workspace.id));
    const [providers] = useState(() => new CloudAiAdapter(workspace.id));
    const [reports] = useState(() => new CloudReportAdapter(workspace.id));
    const renderConversation = (fullWidth: boolean) => (
        <Suspense>
            <FixtureAgent
                workspace={workspace}
                owner="synthetic-owner"
                ownerName="Synthetic owner"
                adapter={adapter}
                providers={providers}
                reports={reports}
                wide={fullWidth}
                navigate={() => null}
            />
        </Suspense>
    );
    return (
        <QueryClientProvider client={client}>
            <OperationFeedbackProvider>
                {sheet ? (
                    <Sheet title="Test Agent" open onOpenChange={() => {}} size="third" resizable>
                        {renderConversation}
                    </Sheet>
                ) : conversation ? (
                    renderConversation(wide)
                ) : (
                    <AgentModelControls
                        workspace={workspace}
                        owner="synthetic-owner"
                        adapter={adapter}
                        providers={providers}
                    />
                )}
            </OperationFeedbackProvider>
        </QueryClientProvider>
    );
}

/**
 * 焦点夹具用实际的组合搜索、输入控件与线型标签验证背景变化，编辑器仅在其专属场景加载语言和命令服务。
 */
function FocusFixture({ editor, longOptions }: { editor: boolean; longOptions: boolean }) {
    const [tab, setTab] = useState<"basic" | "members">("basic");
    const [search, setSearch] = useState("");
    const [selection, setSelection] = useState("alpha");
    const [status, setStatus] = useState("");
    const longOption = `Long synthetic option ${"identifier".repeat(20)}`;
    return (
        <main>
            <SettingsTabList
                tabs={[
                    { id: "basic", label: "Basic information" },
                    { id: "members", label: "Members" },
                ]}
                selected={tab}
                prefix="focus-fixture"
                activate={setTab}
                label="Workspace settings"
                className="vq-settings-tabs"
            />
            <TableSearch label="Search synthetic items" value={search} onChange={setSearch} />
            <Field label="Synthetic name">
                <Input defaultValue="Sample" />
            </Field>
            <Field label="Synthetic email">
                <Input type="email" />
            </Field>
            <Field label="Synthetic description">
                <Textarea />
            </Field>
            <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                    <Button size="compact">Synthetic dropdown</Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                    <DropdownMenu.Content className="vq-dropdown" sideOffset={4}>
                        <DropdownMenu.CheckboxItem className="vq-dropdown-item" checked>
                            Alpha
                        </DropdownMenu.CheckboxItem>
                        <DropdownMenu.CheckboxItem className="vq-dropdown-item" checked={false}>
                            Beta
                        </DropdownMenu.CheckboxItem>
                        <DropdownMenu.CheckboxItem className="vq-dropdown-item" disabled>
                            Disabled option
                        </DropdownMenu.CheckboxItem>
                        {longOptions ? (
                            <DropdownMenu.Item className="vq-dropdown-item">{longOption}</DropdownMenu.Item>
                        ) : null}
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
            <Select
                value={selection}
                onValueChange={setSelection}
                aria-label="Synthetic select"
                appearance="default-dropdown"
            >
                <SelectItem value="alpha">Alpha</SelectItem>
                <SelectItem value="beta">Beta</SelectItem>
                <SelectItem value="disabled" disabled>
                    Disabled option
                </SelectItem>
                {longOptions ? <SelectItem value="long">{longOption}</SelectItem> : null}
            </Select>
            <ChoiceFilter
                label="Status"
                value={status}
                onChange={setStatus}
                choices={[
                    ["", "All"],
                    ["true", "Enabled"],
                    ["false", "Disabled"],
                ]}
            />
            {editor ? (
                <Suspense>
                    <FocusEditor label="Synthetic JSON" value={'{"name":"Example"}'} />
                </Suspense>
            ) : null}
        </main>
    );
}

/**
 * 分页夹具把真实分页放在管理台正文与表格之后，使用较长的页码测量换页按钮在两档视口中的实际排版。
 */
function PaginationFixture() {
    const [page, setPage] = useState(10001);
    return (
        <div className="vq-shell">
            <main className="vq-content">
                <table className="vq-user-table">
                    <thead>
                        <tr>
                            <th scope="col">Name</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>Synthetic member</td>
                        </tr>
                    </tbody>
                </table>
                <TablePagination view={{ page, pageCount: 10002, setPage }} label="Synthetic table pages" />
            </main>
        </div>
    );
}

const sampleTableRows = Array.from({ length: 12 }, (_, index) => ({
    name: `Record ${String(index + 1).padStart(2, "0")}`,
    note: index === 5 ? "=1+2" : index === 6 ? 'Value, "quoted"\nnew line' : "",
}));

/**
 * 表格夹具使用相同的分页状态和生产表格框架，保留可筛选的显示列，同时用合成文本检查导出后的转义行为。
 */
function DataTableFixture({ exportAllowed }: { exportAllowed: boolean }) {
    const view = useTableView(sampleTableRows, {
        matches: (row, term) => row.name.toLowerCase().includes(term),
    });
    const table = (
        <div className="table-scroll">
            <table className="vq-user-table" aria-label="Example records">
                <thead>
                    <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Note</th>
                    </tr>
                </thead>
                <tbody>
                    {view.rows.map((row) => (
                        <tr key={row.name}>
                            <td>{row.name}</td>
                            <td>{row.note}</td>
                        </tr>
                    ))}
                    {view.rows.length === 0 && (
                        <tr>
                            <td className="vq-table-empty" colSpan={2}>
                                No matching records.
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
    return (
        <div className="vq-shell">
            <main className="vq-content">
                <DataTable
                    label="Example records"
                    view={view}
                    searchLabel="Search records"
                    paginationLabel="Example record pages"
                    exportAllowed={exportAllowed}
                    exportColumns={[
                        { label: "Name", value: (row) => row.name },
                        { label: "Note", value: (row) => row.note },
                    ]}
                >
                    {table}
                </DataTable>
            </main>
        </div>
    );
}

/**
 * 数据集测试使用实际表单文档和抽屉，观察字段类型变更后的受控值，并保留表格滚动和弹层焦点范围。
 * 图形表单置于一级页签下方，确保控件可使用抽屉的整个内容宽度；夹具不参与后端资源读取或写入。
 */
function DatasetFixture({ shape = "TABLE" }: { shape?: "TABLE" | "TREE" }) {
    const [open, setOpen] = useState(false);
    const form = useForm({ defaultValues: { content: { document: newStaticDataset(shape) } } });
    const dataset = useWatch({ control: form.control, name: "content.document" });
    const title = shape === "TREE" ? "Synthetic tree dataset" : "Synthetic dataset";
    const prefix = `synthetic-dataset-${shape}`;
    return (
        <>
            <button type="button" onClick={() => setOpen(true)}>
                Edit {title.toLowerCase()}
            </button>
            <Sheet open={open} onOpenChange={setOpen} title={title} size="third">
                <FormProvider {...form}>
                    <SettingsTabList
                        tabs={[{ id: "form", label: "Data (Form)", icon: "design" }]}
                        selected="form"
                        prefix={prefix}
                        activate={() => {}}
                        label="Dataset editor"
                        className="vq-settings-tabs vq-dataset-tabs"
                    />
                    <div className="vq-dataset-panels">
                        <SettingsPanel tab="form" selected="form" prefix={prefix}>
                            <fieldset className="vq-editor-fields">
                                <DatasetFields dataset={dataset} />
                            </fieldset>
                        </SettingsPanel>
                    </div>
                </FormProvider>
            </Sheet>
        </>
    );
}

/**
 * 夹具只持有打开状态与确认计数，两个自然命名的入口分别模拟列表编辑和新增资源，便于核对原始焦点归属。
 * 关闭、嵌套取消、焦点圈定和提示展示全部交给实际组件，不设置额外事件处理器修补交互。
 * 字段内容是公开合成建议，不包含真实恢复短语、用户信息或测试定位标记。
 */
function InteractionFixture() {
    const [open, setOpen] = useState(false);
    const [archives, setArchives] = useState(0);
    const advice = "Use a unique synthetic recovery phrase. Store it offline and never reuse an account password.";
    return (
        <main>
            <h1>Synthetic resource interactions</h1>
            <button type="button" onClick={() => setOpen(true)}>
                Edit synthetic resource
            </button>
            <button type="button" onClick={() => setOpen(true)}>
                Create synthetic resource
            </button>
            <Button size="compact">Compact synthetic action</Button>
            <Button size="regular">Regular synthetic action</Button>
            <DatasetFixture />
            <DatasetFixture shape="TREE" />
            <Sheet
                open={open}
                onOpenChange={setOpen}
                title="Synthetic resource"
                description="Component regression fixture"
                size="third"
                resizable
            >
                <p role="status">Archive confirmations: {archives}</p>
                <Field label="Synthetic recovery phrase" htmlFor="synthetic-phrase" longHint={advice}>
                    <Input id="synthetic-phrase" defaultValue="public synthetic phrase" />
                </Field>
                <ConfirmDialog
                    title="Archive synthetic resource?"
                    trigger="Archive synthetic resource"
                    confirmLabel="Confirm archive"
                    cancelLabel="Cancel archive"
                    onConfirm={() => setArchives((n) => n + 1)}
                >
                    This synthetic archive only increments the visible confirmation count.
                </ConfirmDialog>
                <span id="synthetic-nickname-status" className="vq-visually-hidden">
                    Visible to current members.
                </span>
                <Field
                    label="Synthetic nickname"
                    htmlFor="synthetic-nickname"
                    hint="Shown to synthetic peers."
                    required
                >
                    <Input id="synthetic-nickname" aria-describedby="synthetic-nickname-status" required />
                </Field>
                <Field label="Synthetic initials" hint="Used in the avatar.">
                    <Input />
                </Field>
            </Sheet>
        </main>
    );
}

/**
 * 使用真实严格模式挂载使组件经历开发期效果重放，不能用普通根节点掩盖抽屉首次挂载时的焦点生命周期问题。
 * 入口容器只承担 React 挂载职责，浏览器用例始终通过用户可感知的角色、名称和标签访问内容。
 */
const container = document.getElementById("root");
if (!container) throw new Error("INTERACTION_FIXTURE_ROOT_MISSING");
const params = new URLSearchParams(location.search);
let content = <InteractionFixture />;
if (params.has("pagination")) content = <PaginationFixture />;
if (params.has("data-table")) {
    content = <DataTableFixture exportAllowed={canExportWorkspaceTable(params.has("viewer") ? "VIEWER" : "OWNER")} />;
    document.documentElement.dataset.veriqWeb = "";
}
if (params.has("resource-directory")) content = <ResourceDirectoryFixture />;
if (params.has("model-settings") || params.has("agent-appearance")) {
    const appearance = params.get("agent-appearance");
    content = (
        <AgentFixture
            conversation={params.has("agent-appearance")}
            wide={appearance === "wide"}
            sheet={appearance === "sheet"}
        />
    );
}
if (params.has("focus")) {
    const mode = params.get("focus");
    content = <FocusFixture editor={mode === "editor"} longOptions={mode === "long-menu"} />;
}
if (params.has("pagination") || params.has("focus") || params.has("model-settings") || params.has("agent-appearance")) {
    document.documentElement.dataset.veriqWeb = "";
}
createRoot(container).render(<StrictMode>{content}</StrictMode>);
