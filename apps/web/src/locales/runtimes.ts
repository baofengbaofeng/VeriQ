/** 设备登记、共享信任与服务账号的中英文文案明确区分登记和真实执行能力，展示用语不会改变硬件信任或凭证投递权限；设备上报事实、原始技术标识和秘密值不参与翻译。 */
export const runtimesMessages: Record<string, readonly [string, string]> = {
    Workspace: ["工作区", "Workspace"],
    "Register a device and choose who may use it. Registration alone does not start a worker.": [
        "登记设备并选择可使用它的成员。完成登记不会自动启动 Worker。",
        "Register a device and choose who may use it. Registration alone does not start a worker.",
    ],
    "Create or join a Workspace before registering a device.": [
        "登记设备前，请先创建或加入工作区。",
        "Create or join a Workspace before registering a device.",
    ],
    "Approve device": ["审批设备", "Approve device"],
    "Approve a device": ["审批设备", "Approve a device"],
    [
        "Run VeriQ login on your device, then enter its approval code. Confirm that you recognize the device before " +
        "approving."]:
        [
            "请在设备上运行 VeriQ 登录，再输入设备审批码。审批前请确认您认识这台设备。",
            "Run VeriQ login on your device, then enter its approval code. Confirm that you recognize the device bef" +
                "ore approving.",
        ],
    "Approval code": ["设备审批码", "Approval code"],
    "Inspect device": ["检查设备", "Inspect device"],
    "Reported:": ["上报信息：", "Reported:"],
    "; engine": ["；引擎", "; engine"],
    "; browsers": ["；浏览器", "; browsers"],
    Sharing: ["共享范围", "Sharing"],
    "Private — only me": ["私有，仅限本人", "Private — only me"],
    "Share with this Workspace": ["共享给当前工作区", "Share with this Workspace"],
    "Share with selected members": ["共享给所选成员", "Share with selected members"],
    "Registered devices": ["已登记设备", "Registered devices"],
    "Refresh devices": ["刷新设备", "Refresh devices"],
    "Loading Runtimes…": ["正在加载 Runtime 设备…", "Loading Runtimes…"],
    "No registered Runtimes in this Workspace.": [
        "此工作区尚无已登记的 Runtime 设备。",
        "No registered Runtimes in this Workspace.",
    ],
    "Load more devices": ["加载更多设备", "Load more devices"],
    "Members allowed to use this device": [
        "允许使用此设备的成员",
        "Members allowed to use this device",
    ],
    "Personal device": ["个人设备", "Personal device"],
    "Service account device": ["服务账号设备", "Service account device"],
    "Current trust:": ["当前信任状态：", "Current trust:"],
    "Reported capabilities:": ["上报能力：", "Reported capabilities:"],
    "no browsers": ["无浏览器", "no browsers"],
    ". These reports do not approve an engine release.": [
        "。这些上报信息不代表引擎发行已获批准。",
        ". These reports do not approve an engine release.",
    ],
    "Shared with Workspace": ["已共享给工作区", "Shared with Workspace"],
    "Shared with selected members": ["已共享给所选成员", "Shared with selected members"],
    Private: ["私有", "Private"],
    ". Platform credential delivery:": ["。平台凭证投递：", ". Platform credential delivery:"],
    "Worker is": ["Worker 状态为", "Worker is"],
    ". Execution history becomes available after runs exist; current trust does not rewrite past results.":
        [
            "。开始运行后可查看执行历史；当前信任状态不修改过去的结果。",
            ". Execution history becomes available after runs exist; current trust does not rewrite past results.",
        ],
    "Share with the Workspace": ["共享给工作区", "Share with the Workspace"],
    "Save sharing": ["保存共享设置", "Save sharing"],
    "Revoke device": ["吊销设备", "Revoke device"],
    "Current trust": ["当前信任状态", "Current trust"],
    "User registered": ["用户登记", "User registered"],
    Managed: ["受管理", "Managed"],
    "Save trust": ["保存信任设置", "Save trust"],
    "Workspace credential delivery": ["工作区凭证投递", "Workspace credential delivery"],
    [
        "Workspace owners and administrators may approve delivery after hardware trust is managed. Updating hardware" +
        " trust clears this approval."]:
        [
            "设备硬件信任设为受管理后，工作区所有者或管理员可批准凭证投递。更新硬件信任将清除该批准。",
            "Workspace owners and administrators may approve delivery after hardware trust is managed. Updating hard" +
                "ware trust clears this approval.",
        ],
    "Allow platform credential delivery": [
        "允许平台投递凭证",
        "Allow platform credential delivery",
    ],
    "Save credential delivery": ["保存凭证投递设置", "Save credential delivery"],
    "Deployment service accounts": ["部署服务账号", "Deployment service accounts"],
    "Use a one-time registration token with VeriQ enroll-service. Registration does not grant managed trust.":
        [
            "通过 VeriQ enroll-service 使用一次性登记令牌。完成登记不自动授予受管理信任。",
            "Use a one-time registration token with VeriQ enroll-service. Registration does not grant managed trust.",
        ],
    "Create service account": ["创建服务账号", "Create service account"],
    "Loading service accounts…": ["正在加载服务账号…", "Loading service accounts…"],
    "No deployment service accounts.": ["尚无部署服务账号。", "No deployment service accounts."],
    "Issue enrollment token": ["签发设备登记令牌", "Issue enrollment token"],
    "Disable service account": ["禁用服务账号", "Disable service account"],
    "Load more service accounts": ["加载更多服务账号", "Load more service accounts"],
    "One-time enrollment token": ["一次性设备登记令牌", "One-time enrollment token"],
    "Expires in ten minutes. Pass through standard input, never a command argument.": [
        "十分钟后过期。请通过标准输入传递，不要作为命令行参数。",
        "Expires in ten minutes. Pass through standard input, never a command argument.",
    ],
    "Dismiss token": ["关闭令牌", "Dismiss token"],
};
