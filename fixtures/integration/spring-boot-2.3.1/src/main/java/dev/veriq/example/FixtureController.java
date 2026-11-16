package dev.veriq.example;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import javax.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

/**
 * Java 接入端点遵循与 Python 示例相同的夹具请求信封，输入逐项限制字段与类型，员工读写只接受普通 editor 身份，
 * 夹具服务权限不能用于冒充员工完成正常业务断言。
 * 页面和脚本复用 fixtures/demo-app 的静态源码，不复制另一份 UI。
 * 根目录通过显式环境配置绑定，只读取固定文件名，不接受请求文件路径。
 * 受控示例不提供任意 SQL、脚本执行或客户生产系统调用接口。
 */
@RestController
public class FixtureController {
    private final FixtureStore store;
    private final ObjectMapper mapper;
    private final Path webRoot;

    /**
     * 将业务存储和静态源码位置作为部署依赖绑定，未配置页面根时仍可使用纯 HTTP API；需要浏览器流程时应显式提供仓库
     * demo-app 绝对路径或受控静态代理。
     */
    public FixtureController(FixtureStore store, ObjectMapper mapper) {
        this.store = store;
        this.mapper = mapper;
        String configured = System.getenv("VERIQ_JAVA_WEB_ROOT");
        this.webRoot = configured == null ? null : Paths.get(configured).toAbsolutePath();
    }

    private static void require(HttpServletRequest request, String identity) {
        if (!identity.equals(request.getAttribute("veriqIdentity"))) throw new ResponseStatusException(HttpStatus
            .FORBIDDEN, "FORBIDDEN");
    }

    private static void fields(ObjectNode input, String... allowed) {
        Set<String> names = new HashSet<>(Arrays.asList(allowed));
        Iterator<String> actual = input.fieldNames();
        while (actual.hasNext()) if (!names.contains(actual.next())) invalid();
    }

    private static String text(JsonNode input, String field) {
        JsonNode value = input.get(field);
        if (value == null || !value.isTextual() || value.asText().isEmpty() || value.asText().length() > 1000)
            invalid();
        return value.asText();
    }

