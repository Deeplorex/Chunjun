import { readFileSync } from 'node:fs';

const subject = readFileSync(process.argv[2], 'utf8').split(/\r?\n/)[0];
const convention =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./-]+\))?!?: .+/u;
if (!convention.test(subject)) {
  console.error(
    'Commit subject must use Conventional Commits, e.g. feat(import): 添加图片导入',
  );
  process.exitCode = 1;
}
