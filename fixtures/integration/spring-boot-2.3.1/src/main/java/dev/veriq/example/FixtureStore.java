package dev.veriq.example;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermission;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import javax.annotation.PreDestroy;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/** 此受控 Java 示例用单进程锁与私有原子 JSON 快照保存夹具所有权和关闭墓碑，所有业务写入和清理在同一个同步临界区检查状态
 * ，避免清理后的晚到提交复活记录。
 * 数据集很小，整文件快照用于展示协议，不作为高并发生产数据库。
 * 文件锁拒绝第二个进程打开同一存储，避免多进程各自写出旧快照。
 * 生产接入应以数据库事务和行锁实现相同边界，不复制这个存储适配器。
 */
@Component
public class FixtureStore {
    private final ObjectMapper mapper;
    private final Path file;
    private final FileChannel lockChannel;
    private final FileLock lock;
    private ObjectNode state;

    /** 只接受预先配置的私有 POSIX 目录和普通存储文件，拒绝符号链接与组或其它用户权限；初始化不触碰任何默认主目录文件，
     * 路径必须由操作者明确注入。
     */
    public FixtureStore(ObjectMapper mapper) throws IOException {
        this.mapper = mapper;
        String configured = System.getenv("VERIQ_JAVA_DATABASE");
        if (configured == null || configured.isEmpty()) throw new
            IllegalStateException("Configure VERIQ_JAVA_DATABASE");
        this.file = Paths.get(configured).toAbsolutePath();
        requirePrivate(file.getParent(), true);
        Path lockPath = file.resolveSibling(file.getFileName() + ".lock");
        if (Files.exists(lockPath, LinkOption.NOFOLLOW_LINKS)) requirePrivate(lockPath, false);
        this.lockChannel = FileChannel.open(lockPath, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
            LinkOption.NOFOLLOW_LINKS);
        Files.setPosixFilePermissions(lockPath, privatePermissions());
        this.lock = lockChannel.tryLock();
        if (lock == null) throw new IllegalStateException("Fixture store is already open");
        if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            requirePrivate(file, false);
            this.state = (ObjectNode) mapper.readTree(Files.readAllBytes(file));
            if (!state.path("fixtures").isObject() || !state.path("employees").isObject()) throw new
                IOException("Invalid fixture store");
        } else {
            this.state = mapper.createObjectNode();
            state.putObject("fixtures");
            state.putObject("employees");
        }
    }

    private static Set<PosixFilePermission> privatePermissions() {
        Set<PosixFilePermission> result = new HashSet<>();
        result.add(PosixFilePermission.OWNER_READ);
        result.add(PosixFilePermission.OWNER_WRITE);
        return result;
    }

    private static void requirePrivate(Path path, boolean directory) throws IOException {
        if (Files.isSymbolicLink(path) || (directory ? !Files.isDirectory(path) : !Files.isRegularFile(path))) throw
            new IOException("Expected private storage");
        for (PosixFilePermission permission : Files.getPosixFilePermissions(path)) {
            if (permission.name().startsWith("GROUP_") || permission.name().startsWith("OTHERS_")) throw new
                IOException("Storage permissions must be private");
        }
    }

    private synchronized ObjectNode mutate(Function<ObjectNode, ObjectNode> operation) {
        // 在副本上先完成业务校验并写出原子快照，只有成功替换后才更新内存事实；失败保留旧状态，避免响应失败却让后续查询
        // 读到尚未持久化的数据或关闭状态。
        // 整个临界区同时覆盖 namespace 检查和员工插入，清理与写入不会在不同事务窗口穿插。
        ObjectNode next = state.deepCopy();
        ObjectNode result = operation.apply(next);
        Path temporary = null;
        try {
            temporary = Files.createTempFile(file.getParent(), "veriq-fixture-", ".json");
            Files.setPosixFilePermissions(temporary, privatePermissions());
            byte[] data = mapper.writeValueAsBytes(next);
            Files.write(temporary, data);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.WRITE)) { channel.force(true); }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            state = next;
            return result;
        } catch (IOException error) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Fixture persistence failed");
        } finally {
            if (temporary != null) {
                try { Files.deleteIfExists(temporary); }
                catch (IOException error) { throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "Fixture temporary cleanup failed"); }
            }
        }
    }

    private ObjectNode context(JsonNode row) {
        ObjectNode result = mapper.createObjectNode();
        result.set("fixtureId", row.get("fixtureId"));
        result.set("namespace", row.get("namespace"));
        result.set("cleanupToken", row.get("cleanupToken"));
        result.set("variables", row.get("variables"));
        return result;
    }

    /** 相同幂等键必须与完整 JSON 参数绑定，相同参数只重放原准备结果，不延长 TTL；已关闭、已到期或被其他键占用的命名空间
     * 都拒绝重新准备，避免旧请求复活测试数据。
     */
    public ObjectNode prepare(ObjectNode input) {
        return mutate(next -> {
            ObjectNode fixtures = (ObjectNode) next.get("fixtures");
            String key = input.path("idempotencyKey").asText();
            JsonNode existing = fixtures.get(key);
            if (existing != null) {
                if (!existing.path("request").equals(input) || !existing.path("state").asText().equals("OPEN") ||
                    existing.path("expires").asLong() <= System.currentTimeMillis()) conflict();
                return context(existing);
            }
            fixtures.elements().forEachRemaining(row -> {
                if (row.path("namespace").equals(input.get("namespace"))) conflict();
            });
            ObjectNode row = fixtures.putObject(key);
            row.put("fixtureId", UUID.randomUUID().toString());
            row.set("namespace", input.get("namespace"));
            row.set("request", input.deepCopy());
            row.put("state", "OPEN");
            row.put("expires", System.currentTimeMillis() + input.path("ttlSeconds").asLong() * 1000);
            row.put("cleanupToken", UUID.randomUUID().toString() + UUID.randomUUID());
            row.putObject("variables").put("code", "employee-" + row.path("fixtureId").asText());
            return context(row);
        });
    }

    private static void conflict() { throw new ResponseStatusException(HttpStatus.CONFLICT,
        "NAMESPACE_CLOSED_OR_CONFLICT"); }

    /** 查询仅返回夹具标识、命名空间和状态，丢失准备响应时也能确认是否创建；不通过普通查询返回清理令牌或业务认证材料，
     * 真实恢复可使用同参数准备重放获取完整结果。
     */
    public synchronized ObjectNode query(String key) {
        JsonNode row = state.path("fixtures").get(key);
        if (row == null) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Fixture not found");
        ObjectNode result = mapper.createObjectNode();
        for (String field : new String[] {"fixtureId", "namespace", "state"}) result.set(field, row.get(field));
        return result;
    }

    private ObjectNode close(ObjectNode next, String key, String namespace, String token) {
        ObjectNode fixtures = (ObjectNode) next.get("fixtures");
        ObjectNode row = (ObjectNode) fixtures.get(key);
        if (row != null && !row.path("namespace").asText().equals(namespace)) conflict();
        if (row != null && token != null && !java.security.MessageDigest.isEqual(token.getBytes(java.nio.charset
            .StandardCharsets.UTF_8), row.path("cleanupToken").asText().getBytes(java.nio.charset.StandardCharsets
            .UTF_8))) throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Cleanup denied");
        boolean closed = row == null || row.path("state").asText().equals("CLOSED");
        if (row == null) {
            fixtures.elements().forEachRemaining(other -> {
                if (other.path("namespace").asText().equals(namespace)) conflict();
            });
            row = fixtures.putObject(key);
            row.put("namespace", namespace);
            row.put("fixtureId", UUID.randomUUID().toString());
            row.put("cleanupToken", "");
        }
        row.put("state", "CLOSED");
        ObjectNode employees = (ObjectNode) next.get("employees");
        ArrayList<String> remove = new ArrayList<>();
        employees.fields().forEachRemaining(entry -> {
            if (entry.getValue().path("namespace").asText().equals(namespace)) remove.add(entry.getKey());
        });
        employees.remove(remove);
        return mapper.createObjectNode().put("status", closed ? "ALREADY_CLEANED" : "CLEANED");
    }

    /** 清理必须绑定原幂等键和精确 namespace，允许服务身份在未收到准备响应时不带 token 补偿；墓碑阻止晚到 prepare，
     * 同步写入检查阻止晚到业务提交，重复清理保持安全。
     */
    public ObjectNode cleanup(ObjectNode input) {
        return mutate(next -> close(next, input.path("idempotencyKey").asText(), input.path("namespace").asText(),
            input.has("cleanupToken") ? input.path("cleanupToken").asText() : null));
    }

    private String namespace(ObjectNode next, String code) {
        java.util.Iterator<JsonNode> rows = next.path("fixtures").elements();
        while (rows.hasNext()) {
            JsonNode row = rows.next();
            if (row.path("variables").path("code").asText().equals(code)) return row.path("namespace").asText();
        }
        throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Fixture code not found");
    }

    /** 普通 editor 业务写入只在当前夹具仍开放且未过期时提交，状态检查和真实员工插入共享持久化锁；fixture-service
     * 无权通过本方法代替普通业务角色执行写入。
     */
    public ObjectNode create(ObjectNode input) {
        return mutate(next -> {
            String namespace = input.has("namespace") ? input.path("namespace").asText() : namespace(next, input
                .path("code").asText());
            boolean open = false;
            java.util.Iterator<JsonNode> rows = next.path("fixtures").elements();
            while (rows.hasNext()) {
                JsonNode row = rows.next();
                if (row.path("namespace").asText().equals(namespace) && row.path("state").asText().equals("OPEN") &&
                    row.path("expires").asLong() > System.currentTimeMillis()) open = true;
            }
            if (!open) conflict();
            String id = UUID.randomUUID().toString();
            ((ObjectNode) next.get("employees")).putObject(id).put("id", id).put("namespace", namespace).set("name",
                input.get("name"));
            return mapper.createObjectNode().put("id", id).put("status", "CREATED");
        });
    }

    /** 持久化查询只读取当前归属员工并返回稳定 id 和名称，不创建或修复业务对象；客户端应在写入结果未知时优先调用此接口，
     * 而不是盲目重新提交同一个业务写操作。
     */
    public synchronized ObjectNode employees(String namespace, String code) {
        String selected = namespace != null ? namespace : namespace(state, code);
        ObjectNode result = mapper.createObjectNode();
        com.fasterxml.jackson.databind.node.ArrayNode items = result.putArray("items");
        state.path("employees").elements().forEachRemaining(row -> {
            if (row.path("namespace").asText().equals(selected)) {
                ObjectNode item = ((ObjectNode) row).deepCopy();
                item.remove("namespace");
                items.add(item);
            }
        });
        return result;
    }

    /** 外部维护只扫描有界数量的已到期开放夹具，并复用同一清理临界区；没有内部 Cron，响应 hasMore 供外部调度继续调用，
     * 未到期或其他归属数据不会被批量删除。
     */
    public ObjectNode maintenance(int limit) {
        return mutate(next -> {
            ArrayList<String> keys = new ArrayList<>();
            next.path("fixtures").fields().forEachRemaining(entry -> {
                JsonNode row = entry.getValue();
                if (row.path("state").asText().equals("OPEN") && row.path("expires").asLong() <= System
                    .currentTimeMillis()) keys.add(entry.getKey());
            });
            int processed = Math.min(limit, keys.size());
            for (String key : keys.subList(0, processed)) close(next, key, next.path("fixtures").path(key)
                .path("namespace").asText(), null);
            return mapper.createObjectNode().put("processed", processed).put("hasMore", keys.size() > limit);
        });
    }

    /** 容器停止时仅释放本示例持有的存储文件锁及通道，不删除存储或关闭墓碑；重启后仍能拒绝旧幂等键重放，外部 TTL
     * 维护继续处理此前开放的命名空间。
     */
    @PreDestroy
    public void close() throws IOException {
        lock.release();
        lockChannel.close();
    }
}
