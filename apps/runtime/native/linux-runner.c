#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Per-Attempt subreaper. FD4 is private status, FD5 private parent control.
 * The business worker never inherits either, or the proof-writing capability.
 * ECHILD after the single spawn gate closes is the positive drain proof. */
static volatile sig_atomic_t stop_requested;
static const char *failure_code;
static int failure_errno;
static long failure_pid, failure_uid = -1;
static bool fail(const char *code, int error, pid_t pid, long uid) {
    if (!failure_code) { failure_code = code; failure_errno = error; failure_pid = pid; failure_uid = uid; }
    return false;
}
static void diagnostic(const char *proof_path) {
    if (!failure_code) return;
    char path[PATH_MAX], record[512];
    if (snprintf(path, sizeof(path), "%s.error", proof_path) >= (int)sizeof(path)) return;
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) return;
    int length = snprintf(record, sizeof(record), "{\"failureCode\":\"%s\",\"errno\":%d,\"pid\":%ld,\"observedUid\":%ld}\n", failure_code, failure_errno, failure_pid, failure_uid);
    if (length > 0 && length < (int)sizeof(record)) { ssize_t written = write(fd, record, (size_t)length); if (written == length) { int synced = fsync(fd); (void)synced; } }
    close(fd);
}
static void request_stop(int signal_number) { (void)signal_number; stop_requested = 1; }
static long long milliseconds(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) return -1;
    return (long long)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}
