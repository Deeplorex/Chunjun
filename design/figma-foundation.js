await Promise.all(['Regular','Medium','Bold'].map(style=>figma.loadFontAsync({family:'Noto Sans SC',style})));
await figma.loadFontAsync({family:'IBM Plex Sans',style:'Regular'});
const created=[];
const first=figma.root.children[0];first.name='00 · 产品与功能';
const screens=figma.createPage();screens.name='01 · 桌面高保真';created.push(screens.id);
const parts=figma.createPage();parts.name='02 · 组件与规范';created.push(parts.id);
await figma.setCurrentPageAsync(parts);
const rgb=h=>({r:parseInt(h.slice(1,3),16)/255,g:parseInt(h.slice(3,5),16)/255,b:parseInt(h.slice(5,7),16)/255});
async function createVariableCollection(name,modeNames){const collection=figma.variables.createVariableCollection(name);const modeIds={};collection.renameMode(collection.modes[0].modeId,modeNames[0]);modeIds[modeNames[0]]=collection.modes[0].modeId;return{collection,modeIds};}
const {collection,modeIds}=await createVariableCollection('纯钧 / 基础与语义',['Light']);
const colors={paper:'#F7F7F3',surface:'#FFFFFF',rail:'#EEEFE9',canvas:'#E5E8E1',ink:'#252E29',muted:'#68746B',line:'#D6DCD3',accent:'#276650',soft:'#E5EFE7',warning:'#865A23',warnbg:'#FAEFDC',error:'#A23E36',errorbg:'#F8E8E4',white:'#FFFFFF'};
const vars={};
for(const [name,hex] of Object.entries(colors)){const p=figma.variables.createVariable('primitive/'+name,collection,'COLOR');p.scopes=[];p.setValueForMode(modeIds.Light,rgb(hex));const v=figma.variables.createVariable('color/'+name,collection,'COLOR');v.scopes=['FRAME_FILL','SHAPE_FILL','TEXT_FILL','STROKE_COLOR'];v.setVariableCodeSyntax('WEB','var(--cj-'+name+')');v.setValueForMode(modeIds.Light,{type:'VARIABLE_ALIAS',id:p.id});vars[name]=v;}
for(const v of [4,6,8,12,16,20,24,32,40]){const t=figma.variables.createVariable('space/'+v,collection,'FLOAT');t.scopes=['GAP','CORNER_RADIUS'];t.setValueForMode(modeIds.Light,v);t.setVariableCodeSyntax('WEB','var(--cj-space-'+v+')');vars['s'+v]=t;}
function fill(k){return[figma.variables.setBoundVariableForPaint({type:'SOLID',color:rgb(colors[k])},'color',vars[k])];}
const styles={};
for(const [name,size,style,line]of [['caption',12,'Regular',18],['body',14,'Regular',22],['label',14,'Medium',22],['group',16,'Medium',24],['title',24,'Medium',34],['display',36,'Medium',48]]){const t=figma.createTextStyle();t.name='纯钧 / '+name;t.fontName={family:'Noto Sans SC',style};t.fontSize=size;t.lineHeight={unit:'PIXELS',value:line};styles[name]=t.id;}
function txt(p,s,sty='label',col='ink'){const t=figma.createText();t.name=s;t.textStyleId=styles[sty];t.characters=s;t.fills=fill(col);p.appendChild(t);created.push(t.id);return t;}
const comps={};
for(const [i,kind]of ['Primary','Secondary','Ghost','Danger','Disabled'].entries()){const c=figma.createComponent();c.name='Button / '+kind;c.layoutMode='HORIZONTAL';c.primaryAxisAlignItems='CENTER';c.counterAxisAlignItems='CENTER';c.resize(148,40);c.paddingLeft=16;c.paddingRight=16;c.setBoundVariable('cornerRadius',vars.s6);c.fills=fill(kind==='Primary'?'accent':kind==='Danger'?'error':kind==='Disabled'?'rail':'surface');if(kind==='Secondary'){c.strokes=fill('line');c.strokeWeight=1;}const t=txt(c,'操作按钮','label',['Primary','Danger'].includes(kind)?'white':kind==='Disabled'?'muted':'ink');const key=c.addComponentProperty('Label','TEXT','操作按钮');t.componentPropertyReferences={characters:key};c.description='纯钧桌面按钮。主操作仅一个；保持 40px 高，按文案调整宽度。';parts.appendChild(c);c.x=200+i*184;c.y=220;created.push(c.id);comps[kind]={id:c.id,labelKey:key};}
const plus=figma.createComponent();plus.name='Icon / Plus';plus.resize(20,20);plus.fills=[];const svg=figma.createNodeFromSvg('<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14M5 12h14" stroke="#252E29" stroke-width="1.7" stroke-linecap="round"/></svg>');plus.appendChild(svg);parts.appendChild(plus);plus.x=200;plus.y=304;created.push(plus.id,...svg.findAll(()=>true).map(n=>n.id),svg.id);
// Use the discovered Simple Design System icon button, with a semantic plus swap.
const kit=await figma.importComponentSetByKeyAsync('e098805c9e6db6bfa6a87de61a8324a545d42501');
const kitComp=kit.children.find(n=>n.name==='Variant=Neutral, State=Default, Size=Small');
const imported=kitComp.createInstance();imported.setProperties({'Icon#4:192':plus.id});parts.appendChild(imported);imported.x=248;imported.y=296;created.push(imported.id);comps.Add={id:kitComp.id,swap:'Icon#4:192',icon:plus.id};
for(const [i,kind]of ['Default','Selected'].entries()){const c=figma.createComponent();c.name='Navigation / '+kind;c.layoutMode='HORIZONTAL';c.counterAxisAlignItems='CENTER';c.paddingLeft=16;c.itemSpacing=12;c.resize(148,44);c.cornerRadius=6;c.fills=fill(kind==='Selected'?'soft':'paper');const t=txt(c,'图片压缩','label',kind==='Selected'?'accent':'muted');const k=c.addComponentProperty('Label','TEXT','图片压缩');t.componentPropertyReferences={characters:k};parts.appendChild(c);c.x=200+i*184;c.y=380;created.push(c.id);comps['Nav'+kind]={id:c.id,labelKey:k};}
const image=figma.createImage(figma.base64Decode('__IMAGE_BASE64__'));
const spec=figma.createAutoLayout('VERTICAL');parts.appendChild(spec);spec.name='UI 规范 / light desktop';spec.x=200;spec.y=500;spec.resize(1070,200);spec.paddingLeft=32;spec.paddingRight=32;spec.paddingTop=32;spec.paddingBottom=32;spec.itemSpacing=16;spec.fills=fill('surface');txt(spec,'安静、直接、有分寸。','title');txt(spec,'纸白背景 · 石墨文字 · 青绿主操作 · 40px 控件 · Noto Sans SC 中文','body','muted');txt(spec,'状态用图标和文字说明；预览与导出分开；一次只突出一个主操作。','body');
const localIds=parts.findAll(()=>true).filter(n=>!n.name.startsWith('Variant=')).map(n=>n.id);
return {createdNodeIds:[...new Set([...created,...localIds])],mutatedNodeIds:[first.id],pages:{brief:first.id,screens:screens.id,parts:parts.id},variables:Object.fromEntries(Object.entries(vars).map(([k,v])=>[k,v.id])),styles,components:comps,imageHash:image.hash,collectionId:collection.id};
