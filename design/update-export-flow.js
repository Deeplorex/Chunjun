// One-time mutation record, executed with Figma use_figma in A1vGeie8es1ZWYTU8dJnIQ.
// Some original nodes are replaced; inspect current IDs before reapplying.
// Changes only the approved export flow, using existing components and tokens.
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('5:5'));
const page = figma.currentPage;
const created = [], mutated = new Set(), removed = [];
const track = (node) => { created.push(node.id); if ('findAll' in node) created.push(...node.findAll(() => true).map(n => n.id)); return node; };
const fonts = new Map();
for (const text of page.findAllWithCriteria({ types: ['TEXT'] })) for (const segment of text.getStyledTextSegments(['fontName'])) fonts.set(JSON.stringify(segment.fontName), segment.fontName);
await Promise.all([...fonts.values()].map(font => figma.loadFontAsync(font)));
const source = await figma.getNodeByIdAsync('11:105');
const previous = await figma.getNodeByIdAsync('11:1250');
const sampleLabel = await figma.getNodeByIdAsync('11:1615');
const sampleBody = await figma.getNodeByIdAsync('11:1633');
const sampleGroup = await figma.getNodeByIdAsync('11:1613');
const sampleField = await figma.getNodeByIdAsync('11:1614');
const primary = await figma.getNodeByIdAsync('5:51');
const secondary = await figma.getNodeByIdAsync('5:53');
const ghost = await figma.getNodeByIdAsync('5:55');
const vars = {};
for (const [name,id] of Object.entries({surface:'VariableID:5:11',ink:'VariableID:5:17',muted:'VariableID:5:19',line:'VariableID:5:21',warning:'VariableID:5:27',paper:'VariableID:5:9',accent:'VariableID:5:23',space:'VariableID:5:42',gap:'VariableID:5:41',radius:'VariableID:5:38'})) vars[name] = await figma.variables.getVariableByIdAsync(id);
function fill(node,name) {
  const value = vars[name].resolveForConsumer(node).value;
  node.fills = [figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:value.r,g:value.g,b:value.b}},'color',vars[name])];
}
function auto(parent,name,width,direction='VERTICAL',padding=0,gap=20) {
  const node=track(figma.createAutoLayout(direction)); parent.appendChild(node); node.name=name; node.resize(width,10); node.primaryAxisSizingMode=direction==='VERTICAL'?'AUTO':'FIXED'; node.counterAxisSizingMode=direction==='VERTICAL'?'FIXED':'AUTO'; node.clipsContent=false; node.fills=[]; node.itemSpacing=gap;
  node.paddingLeft=node.paddingRight=node.paddingTop=node.paddingBottom=padding;
  if(padding===24) for(const key of ['paddingLeft','paddingRight','paddingTop','paddingBottom']) node.setBoundVariable(key,vars.space);
  if(gap===20) node.setBoundVariable('itemSpacing',vars.gap);
  return node;
}
function text(parent,content,width,kind='body',color='ink') {
  const node=track((kind==='group'?sampleGroup:kind==='label'?sampleLabel:sampleBody).clone()); parent.appendChild(node); node.characters=content; node.name=content.slice(0,40); node.textAutoResize='HEIGHT'; node.resize(width,node.height); fill(node,color); return node;
}
function button(parent,label,width,style='secondary') {
  const node=track((style==='primary'?primary:style==='ghost'?ghost:secondary).createInstance());parent.appendChild(node);node.resize(width,40);for(const t of node.findAllWithCriteria({types:['TEXT']}))t.characters=label;node.name='Button / '+label;return node;
}
function field(parent,label,value,width) {
  const node=track(sampleField.clone());parent.appendChild(node);node.name='Field / '+label;node.resize(width,68);
  for(const n of node.children){ if(n.type==='TEXT'){n.characters=label;n.name=label;} else if(n.type==='FRAME'){n.resize(width,40); for(const t of n.findAllWithCriteria({types:['TEXT']})){t.characters=value;t.name=value; t.resize(Math.max(20,width-24),t.height);}} }
  return node;
}
async function link(node,target,navigation='NAVIGATE',position) {
  await node.setReactionsAsync([{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:target,navigation,transition:{type:'DISSOLVE',easing:{type:'EASE_OUT'},duration:0.15},...(position?{overlayRelativePosition:position}:{})}]}]); mutated.add(node.id);
}
function renameText(node,value){node.characters=value;mutated.add(node.id);}
// A reusable overlay keeps each workspace visible when settings are expanded.
let overlay = page.children.find(n=>n.name==='Overlay / 本次导出');
if(overlay){ removed.push(overlay.id); overlay.remove(); }
overlay=auto(page,'Overlay / 本次导出',1263,'VERTICAL',24,20);overlay.x=6440;overlay.y=200;fill(overlay,'surface');
const panelHead=auto(overlay,'Header',1215,'HORIZONTAL',0,20);panelHead.counterAxisAlignItems='CENTER';
text(panelHead,'本次导出',1019,'group');const collapse=button(panelHead,'收起设置',176,'ghost');collapse.resize(176,24);await collapse.setReactionsAsync([{trigger:{type:'ON_CLICK'},actions:[{type:'CLOSE'}]}]);mutated.add(collapse.id);
const fields=auto(overlay,'Export fields',1215,'HORIZONTAL',0,20);
field(fields,'保存位置','原目录 / 纯钧导出',352);field(fields,'输出格式','保持原格式',235);
const names=auto(fields,'Naming',588,'HORIZONTAL',0,12);field(names,'前缀','',156);field(names,'后缀','_纯钧',156);field(names,'重名处理','自动编号',252);
const panelFoot=auto(overlay,'Footer',1215,'HORIZONTAL',0,20);text(panelFoot,'{原文件名}_纯钧.{格式} · 仅用于本次工作区',960);const checkbox=track((await figma.getNodeByIdAsync('11:1628')).clone());panelFoot.appendChild(checkbox);checkbox.resize(235,24);for(const t of checkbox.findAllWithCriteria({types:['TEXT']})) t.characters='导出后打开文件夹';
text(overlay,'BMP / TIFF / GIF / SVG 静态输出为 PNG。',1215);
// A transparent full-size overlay gives bottom alignment without unsupported manual overlay properties.
const panel=overlay;
overlay=track(figma.createFrame());page.appendChild(overlay);overlay.name='Overlay / 本次导出';overlay.resize(1440,960);overlay.fills=[];overlay.x=6440;overlay.y=200;
overlay.appendChild(panel);panel.name='本次导出面板';panel.x=177;panel.y=880-panel.height;
// Replace the old mandatory check board with the inline expanded-state example.
for(const child of [...previous.children]) {removed.push(child.id);child.remove();}
for(const child of source.children) previous.appendChild(track(child.clone()));
previous.name='07 / 导出设置 · 就地展开';mutated.add(previous.id);
const expandedPanel=track(panel.clone());previous.appendChild(expandedPanel);expandedPanel.x=177;expandedPanel.y=880-expandedPanel.height;expandedPanel.name='本次导出 / 展开';
const expandedBar=previous.children.find(n=>n.name==='Persistent action bar');
for(const n of expandedBar.children){if(n.type==='INSTANCE'&&n.name.includes('导出设置')){for(const t of n.findAllWithCriteria({types:['TEXT']}))renameText(t,'收起设置');await link(n,'11:105');}}
for(const n of expandedPanel.findAllWithCriteria({types:['INSTANCE']})) if(n.name==='Button / 收起设置')await link(n,'11:105');
// Full editable risk states use existing screens as their context.
async function risk(name,baseId,x,y,message,blocked=false) {
  let old=page.children.find(n=>n.name===name);if(old){removed.push(old.id);old.remove();}
  const base=await figma.getNodeByIdAsync(baseId), screen=track(base.clone());page.appendChild(screen);screen.name=name;screen.x=x;screen.y=y;
  const scrim=track(figma.createRectangle());screen.appendChild(scrim);scrim.name='Modal backdrop';scrim.resize(1440,960);scrim.fills=[{type:'SOLID',color:{r:37/255,g:46/255,b:41/255},opacity:0.5}];
  const dialog=auto(screen,'Export risk dialog',560,'VERTICAL',32,24);fill(dialog,'surface');dialog.setBoundVariable('cornerRadius',vars.radius);
  const title=text(dialog,blocked?'需要调整导出选项':'确认这些变化后导出',496,'group');title.fontSize=20;title.lineHeight={unit:'PIXELS',value:30};text(dialog,message,496,'label');text(dialog,'源文件保持只读，只导出处理后的副本。',496,'body','muted');
  const actions=auto(dialog,'Actions',496,'HORIZONTAL',0,12);actions.primaryAxisAlignItems='MAX';const cancel=button(actions,'返回调整',136);await link(cancel,baseId);
  if(!blocked){const confirm=button(actions,'确认并导出',156,'primary');await link(confirm,'11:1352');}
  dialog.x=(1440-dialog.width)/2;dialog.y=(960-dialog.height)/2;return screen;
}
const alphaRisk=await risk('16 / 导出风险 · 透明度与提帧','11:292',4880,200,'2 张图片含透明区域，导出 JPEG 后将填充白色背景。\n\n动画图片只导出选定帧，其余动画帧不会写入副本。');
const metadataRisk=await risk('17 / 导出风险 · 声明修改','25:313',4880,1310,'将删除已选择的声明字段；其他字段保持不变。\n\n写入的来源名称属于用户声明，未经纯钧核验。');
const blockedRisk=await risk('18 / 导出受限 · 来源与色彩','11:105',4880,2420,'源文件包含来源或色彩信息，当前重新编码无法完整保留。请改用元数据声明页处理原容器。',true);
// Route settings to the inline overlay and ordinary export straight to progress.
const position=undefined;
let rerouted=0;
for(const screen of page.children.filter(n=>n.type==='FRAME'&&n.width===1440)){
  const bar=screen.children.find(n=>n.name==='Persistent action bar');if(!bar)continue;
  for(const n of bar.children){
    if(n.type==='TEXT'&&n.characters.startsWith('保存到：')&&screen.id!=='11:1352'&&screen.id!=='11:1561'){n.textDecoration='UNDERLINE';mutated.add(n.id);await link(n,overlay.id,'OVERLAY',position);}
    if(n.type!=='INSTANCE')continue;
    const labels=n.findAllWithCriteria({types:['TEXT']}).map(t=>t.characters);
    if(labels.includes('导出设置')){
      if(screen.id==='11:1561'){removed.push(n.id);n.remove();}
      else if(['11:1352','11:1439'].includes(screen.id)){for(const t of n.findAllWithCriteria({types:['TEXT']}))renameText(t,'更改保存位置');await n.setReactionsAsync([]);mutated.add(n.id);}
      else await link(n,overlay.id,'OVERLAY',position);
    }
    else if(['11:105','11:292','11:553','11:887','11:1067','25:121','25:313','25:497','11:1250'].includes(screen.id) && n.mainComponent?.id==='5:51'){
      await link(n,screen.id==='11:292'?alphaRisk.id:screen.id==='25:313'?metadataRisk.id:'11:1352');rerouted++;
    }
  }
}
// Defaults remain on Settings; add naming without creating an export workflow there.
const settings=await figma.getNodeByIdAsync('11:1612');renameText(await figma.getNodeByIdAsync('11:1613'),'默认导出偏好');
const oldConflict=await figma.getNodeByIdAsync('11:1618');const index=settings.children.indexOf(oldConflict);removed.push(oldConflict.id);oldConflict.remove();
const defaults=auto(settings,'Default naming',786,'HORIZONTAL',0,12);field(defaults,'前缀','',218);field(defaults,'后缀','_纯钧',218);field(defaults,'重名处理','自动编号',326);settings.insertChild(index,defaults);mutated.add(settings.id);
const hint=text(settings,'本次导出可在工作区底部单独调整；保存位置仅在当前会话有效。',786);settings.insertChild(index+1,hint);settings.itemSpacing=16;mutated.add(settings.id);
// Ensure a context example's primary action also skips the removed check step.
for(const n of expandedBar.children)if(n.type==='INSTANCE'&&n.name.includes('导出 6 张图片'))await link(n,'11:1352');
return {createdNodeIds:[...new Set(created)],mutatedNodeIds:[...mutated],removedNodeIds:removed,expandedFrame:previous.id,overlay:overlay.id,riskFrames:[alphaRisk.id,metadataRisk.id,blockedRisk.id],rerouted,overlayBounds:{width:overlay.width,height:panel.height,y:panel.y},fontFamily:'Noto Sans SC'};
