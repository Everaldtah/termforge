// Linux test harness for the shim: boots a fakefs root, runs one command on a pty and
// one with piped stdio, prints what came back. Built by tools/ish/test-linux.sh.
//   tf_test <fakefs-dir> <host-dir> <cmd> [args...]
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>
#include "tf_ish.h"

static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t c = PTHREAD_COND_INITIALIZER;
static int exits = 0, last_pid = -1, last_code = -1;

static double now_ms(void) {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec * 1000.0 + tv.tv_usec / 1000.0;
}

static void on_output(int pty, const void *buf, size_t len, void *ctx) {
    fprintf(stderr, "[pty %d] ", pty);
    fwrite(buf, 1, len, stderr);
    fputc('\n', stderr);
}

static void on_exit_cb(int pid, int code, void *ctx) {
    pthread_mutex_lock(&m);
    exits++;
    last_pid = pid;
    last_code = code;
    pthread_cond_signal(&c);
    pthread_mutex_unlock(&m);
}

static void on_log(const char *line, void *ctx) {
    fprintf(stderr, "[kernel] %s\n", line);
}

static void wait_exit(int n) {
    pthread_mutex_lock(&m);
    while (exits < n)
        pthread_cond_wait(&c, &m);
    pthread_mutex_unlock(&m);
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: %s <fakefs-dir> <host-dir> <cmd> [args...]\n", argv[0]);
        return 2;
    }
    tf_ish_callbacks cb = {.output = on_output, .exited = on_exit_cb, .log = on_log};
    double t0 = now_ms();
    int err = tf_ish_boot(argv[1], argv[2], "/mnt/termforge", "/tmp", cb);
    printf("boot: %d (%.1f ms) %s\n", err, now_ms() - t0, tf_ish_version());
    if (err < 0)
        return 1;

    const char *envp[] = {"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/root", "TERM=xterm-256color", NULL};

    // 1. pty session
    int pty = -1, pid = -1;
    t0 = now_ms();
    err = tf_ish_session_start((const char *const *) argv + 3, envp, "/root", 80, 24, &pty, &pid);
    printf("session: err=%d pty=%d pid=%d\n", err, pty, pid);
    if (err < 0)
        return 1;
    wait_exit(1);
    printf("session exit: pid=%d code=%d (%.1f ms)\n", last_pid, last_code, now_ms() - t0);

    // 2. exec with pipes: stdout + stderr captured separately, stdin fed
    int in[2], out[2], errp[2];
    pipe(in); pipe(out); pipe(errp);
    const char *exec_argv[] = {"/bin/sh", "-c", "read x; echo \"stdin was: $x\"; echo to-stderr >&2; ls /mnt/termforge | head -3; exit 7", NULL};
    t0 = now_ms();
    pid = tf_ish_exec(exec_argv, envp, "/mnt/termforge", in[0], out[1], errp[1]);
    close(in[0]); close(out[1]); close(errp[1]);
    printf("exec: pid=%d\n", pid);
    if (pid < 0)
        return 1;
    write(in[1], "hello\n", 6);
    close(in[1]);
    char buf[4096];
    ssize_t n;
    while ((n = read(out[0], buf, sizeof buf)) > 0)
        printf("[stdout] %.*s", (int) n, buf);
    while ((n = read(errp[0], buf, sizeof buf)) > 0)
        printf("[stderr] %.*s", (int) n, buf);
    wait_exit(2);
    printf("exec exit: pid=%d code=%d (%.1f ms)\n", last_pid, last_code, now_ms() - t0);
    return 0;
}
