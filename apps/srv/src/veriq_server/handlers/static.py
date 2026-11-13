"""生产静态适配器只公开安装包清单列出的前端资源并复用 Tornado 的文件传输实现，开发模式不读取发行目录；入口路由资格、构建身份与路径约束分别在装配和读取时核实。

发布输入包含完整 static-manifest.json、Vite 模块图和四字段 build-info.json。
元数据与清单仅供启动校验，不作为任意静态文件公开。
用户证据继续走受鉴权的制品 API，不进入本模块的发布白名单。
"""

from dataclasses import dataclass
import hashlib
from importlib import resources
import json
import mimetypes
from pathlib import Path, PurePosixPath
import re
from typing import Any

from jsonschema import ValidationError
from tornado.web import HTTPError, StaticFileHandler

from .. import __version__
from ..service import Problem
from ..settings import Settings
from ..validation import validate_api
from .base import API

# 这些路径逐项对应 main.tsx 的实际页面，不把客户端的星号错误页解释为任意服务器深链接许可；新增前端路由时必须同步本表与真实 HTTP 刷新测试。
# 查询字符串由 HTTP 层分离，因此报告筛选和邀请参数无需扩大路径匹配范围。
# 目录后缀、任意扩展名及页面子路径不自动取得 SPA 入口资格。
SPA_PATHS = (
    "/",
    "/setup",
    "/login",
    "/reset",
    "/reset/confirm",
    "/account",
    "/admin/users",
    "/workspaces",
    "/runtimes",
    "/resources",
    "/environments",
    "/ai",
    "/bundles",
    "/reports",
    "/execution-plans",
    "/invitations/accept",
)


@dataclass(frozen=True)
class PublishedSite:
    """已验证的安装包静态描述将根目录、公开文件集合和构建身份一起传给处理器，集合冻结后不从请求参数扩展；文件内容仍由 Tornado 按请求读取以保留范围与条件响应能力。

    root 始终来自 Python 安装包而非工作目录或制品目录。
    public_files 只含清单产物与固定入口，排除内部发布元数据。
    build_info 已通过既有公开 DTO 校验，不包含运行时配置。
    描述在启动期间创建，处理请求时不扩大文件集合。
    固定根目录使当前工作目录变化不会改变静态来源。
    public_files 使用相对路径，不能携带制品存储的绝对地址。
    frozenset 阻止处理器意外追加临时生成文件。
    完整库存中的隐藏文件只参与校验，不进入该集合。
    元数据保留清单精确字节身份，不在响应时重新生成。
    本对象不保存数据库、会话、凭证或可写存储句柄。
    """

    root: Path
    public_files: frozenset[str]
    build_info: dict[str, Any]


def _published_file(root: Path, relative: str) -> Path:
    """检查发布路径的原始组成并拒绝任何符号链接组件，点段、反斜杠和剩余转义不得在下游变成另一条路径；启动与每次文件请求复用此检查以封闭两阶段解释差异。

    不调用 resolve 后再授权，因为那会丢失符号链接与原始点段信息。
    根目录父级也检查链接，防止整个安装包资源目录被重定向。
    只接受普通文件，目录与设备不能成为清单可服务对象。
    相对路径按 POSIX 分隔符逐段检查，拒绝首尾或重复斜杠。
    点段必须在 Path 归一化之前拒绝，否则会失去原始意图。
    百分号不能留给其它层继续解码。
    冒号排除平台驱动器与替代数据流式路径表达。
    查询和片段应属于 URL 元数据，不能混进库存文件名。
    检查所有父路径，不允许包资源根本身成为目录链接。
    普通文件存在性同时排除设备、套接字及目录入口。
    """
    parts = relative.split("/")
    if not relative or any(part in {"", ".", ".."} for part in parts):
        raise ValueError("Invalid published path")
    if any(character in relative for character in ("\\", "%", "\x00", "?", "#", ":")):
        raise ValueError("Invalid published path")
    target = root.joinpath(*parts)
    if any(path.is_symlink() for path in (target, *target.parents)) or not target.is_file():
        raise ValueError("Published file is missing or linked")
    return target


