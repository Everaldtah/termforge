// TermForge's C interface to the iSH kernel. See tf_ish.h.
// Mirrors what iSH's own iOS app does in AppDelegate.m / TerminalViewController.m,
// without the app's Objective-C, user defaults, iosfs bookmarks and clipboard devices.
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "debug.h"
#include "kernel/calls.h"
#include "kernel/init.h"
#include "kernel/task.h"
#include "kernel/fs.h"
#include "kernel/signal.h"
#include "fs/devices.h"
#include "fs/fd.h"
#include "fs/real.h"
#include "fs/sock.h"
#include "fs/tty.h"
#include "fs/path.h"
#include "tools/fakefs.h"
#include "tf_ish.h"

#ifndef TF_ISH_VERSION
#define TF_ISH_VERSION "ish (unknown commit)"
#endif

// iSH copies the host's node name into a 65-byte uname field; a Mac's hostname (the
// simulator's) can be longer and __strcpy_chk aborts. The override is iSH's own hook.
extern const char *uname_hostname_override;

static tf_ish_callbacks g_cb;
static bool g_booted;
// Serialises every entry into the kernel from host threads: iSH's app only ever
// drives these calls from its main thread.
static pthread_mutex_t g_api = PTHREAD_MUTEX_INITIALIZER;

// ---- terminal driver: every session pty writes straight to the host callback

#define TF_MAX_PTYS 256
static struct tty *g_ttys[TF_MAX_PTYS];
static pthread_mutex_t g_ttys_lock = PTHREAD_MUTEX_INITIALIZER;

static int tf_tty_init(struct tty *tty) {
    return 0;
}

static int tf_tty_write(struct tty *tty, const void *buf, size_t len, bool blocking) {
    if (g_cb.output)
        g_cb.output(tty->num, buf, len, g_cb.ctx);
    return (int) len;
}

static void tf_tty_cleanup(struct tty *tty) {
    pthread_mutex_lock(&g_ttys_lock);
    if (tty->num >= 0 && tty->num < TF_MAX_PTYS && g_ttys[tty->num] == tty)
        g_ttys[tty->num] = NULL;
    pthread_mutex_unlock(&g_ttys_lock);
}

static struct tty_driver_ops tf_tty_ops = {
    .init = tf_tty_init,
    .write = tf_tty_write,
    .cleanup = tf_tty_cleanup,
};
DEFINE_TTY_DRIVER(tf_console_driver, &tf_tty_ops, TTY_CONSOLE_MAJOR, 64);
static struct tty_driver tf_pty_driver = {.ops = &tf_tty_ops};

static struct tty *tf_tty_for(int pty) {
    if (pty < 0 || pty >= TF_MAX_PTYS)
        return NULL;
    pthread_mutex_lock(&g_ttys_lock);
    struct tty *tty = g_ttys[pty];
    pthread_mutex_unlock(&g_ttys_lock);
    return tty;
}

// ---- kernel hooks

static void tf_exit_hook(struct task *task, int code) {
    // children of init are sessions and execs; deeper descendants are theirs to reap.
    // Called with pids_lock held: the callback must not re-enter the kernel.
    if (task->parent != NULL && task->parent->parent != NULL)
        return;
    // code is a wait status: exit code << 8, or the signal number in the low bits
    int status = (code & 0x7f) ? 128 + (code & 0x7f) : (code >> 8) & 0xff;
    if (g_cb.exited)
        g_cb.exited(task->pid, status, g_cb.ctx);
}

static void tf_die_handler(const char *msg) {
    if (g_cb.log)
        g_cb.log(msg, g_cb.ctx);
}

// ---- helpers

