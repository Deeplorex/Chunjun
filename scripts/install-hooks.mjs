import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  console.log('Source archive: Git hooks are not applicable.');
  process.exit(0);
}
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  stdio: 'inherit',
});
console.log(
  'Repository hooks enabled: staged format/lint and Conventional Commits.',
);
