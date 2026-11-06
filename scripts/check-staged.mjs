import { execFileSync, spawnSync } from 'node:child_process';
import * as prettier from 'prettier';
import { ESLint } from 'eslint';

/**
 * 判断一个暂存文件是否需要读取内容做格式检查。
 * 二进制与无解析器的文件（字体/图片等）直接跳过——不把内容读进子进程缓冲，
 * 否则超过 8MB 的暂存文件会把钩子打崩（Noto Sans SC 字体就有 17.8MB）。
 */
export async function inspectionKind(file) {
  if (file.endsWith('.rs')) return 'rust';
  const info = await prettier.getFileInfo(file, {
    ignorePath: '.prettierignore',
  });
  if (info.ignored || !info.inferredParser) return null;
  return 'prettier';
}

async function main() {
  const files = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const eslint = new ESLint();
  let failed = false;
  for (const file of files) {
    if (/^(assets|design|output|\.handoff)\//u.test(file)) continue;
    const kind = await inspectionKind(file);
    if (!kind) continue;
    const text = execFileSync('git', ['show', `:${file}`], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (kind === 'rust') {
      const result = spawnSync(
        'rustfmt',
        [
          '--edition',
          '2021',
          '--emit',
          'stdout',
          '--config',
          'skip_children=true',
        ],
        { input: text, encoding: 'utf8' },
      );
      if (
        result.status !== 0 ||
        result.stdout.replaceAll('\r\n', '\n') !== text.replaceAll('\r\n', '\n')
      ) {
        console.error(`Format the staged Rust file: ${file}`);
        failed = true;
      }
      continue;
    }
    const options = await prettier.resolveConfig(file);
    if (!(await prettier.check(text, { ...options, filepath: file }))) {
      console.error(`Format the staged file: ${file}`);
      failed = true;
    }
    if (/\.[cm]?[jt]sx?$/u.test(file) && !(await eslint.isPathIgnored(file))) {
      const results = await eslint.lintText(text, { filePath: file });
      if (results.some((result) => result.errorCount || result.warningCount)) {
        console.error((await eslint.loadFormatter('stylish')).format(results));
        failed = true;
      }
    }
  }
  if (failed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url ===
    (await import('node:url')).pathToFileURL(process.argv[1]).href
) {
  await main();
}
