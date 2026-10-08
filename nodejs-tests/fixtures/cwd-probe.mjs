// Relative fs paths must resolve against this session's own cwd.
import { writeFileSync } from 'node:fs';
writeFileSync('where.txt', process.cwd());
