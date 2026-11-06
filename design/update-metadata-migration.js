// Metadata migration copy sync (prepared, not yet executed in Figma).
// 按 design/update-scrollbars.js 模式编写；执行前先在控制台跑一次，
// 未匹配到的目标会列在返回的 missing 里，不会凭空创建。
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('5:5'));
const page = figma.currentPage;
const missing = [];
const updated = [];

const replacements = [
  {
    find: '保持原样（未接入）',
    replace:
      'ICC 与 EXIF 随 JPEG/PNG 副本自动迁移复检；EXIF 方向烘焙为正向像素。WebP / AVIF 目标不承载这些字段，导出前会请求确认。',
    label: '转换面板颜色配置假控件 → 真实能力说明',
  },
  {
    find: '按 EXIF 方向自动旋正',
    replace: '',
    label: '移除不可用的方向旋正假勾选',
  },
  {
    find: '当前重新编码无法完整保留。请改用元数据声明页处理原容器。',
    replace:
      '目标格式无法承载这些字段：确认后将丢弃；改用 JPEG/PNG 可完整迁移。',
    label: '来源/色彩受限从阻断改为可确认损失',
  },
];

const fonts = new Map();
for (const text of page.findAllWithCriteria({ types: ['TEXT'] }))
  for (const run of text.getStyledTextSegments(['fontName']))
    fonts.set(JSON.stringify(run.fontName), run.fontName);
await Promise.all([...fonts.values()].map((font) => figma.loadFontAsync(font)));

for (const item of replacements) {
  const hits = page
    .findAllWithCriteria({ types: ['TEXT'] })
    .filter((node) => node.characters.includes(item.find));
  if (hits.length === 0) {
    missing.push(item.label);
    continue;
  }
  for (const node of hits) {
    node.characters = item.replace || node.characters.split(item.find)[0];
    updated.push({ id: node.id, label: item.label });
  }
}

// 证据字段表“色彩配置”行改为“容器字段”。
const rows = page
  .findAllWithCriteria({ types: ['TEXT'] })
  .filter((node) => node.characters.trim() === '色彩配置');
if (rows.length === 0) missing.push('证据表色彩配置行');
for (const node of rows) {
  node.characters = '容器字段';
  updated.push({ id: node.id, label: '证据表色彩配置行 → 容器字段' });
}

return { updated, missing };
