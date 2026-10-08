// Exercises the virtual TTY the way an Ink app does: raw mode, resize, SIGINT, exit code.
const { stdin, stdout } = process;
stdout.write(`isTTY=${stdin.isTTY}/${stdout.isTTY} raw=${stdin.isRaw} cols=${stdout.columns} rows=${stdout.rows}\n`);
stdout.write(`argv=${process.argv.slice(2).join(',')}\ncwd=${process.cwd()}\n`);
stdout.on('resize', () => stdout.write(`RESIZE ${stdout.columns}x${stdout.rows}\n`));
process.on('SIGINT', () => stdout.write('GOT SIGINT\n'));
stdin.setRawMode(true);
stdin.on('data', (d) => {
  stdout.write(`KEY:${Buffer.from(d).toString('hex')}\n`);
  if (d.includes(0x71)) process.exit(7);
});
stdout.write('READY\n');
