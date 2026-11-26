// 此页面只把服务端查询返回的真实员工渲染为持久化表格，保存成功提示与刷新后独立读回使用不同锚点，避免把客户端乐观状态误
// 当成数据库提交证据。
// 命名空间或公开夹具代码由受控用例导航传入，浏览器不会接收夹具清理令牌。元素内容通过 textContent 写入，
// 业务名称不会作为 HTML 或脚本执行。本页面保留既有 name、save、result 锚点，
// 便于现有浏览器夹具继续调用。
const params = new URL(location.href).searchParams;
const owner = params.has("namespace")
    ? { namespace: params.get("namespace") }
    : { code: params.get("code") };
const status = document.querySelector("[veriq-id=result]");
const form = document.querySelector("form");
const button = document.querySelector("button");

// 列表刷新始终重新请求普通业务接口，并使用响应标识作为稳定行键，使重新排序和页面刷新不会改变员工对应关系，
// 也不会依赖视觉位置定位记录。错误响应交给调用方显示固定消息，禁止把响应正文或认证材料拼进页面诊断。
// 未绑定夹具的人工打开不发出无归属的业务查询，表格保持空白供用户配置。这不是自动重试循环，网络失败后不会再次发出业务写
// 操作。
async function refresh() {
    if (!Object.values(owner)[0]) return;
    const response = await fetch(`/employees?${new URLSearchParams(owner)}`);
    if (!response.ok) throw new Error("Employee query failed");
    const data = await response.json();
    const body = document.querySelector("tbody");
    body.replaceChildren();
    for (const employee of data.items) {
        const row = document.createElement("tr");
        row.setAttribute("veriq-id", "employee.row");
        row.dataset.recordKey = employee.id;
        const cell = document.createElement("td");
        cell.setAttribute("veriq-id", "employee.name");
        cell.textContent = employee.name;
        row.append(cell);
        body.append(row);
    }
}

// 提交过程中禁用按钮避免人工双击产生两个业务写入，但接口仍不承诺业务请求恰好一次；未知网络结果必须先查询，
// 不能以重复点击掩盖写入状态不明的问题。
// finally 恢复交互能力，失败时保留固定诊断，不回显 token、Cookie 或原始响应头。
// 保存提示仅表示写接口已接受，独立列表查询及后续整页刷新才用于持久化断言。
// 原生表单同时支持键盘 Enter 和按钮激活，不依赖鼠标专属事件。
form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    try {
        const response = await fetch("/employees", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...owner, name: form.elements.name.value }),
        });
        const result = await response.json();
        status.textContent = result.status || result.code;
        if (response.ok) await refresh();
    } catch {
        status.textContent = "Request failed; query before retrying";
    } finally {
        button.disabled = false;
    }
});
refresh().catch(() => {
    status.textContent = "Employee query failed";
});
