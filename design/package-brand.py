from PIL import Image
from pathlib import Path
import json, hashlib, zipfile

root=Path('assets')
folder=root/'brand'/'raster'
sizes=[16,20,24,32,40,48,64,128,256]
frames=[Image.open(folder/f'app-icon-{n}.png').convert('RGBA') for n in sizes]
Image.open(folder/'app-icon-1024.png').save(folder/'app-icon.ico',format='ICO',sizes=[(n,n) for n in sizes],append_images=frames)
Image.open(folder/'app-icon-1024.png').save(folder/'app-icon.icns',format='ICNS',append_images=frames+[Image.open(folder/'app-icon-512.png')])
Image.open(folder/'app-icon-256.png').save(root/'brand'/'favicon.ico',format='ICO',sizes=[(n,n) for n in [16,32,48]],append_images=frames)

# Verify the Windows container uses the dedicated optical frames, not auto-resized artwork.
ico=Image.open(folder/'app-icon.ico')
assert set(ico.ico.sizes())=={(n,n) for n in sizes}
for n in [16,20,24]:
    assert ico.ico.getimage((n,n)).convert('RGBA').tobytes()==Image.open(folder/f'app-icon-{n}.png').convert('RGBA').tobytes()
icns=Image.open(folder/'app-icon.icns')
icns.load()
assert icns.size==(1024,1024)
for file in folder.glob('app-icon-*.png'):
    n=int(file.stem.rsplit('-',1)[1]); im=Image.open(file)
    assert im.size==(n,n) and im.mode=='RGBA'
    assert im.getchannel('A').getbbox() is not None

entries=[]
for p in sorted(root.rglob('*')):
    if p.is_file() and p.name!='manifest.json':
        payload=p.read_bytes()
        entries.append({'file':p.relative_to(root).as_posix(),'bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()})
(root/'manifest.json').write_text(json.dumps({'version':'1.0','date':'2026-11-02','files':entries},ensure_ascii=False,indent=2),encoding='utf8')
dest=Path('Chunjun-Brand-Assets-v1.zip')
with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file():z.write(p,Path('Chunjun-Brand-Assets-v1')/p.relative_to(root))
with zipfile.ZipFile(dest) as z:assert z.testzip() is None
print(json.dumps({'files':len(entries)+1,'zipBytes':dest.stat().st_size,'icoFrames':len(sizes),'icnsSize':icns.size,'opticalFramesVerified':[16,20,24]}))
