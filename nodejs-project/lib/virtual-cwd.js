'use strict';
// Worker threads share one OS-level working directory and cannot chdir, but every
// terminal session needs its own. Give each worker a virtual cwd: process.cwd()/chdir()
// track it, and relative string paths handed to fs are resolved against it before
// reaching libuv (which would otherwise resolve them against the process-wide cwd).

const fs = require('fs');
const path = require('path');

// fs functions whose leading arguments are paths; value = how many leading args are paths.
const PATH_ARGS = {
  access: 1, appendFile: 1, chmod: 1, chown: 1, copyFile: 2, cp: 2, exists: 1, lchmod: 1, lchown: 1,
  link: 2, lstat: 1, lutimes: 1, mkdir: 1, mkdtemp: 1, open: 1, opendir: 1, readdir: 1, readFile: 1,
  readlink: 1, realpath: 1, rename: 2, rm: 1, rmdir: 1, stat: 1, statfs: 1, symlink: 0, truncate: 1,
  unlink: 1, utimes: 1, watch: 1, watchFile: 1, unwatchFile: 1, writeFile: 1, createReadStream: 1,
  createWriteStream: 1,
};

function install(initialCwd) {
  let cwd = path.resolve(initialCwd);
  const abs = (p) => (typeof p === 'string' && !path.isAbsolute(p) ? path.resolve(cwd, p) : p);

  process.cwd = () => cwd;
  process.chdir = (dir) => {
    const next = path.resolve(cwd, String(dir));
    const st = fs.statSync(next);
    if (!st.isDirectory()) {
      const err = new Error(`ENOTDIR: not a directory, chdir ${cwd} -> '${dir}'`);
      err.code = 'ENOTDIR';
      throw err;
    }
    cwd = next;
  };

  const wrap = (target, name, count) => {
    const orig = target[name];
    if (typeof orig !== 'function' || orig.__tfWrapped) return;
    const wrapped = function (...args) {
      for (let i = 0; i < count && i < args.length; i++) args[i] = abs(args[i]);
      // symlink(target, path): only the link location is relative to cwd
      if (name.startsWith('symlink') && args.length > 1) args[1] = abs(args[1]);
      return orig.apply(this, args);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
    wrapped.__tfWrapped = true;
    target[name] = wrapped;
  };

  for (const [name, count] of Object.entries(PATH_ARGS)) {
    wrap(fs, name, count);
    wrap(fs, `${name}Sync`, count);
    wrap(fs.promises, name, count);
  }
  require('module').syncBuiltinESMExports();
  return { get cwd() { return cwd; } };
}

module.exports = { install };
