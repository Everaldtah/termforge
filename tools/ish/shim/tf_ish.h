// TermForge's C interface to the iSH kernel (Linux x86 usermode emulator).
// Compiled with iSH's sources by tools/ish/build-ios.sh into iSHCore.xcframework;
// Swift sees only this header. All functions may be called from any thread.
#ifndef TF_ISH_H
#define TF_ISH_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Called from emulator threads; must return quickly and must not call back into tf_ish_*.
typedef struct tf_ish_callbacks {
    // bytes a program wrote to a session's terminal
    void (*output)(int pty, const void *buf, size_t len, void *ctx);
    // a session's process (a child of init) exited; code is the exit status, or 128+signal
    void (*exited)(int pid, int code, void *ctx);
    // kernel log line (NUL-terminated)
    void (*log)(const char *line, void *ctx);
    void *ctx;
} tf_ish_callbacks;

// Converts a rootfs tar.gz into iSH's fakefs layout at fakefs_dir (creates <dir>/data +
// <dir>/meta.db). Returns 0, or -1 with a message in err.
int tf_ish_import_rootfs(const char *tar_gz, const char *fakefs_dir, char *err, size_t err_len);

// Boots the kernel once per process: mounts the fakefs root, /proc, /dev/pts, and the
// host directory host_dir at mount_point inside the guest, then starts init.
// Returns 0 or a negative Linux errno.
int tf_ish_boot(const char *fakefs_dir, const char *host_dir, const char *mount_point,
                const char *tmp_dir, tf_ish_callbacks callbacks);

// Starts a program on a new pseudo-terminal. argv/envp are NULL-terminated arrays.
// cwd may be NULL. On success fills out_pty (for the other session calls) and out_pid.
int tf_ish_session_start(const char *const *argv, const char *const *envp, const char *cwd,
                         int cols, int rows, int *out_pty, int *out_pid);

// Keystrokes for a session; returns bytes accepted or a negative errno.
long tf_ish_session_input(int pty, const void *buf, size_t len);
void tf_ish_session_resize(int pty, int cols, int rows);
// SIGHUP to the session's foreground group; the terminal is gone.
void tf_ish_session_hangup(int pty);

// Runs a program with host pipes as stdin/stdout/stderr (for child_process-style
// execution). stdin_fd/stdout_fd/stderr_fd are host file descriptors the caller owns
// (pipe ends); the kernel dups them, so the caller may close its copies after this
// returns. Returns the guest pid or a negative errno; completion arrives via `exited`.
int tf_ish_exec(const char *const *argv, const char *const *envp, const char *cwd,
                int stdin_fd, int stdout_fd, int stderr_fd);

// Sends a signal to a guest process.
int tf_ish_kill(int pid, int signal);

// Version string of the embedded iSH ("ish <commit>").
const char *tf_ish_version(void);

#ifdef __cplusplus
}
#endif
#endif
