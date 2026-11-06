const fs=require('fs'),path=require('path');
const sharp=require('C:/Users/caozh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root=path.resolve('assets'),brand=path.join(root,'brand'),iconsDir=path.join(root,'icons');
for(const dir of [brand,iconsDir,path.join(brand,'raster'),path.join(brand,'filetypes'),path.join(brand,'exploration'),path.join(iconsDir,'png-24'),path.join(iconsDir,'png-48')])fs.mkdirSync(dir,{recursive:true});
const d=JSON.parse(fs.readFileSync('design/brand-source.json','utf8'));
const paths=(arr,col)=>arr.map(p=>`<path d="${p}" fill="${col}" fill-rule="evenodd"/>`).join('');
const svg=(body,size=96,w=size,h=size)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
const marks={standard:svg(paths(d.markPaths,d.accent)),ink:svg(paths(d.markPaths,d.ink)),inverse:svg(paths(d.markPaths,d.paper)),small:svg(paths(d.smallPaths,d.accent),16),app:svg(`<rect width="96" height="96" rx="21" fill="${d.accent}"/>${paths(d.markPaths,d.paper)}`),appLight:svg(`<rect width="96" height="96" rx="21" fill="${d.paper}"/>${paths(d.markPaths,d.accent)}`)};
const write=(rel,content)=>fs.writeFileSync(path.join(root,rel),content);
for(const [k,file]of Object.entries({standard:'mark.svg',ink:'mark-ink.svg',inverse:'mark-inverse.svg',small:'mark-small.svg',app:'app-icon.svg',appLight:'app-icon-light.svg'}))write('brand/'+file,marks[k]);
const ICONS={
 compress:'<path d="M4 4l6 6m0-5v5H5m15 10l-6-6m0 5v-5h5"/>',
 convert:'<path d="M4 7h15m-4-4l4 4-4 4M20 17H5m4-4l-4 4 4 4"/>',
 crop:'<path d="M6 3v15h15M3 6h15v15"/>',
 watermark:'<path d="M5 5h14M12 5v10M8 15h8M4 20h16"/><path d="M5 18l-1 2 1 2m14-4l1 2-1 2"/>',
 metadata:'<path d="M8 3H4v18h16V3h-4M8 3v4h8V3H8zM8 11h8M8 15h3M8 18h6"/>',
 scan:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M7 12h10"/>',
 image:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 17l5-5 4 4 4-6 5 7"/><circle cx="8" cy="8" r="1"/>',
 file:'<path d="M14 2H5v20h14V7l-5-5zM14 2v5h5M8 12h8M8 16h6"/>',
 folder:'<path d="M3 7h7l2-3h8a1 1 0 011 1v14H3z"/>',
 'folder-open':'<path d="M3 9V5h7l2 3h9M3 9h19l-3 11H3V9z"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',close:'<path d="M6 6l12 12M18 6L6 18"/>',check:'<path d="M5 12l4 4L19 6"/>',
 warning:'<path d="M12 3L2 21h20L12 3zM12 9v5m0 3v1"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
 shield:'<path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="M8 12l3 3 5-6"/>',
 lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 018 0v4"/>',
 settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10l2 2M5 19l2-2M17 7l2-2"/>',
 history:'<path d="M3 11a9 9 0 119 10M3 4v7h7m2-5v6l4 2"/>',
 undo:'<path d="M3 9h11a6 6 0 010 12M3 9l5-5M3 9l5 5"/>',
 redo:'<path d="M21 9H10a6 6 0 000 12M21 9l-5-5M21 9l-5 5"/>',
 'rotate-left':'<path d="M3 9a9 9 0 111 9M3 3v6h6M12 7v5l3 2"/>',
 'rotate-right':'<path d="M21 9a9 9 0 10-1 9M21 3v6h-6M12 7v5l-3 2"/>',
 'flip-horizontal':'<path d="M12 3v18M3 5v14l6-7-6-7zm18 0v14l-6-7 6-7z"/>',
 'flip-vertical':'<path d="M3 12h18M5 3h14l-7 6-7-6zm0 18h14l-7-6-7 6z"/>',
 download:'<path d="M12 3v12m-5-5l5 5 5-5M4 16v5h16v-5"/>',
 upload:'<path d="M12 15V3m-5 5l5-5 5 5M4 16v5h16v-5"/>',
 save:'<path d="M4 3h13l4 4v14H3V3h1zM7 3v6h9V3M7 21v-8h10v8"/>',
 copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
 trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
 refresh:'<path d="M20 8a9 9 0 00-15-4L3 7m0-5v5h5M4 16a9 9 0 0015 4l2-3m0 5v-5h-5"/>',
 play:'<path d="M8 4l12 8-12 8V4z"/>',pause:'<path d="M7 4v16M17 4v16"/>',
 'zoom-in':'<circle cx="10" cy="10" r="7"/><path d="M15 15l6 6M7 10h6M10 7v6"/>',
 'zoom-out':'<circle cx="10" cy="10" r="7"/><path d="M15 15l6 6M7 10h6"/>',
 fit:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
 compare:'<path d="M12 3v18M9 5H3v14h6m6-14h6v14h-6M8 10l-2 2 2 2m8-4l2 2-2 2"/>',
 eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
 'eye-off':'<path d="M3 3l18 18M6 6C3 8 2 12 2 12s4 7 10 7c2 0 4-1 5-2M10 5h2c6 0 10 7 10 7l-3 4M10 10a3 3 0 004 4"/>',
 'chevron-down':'<path d="M5 9l7 7 7-7"/>',
 'chevron-left':'<path d="M15 5l-7 7 7 7"/>',
 'chevron-right':'<path d="M9 5l7 7-7 7"/>',
 edit:'<path d="M14 4l6 6-9 9H5v-6zM14 4l2-2 6 6-2 2"/>',
 brush:'<path d="M13 4l7 7-8 8H5v-7l8-8zM13 4l2-2 7 7-2 2M3 21h5"/>',
 grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
 search:'<circle cx="10" cy="10" r="7"/><path d="M15 15l6 6"/>',
 window:'<rect x="5" y="5" width="14" height="14"/>'
};
const labels=['压缩','转换','裁剪','明水印','元数据','扫描','图片','文件','文件夹','打开文件夹','添加','缩小','关闭','完成','警告','信息','本地处理','锁定','设置','历史','撤销','重做','左转','右转','水平翻转','垂直翻转','导出','导入','保存','复制','删除','重试','开始','暂停','放大查看','缩小查看','适应窗口','对比','显示','隐藏','向下','向左','向右','编辑','画笔','网格','查找','最大化'];
const iconSvg=(body,color='currentColor')=>`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const iconList=Object.entries(ICONS).map(([name,body],i)=>({name,label:labels[i],body,svg:iconSvg(body)}));
iconList.forEach(i=>write('icons/'+i.name+'.svg',i.svg));
write('icons/sprite.svg',`<svg xmlns="http://www.w3.org/2000/svg"><defs>${iconList.map(i=>`<symbol id="cj-${i.name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${i.body}</symbol>`).join('')}</defs></svg>`);
write('icons/index.json',JSON.stringify({grid:24,strokeWidth:1.8,icons:iconList.map(({name,label})=>({name,label,file:name+'.svg'}))},null,2));
const ascii={J:['001','001','001','001','101','101','010'],P:['110','101','101','110','100','100','100'],G:['011','100','100','101','101','101','011'],N:['101','111','111','111','111','111','101'],W:['101','101','101','111','111','111','101'],E:['111','100','100','110','100','100','111'],B:['110','101','101','110','101','101','110'],A:['010','101','101','111','101','101','101'],V:['101','101','101','101','101','010','010'],I:['111','010','010','010','010','010','111'],F:['111','100','100','110','100','100','100'],H:['101','101','101','111','101','101','101'],C:['011','100','100','100','100','100','011'],T:['111','010','010','010','010','010','010'],S:['011','100','100','010','001','001','110']};
const filetypes=['JPG','PNG','WEBP','AVIF','HEIC','TIFF','GIF','SVG'];
function pixelText(word){let body='';const unit=1.5,total=(word.length*4-1)*unit,x0=(64-total)/2;[...word].forEach((c,i)=>{(ascii[c]||ascii.I).forEach((row,y)=>[...row].forEach((bit,x)=>{if(bit==='1')body+=`<rect x="${x0+(i*4+x)*unit}" y="${39+y*unit}" width="${unit}" height="${unit}" fill="${d.accent}"/>`;}));});return body;}
for(const ext of filetypes){const s=svg(`<path d="M14 5h25l11 11v43H14V5z" fill="${d.paper}" stroke="${d.accent}" stroke-width="2"/><path d="M39 5v11h11" fill="none" stroke="${d.accent}" stroke-width="2"/><g transform="translate(21 16) scale(.22)">${paths(d.markPaths,d.accent)}</g>${pixelText(ext)}`,64);write('brand/filetypes/'+ext.toLowerCase()+'.svg',s);}
for(let i=0;i<d.alternatives.length;i++){const a=d.alternatives[i];write('brand/exploration/direction-'+(i+1)+'.svg',svg(paths(a.paths||d.markPaths,d.accent)));}
const sizes=[16,20,24,32,40,48,64,128,256,512,1024];
async function main(){
 await Promise.all(sizes.map(async size=>{const app=size<=24?svg(`<rect width="16" height="16" rx="3.5" fill="${d.accent}"/>${paths(d.smallPaths,d.paper)}`,16):marks.app;await sharp(Buffer.from(app)).resize(size,size).png().toFile(path.join(brand,'raster',`app-icon-${size}.png`));await sharp(Buffer.from(size<=24?marks.small:marks.standard)).resize(size,size).png().toFile(path.join(brand,'raster',`mark-${size}.png`));}));
 await sharp(Buffer.from(marks.app)).resize(180).png().toFile(path.join(brand,'raster','apple-touch-icon.png'));
 await Promise.all(iconList.flatMap(i=>[24,48].map(size=>sharp(Buffer.from(iconSvg(i.body,d.ink))).resize(size,size).png().toFile(path.join(iconsDir,'png-'+size,i.name+'.png')))));
 await Promise.all(filetypes.flatMap(ext=>[64,128,256].map(size=>sharp(path.join(brand,'filetypes',ext.toLowerCase()+'.svg')).resize(size,size).png().toFile(path.join(brand,'filetypes',ext.toLowerCase()+'-'+size+'.png')))));
 const manifest={version:'1.0',date:'2026-11-02',concept:d.concept,brand:d,marks,icons:iconList,appSizes:sizes,filetypes};
 fs.writeFileSync('design/brand-manifest.json',JSON.stringify(manifest,null,2));
 const preview=svg(`<rect width="96" height="96" fill="${d.paper}"/>${paths(d.markPaths,d.accent)}`);await sharp(Buffer.from(preview)).resize(768).png().toFile(path.join(brand,'raster','mark-preview.png'));
 console.log(JSON.stringify({icons:iconList.length,sizes:sizes.length,filetypes:filetypes.length,root}));
}
main().catch(e=>{console.error(e);process.exit(1);});