    private static void invalid() { throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST"); }

    private static void envelope(ObjectNode input) {
        String workspace = text(input, "workspaceId");
        String execution = text(input, "caseExecutionId");
        text(input, "namespace");
        JsonNode attempt = input.get("attemptNo");
        if (attempt == null || !attempt.isIntegralNumber() || !attempt.canConvertToInt() || (attempt.asInt() != 1 &&
            attempt.asInt() != 2)) invalid();
        if (!text(input, "idempotencyKey").equals(workspace + ":" + execution + ":" + attempt.asInt())) invalid();
    }

    /**
     * 准备仅允许独立 fixture-service 身份，完整信封和显式输入 Schema 在任何存储变化前检查；整数 TTL
     * 不接受布尔值或小数，同键不同输入由存储返回冲突。
     */
    @PostMapping("/prepare")
    public ObjectNode prepare(HttpServletRequest request, @RequestBody ObjectNode input) {
        require(request, "fixture-service");
        fields(input, "workspaceId", "caseExecutionId", "attemptNo", "namespace", "idempotencyKey", "input",
            "ttlSeconds");
        envelope(input);
        if (!input.path("input").isObject()) invalid();
        fields((ObjectNode) input.get("input"), "name");
        text(input.get("input"), "name");
        JsonNode ttl = input.get("ttlSeconds");
        if (ttl == null || !ttl.isIntegralNumber() || !ttl.canConvertToInt() || ttl.asInt() < 1 || ttl.asInt() >
            604800) invalid();
        return store.prepare(input);
    }

    /**
     * 查询只能使用夹具服务身份按原幂等键读取准备状态，返回范围由固定 DTO 限制；业务角色不能借此取得其它测试命名空间的
     * 清理能力或原始凭证材料。
     */
    @GetMapping("/query")
    public ObjectNode query(HttpServletRequest request, @RequestParam String idempotencyKey) {
        require(request, "fixture-service");
        return store.query(idempotencyKey);
    }

    /**
     * 清理接受与 SDK 一致的 POST 或 DELETE JSON 信封，token 可缺失用于丢失准备响应后的受限服务补偿；若显式提供错误
     * token 必须拒绝，不因具备服务身份而忽略错误材料。
     */
    @RequestMapping(value="/cleanup", method={RequestMethod.POST, RequestMethod.DELETE})
    public ObjectNode cleanup(HttpServletRequest request, @RequestBody ObjectNode input) {
        require(request, "fixture-service");
        fields(input, "workspaceId", "caseExecutionId", "attemptNo", "namespace", "idempotencyKey", "cleanupToken");
        envelope(input);
        if (input.has("cleanupToken")) text(input, "cleanupToken");
        return store.cleanup(input);
    }

    /**
     * 普通写入验证业务名称和唯一归属选择，code 与 namespace 不能同时提供或同时缺失；权限判断使用业务 editor，
     * 而不是准备夹具所用的高权限服务身份。
     */
    @PostMapping("/employees")
    public ObjectNode create(HttpServletRequest request, @RequestBody ObjectNode input) {
        require(request, "editor");
        fields(input, "name", "namespace", "code");
        if (text(input, "name").length() > 160 || input.has("namespace") == input.has("code")) invalid();
        text(input, input.has("namespace") ? "namespace" : "code");
        return store.create(input);
    }

    /**
     * 员工查询完全只读，响应返回数据库快照中的真实记录而非写接口的客户端缓存；这使刷新后 UI 与 GET
     * 断言能独立确认持久化，而不会把乐观提示误当成成功证据。
     */
    @GetMapping("/employees")
    public ObjectNode employees(HttpServletRequest request, @RequestParam(required=false) String namespace,
        @RequestParam(required=false) String code) {
        require(request, "editor");
        if ((namespace == null) == (code == null)) invalid();
        return store.employees(namespace, code);
    }

    /**
     * 身份探测返回实际过滤器解析的角色标识，SDK 会将其与发布环境允许的身份集合逐项核对；返回值不包含认证 token 或
     * Cookie，因此能安全用于身份匹配检查。
     */
    @GetMapping("/me")
    public ObjectNode identity(HttpServletRequest request) {
        return mapper.createObjectNode().put("id", (String) request.getAttribute("veriqIdentity"));
    }

    /**
     * 受限维护端点仅允许外部 maintenance 身份调用，批量大小为一到一百且无内部定时器；调用者根据 hasMore 继续处理，
     * 不能以清理普通员工业务数据代替 fixture TTL 补偿。
     */
    @PostMapping("/maintenance")
    public ObjectNode maintenance(HttpServletRequest request, @RequestBody ObjectNode input) {
        require(request, "maintenance");
        fields(input, "limit");
        JsonNode limit = input.get("limit");
        if (limit != null && (!limit.isIntegralNumber() || !limit.canConvertToInt() || limit.asInt() < 1 || limit
            .asInt() > 100)) invalid();
        return store.maintenance(limit == null ? 100 : limit.asInt());
    }

    /**
     * 构建版本来自同一部署环境配置，供 Run 的冻结 SHA 与真正被测服务进行比对；开发默认值明确表示未绑定正式构建，
     * 不应据此宣称客户应用版本已验收。
     */
    @GetMapping("/build-info")
    public ObjectNode build() {
        String sha = System.getenv("VERIQ_DEMO_BUILD_SHA");
        return mapper.createObjectNode().put("buildSha", sha == null ? "development" : sha);
    }

    private String asset(String name) throws IOException {
        if (webRoot == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Configure VERIQ_JAVA_WEB_ROOT");
        return Files.readString(webRoot.resolve(name));
    }

    /**
     * 页面只读取明确配置的共享静态根中的固定 index.html，不接受任意路径参数；这里复用 Python 示例 UI 的源码，
     * 使同一份目录和 DSL 可以覆盖两种后端 HTTP 实现。
     */
    @GetMapping(value="/", produces="text/html;charset=UTF-8")
    public String page() throws IOException { return asset("index.html"); }

    /**
     * 脚本由同一静态源码根提供并使用正确媒体类型，认证流程依赖 SDK 的正常业务 Bearer 注入；页面不嵌入密钥、
     * 不会读取平台控制服务 Cookie 或清理令牌。
     */
    @GetMapping(value="/demo.js", produces="application/javascript;charset=UTF-8")
    public String script() throws IOException { return asset("demo.js"); }

    /**
     * OpenAPI 与本 Java 示例的实际端点一起随独立 jar 打包，删除 Python 专属 session 登录能力并保留精确夹具信封；
     * 消费方应固定这份契约而不是猜测接口字段或成功状态。
     */
    @GetMapping(value="/openapi.json", produces="application/json;charset=UTF-8")
    public String openapi() throws IOException {
        try (java.io.InputStream source = getClass().getResourceAsStream("/openapi.json")) {
            if (source == null) throw new IOException("OpenAPI resource is missing");
            return new String(source.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }
}
