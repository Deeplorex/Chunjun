const fs=require('fs');const p=JSON.parse(fs.readFileSync('design/product-scope.json','utf8'));
const m=p.modules.find(m=>m.id==='A');
const by=id=>m.features.find(f=>f[0]===id);
by('A01')[2]='导入后自动扫描 AIGC 通用声明、C2PA 内容凭证、XMP／EXIF／PNG 文本及厂商公开字段，自动提取平台、生成属性、工具与内容编号；元数据识别无需 AI 模型。';
by('A11')[1]='自动读取与一键补充声明';by('A11')[2]='默认自动识别并沿用源文件已有声明，无需用户输入平台名称、厂商编码、JSON 或内容编号。普通用户选择保留、补充或移除即可；字段编辑仅在高级选项中提供。';
by('A13')[2]='逐张自动识别来源，混合平台文件使用各自声明与编号；批量操作不要求统一填写某一厂商字段；无法识别、缺失和冲突项单独列出。';
p.metadataContract.automation='自动读取 → 匹配本地规则 → 展示平台与声明摘要 → 用户选择操作 → 导出后回读。默认不展示原始字段表单。';
p.metadataContract.missingPolicy='缺失字段标记未提供；未发现声明不要求用户填全厂商参数。可一键添加通用的 AI 生成用户声明，应用自动生成的本地记录编号明确属于纯钧，不能冒充原厂生成编号。';
p.metadataContract.providerIdentity='将可解析协议、字段中声明的平台、签名所支持的身份及实际验证状态分开展示；厂商名称或可复制字段不能单独证明来源真实性。';
p.metadataContract.compatibility='按公开协议和原始下载样本逐平台验收，同平台不同产品、下载入口和文件格式分别测试；截图、转存或平台剥离元数据后允许返回来源无法确认。';
p.metadataContract.offlineRules='规则库随安装包提供、带版本；支持从本地导入规则包。主动更新为可选操作，日常识别和处理不依赖网络。';
p.providerTargets=[
 {vendor:'字节跳动',products:'即梦 AI / 豆包',route:'AIGC 通用声明及公开字段',evidence:'火山引擎公开 AIGCMeta 文档；具体产品导出文件待样本验收',source:'https://docs.volcengine.com/docs/intelligent-processing/add-aigc-metadata-guide?lang=zh'},
 {vendor:'阿里巴巴',products:'通义万相 / 千问生图',route:'AIGC 通用声明、XMP 与格式专用记录',evidence:'首版适配目标，具体字段及产品出口待原始样本验收',source:''},
 {vendor:'腾讯',products:'混元生图',route:'AIGC 通用声明及公开字段',evidence:'首版适配目标，具体产品出口待原始样本验收',source:''},
 {vendor:'百度',products:'文心生图 / 文心一格',route:'AIGC 通用声明与平台字段',evidence:'首版适配目标，待公开格式和原始样本验收',source:''},
 {vendor:'快手',products:'可灵 / 可图',route:'AIGC 通用声明与平台字段',evidence:'首版适配目标，待公开格式和原始样本验收',source:''},
 {vendor:'OpenAI',products:'ChatGPT Images / DALL·E',route:'C2PA 内容凭证与来源信息',evidence:'官方文档确认内容来源信号；离线解析待原始样本验收',source:'https://developers.openai.com/api/docs/guides/content-provenance'},
 {vendor:'Google',products:'Gemini / Imagen',route:'有嵌入 C2PA 的导出文件及普通来源字段',evidence:'官方已说明部分产品的 C2PA；SynthID 像素水印另行处理，待出口样本验收',source:'https://blog.google/innovation-and-ai/products/ai-image-verification-gemini-app/'},
 {vendor:'Adobe',products:'Firefly / Photoshop 生成式编辑',route:'Content Credentials / C2PA',evidence:'Firefly 官方确认凭证包含来源与 AI 使用信息；具体工作流待样本验收',source:'https://helpx.adobe.com/firefly/web/get-started/learn-the-basics/content-credentials-overview.html'},
 {vendor:'Midjourney',products:'Midjourney',route:'平台公开说明的来源元数据',evidence:'官方内容真实性文档已公开；各下载入口待原始样本验收',source:'https://docs.midjourney.com/hc/en-us/articles/48207461163661-Content-Authenticity'}
];
p.sources.push(...p.providerTargets.filter(r=>r.source&&!p.sources.some(s=>s[1]===r.source)).map(r=>[r.vendor+'：公开元数据与内容来源说明',r.source]));
for(const t of ['主流平台兼容以真实原始下载样本验收，不能将产品适配目标写成已支持','正常流程无需手填厂商名称、编码或内容编号；缺失来源显示无法确认','混合平台批处理保留逐图编号，C2PA 验证状态与普通字段声明分开展示'])if(!p.acceptance.includes(t))p.acceptance.push(t);
fs.writeFileSync('design/product-scope.json',JSON.stringify(p,null,2)+'\n');
let gen=fs.readFileSync('design/make-scope.cjs','utf8');
const tag='<section><h2>两种标识方式</h2>';
const added='<section><h2>主流平台自动识别</h2><p>${p.metadataContract.automation}</p><p>${p.metadataContract.missingPolicy}</p><p>${p.metadataContract.providerIdentity}</p><p>${p.metadataContract.offlineRules}</p><p class="note">以下为首版适配目标与文档证据，不表示功能已实现或所有出口已通过验收。</p><table><tr><th>平台</th><th>兼容路线</th><th>验证状态</th></tr>${p.providerTargets.map(r=>`<tr><th>${r.vendor}<br>${r.products}</th><td>${r.route}</td><td>${r.evidence}</td></tr>`).join(\'\')}</table><p>${p.metadataContract.compatibility}</p></section>';
if(!gen.includes('<h2>主流平台自动识别</h2>'))gen=gen.replace(tag,added+tag);fs.writeFileSync('design/make-scope.cjs',gen);require('./make-scope.cjs');