def load_published_site(settings: Settings) -> PublishedSite | None:
    """正式模式在应用装配前加载安装包静态清单并验证入口、依赖文件及构建身份，缺失或非法内容统一给出可操作的英文启动错误；开发模式完全不要求发行资源存在。

    完整库存哈希绑定原始字节，不重新序列化 JSON 改变发布身份。
    构建版本必须等于服务包版本，避免前后端混装仍报告成功。
    库存逐项验证哈希和长度，Vite 模块图额外验证入口与导入引用。
    只对生产执行预检，editable 开发安装不依赖前端资源。
    库存 schemaVersion 精确固定为 1.0，未知版本不会被猜测兼容。
    每个库存项限定 path、sha256、sizeBytes 三个字段。
    所有文件验证后才构造发布描述，失败不会留下部分白名单。
    目录扫描用于核对闭包，不能代替发布输入授权。
    模块图输出与动态导入必须都能在完整库存中找到。
    构建信息中的额外字段由现有 DTO 拒绝。
    统一外层错误保留原始 cause，但不包含配置值。
    这些检查验证安装文件一致性，不替代发行签名或 CI commit 证明。
    """
    if settings.environment == "development":
        return None
    try:
        root = Path(str(resources.files("veriq_server").joinpath("static", "dist")))
        raw = _published_file(root, "static-manifest.json").read_bytes()
        inventory = json.loads(raw)
        info = json.loads(_published_file(root, "build-info.json").read_bytes())
        validate_api("BuildInfoDTO", info)
        if (
            info["version"] != __version__
            or info["staticManifestHash"] != hashlib.sha256(raw).hexdigest()
        ):
            raise ValueError("Build identity does not match package")
        if (
            not isinstance(inventory, dict)
            or set(inventory) != {"schemaVersion", "files"}
            or inventory["schemaVersion"] != "1.0"
            or not isinstance(inventory["files"], list)
        ):
            raise ValueError("Invalid static inventory")
        published = set()
        # 完整库存覆盖 Vite 未引用的复制公开文件和 worker，逐项核对精确字节哈希及长度；禁止重复记录或附加字段，避免不同发布工具对同一清单产生不同解释。
        # 两个身份元数据文件不列入自身库存，从而消除清单哈希与构建信息之间的循环依赖。
        # bool 不是合法长度，即使 Python 的整数子类关系会让普通 isinstance 判断接受它。
        for entry in inventory["files"]:
            if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "sizeBytes"}:
                raise ValueError("Invalid static inventory entry")
            relative, digest, size = entry["path"], entry["sha256"], entry["sizeBytes"]
            if (
                not isinstance(relative, str)
                or relative in published
                or relative in {"static-manifest.json", "build-info.json"}
            ):
                raise ValueError("Invalid or duplicate static inventory path")
            if (
                not isinstance(digest, str)
                or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or type(size) is not int
                or size < 0
            ):
                raise ValueError("Invalid static inventory digest or size")
            content = _published_file(root, relative).read_bytes()
            if len(content) != size or hashlib.sha256(content).hexdigest() != digest:
                raise ValueError("Static inventory content mismatch")
            published.add(relative)
        if not {"index.html", ".vite/manifest.json"} <= published:
            raise ValueError("Required static inventory entry is missing")
        # 扫描安装目录只能验证已发布文件集合，不能把扫描结果自动添加进公开白名单；旧 hash 资源和未列 worker 都说明发行目录不完整清理，应在启动前拒绝。
        # 每个组件的符号链接由同一文件路径检查拒绝，扫描时额外拒绝链接目录。
        # 两个内部元数据文件是唯一允许不列在库存中的普通文件。
        actual = set()
        for candidate in root.rglob("*"):
            if candidate.is_symlink():
                raise ValueError("Linked static package entry")
            if candidate.is_file():
                actual.add(candidate.relative_to(root).as_posix())
        if actual != published | {"static-manifest.json", "build-info.json"}:
            raise ValueError("Unlisted static package file")
        manifest = json.loads(_published_file(root, ".vite/manifest.json").read_bytes())
        if (
            not isinstance(manifest, dict)
            or not isinstance(manifest.get("index.html"), dict)
            or manifest["index.html"].get("isEntry") is not True
        ):
            raise ValueError("Vite index entry is missing or invalid")
        # 模块图仍用于检查入口及导入闭包，但它不定义完整库存，避免遗漏复制公开文件；所有图中输出必须落在已经验证字节的文件集合中，不能只验证图的语法。
        # 懒加载引用指向清单键，CSS 与 assets 引用则直接指向输出路径。
        # 空图、缺少入口及悬空 chunk 都不能作为可启动的正式管理台。
        for entry in manifest.values():
            if (
                not isinstance(entry, dict)
                or not isinstance(entry.get("file"), str)
                or entry["file"] not in published
            ):
                raise ValueError("Invalid Vite entry")
            for field in ("css", "assets", "imports", "dynamicImports"):
                values = entry.get(field, [])
                if not isinstance(values, list) or any(
                    not isinstance(value, str) for value in values
                ):
                    raise ValueError("Invalid Vite references")
                allowed = manifest if field in {"imports", "dynamicImports"} else published
                if any(value not in allowed for value in values):
                    raise ValueError("Missing Vite reference")
        # 库存包括供诊断验证的隐藏构建文件，但它们不是公共 URL；除入口外不发布 HTML，原始报告与导入证据保持在受鉴权制品 API 的独立存储边界内。
        # 运行时白名单从完整库存过滤得出，不根据 MIME、请求 Accept 或磁盘新文件扩权。
        # metadata 始终由专用端点投影，不能通过静态 URL 读取原文件。
        public = {
            path
            for path in published
            if not any(part.startswith(".") for part in PurePosixPath(path).parts)
        }
        # 精确根入口是唯一允许的 HTML 文档，后缀比较忽略大小写并覆盖 XHTML；额外 MIME 别名采用 Tornado 相同的标准库映射，不能让宿主机类型表把复制证据变成活动页面。
        # 压缩文件由 Tornado 返回 gzip 或 octet-stream 类型，不把底层推测的 HTML MIME 误当成实际响应类型。
        # 标准 HTML 后缀仍显式拒绝，不依赖宿主机恰好登记了完整默认类型表。
        # MIME 比较先取分号前的媒体类型本体并去掉外层空白；charset 等参数及大小写不能把活动 HTML 文档伪装成其它类型。
        for path in public:
            if path == "index.html":
                continue
            mime_type, encoding = mimetypes.guess_type(path)
            if PurePosixPath(path).suffix.lower() in {
                ".html",
                ".htm",
                ".shtml",
                ".xhtml",
                ".xht",
            } or (
                encoding is None
                and (mime_type or "").partition(";")[0].strip().lower()
                in {"text/html", "application/xhtml+xml"}
            ):
                raise ValueError("Non-entry HTML in static inventory")
        return PublishedSite(root, frozenset(public), info)
    except (OSError, ValueError, TypeError, ValidationError) as error:
        raise ValueError(
            "Production static package is incomplete or invalid; rebuild and reinstall the frontend-enabled VeriQ wheel"
        ) from error


