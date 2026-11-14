/** Linux 密钥辅助程序仅处理固定产品档案的三十二字节随机材料，私有 SecretService 实例拒绝所有交互提示；父输入死亡监视在调用系统库前建立，避免父进程崩溃后遗留可能无限等待的库调用。 */
#define _GNU_SOURCE
#include <libsecret/secret.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

typedef struct { SecretService parent; gboolean prompt_refused; } VeriqService;
typedef struct { SecretServiceClass parent; } VeriqServiceClass;
G_DEFINE_TYPE(VeriqService, veriq_service, SECRET_TYPE_SERVICE)

/** 私有实例覆盖同步和异步提示入口并返回固定锁定错误，完全不调用默认 Prompt 实现；该操作只改变本进程持有的客户端类型，不解锁集合、不生成用户界面，也不修改系统服务或其他应用的行为。 */
static GVariant *deny_prompt_sync(SecretService *service, SecretPrompt *prompt,
        GCancellable *cancel, const GVariantType *type, GError **error) {
    (void)prompt; (void)cancel; (void)type;
    ((VeriqService *)service)->prompt_refused = TRUE;
    g_set_error_literal(error, SECRET_ERROR, SECRET_ERROR_IS_LOCKED, "VAULT_PROMPT_REFUSED");
    return NULL;
}
static void deny_prompt_async(SecretService *service, SecretPrompt *prompt,
        const GVariantType *type, GCancellable *cancel, GAsyncReadyCallback callback, gpointer data) {
    (void)prompt; (void)type;
    ((VeriqService *)service)->prompt_refused = TRUE;
    GTask *task = g_task_new(service, cancel, callback, data);
    g_task_return_new_error(task, SECRET_ERROR, SECRET_ERROR_IS_LOCKED, "VAULT_PROMPT_REFUSED");
    g_object_unref(task);
}
static GVariant *deny_prompt_finish(SecretService *service, GAsyncResult *result, GError **error) {
    (void)service;
    return g_task_propagate_pointer(G_TASK(result), error);
}
static void veriq_service_class_init(VeriqServiceClass *klass) {
    SecretServiceClass *parent = SECRET_SERVICE_CLASS(klass);
    parent->prompt_sync = deny_prompt_sync;
    parent->prompt_async = deny_prompt_async;
    parent->prompt_finish = deny_prompt_finish;
}
static void veriq_service_init(VeriqService *service) { service->prompt_refused = FALSE; }

static const SecretSchema schema = {
    .name = "org.veriq.RuntimeVault1", .flags = SECRET_SCHEMA_NONE,
    .attributes = {{"product", SECRET_SCHEMA_ATTRIBUTE_STRING},
        {"profile", SECRET_SCHEMA_ATTRIBUTE_STRING}, {"version", SECRET_SCHEMA_ATTRIBUTE_STRING}, {NULL, 0}}
};

/** 请求帧读取完成后独立线程继续监视父输入，正常父进程必须保持该控制管道打开直到辅助程序退出；任何额外字节或 EOF 都结束本进程，不按名称查杀其他进程，也不依赖主线程正在等待的库及时取消。 */
static void *watch_parent(void *unused) {
    (void)unused;
    char byte;
    for (;;) {
        ssize_t count = read(STDIN_FILENO, &byte, 1);
        if (count < 0 && errno == EINTR) continue;
        _exit(125);
    }
    return NULL;
}

static gboolean uuid(const char *value) {
    if (strlen(value) != 36) return FALSE;
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != '-') return FALSE; }
        else if (!(value[i] >= '0' && value[i] <= '9') && !(value[i] >= 'a' && value[i] <= 'f') &&
            !(value[i] >= 'A' && value[i] <= 'F')) return FALSE;
    }
    return TRUE;
}
static gchar *encode_key(const guchar *key) {
    gchar *encoded = g_base64_encode(key, 32);
    for (size_t i = 0; i < 43; i++) {
        if (encoded[i] == '+') encoded[i] = '-';
        if (encoded[i] == '/') encoded[i] = '_';
    }
    encoded[43] = '\0';
    return encoded;
}
static guchar *decode_key(const char *text) {
    if (strlen(text) != 43) return NULL;
    gchar encoded[45];
    for (size_t i = 0; i < 43; i++) {
        char c = text[i];
        if (!g_ascii_isalnum(c) && c != '-' && c != '_') return NULL;
        encoded[i] = c == '-' ? '+' : c == '_' ? '/' : c;
    }
    encoded[43] = '='; encoded[44] = '\0';
    gsize length = 0;
    guchar *key = g_base64_decode(encoded, &length);
    gchar *canonical = length == 32 ? encode_key(key) : NULL;
    gboolean valid = canonical && strcmp(canonical, text) == 0;
    g_free(canonical);
    if (!valid) { g_free(key); return NULL; }
    return key;
}

