package dev.veriq.example;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 该过滤器把普通业务、夹具服务和维护三种身份分开，并为每个实际请求生成独立 requestId 与配置的 build SHA；
 * 任何令牌只用于常量时间比较，禁止写入日志或响应正文。
 * 这是受控示例的正常 Bearer 认证，不提供跳过业务权限的测试后门。
 * 明确身份后仍由控制器根据操作要求校验角色，UI 隐藏不能替代服务授权。
 * 只读静态资源和构建信息允许未登录访问，所有数据端点仍必须认证。
 */
@Component
public class IdentityFilter extends OncePerRequestFilter {
    private final Map<String, String> tokens = new LinkedHashMap<>();
    private final String buildSha;

    /**
     * 启动时要求三份足够长且互不相同的外部令牌，缺失或重复均拒绝启动，不生成硬编码演示密码；构建版本由被测应用部署方显
     * 式注入并限制为安全响应头字符。
     */
    public IdentityFilter() {
        tokens.put("editor", required("VERIQ_DEMO_BUSINESS_TOKEN"));
        tokens.put("fixture-service", required("VERIQ_DEMO_FIXTURE_TOKEN"));
        tokens.put("maintenance", required("VERIQ_DEMO_MAINTENANCE_TOKEN"));
        if (tokens.values().stream().distinct().count() != 3) throw new
            IllegalStateException("Use three distinct tokens");
        String configured = System.getenv("VERIQ_DEMO_BUILD_SHA");
        buildSha = configured == null ? "development" : configured;
        if (!buildSha.matches("[A-Za-z0-9._-]{1,160}")) throw new IllegalStateException("Invalid build SHA");
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.length() < 24 || value.contains("\r") || value.contains("\n")) throw new
            IllegalStateException("Configure three strong fixture example tokens");
        return value;
    }

    /**
     * 所有路径都带有固定无缓存响应头，认证失败仅输出稳定错误码；重定向、表单参数和 Cookie 不参与 Bearer 判断，
     * 避免把夹具身份错误地回退为其它已有业务会话。
     */
    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
        throws ServletException, IOException {
        response.setHeader("X-Request-Id", UUID.randomUUID().toString());
        response.setHeader("X-Build-Sha", buildSha);
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        String path = request.getRequestURI();
        if (path.equals("/") || path.equals("/demo.js") || path.equals("/build-info") || path.equals("/openapi.json")) {
            chain.doFilter(request, response);
            return;
        }
        String header = request.getHeader("Authorization");
        if (header != null && header.startsWith("Bearer ")) {
            byte[] supplied = header.substring(7).getBytes(StandardCharsets.UTF_8);
            for (Map.Entry<String, String> token : tokens.entrySet()) {
                if (MessageDigest.isEqual(supplied, token.getValue().getBytes(StandardCharsets.UTF_8))) {
                    request.setAttribute("veriqIdentity", token.getKey());
                    chain.doFilter(request, response);
                    return;
                }
            }
        }
        response.setStatus(401);
        response.setContentType("application/json");
        response.getWriter().write("{\"code\":\"UNAUTHORIZED\"}");
    }
}