// argv/envp for do_execve: NUL-separated, NUL-terminated ("a\0b\0\0").
static char *pack_strings(const char *const *strs, size_t *count_out) {
    size_t total = 1, count = 0;
    for (const char *const *p = strs; p && *p; p++, count++)
        total += strlen(*p) + 1;
    char *buf = malloc(total);
    if (buf == NULL)
        return NULL;
    char *w = buf;
    for (const char *const *p = strs; p && *p; p++) {
        size_t n = strlen(*p) + 1;
        memcpy(w, *p, n);
        w += n;
    }
    *w = '\0';
    if (count_out)
        *count_out = count;
    return buf;
}

static int set_cwd(const char *cwd) {
    if (cwd == NULL || cwd[0] == '\0')
        return 0;
    struct fd *dir = generic_open(cwd, O_RDONLY_, 0);
    if (IS_ERR(dir))
        return PTR_ERR(dir);
    fs_chdir(current->fs, dir);
    return 0;
}

// Runs argv in the task that is `current`; on success the task is running.
static int exec_current(const char *const *argv, const char *const *envp, const char *cwd) {
    int err = set_cwd(cwd);
    if (err < 0)
        return err;
    size_t argc = 0;
    char *argv_buf = pack_strings(argv, &argc);
    char *envp_buf = pack_strings(envp, NULL);
    if (argv_buf == NULL || envp_buf == NULL || argc == 0) {
        free(argv_buf);
        free(envp_buf);
        return -ENOMEM;
    }
    err = do_execve(argv[0], argc, argv_buf, envp_buf);
    free(argv_buf);
    free(envp_buf);
    if (err < 0)
        return err;
    task_start(current);
    return 0;
}

// ---- public API

int tf_ish_import_rootfs(const char *tar_gz, const char *fakefs_dir, char *err, size_t err_len) {
    struct fakefsify_error fs_err = {0};
    if (!fakefs_import(tar_gz, fakefs_dir, &fs_err, (struct progress) {})) {
        if (err && err_len)
            snprintf(err, err_len, "%s (line %d)", fs_err.message[0] ? fs_err.message : "unknown error", fs_err.line);
        return -1;
    }
    return 0;
}

int tf_ish_boot(const char *fakefs_dir, const char *host_dir, const char *mount_point,
                const char *tmp_dir, tf_ish_callbacks callbacks) {
    pthread_mutex_lock(&g_api);
    if (g_booted) {
        pthread_mutex_unlock(&g_api);
        return -EALREADY;
    }
    g_cb = callbacks;
    uname_hostname_override = "termforge";

    char data_dir[4096];
    snprintf(data_dir, sizeof data_dir, "%s/data", fakefs_dir);
    int err = mount_root(&fakefs, data_dir);
    if (err < 0)
        goto out;

    err = become_first_process();
    if (err < 0)
        goto out;
    create_some_device_nodes();

    do_mount(&procfs, "proc", "/proc", "", 0);
    do_mount(&devptsfs, "devpts", "/dev/pts", "", 0);
    if (host_dir && mount_point) {
        generic_mkdirat(AT_PWD, mount_point, 0755);
        err = do_mount(&realfs, host_dir, mount_point, "", 0);
        if (err < 0)
            goto out;
    }

    exit_hook = tf_exit_hook;
    die_handler = tf_die_handler;
    if (tmp_dir) {
        char *prefix = malloc(strlen(tmp_dir) + 16);
        sprintf(prefix, "%s/ishsock", tmp_dir);
        sock_tmp_prefix = prefix;
    }

    tty_drivers[TTY_CONSOLE_MAJOR] = &tf_console_driver;
    set_console_device(TTY_CONSOLE_MAJOR, 1);
    err = create_stdio("/dev/console", TTY_CONSOLE_MAJOR, 1);
    if (err < 0)
        goto out;

    // init: stays alive, reaps whatever gets reparented to it
    const char *init_argv[] = {"/bin/sh", "-c", "while true; do wait; sleep 1; done", NULL};
    const char *init_envp[] = {"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", NULL};
    err = exec_current(init_argv, init_envp, "/");
    if (err < 0)
        goto out;
    g_booted = true;
    err = 0;
out:
    pthread_mutex_unlock(&g_api);
    return err;
}