/** 错误只依据结构化域与代码分类，锁定和明确服务缺失不折叠为条目缺失，所有其他系统错误也不输出原始文本；修改开始后的未知失败保留不确定性，避免上层把网络断开错误理解为已经回滚。 */
static const char *error_status(GError *error, gboolean mutation) {
    if (error && g_error_matches(error, SECRET_ERROR, SECRET_ERROR_IS_LOCKED)) return "locked";
    if (mutation) return "mutation-unconfirmed";
    if (error && (error->domain == G_IO_ERROR ||
        g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_SERVICE_UNKNOWN) ||
        g_error_matches(error, G_DBUS_ERROR, G_DBUS_ERROR_NAME_HAS_NO_OWNER) ||
        g_error_matches(error, SECRET_ERROR, SECRET_ERROR_NO_SUCH_OBJECT))) return "unavailable";
    return "failed";
}

static gboolean read_key(SecretItem *item, guchar key[32], GError **error) {
    if (!secret_item_load_secret_sync(item, NULL, error)) return FALSE;
    SecretValue *value = secret_item_get_secret(item);
    if (!value) return FALSE;
    gsize size = 0;
    const gchar *bytes = secret_value_get(value, &size);
    const gchar *content_type = secret_value_get_content_type(value);
    gboolean valid = bytes && size == 32 && content_type && strcmp(content_type, "application/octet-stream") == 0;
    if (valid) memcpy(key, bytes, 32);
    secret_value_unref(value);
    return valid;
}

/** 主操作只在固定产品属性下搜索精确档案与密钥版本，拒绝重复条目并禁止不同密钥覆盖已使用版本；搜索加创建不是跨客户端原子比较交换，因此调用者仍须持有档案锁、唯一版本和恢复日志。 */
static const char *operate(char **parts, guchar *input, gchar **output) {
    const char *status = "failed";
    GError *error = NULL;
    GList *items = NULL;
    GHashTable *attributes = NULL;
    SecretCollection *collection = NULL;
    SecretService *service = NULL;
    const char *address = g_getenv("DBUS_SESSION_BUS_ADDRESS");
    /* 只使用明确的本地会话总线，禁止缺失会话时由库猜测并启动外部 dbus-launch 或执行其他地址传输程序；实际桌面与测试上下文都必须提供真实地址，不把此失败改为文件后端。 */
    if (!address || !g_str_has_prefix(address, "unix:") || strchr(address, ';')) return "unavailable";
    service = secret_service_open_sync(veriq_service_get_type(), "org.freedesktop.secrets",
        SECRET_SERVICE_OPEN_SESSION, NULL, &error);
    if (!service) { status = error_status(error, FALSE); goto cleanup; }
    collection = secret_collection_for_alias_sync(service, SECRET_COLLECTION_DEFAULT,
        SECRET_COLLECTION_NONE, NULL, &error);
    if (!collection) { status = error ? error_status(error, FALSE) : "unavailable"; goto cleanup; }
#ifdef VERIQ_VAULT_TEST_DRIVER
    /* 默认关闭的独立测试程序只对测试自有默认集合触发真实锁定与提示路径，复用同一拒绝提示实例；这些命令不会编入正式辅助程序，也不能加入安装库存或当作生产通用系统接口使用。 */
    if (strcmp(parts[1], "lock") == 0 || strcmp(parts[1], "prompt") == 0) {
        GList *objects = g_list_append(NULL, collection), *changed = NULL;
        if (strcmp(parts[1], "lock") == 0) {
            gint count = secret_service_lock_sync(service, objects, NULL, &changed, &error);
            status = count == 1 && !error ? "ok" : error_status(error, FALSE);
        } else {
            (void)secret_service_unlock_sync(service, objects, NULL, &changed, &error);
            status = ((VeriqService *)service)->prompt_refused ? "prompt-denied" : "failed";
        }
        g_list_free_full(changed, g_object_unref);
        g_list_free(objects);
        goto cleanup;
    }
#endif
    if (secret_collection_get_locked(collection)) { status = "locked"; goto cleanup; }
    if (strcmp(parts[1], "probe") == 0) { status = "ready"; goto cleanup; }
    attributes = secret_attributes_build(&schema, "product", "veriq-runtime-v1",
        "profile", parts[2], "version", parts[3], NULL);
    items = secret_service_search_sync(service, &schema, attributes, SECRET_SEARCH_ALL, NULL, &error);
    if (error) { status = error_status(error, FALSE); goto cleanup; }
    if (g_list_length(items) > 1) goto cleanup;
    SecretItem *item = items ? SECRET_ITEM(items->data) : NULL;
    if (item && secret_item_get_locked(item)) { status = "locked"; goto cleanup; }
    if (strcmp(parts[1], "get") == 0) {
        guchar existing[32];
        if (!item) { status = "missing"; goto cleanup; }
        if (!read_key(item, existing, &error)) { status = error_status(error, FALSE); goto cleanup; }
        *output = encode_key(existing); status = "ok";
    } else if (strcmp(parts[1], "delete") == 0) {
        if (!item) { status = "missing"; goto cleanup; }
        status = secret_item_delete_sync(item, NULL, &error) ? "ok" : error_status(error, TRUE);
    } else {
        gboolean recover_existing = item != NULL;
#ifdef VERIQ_VAULT_TEST_DRIVER
        if (strcmp(parts[1], "duplicate") == 0) recover_existing = FALSE;
#endif
        if (recover_existing) {
            guchar existing[32];
            if (!read_key(item, existing, &error)) { status = error_status(error, FALSE); goto cleanup; }
            status = memcmp(existing, input, 32) == 0 ? "ok" : "failed";
            goto cleanup;
        }
        SecretValue *value = secret_value_new((const gchar *)input, 32, "application/octet-stream");
        SecretItem *created = secret_item_create_sync(collection, &schema, attributes,
            "VeriQ Runtime profile key", value, SECRET_ITEM_CREATE_NONE, NULL, &error);
        status = created ? "ok" : error_status(error, TRUE);
        if (created) g_object_unref(created);
        secret_value_unref(value);
    }
cleanup:
    g_clear_error(&error);
    g_list_free_full(items, g_object_unref);
    if (attributes) g_hash_table_unref(attributes);
    if (collection) g_object_unref(collection);
    if (service) g_object_unref(service);
    return status;
}

