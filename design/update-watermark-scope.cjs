const fs=require('fs');
const p=JSON.parse(fs.readFileSync('design/product-scope.json','utf8'));
const m=p.modules.find(m=>m.id==='A');m.name='水印与声明';
const edits={
 A01:['本地批量扫描','分别读取 AIGC 元数据声明与明水印；元数据解析无需 AI 模型，文字水印用本地 OCR，固定图标可用模板匹配；普通工具名称仅为辅助线索。'],
 A02:['分层检测证据','分别展示明确的 AIGC 声明、普通来源字段、明水印位置与识别内容；文字匹配置信度不代表 AI 生成概率。'],
 A08:['删除元数据声明','按声明记录或字段选择删除，先看原值与变更；保留未选中的 EXIF、ICC、版权及 GPS 信息；对同一逻辑声明的已知副本同步检查，导出后重新读取验证。'],
 A09:['添加明水印','支持用途说明、版权、品牌文字、本地图片及 AIGC 提示；九宫格位置、字号、边距、颜色、不透明度、底板与单处／平铺。'],
 A10:['改写明水印','用户选择旧区域后修补，再绘制新文字；用户新加且未导出的图层可直接编辑，不把栅格化文字当作可编辑文字。'],
 A11:['添加与改写元数据声明','元数据与明水印为并列入口。普通声明可编辑作者、版权和说明；AIGC 声明使用专门字段映射与结构校验，展示生成属性、服务提供者及内容编号。'],
 A13:['批量应用规则','明水印按图片相对尺寸定位；元数据声明逐图保留唯一编号，不把同一制作编号复制给全部图片；已有声明可保留、补充或逐项改写。'],
 A14:['导出保留与复检','压缩、转换与裁剪默认保留已有可读取的声明。目标格式无法原样承载时展示差异，要求明确选择受支持映射／换格式；不把旁置报告当作已嵌入声明。导出后分别验证明水印和元数据。']
};
for(const a of m.features)if(edits[a[0]]){a[1]=edits[a[0]][0];a[2]=edits[a[0]][1];}
for(const a of [
 ['A16','用途水印模板','身份证／证件复印件、合同材料、版权图片等用途模板；例如“仅供办理〔事项〕使用，他用无效”，支持自定义机构、事项与可选日期，文本直接本地绘制无需 AI。'],
 ['A17','单处与斜向平铺','可选择单处、居中跨图或全图重复；调节旋转角度、横纵间距与透明度；预览检查文字可读性及证件关键信息，支持批量应用与本地保存模板。']
])if(!m.features.some(f=>f[0]===a[0]))m.features.push(a);
p.watermarkTypes=[
 {name:'明水印',purpose:'直接绘制到图片像素上的文字或图片，包括用途、版权、品牌及 AIGC 提示。',model:'添加、排版与改写图层不需要 AI；自动识别和复杂区域修补可用本地模型。'},
 {name:'元数据声明',purpose:'写入文件结构中的普通来源／版权声明或结构化 AIGC 声明，图片画面不出现文字。',model:'解析、增删改写和校验不需要 AI 模型。'}
];
p.metadataContract={
 profiles:['通用声明：作者、版权与说明','AIGC 声明：结构化标签及来源要素'],
 explicitEvidence:'明确 AIGC 声明与 CreatorTool、Software 等辅助字段分开，不仅凭工具名称判定。',
 fields:['Label','ContentProducer','ProduceID','ReservedCode1','ContentPropagator','PropagateID','ReservedCode2'],
 labelValues:{'1':'属于 AI 生成合成','2':'可能为 AI 生成合成','3':'疑似为 AI 生成合成'},
 writePolicy:'无源文件修改、无需重新生成像素；只对支持的容器实施元数据改写。修改被签名保护的内容时单独显示保护状态，不声称原签名依然有效。',
 batchPolicy:'先检查现有声明，逐张提供明确的保留／补充／替换策略；不捏造服务提供者身份或内容制作编号。',
 roundtrip:'导出后重新读取检查字段和值；跨格式转换的声明承载能力需要用各格式样本验证。',
 distinction:'元数据声明与嵌入像素信号的隐形数字水印不同；后者仍属另行支持范围。'
};
for(const s of ['13 水印与声明／元数据添加与改写','14 水印与声明／元数据删除检查','15 水印与声明／证件用途明水印'])if(!p.screens.includes(s))p.screens.push(s);
for(const s of ['元数据声明增删改写可断网完成且无需加载 OCR 或修补模型','用途水印支持自定义内容、斜向平铺和日期，导出后直接可见','仅添加元数据时画面像素不变，目标字段需通过导出后回读验证'])if(!p.acceptance.includes(s))p.acceptance.push(s);
const src=['GB 45438—2025：第 6.1 节与附录 E 的元数据声明结构','https://www.xiongan.gov.cn/20250617/99e8309670814bdba91b3bcbfaca4e6c/2025061799e8309670814bdba91b3bcbfaca4e6c_38598ff9004470443c9195f1655adb29a0.pdf'];
if(!p.sources.some(s=>s[1]===src[1]))p.sources.push(src);
fs.writeFileSync('design/product-scope.json',JSON.stringify(p,null,2)+'\n');
let gen=fs.readFileSync('design/make-scope.cjs','utf8');
gen=gen.replace('标识。批量文件','水印与声明。批量文件');
const start='<section><h2>AIGC 能力与证据边界</h2>';
const section='<section><h2>两种标识方式</h2><table><tr><th>类型</th><th>用途</th><th>模型依赖</th></tr>${p.watermarkTypes.map(t=>`<tr><th>${t.name}</th><td>${t.purpose}</td><td>${t.model}</td></tr>`).join(\'\')}</table><h3>元数据声明的读写约定</h3><p>${p.metadataContract.explicitEvidence}</p><p>${p.metadataContract.writePolicy}</p><p>${p.metadataContract.batchPolicy}</p><p>${p.metadataContract.roundtrip}</p><p>${p.metadataContract.distinction}</p></section>';
if(!gen.includes('<h2>两种标识方式</h2>'))gen=gen.replace(start,section+start);
fs.writeFileSync('design/make-scope.cjs',gen);
require('./make-scope.cjs');