int tf_ish_session_start(const char *const *argv, const char *const *envp, const char *cwd,
                         int cols, int rows, int *out_pty, int *out_pid) {
    pthread_mutex_lock(&g_api);
    int err = -ENXIO;
    if (!g_booted)
        goto out;
    err = become_new_init_child();
    if (err < 0)
        goto out;

    struct tty *tty = pty_open_fake(&tf_pty_driver);
    if (IS_ERR(tty)) {
        err = PTR_ERR(tty);
        goto out;
    }
    int num = tty->num;
    pthread_mutex_lock(&g_ttys_lock);
    g_ttys[num] = tty;
    pthread_mutex_unlock(&g_ttys_lock);

    lock(&tty->lock);
    tty_set_winsize(tty, (struct winsize_) {.col = cols, .row = rows});
    unlock(&tty->lock);

    char path[64];
    snprintf(path, sizeof path, "/dev/pts/%d", num);
    err = create_stdio(path, TTY_PSEUDO_SLAVE_MAJOR, num);
    tty_release(tty);
    if (err < 0)
        goto out;

    err = exec_current(argv, envp, cwd);
    if (err < 0)
        goto out;
    if (out_pty)
        *out_pty = num;
    if (out_pid)
        *out_pid = current->pid;
    err = 0;
out:
    pthread_mutex_unlock(&g_api);
    return err;
}

long tf_ish_session_input(int pty, const void *buf, size_t len) {
    struct tty *tty = tf_tty_for(pty);
    if (tty == NULL)
        return -ENXIO;
    return tty_input(tty, buf, len, false);
}

void tf_ish_session_resize(int pty, int cols, int rows) {
    struct tty *tty = tf_tty_for(pty);
    if (tty == NULL)
        return;
    lock(&tty->lock);
    tty_set_winsize(tty, (struct winsize_) {.col = cols, .row = rows});
    unlock(&tty->lock);
}

void tf_ish_session_hangup(int pty) {
    struct tty *tty = tf_tty_for(pty);
    if (tty == NULL)
        return;
    lock(&tty->lock);
    tty_hangup(tty);
    unlock(&tty->lock);
}

static struct fd *fd_from_host(int host_fd) {
    int dup_fd = dup(host_fd);
    if (dup_fd < 0)
        return NULL;
    struct fd *fd = adhoc_fd_create(&realfs_fdops);
    if (fd == NULL) {
        close(dup_fd);
        return NULL;
    }
    fd->real_fd = dup_fd;
    fd->dir = NULL;
    return fd;
}

int tf_ish_exec(const char *const *argv, const char *const *envp, const char *cwd,
                int stdin_fd, int stdout_fd, int stderr_fd) {
    pthread_mutex_lock(&g_api);
    int err = -ENXIO;
    if (!g_booted)
        goto out;
    err = become_new_init_child();
    if (err < 0)
        goto out;
    int host[3] = {stdin_fd, stdout_fd, stderr_fd};
    for (int i = 0; i < 3; i++) {
        struct fd *fd = fd_from_host(host[i]);
        if (fd == NULL) {
            err = -EMFILE;
            goto out;
        }
        current->files->files[i] = fd;
    }
    err = exec_current(argv, envp, cwd);
    if (err < 0)
        goto out;
    err = current->pid;
out:
    pthread_mutex_unlock(&g_api);
    return err;
}

int tf_ish_kill(int pid, int signal) {
    lock(&pids_lock);
    struct task *task = pid_get_task(pid);
    int err = -ESRCH;
    if (task != NULL) {
        send_signal(task, signal, SIGINFO_NIL);
        err = 0;
    }
    unlock(&pids_lock);
    return err;
}

const char *tf_ish_version(void) {
    return TF_ISH_VERSION;
}
