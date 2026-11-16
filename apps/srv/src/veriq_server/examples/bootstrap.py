"""示例 Workspace 导入只消费公开平台 API 返回的真实版本、作业与回执，按依赖顺序创建和发布资产，进度中不保存密码或业务令牌，也不伪造编译结果。

先用 workspace-only 创建空间，再由操作者登记或授权 Runtime。恢复时复核已发布内容，冲突停止，绝不覆盖其它人的编辑。验证等待有总时限，超时保留已完成对象供相同参数重新进入。
"""

import argparse
import getpass
import json
import os
from pathlib import Path
import stat
import tempfile
import time
from typing import Any

from .platform_http import Platform
from .resources import sample_package


def save_state(path: Path, state: dict[str, Any]) -> None:
    """通过同目录私有临时文件和原子替换保存已完成的真实 API 标识，写入前拒绝符号链接及非私有旧文件，避免断电产生半截 JSON 或把会话材料写进共享路径。

    进度仅含平台 origin、Workspace、凭据版本和资产标识。不保存 token、密码、Cookie、cleanupToken 或整个 API 响应。父目录由使用者创建并控制，不尝试自动修复不可信目录权限。
    """
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise RuntimeError("State file must be a private regular file")
    parent = path.parent.stat()
    if parent.st_mode & 0o022:
        raise RuntimeError("State directory must not be writable by group or others")
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False, encoding="utf-8") as target:
        temporary = Path(target.name)
        try:
            os.chmod(temporary, 0o600)
            json.dump(state, target, ensure_ascii=False, indent=4)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def replace_ids(value: Any, aliases: dict[str, str]) -> Any:
    """仅替换示例模板中完整匹配的 UUID 字符串，不解释 DSL 占位符、不执行任意表达式，保证变量绑定仍由真正的编译器和执行 SDK 按固定契约处理。
    """
    if isinstance(value, dict):
        return {key: replace_ids(item, aliases) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_ids(item, aliases) for item in value]
    return aliases.get(value, value) if isinstance(value, str) else value


def publish(api: Platform, base: str, resource: dict[str, Any], content: dict[str, Any], timeout: int) -> str:
    """复用真实草稿修订、服务端 sourceHash 预览和异步验证作业，仅在匹配回执可读取后调用发布端点；任何失败均保留草稿，不把排队状态写成已发布版本。

    已有发布版本必须与当前示例文档一致，否则明确停止。草稿被并发修改时使用平台原有 revision 冲突阻止覆盖。等待只用于读取真实编译结果，不调用内部完成或回执入口。
    """
    route = base + "/resources/" + resource["id"]
    if resource.get("latestVersionId"):
        version = api.request("GET", route + "/versions/" + resource["latestVersionId"])
        if version["content"] != content:
            raise RuntimeError("Published sample differs; use a new Workspace key")
        return str(version["id"])
    draft = api.request("GET", route + "/draft")
    if draft["content"] != content:
        raise RuntimeError("Existing draft differs; import will not overwrite edits")
    preview = api.request("GET", route + "/validation-preview")
    job = api.request("POST", route + "/validate", {
        "revision": preview["revision"], "sourceHash": preview["sourceHash"],
    })
    deadline = time.monotonic() + timeout
    while True:
        job = api.request("GET", base + "/jobs/" + job["id"])
        print(f"Validation {resource['key']}: {job['state']}", flush=True)
        if job["state"] == "FINISHED":
            if job.get("outcome") != "PASSED":
                raise RuntimeError("Real sample validation failed; inspect the platform Job")
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("Validation timed out; configure a MANAGED compiler and resume")
        time.sleep(min(2, max(0, deadline - time.monotonic())))
    receipt = api.request("GET", base + "/jobs/" + job["id"] + "/validation-receipt")
    version = api.request("POST", route + "/publish", {
        "revision": preview["revision"], "validationReceiptId": receipt["id"],
    })
    return str(version["id"])