/** 入口在任何系统库访问前建立 Linux 父死亡信号并读取一个有限 ASCII 请求，密钥只经匿名管道传递而不出现于参数；响应最多一行固定状态，格式错误不会进入服务操作或暴露库错误及提示内容。 */
int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) return 2;
    pid_t parent = getppid();
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != parent) return 2;
    char frame[513]; size_t size = 0;
    for (;;) {
        char byte; ssize_t count = read(STDIN_FILENO, &byte, 1);
        if (count < 0 && errno == EINTR) continue;
        if (count != 1 || size >= 512 || byte == '\0' || (byte != '\n' && (byte < 32 || byte > 126))) return 2;
        if (byte == '\n') break;
        frame[size++] = byte;
    }
    frame[size] = '\0';
    char **parts = g_strsplit(frame, " ", -1);
    guint count = g_strv_length(parts);
    gboolean probe = count == 2 && strcmp(parts[1], "probe") == 0;
#ifdef VERIQ_VAULT_TEST_DRIVER
    probe = probe || (count == 2 && (strcmp(parts[1], "lock") == 0 || strcmp(parts[1], "prompt") == 0));
#endif
    gboolean get_delete = count == 4 && (strcmp(parts[1], "get") == 0 || strcmp(parts[1], "delete") == 0);
    gboolean set = count == 5 && strcmp(parts[1], "set") == 0;
#ifdef VERIQ_VAULT_TEST_DRIVER
    set = set || (count == 5 && strcmp(parts[1], "duplicate") == 0);
#endif
    guchar *input = set ? decode_key(parts[4]) : NULL;
    if (count == 0 || strcmp(parts[0], "V1") != 0 || !(probe || get_delete || set) ||
        (!probe && (!uuid(parts[2]) || !uuid(parts[3]))) || (set && !input)) {
        g_free(input); g_strfreev(parts); return 2;
    }
    pthread_t watcher;
    if (pthread_create(&watcher, NULL, watch_parent, NULL) != 0) { g_free(input); g_strfreev(parts); return 2; }
    pthread_detach(watcher);
    gchar *output = NULL;
    const char *status = operate(parts, input, &output);
    int result = output ? printf("V1 %s %s\n", status, output) : printf("V1 %s\n", status);
    g_free(output); g_free(input); g_strfreev(parts);
    return result < 0 || fflush(stdout) != 0 ? 2 : 0;
}
