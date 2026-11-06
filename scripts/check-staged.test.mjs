import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectionKind } from './check-staged.mjs';

test('binary assets are skipped without reading their bytes', async () => {
  // 字体/图片没有 Prettier 解析器：必须跳过，不能读内容（>8MB 会打爆钩子）。
  assert.equal(
    await inspectionKind('src/assets/fonts/NotoSansSC-VF.ttf'),
    null,
  );
  assert.equal(await inspectionKind('docs/images/shot.png'), null);
});

test('source files keep their inspection kind', async () => {
  assert.equal(await inspectionKind('src-tauri/src/lib.rs'), 'rust');
  assert.equal(await inspectionKind('src/App.tsx'), 'prettier');
  assert.equal(await inspectionKind('package.json'), 'prettier');
});
