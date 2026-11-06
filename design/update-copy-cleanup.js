// Recorded cleanup for the existing high fidelity screens; reuses all existing assets.
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('5:5'));
const page = figma.currentPage;
const fonts = new Map();
for (const node of page.findAllWithCriteria({ types: ['TEXT'] }))
  for (const run of node.getStyledTextSegments(['fontName']))
    fonts.set(JSON.stringify(run.fontName), run.fontName);
await Promise.all([...fonts.values()].map(font => figma.loadFontAsync(font)));
const removed = [], mutated = new Set(), changedScreens = [];
function remove(node) {
  if (!node || node.removed) return;
  if (node.parent) mutated.add(node.parent.id);
  removed.push(node.id);
  if ('findAll' in node) removed.push(...node.findAll(() => true).map(n => n.id));
  node.remove();
}
function rename(node, value) {
  if (node.characters === value) return;
  node.characters = value;
  node.name = value.slice(0, 80);
  mutated.add(node.id);
}
const redundant = /压缩、转换、裁剪与标识处理|无需登录|Ctrl \+ O.*添加图片|拖入更多图片或文件夹|预览示例 · 实际结果|预览不会修改源文件|预览不会改变源文件|当前格式：.*数值越高|当前按质量编码|每个文件保持原格式；画质|兼容常用设备，不支持透明背景|有损模式按画质|关闭则为真正的无损|没有色彩管理引擎|含来源或色彩字段的文件暂不重编码|已完成当前图片预览。调整参数|三分参考线已开启|“应用全部”会统一比例|未发现声明不等于非 AI|未发现不等于非 AI|文件中的声明由来源方写入|普通 Software|自动读取已有声明 · 无需输入厂商字段|本次导出可在工作区底部单独调整|缓存清理不影响源文件|清理缓存不影响源文件|内置清单只是快捷填入|平台名称只按你的声明写入/;
for (const screen of page.children.filter(n => n.type === 'FRAME' && n.width === 1440)) {
  const before = removed.length + mutated.size;
  const heading = screen.children.find(n => n.name === 'Workspace heading');
  if (heading) {
    const text = heading.children.filter(n => n.type === 'TEXT');
    for (const node of text.slice(1)) remove(node);
    for (const node of [...heading.children]) {
      if (node.name === 'Status / 本地处理') { remove(node); continue; }
      if (node.name === 'Watermark type switch') {
        node.x = heading.width - 24 - node.width;
        mutated.add(node.id);
      }
    }
  }
  const nav = screen.children.find(n => n.name === 'App navigation');
  if (nav) {
    for (const node of [...nav.children])
      if ((node.type === 'TEXT' && node.characters === '仅在本机处理') || node.name === 'Icon / shield') remove(node);
  }
  for (const node of screen.findAllWithCriteria({ types: ['TEXT'] })) {
    if (node.removed) continue;
    if (redundant.test(node.characters)) {
      remove(node.parent.name === 'Note' ? node.parent : node);
      continue;
    }
    if (node.characters.includes('来源平台：无法确认')) rename(node, node.characters.split('\n').filter(line => !line.startsWith('来源平台：')).join('\n'));
    if (/^0[12]\s+(元数据声明|明水印)$/.test(node.characters)) rename(node, node.characters.replace(/^0[12]\s+/, ''));
    if (node.characters === '扫描结果') rename(node, '声明检测');
    if (node.parent.name === 'Evidence / 02  明水印' && node.characters.includes('OCR 置信度')) rename(node, '自动识别未安装');
    if (node.characters.startsWith('CreatorTool:') && node.characters.includes('工具名称本身不等于')) rename(node, node.characters.split('\n')[0]);
    if (node.parent.name === 'Inspector / 扫描结果' && /^当前图片 ·/.test(node.characters)) remove(node);
  }
  if (removed.length + mutated.size > before) changedScreens.push(screen.id);
}
for (const id of ['11:92', '11:93', '11:1645', '50:1732']) remove(await figma.getNodeByIdAsync(id));
const hero = await figma.getNodeByIdAsync('11:79'), dropzone = await figma.getNodeByIdAsync('11:81');
dropzone.y = hero.y + hero.height + 48;
mutated.add(dropzone.id);
const settings = await figma.getNodeByIdAsync('11:1612');
settings.primaryAxisSizingMode = 'AUTO'; mutated.add(settings.id);
rename(await figma.getNodeByIdAsync('11:1615'), '保存位置（本次会话）');
rename(await figma.getNodeByIdAsync('11:1625'), '预览缓存');
return {createdNodeIds: [], mutatedNodeIds: [...mutated], removedNodeIds: [...new Set(removed)], changedScreens, editable: true};
