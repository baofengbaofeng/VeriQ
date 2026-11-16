package dev.veriq.example;

import java.util.Collections;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/** 此入口固定展示 Spring Boot 2.3.1 的 HTTP 接入方式，默认只监听本机并禁止框架启动诊断泄漏环境配置；
 * 它是被测业务示例而不是 VeriQ 控制服务或新执行引擎。
 * 业务、夹具和维护令牌由外部环境提供，未配置即拒绝启动。
 * 不连接客户业务数据库，也不包含支付、订单等真实业务调用。
 * Maven 依赖仅属于这个独立示例，不加入主仓库依赖锁。
 */
@SpringBootApplication
public class VeriqExample {
    /** 通过外部端口覆盖默认 loopback 地址，非本机部署必须由操作者设置受控网络与 TLS 代理；启动时不读取或打印任何令牌值
     * ，也不自动调度维护请求或业务执行。
     */
    public static void main(String[] args) {
        SpringApplication app = new SpringApplication(VeriqExample.class);
        app.setDefaultProperties(Collections.singletonMap("server.address", "127.0.0.1"));
        app.run(args);
    }
}