class BuildInfoAPI(API):
    """构建信息端点复用既有公开 API 信封和安全头，仅返回启动时验证过的四字段发布身份；没有前端发布输入的开发服务明确返回不可用，不能伪造正式清单哈希。

    不读取 Git、环境变量或运行配置，因此请求不会泄露部署密钥。
    保持匿名可读以供诊断前后端版本，写方法仍由 API 门禁拒绝。
    公开契约在 shared OpenAPI 中已经定义，本实现不增加另一套字段。
    请求无需先登录，方便初始化前诊断前后端版本。
    生产缺少元数据已在启动时失败，不会在请求时猜测默认值。
    开发的 503 区分未发布状态与路由不存在。
    API 的 no-store 阻止旧版本诊断在浏览器缓存中滞留。
    """

    def get(self) -> None:
        """从应用装配保存的静态描述输出公开构建信息，开发模式缺描述时给出稳定的结构化 503；该请求不连接数据库，也不在每次读取时重新解析磁盘或改变构建身份。

        API.respond 添加 requestId 并维持 no-store，避免代理缓存旧发布信息。
        严格 DTO 在启动时已经校验，响应只包含审核过的公开字段。
        数据来源始终是工厂保存的发布描述。
        响应阶段没有读取磁盘或访问 Git 的副作用。
        HEAD 与 GET 使用同一个公开投影。
        没有发布描述时不能构造全零哈希伪装正常结果。
        异常交给既有 API Problem 映射生成 JSON 错误。
        """
        site = self.settings["published_site"]
        if site is None:
            raise Problem(
                503, "BUILD_INFO_UNAVAILABLE", "Development server has no published frontend build"
            )
        self.respond(site.build_info)

    head = get


