// Existing high fidelity screens plus an editable minimum-window scrollbar state.
await figma.setCurrentPageAsync(await figma.getNodeByIdAsync('5:5'));
const page = figma.currentPage, created = [], removed = [], mutated = new Set();
const fonts = new Map();
for (const text of page.findAllWithCriteria({types:['TEXT']}))
  for (const run of text.getStyledTextSegments(['fontName'])) fonts.set(JSON.stringify(run.fontName),run.fontName);
await Promise.all([...fonts.values()].map(font => figma.loadFontAsync(font)));
function track(node) { created.push(node.id); if ('findAll' in node) created.push(...node.findAll(()=>true).map(n=>n.id)); return node; }
function editText(node,value) { node.characters=value; node.name=value; mutated.add(node.id); }
const screens = page.children.filter(n=>n.type==='FRAME'&&n.width===1440);
const updatedScreens = [];
for (const screen of screens) {
  const nav=screen.children.find(n=>n.name==='App navigation'); if (!nav) continue;
  const first=nav.children.find(n=>n.name.startsWith('Navigation /'));
  const shift=first.y-28;
  for (const n of [...nav.children]) {
    if(n.type==='TEXT'&&['神兵系列','纯钧'].includes(n.characters)) {removed.push(n.id);n.remove();continue;}
    if(shift>0&&n.y>=first.y&&n.y<500) {n.y-=shift;mutated.add(n.id);}
  }
  mutated.add(nav.id);updatedScreens.push(screen.id);
}
const source=await figma.getNodeByIdAsync('11:1561');
const name='19 / 设置 · 最小窗口与悬浮滚动条';
let demo=page.children.find(n=>n.name===name);
if(demo){removed.push(demo.id);demo.remove();}
demo=track(source.clone());page.appendChild(demo);demo.name=name;
demo.x=Math.max(...page.children.filter(n=>n.type==='FRAME'&&n.id!==demo.id).map(n=>n.x+n.width))+160;demo.y=200;demo.resize(1120,760);demo.clipsContent=true;
const title=demo.children.find(n=>n.name==='Window titlebar');title.resize(1120,title.height);
for(const n of title.children)if(n.x>1000){n.x-=320;mutated.add(n.id);}
const nav=demo.children.find(n=>n.name==='App navigation');nav.resize(nav.width,719);
for(const n of nav.children)if(n.y>700){n.y-=200;mutated.add(n.id);}
const heading=demo.children.find(n=>n.name==='Workspace heading');heading.resize(944,heading.height);
for(const n of demo.children.filter(n=>n.type==='RECTANGLE')){
  if(n.width>1000)n.resize(n.x>0?944:1120,n.height);
  else if(n.height>800)n.resize(n.width,719);
  mutated.add(n.id);
}
const bar=demo.children.find(n=>n.name==='Persistent action bar');bar.resize(944,80);bar.y=680;
for(const n of bar.children)if(n.type==='INSTANCE'&&n.x>900){n.x=944-24-n.width;mutated.add(n.id);}
const list=demo.children.find(n=>n.name==='Settings list');list.resize(816,list.height);list.primaryAxisSizingMode='AUTO';
const names=list.children.find(n=>n.name==='Default naming');names.resize(600,names.height);
for(const [i,n] of names.children.entries()){
  const width=i===2?248:164;n.resize(width,n.height);
  for(const item of n.children)if(item.type==='FRAME')item.resize(width,item.height);
}
const cache=list.children.find(n=>n.name==='Cache summary');cache.resize(752,cache.height);cache.primaryAxisSizingMode='FIXED';cache.primaryAxisAlignItems='SPACE_BETWEEN';
const history=list.children.find(n=>n.name==='保留本机处理记录');
const clear=track((await figma.getNodeByIdAsync('5:55')).createInstance());list.insertChild(list.children.indexOf(history)+1,clear);clear.resize(156,24);clear.name='Button / 清除处理记录';for(const t of clear.findAllWithCriteria({types:['TEXT']}))editText(t,'清除处理记录');
const last=list.children.find(n=>n.name==='最小化后继续处理');last.name='文件夹导入包含子目录';for(const t of last.findAllWithCriteria({types:['TEXT']}))editText(t,'文件夹导入包含子目录');
const concurrency=list.children.find(n=>n.name==='Field / 同时处理数量');for(const t of concurrency.findAllWithCriteria({types:['TEXT']}))if(t.characters.includes('自动'))editText(t,'1 张');
const viewport=track(figma.createAutoLayout('VERTICAL'));demo.appendChild(viewport);viewport.name='设置滚动视口 / 无占位';viewport.resize(816,504);viewport.primaryAxisSizingMode='FIXED';viewport.counterAxisSizingMode='FIXED';viewport.fills=[];viewport.clipsContent=true;viewport.x=256;viewport.y=152;
viewport.appendChild(list);list.x=0;list.y=0;list.layoutSizingHorizontal='FILL';
const trackNode=track(figma.createAutoLayout('VERTICAL'));viewport.appendChild(trackNode);trackNode.name='悬浮滚动条 / 12px 命中区';trackNode.layoutPositioning='ABSOLUTE';trackNode.resize(12,504);trackNode.primaryAxisSizingMode='FIXED';trackNode.counterAxisSizingMode='FIXED';trackNode.paddingLeft=trackNode.paddingRight=4;trackNode.fills=[];trackNode.x=804;trackNode.y=0;
const thumb=track(figma.createRectangle());trackNode.appendChild(thumb);thumb.name='滑块 / 4px · 无箭头';thumb.resize(4,Math.max(24,Math.min(504,504*504/list.height)));thumb.cornerRadius=2;
const muted=await figma.variables.getVariableByIdAsync('VariableID:5:19');const color=muted.resolveForConsumer(thumb).value;thumb.fills=[figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:color.r,g:color.g,b:color.b},opacity:0.55},'color',muted)];
mutated.add(demo.id);mutated.add(list.id);
return {createdNodeIds:[...new Set(created)],mutatedNodeIds:[...mutated],removedNodeIds:removed,updatedScreens,minimumSettings:demo.id,viewport:viewport.id,track:trackNode.id,thumb:thumb.id,dimensions:{width:1120,height:760,viewportWidth:816,viewportHeight:504,thumbWidth:4,reservedWidth:0}};