def import_workspace(api: Platform, args: argparse.Namespace, state: dict[str, Any]) -> None:
    """按真实依赖图导入七类资产及 HTTP 执行计划，认证适配器和密钥仅通过环境管理 API 创建，所有外部 UUID 都来自当前空间的服务端响应并在恢复时继续绑定原目标。

    第一阶段允许只创建 Workspace，便于操作者显式授权设备。正式导入需要员工环境管理权限、受信编译器及有效执行设备。业务地址来自 Runtime 可达的配置，绝不假定 localhost 指向控制服务。
    """
    package = sample_package()
    if "sampleSourceInventory" in state and state["sampleSourceInventory"] != package["sourceInventory"]:
        raise RuntimeError("Installed sample sources changed; use a new Workspace key")
    state["sampleSourceInventory"] = package["sourceInventory"]
    if not args.workspace_only:
        options = {"demoURL": args.demo_url.rstrip("/"), "buildSha": args.build_sha,
                   "locale": args.locale, "timezone": args.timezone, "runtimeId": args.runtime_id}
        if "sampleOptions" in state and state["sampleOptions"] != options:
            raise RuntimeError("Sample import options changed; restore the original configuration")
        state["sampleOptions"] = options
    if "workspaceId" not in state:
        workspace = next((item for item in api.items("/api/v1/workspaces") if item["key"] == args.workspace_key), None)
        if workspace is None:
            workspace = api.request("POST", "/api/v1/workspaces", {
                "key": args.workspace_key, "name": "VeriQ employee example",
            })
        state["workspaceId"] = workspace["id"]
        save_state(args.state, state)
    base = "/api/v1/workspaces/" + state["workspaceId"]
    api.request("GET", base)
    if args.workspace_only:
        print(f"Workspace ready: {state['workspaceId']}")
        return
    if not args.runtime_id:
        raise RuntimeError("Provide --runtime-id after registering and authorizing a Runtime")
    if "adapter" not in state:
        adapter = api.request("POST", base + "/auth-adapters", {"configuration": {
            "kind": "HTTP_BEARER", "identityPath": "/me", "identityPointer": "/id",
        }})
        state["adapter"] = adapter["versionId"]
        save_state(args.state, state)
    for key, secret_ref, identity, variable in [
        ("business", "demo_business", "editor", "VERIQ_DEMO_BUSINESS_TOKEN"),
        ("fixture-secret", "demo_fixture", "fixture-service", "VERIQ_DEMO_FIXTURE_TOKEN"),
    ]:
        if key not in state:
            token = os.environ.get(variable)
            if not token or len(token) < 24:
                raise RuntimeError(f"Provide {variable} through the secret environment")
            result = api.request("POST", base + "/credentials", {
                "secretRef": secret_ref, "value": {"token": token}, "allowedIdentityIds": [identity],
            })
            state[key] = result["versionId"]
            save_state(args.state, state)
    manifest = package["manifest"]
    aliases = manifest["versionAliases"]
    resolved = {aliases[key]: state[key] for key in ["adapter", "business", "fixture-secret"]}
    resources = {(item["kind"], item["key"]): item for item in api.items(base + "/resources")}
    for key in manifest["order"]:
        content = replace_ids(package["assets"][key], resolved)
        if key == "environment":
            origin = args.demo_url.rstrip("/")
            document = content["document"]
            document.update(baseURL=origin, apiBaseURL=origin, fixtureBaseURL=origin,
                            allowedOrigins=[origin], buildSha=args.build_sha,
                            locale=args.locale, timezone=args.timezone)
        resource_key = "demo-" + key
        resource = resources.get((content["kind"], resource_key))
        if resource is None:
            resource = api.request("POST", base + "/resources", {
                "kind": content["kind"], "key": resource_key, "name": "Demo " + key, "content": content,
            })
        version = publish(api, base, resource, content, args.validation_timeout)
        resolved[aliases[key]] = version
        state.setdefault("versions", {})[key] = version
        save_state(args.state, state)
    plan_content = {
        "name": "Demo employee smoke", "suiteVersionId": state["versions"]["suite"],
        "environmentVersionId": state["versions"]["environment"], "browsers": ["chromium"],
        "runtimeIds": [args.runtime_id], "overlapPolicy": "QUEUE", "maxCaseRetries": 0,
        "roleKeys": ["editor"], "variables": {},
    }
    if "planId" not in state:
        candidates = [plan for plan in api.items(base + "/execution-plans") if all(plan.get(k) == v for k,
            v in plan_content.items())]
        plan = candidates[0] if candidates else api.request("POST", base + "/execution-plans", plan_content)
        state["planId"] = plan["id"]
        save_state(args.state, state)
    else:
        plan = api.request("GET", base + "/execution-plans/" + state["planId"])
        if plan.get("archived") or any(plan.get(key) != value for key, value in plan_content.items()):
            raise RuntimeError("Existing plan changed; inspect it instead of overwriting edits")
    print(f"Published sample Workspace: {state['workspaceId']}")
    print(f"HTTP execution plan: {state['planId']}")
    print("No Run was triggered; use the plan UI or the scoped CI client")


def main() -> None:
    """读取非秘密命令参数和秘密环境，要求状态文件绑定相同平台及空间键，退出时尽力注销当前临时员工会话，错误输出只包含已受控的固定诊断信息。

    参数不接受密码或业务令牌，防止操作系统进程列表泄漏。build SHA 来自目标应用，不能用 VeriQ 本身提交替代。示例导入不调用模型、不触发 Run、不自动授予 Runtime 信任。
    """
    parser = argparse.ArgumentParser(description="Import real VeriQ sample assets through public APIs")
    parser.add_argument("--server", required=True)
    parser.add_argument("--workspace-key", default="veriq-demo")
    parser.add_argument("--email", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--workspace-only", action="store_true")
    parser.add_argument("--runtime-id")
    parser.add_argument("--demo-url", default="http://127.0.0.1:8090")
    parser.add_argument("--build-sha", default="development")
    parser.add_argument("--locale", default="en-US")
    parser.add_argument("--timezone", default="UTC")
    parser.add_argument("--validation-timeout", type=int, default=300)
    args = parser.parse_args()
    args.state = args.state.absolute()
    if args.validation_timeout < 1:
        parser.error("--validation-timeout must be positive")
    Platform(args.demo_url)
    state = {"server": args.server.rstrip("/"), "workspaceKey": args.workspace_key}
    if args.state.exists() or args.state.is_symlink():
        info = args.state.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise RuntimeError("State file must be a private regular file")
        previous = json.loads(args.state.read_text(encoding="utf-8"))
        if any(previous.get(key) != value for key, value in state.items()):
            raise RuntimeError("State belongs to another platform or Workspace key")
        state = previous
    password = os.environ.get("VERIQ_BOOTSTRAP_PASSWORD") or getpass.getpass("VeriQ password: ")
    api = Platform(args.server)
    api.login(args.email, password)
    try:
        import_workspace(api, args, state)
    finally:
        try:
            api.request("POST", "/api/v1/auth/logout", {})
        except RuntimeError:
            print("Temporary session logout failed; revoke it in Account sessions")


def entrypoint() -> None:
    """安装后的模块和仓库薄入口共享同一失败映射，输出只使用受控错误描述而不包含命令环境或凭据正文，确保源码运行与 wheel 安装运行不会形成两套导入行为。
    """
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
    except (ValueError, OSError, KeyError):
        raise SystemExit(
            "Sample import failed; inspect platform Job and configuration without exposing secrets") from None


if __name__ == "__main__":
    entrypoint()