class PublishedFileHandler(StaticFileHandler, API):
    """在 Tornado 成熟文件处理器前添加发布白名单与既有 API 错误边界，文件传输继续使用其 HEAD、范围及条件实现；页面入口只能通过装配阶段登记的精确路径到达。

    API 提供 Origin、CSRF 以及结构化错误，不新增跨源授权例外。
    StaticFileHandler 保留内容类型、长度与 ETag 的成熟实现。
    路径检查每次执行，不信任启动后发生的符号链接替换。
    构造参数只从服务器路由表注入。
    spa 标志不会由请求查询参数决定。
    同一个文件根同时用于库存校验与 Tornado 传输。
    目录不设置 default_filename，避免隐式目录入口和重定向。
    API 默认 MIME 在成功文件传输时由 Tornado 按真实类型覆盖。
    错误仍经 API.write_error 输出稳定的 JSON 信封。
    """

    def initialize(self, *args: Any, **kwargs: Any) -> None:
        """给同一个请求处理器注入原有安全上下文与已经验证的静态描述，SPA 标志仅来自服务器登记路由而非查询参数；两个父类都初始化以保留 Tornado 文件状态和请求关联标识。

        不设置默认目录文件，避免目录重定向或任意目录获得入口语义。
        传输根目录与发布白名单来自同一个描述，不能分别被请求覆盖。
        Tornado 通过路由 kwargs 调用初始化，不使用位置参数构造业务对象。
        两个父类拥有不同框架初始化签名，因此入口接受框架参数后显式分派。
        API 初始化建立 request_id 与现有安全上下文。
        文件父类初始化只接收经过验证的包内根目录。
        这里没有添加任意路径或 symlink 授权选项。
        """
        site: PublishedSite = kwargs["site"]
        API.initialize(self, kwargs["config"], kwargs["db"])
        StaticFileHandler.initialize(self, path=str(site.root))
        self.site, self.spa = site, kwargs.get("spa", False)

    def get(self, path: str = "", include_body: bool = True) -> Any:
        """读取前将精确 SPA 路由映射到唯一入口并检查发布资格，非法路径返回既有 JSON 错误；合法请求委托 Tornado 协程完成传输，不复制文件读取、范围解析或缓存验证逻辑。

        Tornado 已做一次 URL 解码，因此剩余百分号由路径校验拒绝。
        目录遍历与链接检查发生在父类访问文件之前，禁止二次解码。
        路径白名单先于父类文件传输检查，不能靠文件存在性取得权限。
        精确页面路由映射后仍必须检查 index 文件不是链接。
        静态文件路由捕获的名称必须在冻结的公开集合中。
        协程返回给 Tornado 框架等待，适配器不自行启动事件循环。
        同步校验抛出的 HTTPError 也沿用既有 JSON 错误边界。
        """
        relative = "index.html" if self.spa else path
        try:
            _published_file(self.site.root, relative)
        except ValueError:
            raise HTTPError(404) from None
        if relative not in self.site.public_files:
            raise HTTPError(404)
        return super().get(relative, include_body)

    def head(self, path: str = "") -> Any:
        """HEAD 使用与 GET 完全相同的发布路径检查及响应头生成，仅让 Tornado 抑制正文；页面根路径没有捕获参数时仍可读取入口长度，不因默认父类签名差异返回服务器错误。

        不手动读取文件或计算长度，避免与范围及压缩响应规则不一致。
        直接调用当前适配器的 get，不能绕过其白名单。
        没有额外文件打开步骤，HEAD 与 GET 观察同一条传输路径。
        空的 path 默认值只适用于精确登记的 SPA 路由。
        静态文件路由仍通过正则捕获真实相对路径。
        """
        return self.get(path, include_body=False)

    def set_extra_headers(self, path: str) -> None:
        """只有发布清单中的带指纹 assets 获得长期 immutable 缓存，入口和其它公开文件必须重新验证；覆盖 Tornado 的查询参数缓存策略，避免任意 v 参数把普通文件变成长缓存资源。

        Vite 默认指纹至少八个 URL 安全文字，CSS 与 JS 共用这一规则。
        错误由 API 默认 no-store 覆盖，不会缓存缺文件响应。
        文件名规则只对 assets 目录生效，普通 public 文件保持重新验证。
        清单哈希确保启动时的内容属于同一批发行输入。
        Tornado 可能因 v 参数预设 Expires，此处必须同时清除它。
        no-cache 允许条件请求，ETag 和 Last-Modified 仍由父类产生。
        immutable 不改变静态文件的鉴权或发布资格。
        本方法只在成功文件响应设置额外头，错误沿用 no-store。
        """
        hashed = re.fullmatch(r"assets/.+-[A-Za-z0-9_-]{8,}\.[^/]+", path)
        self.set_header(
            "Cache-Control", "public, max-age=31536000, immutable" if hashed else "no-cache"
        )
        self.clear_header("Expires")