static bool identity(pid_t pid, uid_t uid, unsigned long long *start) {
    char path[80], line[4096];
    struct stat metadata;
    snprintf(path, sizeof(path), "/proc/%ld", (long)pid);
    if (stat(path, &metadata)) return fail("CHILD_METADATA_UNREADABLE", errno, pid, -1);
    if (metadata.st_uid != uid) return fail("CHILD_UID_MISMATCH", 0, pid, metadata.st_uid);
    snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
    FILE *file = fopen(path, "r");
    if (!file) return fail("CHILD_STAT_OPEN_FAILED", errno, pid, -1);
    bool ok = fgets(line, sizeof(line), file) != NULL;
    int read_error = ok ? 0 : errno;
    fclose(file);
    if (!ok) return fail("CHILD_STAT_READ_FAILED", read_error, pid, -1);
    char *tail = ok ? strrchr(line, ')') : NULL;
    if (!tail || tail[1] != ' ') return fail("CHILD_STAT_FORMAT", 0, pid, -1);
    char *state = NULL, *field = strtok_r(tail + 2, " ", &state);
    for (int index = 0; field && index < 19; index++) field = strtok_r(NULL, " ", &state);
    if (!field) return fail("CHILD_STAT_FORMAT", 0, pid, -1);
    char *end;
    *start = strtoull(field, &end, 10);
    return end != field && *end == '\0';
}
static bool direct_children(uid_t uid, int signal_number) {
    /* /proc/PID/task/PID/children is optional (CONFIG_CHECKPOINT_RESTORE).
     * PPID discovers direct children; only waitpid ECHILD proves final drain. */
    DIR *processes = opendir("/proc");
    if (!processes) return false;
    struct dirent *entry;
    bool ok = true;
    while ((entry = readdir(processes)) != NULL) {
        char *end;
        long value = strtol(entry->d_name, &end, 10);
        if (*end || value <= 1 || value > INT_MAX) continue;
        char path[80], line[4096], state;
        snprintf(path, sizeof(path), "/proc/%ld/stat", value);
        FILE *file = fopen(path, "r");
        if (!file) {
            if (errno == ENOENT || errno == ESRCH) continue;
            ok = fail("SCAN_STAT_OPEN_FAILED", errno, (pid_t)value, -1); break;
        }
        bool read_ok = fgets(line, sizeof(line), file) != NULL;
        int read_error = read_ok ? 0 : errno;
        fclose(file);
        if (!read_ok) {
            /* Unrelated tasks can disappear between open/read. A child cannot be
             * reaped concurrently: this single-threaded guardian owns waitpid. */
            if (read_error == ENOENT || read_error == ESRCH) continue;
            ok = fail("SCAN_STAT_READ_FAILED", read_error, (pid_t)value, -1); break;
        }
        char *tail = read_ok ? strrchr(line, ')') : NULL;
        long parent;
        if (!tail || sscanf(tail+2, "%c %ld", &state, &parent) != 2 || parent != getpid()) continue;
        pid_t pid = (pid_t)value;
        unsigned long long before, current;
        if (!identity(pid, uid, &before)) {
            if (kill(pid, 0) && errno == ESRCH) continue;
            ok = false; break;
        }
        /* A current kernel child cannot be PID-reused before we waitpid it. */
        if (!identity(pid, uid, &current) || current != before) { ok = false; break; }
        if (kill(pid, signal_number) && errno != ESRCH) { ok = false; break; }
    }
    closedir(processes);
    return ok;
}
static bool proof(const char *path, const char *nonce, uid_t uid, pid_t worker,
                  unsigned long long guardian_start, unsigned long long worker_start) {
    char temporary[PATH_MAX], directory[PATH_MAX];
    if (snprintf(temporary, sizeof(temporary), "%s.tmp", path) >= (int)sizeof(temporary)) return false;
    if (snprintf(directory, sizeof(directory), "%s", path) >= (int)sizeof(directory)) return false;
    char *slash = strrchr(directory, '/');
    if (!slash) return false;
    *slash = '\0';
    int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    if (fd < 0) return false;
    char record[1024];
    int size = snprintf(record, sizeof(record),
        "{\"version\":1,\"state\":\"DRAINED\",\"nonce\":\"%s\",\"uid\":%lu,\"guardianPid\":%ld,\"guardianStartTime\":\"%llu\",\"workerPid\":%ld,\"workerStartTime\":\"%llu\"}\n",
        nonce, (unsigned long)uid, (long)getpid(), guardian_start, (long)worker, worker_start);
    bool ok = size > 0 && size < (int)sizeof(record) && write(fd, record, (size_t)size) == size && fsync(fd) == 0;
    if (close(fd)) ok = false;
    if (ok && rename(temporary, path)) ok = false;
    int parent = ok ? open(directory, O_RDONLY | O_DIRECTORY) : -1;
    if (parent < 0 || fsync(parent)) ok = false;
    if (parent >= 0) close(parent);
    if (!ok) unlink(temporary);
    return ok;
}
int main(int argc, char **argv) {
    if (argc < 5 || strlen(argv[2]) > 80 || strspn(argv[2], "0123456789abcdef-") != strlen(argv[2])) return 125;
    const char *proof_path = argv[1], *nonce = argv[2];
    char *end;
    long grace = strtol(argv[3], &end, 10);
    if (*end || grace < 0 || grace > 30000) return 125;
    uid_t uid = getuid();
    unsigned long long guardian_start, worker_start;
    if (prctl(PR_SET_NAME, "veriq_runner") || prctl(PR_SET_CHILD_SUBREAPER, 1) || !identity(getpid(), uid, &guardian_start)) return 125;
    struct sigaction action = {.sa_handler = request_stop};
    sigemptyset(&action.sa_mask);
    sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); sigaction(SIGUSR1, &action, NULL);
    signal(SIGPIPE, SIG_IGN);
    int gate[2];
    if (pipe2(gate, O_CLOEXEC)) return 125;
    pid_t worker = fork();
    if (worker < 0) return 125;
    if (worker == 0) {
        close(gate[1]); close(4); close(5);
        signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGUSR1, SIG_DFL); signal(SIGPIPE, SIG_DFL);
        if (setsid() < 0) _exit(125);
        char start;
        ssize_t count;
        do { count = read(gate[0], &start, 1); } while (count < 0 && errno == EINTR);
        close(gate[0]);
        if (count != 1 || start != 'G') _exit(125);
        execvp(argv[4], &argv[4]);
        _exit(127);
    }
    close(gate[0]); close(3); /* Node IPC belongs only to the worker. */
    if (!identity(worker, uid, &worker_start)) { kill(worker, SIGKILL); return 125; }
    dprintf(4, "{\"type\":\"READY\",\"workerPid\":%ld}\n", (long)worker);
    int flags = fcntl(5, F_GETFL);
    if (flags < 0 || fcntl(5, F_SETFL, flags | O_NONBLOCK)) { kill(worker, SIGKILL); return 125; }
    bool started = false, root_exited = false, trusted = true, gate_closed = false, control_open = true;
    long long stop_at = -1, created = milliseconds();
    char control[16]; size_t used = 0;
    for (;;) {
        char bytes[16]; ssize_t count = control_open ? read(5, bytes, sizeof(bytes)) : -1;
        if (count == 0) { stop_requested = 1; control_open = false; close(5); }
        else if (count > 0) {
            for (ssize_t i = 0; i < count; i++) {
                if (used >= sizeof(control)-1) { trusted = false; stop_requested = 1; break; }
                control[used++] = bytes[i];
                if (bytes[i] == '\n') {
                    control[used] = '\0';
                    if (!strcmp(control, "START\n") && !started && !stop_requested) {
                        if (write(gate[1], "G", 1) != 1) trusted = false;
                        close(gate[1]); gate_closed = true; started = true;
                    } else if (!strcmp(control, "STOP\n")) stop_requested = 1;
                    else { trusted = false; stop_requested = 1; }
                    used = 0;
                }
            }
        } else if (control_open && errno != EAGAIN && errno != EINTR) { trusted = false; stop_requested = 1; }
        if (!started && milliseconds() - created > 15000) stop_requested = 1;
        int status; pid_t reaped;
        while ((reaped = waitpid(-1, &status, WNOHANG)) > 0) {
            if (reaped == worker && !root_exited) {
                root_exited = true; stop_requested = 1;
                if (WIFEXITED(status)) dprintf(4, "{\"type\":\"EXIT\",\"code\":%d,\"signal\":null}\n", WEXITSTATUS(status));
                else dprintf(4, "{\"type\":\"EXIT\",\"code\":null,\"signal\":%d}\n", WTERMSIG(status));
            }
        }
        if (reaped < 0 && errno != ECHILD && errno != EINTR) { trusted = false; stop_requested = 1; }
        bool no_children = reaped < 0 && errno == ECHILD;
        if (stop_requested) {
            if (!gate_closed) { close(gate[1]); gate_closed = true; }
            if (stop_at < 0) stop_at = milliseconds();
            if (no_children) {
                if (!trusted) diagnostic(proof_path);
                bool drained = trusted && root_exited && gate_closed && proof(proof_path, nonce, uid, worker, guardian_start, worker_start);
                return drained ? 0 : 125;
            }
            int signal_number = milliseconds() - stop_at < grace ? SIGTERM : SIGKILL;
            if (!direct_children(uid, signal_number)) { trusted = false; diagnostic(proof_path); }
        }
        struct pollfd poll_control = {.fd = control_open ? 5 : -1, .events = POLLIN};
        /* Keep adopting/reaping if a kernel-uninterruptible child outlives the parent's
         * bounded stop request. No proof is written until the tree actually drains. */
        poll(&poll_control, 1, 20);
    }
}
