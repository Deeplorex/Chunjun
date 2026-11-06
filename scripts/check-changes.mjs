import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateChangeRecord({
  changedFiles,
  currentRecord,
  previousRecord,
  exists,
}) {
  const sourceChanged = changedFiles.some((file) =>
    /^(src\/|src-tauri\/src\/|scripts\/)/u.test(file),
  );
  if (!sourceChanged) return [];
  if (
    !changedFiles.includes('docs/changes.md') ||
    currentRecord === previousRecord
  )
    return ['Behavior changes require a new docs/changes.md entry.'];
  const additions = currentRecord
    .split(/^## /mu)
    .slice(1)
    .filter((entry) => !previousRecord.includes(`## ${entry}`));
  if (!additions.length)
    return ['Add a new change entry; do not rewrite previous entries.'];
  const errors = [];
  for (const entry of additions) {
    const tests = [
      ...entry.matchAll(
        /`([^`\n]+(?:\.test\.[cm]?[jt]sx?|(?:^|\/)tests\/[^`\n]+\.rs))`/gu,
      ),
    ].map((match) => match[1]);
    // Rust unit tests live in the cited source file and use #[cfg(test)].
    const rustTests = [
      ...entry.matchAll(/`(src-tauri\/src\/[^`\n]+\.rs)`/gu),
    ].map((match) => match[1]);
    const cited = [...tests, ...rustTests];
    if (!cited.length)
      errors.push('Behavior entries must cite directly affected test files.');
    for (const test of cited)
      if (!exists(test)) errors.push(`Cited test does not exist: ${test}`);
    const changedTest = cited.some((test) => changedFiles.includes(test));
    if (/Type: bug/u.test(entry) && !changedTest)
      errors.push('Bug fixes require a changed regression test.');
    if (
      !/Type: bug/u.test(entry) &&
      !changedTest &&
      !/existing coverage:/u.test(entry)
    )
      errors.push('Cite a changed test or explain existing coverage.');
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const base = process.env.CHANGE_BASE || 'HEAD';
  const tracked = execFileSync('git', ['diff', '--name-only', base, '--'], {
    encoding: 'utf8',
  });
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { encoding: 'utf8' },
  );
  const changedFiles = [
    ...new Set(`${tracked}\n${untracked}`.split(/\r?\n/u).filter(Boolean)),
  ];
  let previousRecord = '';
  try {
    previousRecord = execFileSync('git', ['show', `${base}:docs/changes.md`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    /* Initial adoption has no earlier record. */
  }
  const currentRecord = existsSync('docs/changes.md')
    ? readFileSync('docs/changes.md', 'utf8')
    : '';
  const errors = validateChangeRecord({
    changedFiles,
    currentRecord,
    previousRecord,
    exists: existsSync,
  });
  errors.forEach((error) => console.error(error));
  if (errors.length) process.exitCode = 1;
  else console.log('Change record and cited tests are linked.');
}
