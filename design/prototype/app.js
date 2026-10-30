/* 纯钧界面原型。编码器不在此文件里。体积数字是预览估算。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const MODES = ["compress", "convert", "crop"];
  const SOCIALS = {
    "ig-post": { ratio: "1", label: "1:1", w: 1080, h: 1080 },
    "ig-portrait": { ratio: "0.8", label: "4:5", w: 1080, h: 1350 },
    "ig-story": { ratio: "0.5625", label: "9:16", w: 1080, h: 1920 },
    yt: { ratio: "1.777778", label: "16:9", w: 1280, h: 720 },
    xhs: { ratio: "0.75", label: "3:4", w: 1080, h: 1440 },
  };
  const ENG = {
    jpg: "MozJPEG", png: "OxiPNG", webp: "libwebp", avif: "libavif",
    gif: "gifsicle", svg: "svgo", heic: "libheif", jxl: "JXL",
  };
  const ACCEPT = new Set(["jpg", "jpeg", "jfif", "png", "webp", "gif", "svg", "avif", "jxl", "heic", "heif"]);

  const state = {
    phase: "entry",
    mode: "compress",
    method: "quality",
    quality: { jpg: 85, webp: 80, avif: 50 },
    levels: { png: 2, gif: 2, gifLossy: 0 },
    size: { target: 200, preset: "200", minQ: 40, allow: true },
    convert: { format: "webp", quality: 80, keepAnim: true, matte: "ink", gifLevel: 2 },
    crop: { ratio: "free", social: null, lockFrame: false, outW: null, outH: null, suggestW: 0, suggestH: 0, png: true, view: "crop" },
    rotate: { quarter: 0, straighten: 0 },
    svgW: 1600,
    strip: true,
    wipe: 0.62,
    holdOriginal: false,
    zoom: "fit",
    viewScale: 1,
    running: false,
    active: null,
  };

  let files = [];
  let seq = 1;
  let armClear = false;
  let noticeTimer = 0;
  let drawnMode = null;

  function normExt(ext) {
    ext = String(ext || "").toLowerCase().replace(".", "");
    if (ext === "jpeg" || ext === "jfif") return "jpg";
    if (ext === "heif") return "heic";
    return ext;
  }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function clamp8(n) { return clamp(Math.round(n), 0, 255); }
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function active() { return files.find((f) => f.id === state.active) || null; }
  function typing(e) {
    const t = e.target;
    if (!t) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable;
  }
  function shanghaiParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return g;
  }
  function formatBytes(n) {
    if (n == null || !isFinite(n)) return "—";
    if (n >= 1048576) {
      const mb = n / 1048576;
      return (mb >= 10 ? mb.toFixed(1) : mb.toFixed(1)) + " MB";
    }
    if (n >= 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
    return Math.round(n) + " B";
  }
  function targetLabel(kb) {
    if (kb >= 1024 && kb % 1024 === 0) return kb / 1024 + "MB";
    return kb + "KB";
  }

  function grain(g, w, h, amount) {
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 16) {
      const n = (Math.random() - 0.5) * amount;
      d[i] = clamp8(d[i] + n);
      d[i + 1] = clamp8(d[i + 1] + n);
      d[i + 2] = clamp8(d[i + 2] + n);
    }
    g.putImageData(img, 0, 0);
  }
  function lotus(g, x, y, s) {
    g.save();
    g.translate(x, y);
    for (let i = 0; i < 9; i++) {
      g.save();
      g.rotate((i / 9) * Math.PI * 2);
      g.beginPath();
      g.ellipse(0, -s * 0.42, s * 0.18, s * 0.46, 0, 0, Math.PI * 2);
      g.fillStyle = i % 2 ? "rgba(240,226,212,0.9)" : "rgba(206,188,172,0.72)";
      g.fill();
      g.restore();
    }
    g.beginPath();
    g.arc(0, 0, s * 0.14, 0, Math.PI * 2);
    g.fillStyle = "rgba(247, 236, 224, 0.95)";
    g.fill();
    g.restore();
  }
  function waterLines(g, w, h, y0) {
    g.save();
    g.strokeStyle = "rgba(198, 214, 214, 0.16)";
    g.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
      const y = y0 + i * i * 0.85;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= w; x += 24) g.lineTo(x, y + Math.sin(x * 0.012 + i) * 2.4);
      g.stroke();
    }
    g.restore();
  }
  function paintPond(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0a1214");
    bg.addColorStop(0.28, "#123238");
    bg.addColorStop(0.5, "#1d5c60");
    bg.addColorStop(0.72, "#0f3336");
    bg.addColorStop(1, "#081416");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    const band = g.createLinearGradient(0, h * 0.4, 0, h * 0.72);
    band.addColorStop(0, "rgba(0,0,0,0)");
    band.addColorStop(0.5, "rgba(214, 232, 230, 0.28)");
    band.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = band;
    g.fillRect(0, h * 0.38, w, h * 0.36);
    waterLines(g, w, h, h * 0.5);
    const stars = [[0.16, 0.14], [0.28, 0.2], [0.37, 0.12], [0.49, 0.18], [0.6, 0.11], [0.72, 0.17], [0.84, 0.13]];
    stars.forEach(([sx, sy], i) => {
      g.fillStyle = i === 4 ? "rgba(240,226,212,0.95)" : "rgba(238,243,244,0.88)";
      const z = i % 3 === 0 ? 3 : 2;
      g.fillRect(sx * w, sy * h, z, z);
      g.fillStyle = "rgba(190, 210, 210, 0.28)";
      g.fillRect(sx * w, h * 0.58 + sy * h * 0.45, 1, 7 + i);
    });
    g.strokeStyle = "rgba(232, 220, 208, 0.55)";
    g.beginPath();
    g.moveTo(w * 0.72, h * 0.4);
    g.lineTo(w * 0.7, h * 0.72);
    g.stroke();
    lotus(g, w * 0.7, h * 0.4, Math.min(w, h) * 0.11);
    grain(g, w, h, 14);
    return c;
  }
  function paintBlade(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const grd = g.createLinearGradient(w * 0.15, h * 0.05, w * 0.85, h * 0.95);
    grd.addColorStop(0, "rgba(8,12,14,0)");
    grd.addColorStop(0.38, "rgba(150, 176, 178, 0.05)");
    grd.addColorStop(0.48, "rgba(226, 236, 236, 0.55)");
    grd.addColorStop(0.5, "rgba(244, 248, 248, 0.95)");
    grd.addColorStop(0.52, "rgba(226, 236, 236, 0.55)");
    grd.addColorStop(0.62, "rgba(150, 176, 178, 0.05)");
    grd.addColorStop(1, "rgba(8,12,14,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(238,243,244,0.92)";
    g.lineWidth = Math.max(2, w / 280);
    g.beginPath();
    g.moveTo(w * 0.22, h * 0.06);
    g.lineTo(w * 0.8, h * 0.94);
    g.stroke();
    g.strokeStyle = "rgba(200, 214, 214, 0.35)";
    g.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      g.beginPath();
      const x = w * (0.28 + i * 0.05);
      const y = h * (0.16 + i * 0.08);
      g.moveTo(x, y);
      g.lineTo(x + w * 0.08, y + h * 0.05);
      g.stroke();
    }
    const frost = g.createRadialGradient(w * 0.5, h * 0.72, 10, w * 0.5, h * 0.72, w * 0.45);
    frost.addColorStop(0, "rgba(240, 226, 212, 0.16)");
    frost.addColorStop(1, "rgba(240, 226, 212, 0)");
    g.fillStyle = frost;
    g.fillRect(0, 0, w, h);
    return c;
  }
  function paintStars(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const water = g.createLinearGradient(0, h * 0.48, 0, h);
    water.addColorStop(0, "rgba(18, 48, 52, 0.2)");
    water.addColorStop(0.2, "#0e2c2f");
    water.addColorStop(1, "#071416");
    g.fillStyle = water;
    g.fillRect(0, h * 0.46, w, h * 0.54);
    g.strokeStyle = "rgba(232, 238, 238, 0.35)";
    g.beginPath();
    g.moveTo(0, h * 0.5);
    g.lineTo(w, h * 0.5);
    g.stroke();
    const pts = [[0.1, 0.16], [0.2, 0.1], [0.3, 0.2], [0.4, 0.08], [0.5, 0.18], [0.6, 0.11], [0.7, 0.22], [0.8, 0.12], [0.9, 0.2]];
    pts.forEach(([sx, sy], i) => {
      g.fillStyle = i === 5 ? "rgba(240,226,212,0.95)" : "rgba(238,243,244,0.9)";
      g.fillRect(sx * w, sy * h, i % 2 ? 2 : 1.4, i % 2 ? 2 : 1.4);
      g.fillStyle = "rgba(200,214,214,0.3)";
      g.fillRect(sx * w, h * 0.52 + (0.22 - sy) * h * 0.4, 1, 6 + (i % 4));
    });
    return c;
  }
  function paintLotusStill(w, h) {
    const c = paintPond(w, h);
    const g = c.getContext("2d");
    lotus(g, w * 0.48, h * 0.46, Math.min(w, h) * 0.16);
    return c;
  }
  function paintScroll(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#081214");
    bg.addColorStop(0.45, "#123438");
    bg.addColorStop(1, "#070d0e");
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    waterLines(g, w, h, h * 0.28);
    g.fillStyle = "rgba(238,243,244,0.8)";
    for (let i = 0; i < 14; i++) g.fillRect(w * (0.08 + i * 0.06), h * (0.18 + (i % 3) * 0.04), 1.4, 1.4);
    lotus(g, w * 0.82, h * 0.42, h * 0.16);
    grain(g, w, h, 10);
    return c;
  }
  function paintInkPlate(w, h) {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#101416";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(200,208,212,0.7)";
    g.beginPath();
    g.moveTo(w * 0.5, h * 0.18);
    g.lineTo(w * 0.5, h * 0.78);
    g.stroke();
    return c;
  }
  function thumbOf(canvas) {
    const t = document.createElement("canvas");
    t.width = 96; t.height = 96;
    const g = t.getContext("2d");
    g.fillStyle = "#101416";
    g.fillRect(0, 0, 96, 96);
    if (!canvas) return t.toDataURL("image/png");
    const s = Math.min(96 / canvas.width, 96 / canvas.height);
    const dw = canvas.width * s;
    const dh = canvas.height * s;
    g.drawImage(canvas, (96 - dw) / 2, (96 - dh) / 2, dw, dh);
    return t.toDataURL("image/png");
  }
  function previewSize(natW, natH) {
    const long = 960;
    const s = long / Math.max(natW, natH);
    return { w: Math.max(2, Math.round(natW * s)), h: Math.max(2, Math.round(natH * s)) };
  }
  function makeFile(spec, preview) {
    const ext = normExt(spec.ext);
    return {
      id: "f" + seq++,
      name: spec.name,
      ext,
      natW: spec.natW,
      natH: spec.natH,
      bytes: spec.bytes,
      hasAlpha: !!spec.hasAlpha,
      animated: !!spec.animated,
      frames: spec.frames || 0,
      duration: spec.duration || 0,
      heicFail: !!spec.heicFail,
      rasterized: ext !== "svg",
      preview,
      thumb: thumbOf(preview || paintInkPlate(96, 96)),
      included: true,
      status: "queued",
      error: "",
      note: "",
      progress: null,
      manualCrop: false,
      crop: { x: 0, y: 0, w: 1, h: 1 },
      resultName: "",
      resultBytes: 0,
    };
  }
  function loadSamples() {
    files = [];
    const specs = [
      { name: "塘莲.jpg", ext: "jpg", natW: 4032, natH: 3024, bytes: 4.8 * 1048576, paint: paintPond },
      { name: "霜刃.png", ext: "png", natW: 2400, natH: 3200, bytes: 6.2 * 1048576, hasAlpha: true, paint: paintBlade },
      { name: "列星.png", ext: "png", natW: 1920, natH: 1080, bytes: 2.1 * 1048576, hasAlpha: true, paint: paintStars },
      { name: "动荷.gif", ext: "gif", natW: 800, natH: 600, bytes: 8.4 * 1048576, animated: true, frames: 12, duration: 2.4, paint: paintLotusStill },
      { name: "旧照.heic", ext: "heic", natW: 3024, natH: 4032, bytes: 3.3 * 1048576, heicFail: true, paint: null },
      { name: "长卷.jpg", ext: "jpg", natW: 12000, natH: 4000, bytes: 48 * 1048576, paint: paintScroll },
    ];
    specs.forEach((spec) => {
      let preview = null;
      if (spec.paint) {
        const s = previewSize(spec.natW, spec.natH);
        preview = spec.paint(s.w, s.h);
      }
      files.push(makeFile(spec, preview));
    });
    state.phase = "work";
    state.active = files[0].id;
    state.crop.ratio = "free";
    state.crop.social = null;
    state.crop.lockFrame = false;
  }

  function rotatedNative(file) {
    const angle = (state.rotate.quarter * 90 + state.rotate.straighten) * Math.PI / 180;
    const sin = Math.abs(Math.sin(angle));
    const cos = Math.abs(Math.cos(angle));
    return {
      w: Math.max(1, Math.round(file.natW * cos + file.natH * sin)),
      h: Math.max(1, Math.round(file.natW * sin + file.natH * cos)),
    };
  }
  function renderRotated(src) {
    const angle = (state.rotate.quarter * 90 + state.rotate.straighten) * Math.PI / 180;
    if (!src) return null;
    if (Math.abs(angle) < 0.0008) return src;
    const sin = Math.abs(Math.sin(angle));
    const cos = Math.abs(Math.cos(angle));
    const rw = Math.max(1, Math.round(src.width * cos + src.height * sin));
    const rh = Math.max(1, Math.round(src.width * sin + src.height * cos));
    const c = document.createElement("canvas");
    c.width = rw; c.height = rh;
    const g = c.getContext("2d");
    g.translate(rw / 2, rh / 2);
    g.rotate(angle);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }
  function blit(canvas, src) {
    if (!src) {
      canvas.width = 2; canvas.height = 2;
      return;
    }
    if (canvas.width !== src.width || canvas.height !== src.height) {
      canvas.width = src.width;
      canvas.height = src.height;
    }
    const g = canvas.getContext("2d");
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(src, 0, 0);
  }
  function downscale(src, scale) {
    const t = document.createElement("canvas");
    t.width = Math.max(4, Math.round(src.width * scale));
    t.height = Math.max(4, Math.round(src.height * scale));
    t.getContext("2d").drawImage(src, 0, 0, t.width, t.height);
    return t;
  }
  function paintAfter(src, q, matte) {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    const g = c.getContext("2d");
    if (matte) {
      g.fillStyle = matte;
      g.fillRect(0, 0, c.width, c.height);
    }
    if (q >= 78) {
      g.filter = "contrast(1.06) saturate(0.94)";
      g.drawImage(src, 0, 0);
      g.filter = "none";
    } else if (q >= 45) {
      g.imageSmoothingEnabled = true;
      g.drawImage(downscale(src, 0.55), 0, 0, c.width, c.height);
    } else {
      g.imageSmoothingEnabled = true;
      g.drawImage(downscale(src, Math.max(0.22, q / 140)), 0, 0, c.width, c.height);
    }
    return c;
  }
  function lossyKind(file) {
    const k = normExt(file.ext);
    if (k === "webp" || k === "avif" || k === "jpg") return k;
    return "jpg";
  }
  function qualityFor(file) {
    const k = normExt(file.ext);
    if (k === "png") return state.levels.png;
    if (k === "gif") return state.levels.gif;
    if (k === "webp") return state.quality.webp;
    if (k === "avif") return state.quality.avif;
    return state.quality.jpg;
  }
  function estimateBytes(file, q, pixelRatio, kind) {
    if (kind === "png") return file.bytes * (1 - 0.04 * state.levels.png) * pixelRatio;
    if (kind === "gif") return file.bytes * (1 - 0.08 * state.levels.gif) * (1 - state.levels.gifLossy / 200) * pixelRatio;
    if (kind === "svg") return null;
    const jpegLike = file.bytes * (0.05 + 0.57 * Math.pow(Math.max(1, q) / 100, 1.4)) * pixelRatio;
    if (kind === "avif") return jpegLike * 0.55;
    return jpegLike;
  }
  function planSize(file) {
    const kind = normExt(file.ext);
    const target = state.size.target * 1024;
    if (kind === "png" || kind === "svg") return { blocked: kind };
    const minQ = state.size.minQ;
    const search = (pixelRatio) => {
      let lo = minQ, hi = 100, best = null;
      for (let i = 0; i < 12 && lo <= hi; i++) {
        const mid = (lo + hi) >> 1;
        const est = estimateBytes(file, mid, pixelRatio, kind === "gif" ? "gif" : kind);
        if (est > target) hi = mid - 1;
        else { best = mid; lo = mid + 1; }
      }
      return best;
    };
    const pack = (q, w, h, pr, scaled) => {
      const bytes = estimateBytes(file, q, pr, kind === "gif" ? "gif" : kind);
      return { q, w, h, bytes, scaled, over: bytes > target + 1 };
    };
    let found = search(1);
    if (found != null) return pack(found, file.natW, file.natH, 1, false);
    if (!state.size.allow) return pack(minQ, file.natW, file.natH, 1, false);
    let w = file.natW;
    let h = file.natH;
    const origLong = Math.max(file.natW, file.natH);
    while (Math.max(w, h) > 320) {
      const next = Math.round(Math.max(w, h) * 0.9);
      const applied = Math.max(320, next);
      const scale = applied / origLong;
      w = Math.max(1, Math.round(file.natW * scale));
      h = Math.max(1, Math.round(file.natH * scale));
      const pr = (w * h) / (file.natW * file.natH);
      found = search(pr);
      if (found != null) return pack(found, w, h, pr, true);
      if (Math.max(w, h) <= 320) break;
    }
    const pr = (w * h) / (file.natW * file.natH);
    return pack(minQ, w, h, pr, true);
  }
  function previewPlan(file) {
    if (!file) return { bytes: null, text: "" };
    if (state.mode === "compress") {
      const kind = normExt(file.ext);
      if (kind === "heic" || kind === "jxl") return { bytes: null, text: "暂不能压回原格式，请改用转换" };
      if (state.method === "size") {
        const p = planSize(file);
        if (p.blocked === "png") return { bytes: estimateBytes(file, 2, 1, "png"), text: "无损格式难以压到目标。若要达标，请改用转换，输出 JPG 或 WebP。" };
        if (p.blocked === "svg") return { bytes: null, text: "SVG 只做结构精简，不保证体积。" };
        let text = "预计质量 " + p.q;
        if (p.scaled) text += "，长边缩至 " + p.w;
        if (p.over) text += "。仍大于目标";
        return { bytes: p.bytes, text, plan: p };
      }
      if (kind === "png") return { bytes: estimateBytes(file, 0, 1, "png"), text: "" };
      if (kind === "gif") return { bytes: estimateBytes(file, 0, 1, "gif"), text: "" };
      if (kind === "svg") return { bytes: null, text: "以 SVGO 结果为准" };
      const q = qualityFor(file);
      return { bytes: estimateBytes(file, q, 1, kind), text: "" };
    }
    if (state.mode === "convert") {
      const fmt = state.convert.format;
      if (fmt === "png") return { bytes: Math.round(file.bytes * 0.9), text: "" };
      const q = state.convert.quality;
      return { bytes: estimateBytes(file, q, 1, fmt), text: "" };
    }
    const frame = outputFrame(file);
    return { bytes: Math.round(frame.w * frame.h * 0.72), text: frame.note, frame };
  }
  function selectionPixels(file) {
    const nat = rotatedNative(file);
    return {
      w: Math.max(1, Math.round(file.crop.w * nat.w)),
      h: Math.max(1, Math.round(file.crop.h * nat.h)),
    };
  }
  function outputFrame(file) {
    const sel = selectionPixels(file);
    if (!state.crop.lockFrame) return { w: sel.w, h: sel.h, note: "默认即选区像素，不放大。" };
    const sw = state.crop.suggestW;
    const sh = state.crop.suggestH;
    if (state.crop.social && sw && (sel.w < sw || sel.h < sh)) {
      return { w: sel.w, h: sel.h, note: "小于建议帧，不放大。" };
    }
    let w = state.crop.outW;
    let h = state.crop.outH;
    if (!w || !h) return { w: sel.w, h: sel.h, note: "默认即选区像素，不放大。" };
    if (w > sel.w || h > sel.h) return { w: sel.w, h: sel.h, note: "已限制在原图像素内" };
    if (w < sel.w || h < sel.h) return { w, h, note: "将缩至该帧" };
    return { w, h, note: "默认即选区像素，不放大。" };
  }
  function ratioNumber() {
    if (state.crop.ratio === "free") return null;
    const n = parseFloat(state.crop.ratio);
    return isFinite(n) ? n : null;
  }
  function initCrop(file, ratio) {
    if (!ratio) return { x: 0, y: 0, w: 1, h: 1 };
    const nat = rotatedNative(file);
    const R = nat.w / nat.h;
    let w;
    let h;
    if (R > ratio) {
      h = 1;
      w = (ratio * nat.h) / nat.w;
    } else {
      w = 1;
      h = nat.w / ratio / nat.h;
    }
    w = clamp(w, 0.02, 1);
    h = clamp(h, 0.02, 1);
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  function uniqueName(stem, ext) {
    const used = new Set(files.map((f) => f.resultName).filter(Boolean));
    let name = stem + "." + ext;
    let n = 2;
    while (used.has(name)) {
      name = stem + "-" + n + "." + ext;
      n += 1;
    }
    return name;
  }
  function resultStem(file) {
    const base = file.name.replace(/\.[^.]+$/, "");
    if (state.mode === "convert") return base;
    if (state.mode === "crop") {
      const frame = outputFrame(file);
      return base + "." + frame.w + "x" + frame.h;
    }
    const kind = normExt(file.ext);
    if (state.method === "size" && kind !== "png" && kind !== "svg") return base + "." + targetLabel(state.size.target);
    if (kind === "png") return base + ".l" + state.levels.png;
    if (kind === "gif") {
      const y = state.levels.gifLossy ? "-y" + state.levels.gifLossy : "";
      return base + ".g" + state.levels.gif + y;
    }
    if (kind === "svg") return base + ".min";
    return base + ".q" + qualityFor(file);
  }
  function resultExt(file) {
    if (state.mode === "convert") return state.convert.format;
    if (state.mode === "crop") {
      if (state.crop.png) return "png";
      const k = normExt(file.ext);
      if (k === "heic" || k === "jxl" || k === "svg") return "png";
      return k;
    }
    const k = normExt(file.ext);
    if (k === "heic" || k === "jxl") return "jpg";
    return k;
  }
  function settle(file) {
    const kind = normExt(file.ext);
    if (file.heicFail || kind === "heic") {
      return { status: "failed", error: "HEIC 解码受限", progress: null, note: "" };
    }
    if (kind === "jxl" && state.mode === "compress") {
      return { status: "failed", error: "暂不能压回原格式，请改用转换", progress: null, note: "" };
    }
    if (kind === "svg" && state.mode === "crop" && !file.rasterized) {
      return { status: "failed", error: "需先栅格化", progress: null, note: "" };
    }
    if (state.mode === "compress" && state.method === "size") {
      const kb = state.size.target;
      if (!Number.isInteger(kb) || kb < 1 || kb > 20480) {
        return { status: "failed", error: "目标体积无效", progress: null, note: "" };
      }
    }
    const plan = previewPlan(file);
    const bytes = Math.max(1, Math.round(plan.bytes || file.bytes * 0.4));
    let note = "";
    if (plan.plan) {
      if (plan.plan.over) note = "仍大于目标";
      if (plan.plan.scaled) note = (note ? note + " · " : "") + "长边缩至 " + plan.plan.w;
    }
    const name = uniqueName(resultStem(file), resultExt(file));
    return { status: "done", error: "", progress: null, note, resultName: name, resultBytes: bytes };
  }

  function syncCanvases() {
    const file = active();
    if (!file || !file.preview) return;
    if (state.mode === "crop") {
      blit($("cv-crop"), renderRotated(file.preview));
      return;
    }
    blit($("cv-before"), file.preview);
    let q = 85;
    let matte = null;
    if (state.mode === "compress") {
      const kind = normExt(file.ext);
      if (state.method === "size") {
        const p = planSize(file);
        q = p.q || state.size.minQ;
      } else if (kind === "jpg" || kind === "webp" || kind === "avif") q = qualityFor(file);
      else q = 90;
    } else {
      q = state.convert.format === "png" ? 95 : state.convert.quality;
      if (file.hasAlpha && state.convert.format === "jpg") {
        matte = state.convert.matte === "white" ? "#ffffff" : "#080a0c";
      }
    }
    blit($("cv-after"), paintAfter(file.preview, q, matte));
  }

  function applyWipe() {
    const w = state.holdOriginal ? 1 : state.wipe;
    const before = $("cv-before");
    before.style.clipPath = "inset(0 " + ((1 - w) * 100) + "% 0 0)";
    $("wipe").style.left = w * 100 + "%";
    $("sheen").style.left = w * 100 + "%";
    $("wipe").setAttribute("aria-valuenow", String(Math.round(w * 100)));
    $("tag-before").style.opacity = w < 0.08 ? "0" : "1";
    $("tag-after").style.opacity = w > 0.92 ? "0" : "1";
  }
  function applyCropBox() {
    const file = active();
    if (!file) return;
    const c = file.crop;
    const frame = $("frame");
    frame.style.left = c.x * 100 + "%";
    frame.style.top = c.y * 100 + "%";
    frame.style.width = c.w * 100 + "%";
    frame.style.height = c.h * 100 + "%";
    $("shade-t").style.cssText = "left:0;top:0;width:100%;height:" + c.y * 100 + "%";
    $("shade-b").style.cssText = "left:0;top:" + (c.y + c.h) * 100 + "%;width:100%;height:" + (1 - c.y - c.h) * 100 + "%";
    $("shade-l").style.cssText = "left:0;top:" + c.y * 100 + "%;width:" + c.x * 100 + "%;height:" + c.h * 100 + "%";
    $("shade-r").style.cssText = "left:" + (c.x + c.w) * 100 + "%;top:" + c.y * 100 + "%;width:" + (1 - c.x - c.w) * 100 + "%;height:" + c.h * 100 + "%";
    const out = outputFrame(file);
    $("frame-size").textContent = out.w + " × " + out.h;
  }
  function layout() {
    const file = active();
    const viewer = $("viewer");
    const fit = $("fit");
    if (!file || state.phase !== "work") return;
    const nat = rotatedNative(file);
    const vw = viewer.clientWidth;
    const vh = viewer.clientHeight;
    if (!vw || !vh) return;
    let scale;
    if (state.zoom === "fit") scale = Math.min(vw / nat.w, vh / nat.h);
    else scale = (typeof state.zoom === "number" ? state.zoom : parseFloat(state.zoom)) / 100;
    scale = clamp(scale, 0.02, 8);
    state.viewScale = scale;
    const dw = Math.max(1, nat.w * scale);
    const dh = Math.max(1, nat.h * scale);
    fit.style.width = dw + "px";
    fit.style.height = dh + "px";
    if (state.zoom === "fit") {
      fit.style.left = Math.max(0, (vw - dw) / 2) + "px";
      fit.style.top = Math.max(0, (vh - dh) / 2) + "px";
    } else {
      fit.style.left = "0px";
      fit.style.top = "0px";
    }
    applyCropBox();
    applyWipe();
  }
  function placeModeLine() {
    const btn = document.querySelector('.modes button[aria-pressed="true"]');
    const line = document.querySelector(".mode-line");
    if (!btn || !line) return;
    line.style.left = btn.offsetLeft + "px";
    line.style.width = btn.offsetWidth + "px";
  }

  function bannerFor(file) {
    if (!file) return "";
    const bits = [];
    const mem = file.natW * file.natH * 4;
    if (file.natW >= 8000 || file.natH >= 8000 || file.bytes >= 40 * 1048576) bits.push("大图，处理时会占用较多内存");
    if (mem >= 256 * 1048576) bits.push("解码后约占 " + Math.ceil(mem / 1048576) + " MB 内存");
    if (state.mode === "convert") {
      const fmt = state.convert.format;
      if (file.hasAlpha && fmt === "jpg") {
        bits.unshift(state.convert.matte === "white" ? "透明将消失。转为 JPG 时以白色填入。" : "透明将消失。转为 JPG 时以墨色填入。");
      }
      if (file.hasAlpha && fmt === "gif") bits.unshift("半透明将按 50% 取舍。");
      if (file.animated && (fmt === "jpg" || fmt === "png" || (fmt === "avif" && !state.convert.keepAnim) || (fmt === "webp" && !state.convert.keepAnim))) {
        bits.unshift("将只保留首帧");
      }
    }
    return bits.join(" ");
  }
  function statusOf(file) {
    if (!file.included && file.status === "queued") return ["不处理", "skip"];
    if (file.status === "running") return ["处理中", "running"];
    if (file.status === "done") return ["完成", "done"];
    if (file.status === "failed") return ["失败", "failed"];
    return ["排队", "queued"];
  }
  function subline(file) {
    const kind = normExt(file.ext).toUpperCase();
    let s = kind + " · " + file.natW + " × " + file.natH;
    if (file.hasAlpha) s += " · 有透明";
    if (file.animated) s += " · " + file.frames + " 帧 · " + file.duration + " 秒";
    return s;
  }

  function renderQueue() {
    const host = $("queue-list");
    host.innerHTML = files.map((f) => {
      const [label, cls] = statusOf(f);
      const result = f.status === "done"
        ? esc(f.resultName) + " · " + formatBytes(f.resultBytes) + (f.note ? " · " + esc(f.note) : "")
        : f.status === "failed" ? esc(f.error) : "";
      const track = f.status === "running"
        ? '<div class="star-track"><div class="rail"></div><div class="fill" style="width:' + (f.progress || 0) + '%"></div><i></i><i></i><i></i><span class="pct">' + (f.progress || 0) + "%</span></div>"
        : "";
      const retry = f.status === "failed" ? '<button type="button" class="retry" data-retry="' + f.id + '">重试</button>' : "";
      return '<div class="q-item' + (f.id === state.active ? " is-active" : "") + '" data-id="' + f.id + '" tabindex="0">' +
        '<input type="checkbox" ' + (f.included ? "checked" : "") + ' aria-label="参与处理" data-check="' + f.id + '">' +
        '<img class="q-thumb" alt="" src="' + f.thumb + '">' +
        '<div><strong class="q-name">' + esc(f.name) + "</strong>" +
        '<span class="q-meta">' + file.meta(f) + "</span>" +
        '<span class="q-status ' + cls + '">' + label + "</span>" + retry +
        (result ? '<span class="q-result">' + result + "</span>" : "") +
        track + "</div></div>";
    }).join("");
  }
  const file = {
    meta(f) {
      return f.natW + "×" + f.natH + " · " + formatBytes(f.bytes);
    },
  };

  function render() {
    const fileNow = active();
    document.body.dataset.phase = state.phase;
    document.body.dataset.mode = state.mode;
    document.querySelectorAll(".modes button").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.mode === state.mode ? "true" : "false");
    });
    $("panel-compress").hidden = state.mode !== "compress";
    $("panel-convert").hidden = state.mode !== "convert";
    $("panel-crop").hidden = state.mode !== "crop";

    if (fileNow && state.phase === "work") {
      $("file-name").textContent = fileNow.name;
      $("file-sub").textContent = subline(fileNow);
      const plan = previewPlan(fileNow);
      const delta = plan.bytes ? Math.round((1 - plan.bytes / fileNow.bytes) * 100) : null;
      const right = state.mode === "crop" ? "选区" : fileNow.status === "done" ? "成品" : "预览";
      $("readouts").innerHTML =
        "<span>原图</span><strong>" + formatBytes(fileNow.bytes) + "</strong>" +
        "<span>" + right + "</span><strong>" + formatBytes(plan.bytes) + "</strong>" +
        "<span>相差</span><strong class=\"delta\">" + (delta == null ? "—" : (delta >= 0 ? "−" : "+") + Math.abs(delta) + "%") + "</strong>";
      const failed = fileNow.status === "failed" || (!fileNow.preview && fileNow.heicFail && fileNow.status !== "queued");
      const showFail = fileNow.status === "failed" || (fileNow.heicFail && !fileNow.preview && state.mode !== "crop");
      const waiting = fileNow.heicFail && !fileNow.preview && fileNow.status !== "failed";
      $("fit").classList.toggle("is-crop", state.mode === "crop" && !showFail && !waiting);
      $("fit").classList.toggle("is-fail", showFail || waiting);
      $("fit").classList.toggle("show-checker", !!(fileNow.hasAlpha || (state.mode === "crop" && Math.abs(state.rotate.straighten) > 0.05)));
      $("fail-plate").hidden = !(showFail || waiting);
      if (waiting) {
        $("fail-plate").querySelector(".kicker").textContent = "等待";
        $("fail-plate").querySelector("h3").textContent = "尚未解码";
        $("fail-reason").textContent = "HEIC";
        $("fail-detail").textContent = "开始处理后在本地解码。没有上传。";
        $("fail-retry").hidden = true;
      } else if (fileNow.status === "failed") {
        $("fail-plate").querySelector(".kicker").textContent = "未能落下";
        $("fail-plate").querySelector("h3").textContent = "失败";
        $("fail-reason").textContent = fileNow.error;
        $("fail-detail").textContent = fileNow.name + " · " + formatBytes(fileNow.bytes) + "。没有上传。";
        $("fail-retry").hidden = false;
      }
      const banner = bannerFor(fileNow);
      $("banner").hidden = !banner || showFail || waiting;
      $("banner").textContent = banner;
      const runningHere = fileNow.status === "running";
      $("stage-track").hidden = !runningHere;
      if (runningHere) {
        $("stage-fill").style.width = (fileNow.progress || 0) + "%";
        $("stage-pct").textContent = (fileNow.progress || 0) + "%";
      }
      const afterWord = fileNow.status === "done" && state.mode !== "crop" ? "成品" : "预览";
      $("tag-after").textContent = afterWord;
      $("wipe-after").textContent = afterWord;
      $("wipe").style.display = state.mode === "crop" ? "none" : "";
      syncCanvases();
    }

    renderControls(fileNow);
    renderQueue();
    renderSummary();
    void document.body.offsetWidth;
    layout();
    placeModeLine();
    if (drawnMode !== state.mode) {
      drawnMode = state.mode;
      const line = document.querySelector(".mode-line");
      line.classList.remove("draw");
      void line.offsetWidth;
      line.classList.add("draw");
    }
  }

  function renderControls(fileNow) {
    const kind = fileNow ? normExt(fileNow.ext) : "jpg";
    const lossy = kind === "jpg" || kind === "webp" || kind === "avif";
    const blocked = state.mode === "compress" && (kind === "heic" || kind === "jxl");
    const showQuality = state.mode === "compress" && !blocked && lossy && state.method === "quality";
    const showSizeReadout = state.mode === "compress" && !blocked && state.method === "size" && (lossy || kind === "gif");
    $("quality-field").hidden = !(showQuality || showSizeReadout);
    $("png-field").hidden = !(state.mode === "compress" && kind === "png");
    $("gif-field").hidden = !(state.mode === "compress" && kind === "gif");
    $("svg-field").hidden = !(state.mode === "compress" && kind === "svg");
    $("blocked-field").hidden = !blocked;
    $("blocked-help").textContent = "暂不能压回原格式，请改用转换";
    $("method-seg").hidden = blocked;
    $("method-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.method === state.method ? "true" : "false"));
    const sizeOn = state.method === "size" && !blocked;
    $("size-field").hidden = !sizeOn;
    if (showQuality && fileNow) {
      const q = qualityFor(fileNow);
      $("quality").style.display = "";
      $("quality").disabled = false;
      $("quality").value = q;
      $("quality-readout").textContent = q;
      $("engine-label").textContent = ENG[kind] || "";
      $("quality-help").textContent = kind === "avif" ? "AVIF 的 50 约相当于 JPEG 的 85。" : "从 85 起。压缩不改变像素尺寸。";
    } else if (showSizeReadout && fileNow) {
      const p = planSize(fileNow);
      $("quality-field").hidden = false;
      $("quality").style.display = "none";
      $("quality-readout").textContent = p.blocked ? "—" : p.q;
      $("engine-label").textContent = ENG[kind] || "";
      $("quality-help").textContent = p.blocked ? "" : ("预计质量 " + p.q + (p.scaled ? "，长边缩至 " + p.w : "") + (p.over ? "。仍大于目标" : ""));
    }
    $("png-readout").textContent = state.levels.png;
    $("png-level").value = state.levels.png;
    $("gif-level").value = state.levels.gif;
    $("gif-level-readout").textContent = state.levels.gif;
    $("gif-lossy").value = state.levels.gifLossy;
    $("gif-lossy-label").textContent = state.levels.gifLossy;
    $("gif-help").textContent = state.levels.gifLossy === 0 ? "不损伤颜色。" : "有损会减少颜色。";
    $("size-presets").querySelectorAll("button").forEach((b) => {
      const on = String(state.size.preset) === b.dataset.kb;
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("custom-kb").value = state.size.target;
    $("min-quality").value = state.size.minQ;
    $("minq-label").textContent = state.size.minQ;
    $("allow-scale").checked = state.size.allow;
    if (sizeOn && fileNow) {
      const p = planSize(fileNow);
      if (p.blocked === "png") $("size-note").textContent = "无损格式难以压到目标。若要达标，请改用转换，输出 JPG 或 WebP。";
      else if (p.blocked === "svg") $("size-note").textContent = "SVG 只做结构精简，不保证体积。";
      else {
        let t = "预计质量 " + p.q;
        if (p.scaled) t += "，长边缩至 " + p.w;
        if (p.over) t += "。仍大于目标";
        else t += "。";
        $("size-note").textContent = t;
      }
    }
    const kinds = new Set(files.map((f) => normExt(f.ext)));
    $("mix-note").hidden = kinds.size < 2;
    $("mix-note").textContent = "队列里有多种格式。参数按格式分别记住，作用在所有排队项上。";
    $("strip-meta").checked = state.strip;
    $("strip-meta-2").checked = state.strip;
    const meta = state.strip ? "地理位置始终剔除。关闭后保留方向、色彩与版权。" : "地理位置始终剔除。关闭后保留方向、色彩与版权。";
    $("meta-help").textContent = meta;
    $("meta-help-2").textContent = meta;

    $("format-pick").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.fmt === state.convert.format ? "true" : "false"));
    $("convert-engine").textContent = ENG[state.convert.format] || "";
    const fmt = state.convert.format;
    $("convert-quality-field").hidden = fmt === "png";
    $("convert-quality").value = state.convert.quality;
    $("convert-quality-readout").textContent = state.convert.quality;
    $("convert-quality-help").textContent = fmt === "avif" ? "AVIF 的 50 约相当于 JPEG 的 85。" : fmt === "gif" ? "这里的质量是有损程度，0 为不损伤颜色。" : "";
    const showAnim = !!(fileNow && fileNow.animated && (fmt === "webp" || fmt === "avif"));
    $("anim-field").hidden = !showAnim;
    $("keep-anim").checked = state.convert.keepAnim;
    $("anim-help").textContent = fmt === "avif" ? "动图 AVIF 兼容不稳定，默认只取首帧。" : "";
    $("matte-field").hidden = !(fileNow && fileNow.hasAlpha && fmt === "jpg");
    $("matte-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.matte === state.convert.matte ? "true" : "false"));
    $("svg-width-field").hidden = !(fileNow && kind === "svg" && state.mode === "convert");
    $("svg-width").value = state.svgW;

    $("ratios").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.ratio === state.crop.ratio ? "true" : "false"));
    $("socials").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.social === state.crop.social ? "true" : "false"));
    if (fileNow && document.activeElement !== $("out-w") && document.activeElement !== $("out-h")) {
      const frame = outputFrame(fileNow);
      $("out-w").value = frame.w;
      $("out-h").value = frame.h;
      $("pixel-note").textContent = frame.note;
    }
    $("straighten").value = state.rotate.straighten;
    $("straighten-label").textContent = Number(state.rotate.straighten).toFixed(1) + "°";
    $("crop-png").checked = state.crop.png;
    $("crop-out-help").textContent = state.crop.png ? "成品保留选区像素，不二次压缩。" : "沿用原格式。JPG 会再编码，质量 95。";
    $("raster-field").hidden = !(fileNow && kind === "svg" && !fileNow.rasterized);
    const showView = state.mode === "crop" && fileNow && fileNow.status === "done";
    $("view-seg").hidden = !showView;
    $("view-seg").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === state.crop.view ? "true" : "false"));

    const runnable = files.some((f) => f.included && (f.status === "queued" || f.status === "failed"));
    $("run-btn").textContent = state.running ? "停止" : "开始处理";
    $("run-btn").disabled = !state.running && !runnable;
    $("download-one").disabled = !(fileNow && fileNow.status === "done");
    $("download-zip").disabled = !files.some((f) => f.status === "done" && f.included);
    document.querySelectorAll(".zoom button").forEach((b) => {
      const on = String(state.zoom) === b.dataset.zoom || (b.dataset.zoom === "100" && state.zoom === 100) || (b.dataset.zoom === "200" && state.zoom === 200);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("zoom-label").textContent = state.zoom === "fit" ? "适应" : (typeof state.zoom === "number" ? state.zoom : state.zoom) + "%";
    $("hint").textContent = state.mode === "crop" ? "方向键移动选区 · Shift 锁定比例 · 拖暗部可新开一刀" : "H 按住看原图 · 双击刃线回中线 · ← → 移动分界";
  }
  function renderSummary() {
    const done = files.filter((f) => f.status === "done");
    const failed = files.filter((f) => f.status === "failed");
    const queued = files.filter((f) => f.included && f.status === "queued").length;
    $("queue-count").textContent = files.length
      ? files.length + " 张 · 排队 " + queued + " · 完成 " + done.length + (failed.length ? " · 失败 " + failed.length : "")
      : "队列空";
    const box = $("summary");
    if (!done.length && !failed.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const saved = done.reduce((s, f) => s + Math.max(0, f.bytes - (f.resultBytes || 0)), 0);
    $("summary-num").textContent = done.length + " 张完成" + (failed.length ? " · " + failed.length + " 张未成" : "");
    const bits = [];
    if (saved > 0 && state.mode !== "crop") bits.push("省下 " + formatBytes(saved));
    if (failed.length) bits.push("失败项不进入压缩包");
    if (!bits.length) bits.push("原文件不会被改写");
    $("summary-sub").textContent = bits.join(" · ");
  }

  function setMode(mode) {
    state.mode = mode;
    if (mode !== "crop") state.crop.view = "crop";
  }
  function select(id) {
    state.active = id;
    render();
  }
  function setRatio(key, manualReset) {
    state.crop.ratio = key;
    state.crop.social = null;
    if (!manualReset) {
      state.crop.lockFrame = false;
      state.crop.outW = null;
      state.crop.outH = null;
    }
    const r = key === "free" ? null : parseFloat(key);
    files.forEach((f) => { if (!f.manualCrop) f.crop = initCrop(f, r); });
  }
  function setSocial(key) {
    const s = SOCIALS[key];
    if (!s) return;
    state.crop.social = key;
    state.crop.ratio = s.ratio;
    state.crop.lockFrame = true;
    state.crop.outW = s.w;
    state.crop.outH = s.h;
    state.crop.suggestW = s.w;
    state.crop.suggestH = s.h;
    const r = parseFloat(s.ratio);
    files.forEach((f) => { if (!f.manualCrop) f.crop = initCrop(f, r); });
  }
  function setFormat(fmt) {
    state.convert.format = fmt;
    const defaults = { jpg: 85, webp: 80, avif: 50, gif: 0, png: 80 };
    state.convert.quality = defaults[fmt];
    if (fmt === "avif") state.convert.keepAnim = false;
    if (fmt === "webp" || fmt === "gif") state.convert.keepAnim = true;
  }
  function notify(text) {
    const n = $("notice");
    n.hidden = false;
    n.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, 4000);
  }
  function enterIfNeeded() {
    if (files.length) {
      state.phase = "work";
      if (!active()) state.active = files[0].id;
    } else state.phase = "entry";
  }

  async function addBrowserFiles(list) {
    let ignored = 0;
    for (const raw of list) {
      const ext = normExt((raw.name.split(".").pop() || ""));
      if (!ACCEPT.has(ext)) { ignored += 1; continue; }
      const spec = {
        name: raw.name || "粘贴-" + shanghaiParts()("hour") + shanghaiParts()("minute") + shanghaiParts()("second") + "." + ext,
        ext,
        natW: 0,
        natH: 0,
        bytes: raw.size,
        hasAlpha: ext === "png",
        heicFail: ext === "heic" || ext === "heif",
      };
      if (spec.heicFail || ext === "jxl") {
        spec.natW = spec.natW || 0;
        const preview = null;
        const item = makeFile({ ...spec, natW: 1024, natH: 1024 }, preview);
        item.natW = 0;
        item.natH = 0;
        if (ext === "jxl") item.heicFail = false;
        item.ext = ext === "heif" ? "heic" : ext;
        if (ext === "jxl") item.bytes = raw.size;
        files.push(item);
        continue;
      }
      try {
        if (ext === "svg") {
          const text = await raw.text();
          const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
          const img = await loadImg(url);
          const vb = svgSize(text, img);
          spec.natW = vb.w;
          spec.natH = vb.h;
          const s = previewSize(vb.w, vb.h);
          const c = document.createElement("canvas");
          c.width = s.w; c.height = s.h;
          c.getContext("2d").drawImage(img, 0, 0, s.w, s.h);
          URL.revokeObjectURL(url);
          const item = makeFile(spec, c);
          item.rasterized = false;
          item.hasAlpha = true;
          files.push(item);
        } else {
          const bmp = await createImageBitmap(raw);
          spec.natW = bmp.width;
          spec.natH = bmp.height;
          const s = previewSize(bmp.width, bmp.height);
          const c = document.createElement("canvas");
          c.width = s.w; c.height = s.h;
          c.getContext("2d").drawImage(bmp, 0, 0, s.w, s.h);
          bmp.close && bmp.close();
          const item = makeFile(spec, c);
          item.hasAlpha = detectAlpha(c) || spec.hasAlpha;
          files.push(item);
        }
      } catch (err) {
        const item = makeFile({ ...spec, natW: 1, natH: 1 }, null);
        item.status = "failed";
        item.error = "文件已损坏";
        files.push(item);
      }
    }
    if (ignored) notify("已忽略 " + ignored + " 个非图片");
    enterIfNeeded();
    render();
  }
  function loadImg(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
  }
  function svgSize(text, img) {
    const m = text.match(/viewBox\s*=\s*["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/i);
    if (m) return { w: Math.round(parseFloat(m[1]) * 2), h: Math.round(parseFloat(m[2]) * 2) };
    return { w: img.width || 1600, h: img.height || 1600 };
  }
  function detectAlpha(canvas) {
    try {
      const g = canvas.getContext("2d");
      const pts = [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1]];
      return pts.some(([x, y]) => g.getImageData(x, y, 1, 1).data[3] < 250);
    } catch (e) { return false; }
  }
  async function handleDrop(dt) {
    const out = [];
    const items = dt.items ? [...dt.items] : [];
    if (items.length && items[0].webkitGetAsEntry) {
      for (const item of items) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) await walkEntry(entry, out);
        else if (item.getAsFile && item.getAsFile()) out.push(item.getAsFile());
      }
    } else {
      [...dt.files].forEach((f) => out.push(f));
    }
    if (out.length) addBrowserFiles(out);
  }
  function walkEntry(entry, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { out.push(f); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const read = () => {
          reader.readEntries(async (batch) => {
            if (!batch.length) {
              for (const e of all) await walkEntry(e, out);
              resolve();
              return;
            }
            all.push(...batch);
            read();
          }, () => resolve());
        };
        read();
      } else resolve();
    });
  }

  let loopToken = 0;
  async function startRun(onlyId) {
    if (state.running) {
      loopToken += 1;
      state.running = false;
      render();
      return;
    }
    const my = ++loopToken;
    state.running = true;
    render();
    const list = files.filter((f) => {
      if (!f.included) return false;
      if (onlyId) return f.id === onlyId;
      return f.status === "queued" || f.status === "failed";
    });
    for (const f of list) {
      if (my !== loopToken) break;
      f.status = "running";
      f.error = "";
      f.progress = 0;
      if (f.id === state.active) render();
      else renderQueue();
      let cancelled = false;
      for (let i = 1; i <= 20; i++) {
        if (my !== loopToken) { cancelled = true; break; }
        await wait(45);
        f.progress = i * 5;
        const row = document.querySelector('.q-item[data-id="' + f.id + '"] .fill');
        const pct = document.querySelector('.q-item[data-id="' + f.id + '"] .pct');
        if (row) row.style.width = f.progress + "%";
        if (pct) pct.textContent = f.progress + "%";
        if (active() && active().id === f.id) {
          $("stage-fill").style.width = f.progress + "%";
          $("stage-pct").textContent = f.progress + "%";
        }
      }
      if (cancelled || my !== loopToken) {
        f.status = "failed";
        f.error = "已取消";
        f.progress = null;
        break;
      }
      const next = settle(f);
      Object.assign(f, next);
      render();
    }
    state.running = false;
    render();
  }

  function localPoint(e) {
    const rect = $("fit").getBoundingClientRect();
    const fileNow = active();
    const nat = rotatedNative(fileNow);
    return {
      x: ((e.clientX - rect.left) / rect.width) * nat.w,
      y: ((e.clientY - rect.top) / rect.height) * nat.h,
      nat,
    };
  }
  function clampRect(r, nat) {
    let { x, y, w, h } = r;
    w = Math.max(32, w);
    h = Math.max(32, h);
    if (w > nat.w) w = nat.w;
    if (h > nat.h) h = nat.h;
    x = clamp(x, 0, nat.w - w);
    y = clamp(y, 0, nat.h - h);
    return { x, y, w, h };
  }
  function dragCrop(handle, orig, dpx, dpy, nat, lock) {
    let x = orig.x, y = orig.y, w = orig.w, h = orig.h;
    const right = orig.x + orig.w;
    const bottom = orig.y + orig.h;
    if (handle === "move") {
      return clampRect({ x: orig.x + dpx, y: orig.y + dpy, w, h }, nat);
    }
    if (handle === "new") {
      let x2 = clamp(orig.x + dpx, 0, nat.w);
      let y2 = clamp(orig.y + dpy, 0, nat.h);
      x = Math.min(orig.x, x2);
      y = Math.min(orig.y, y2);
      w = Math.max(1, Math.abs(x2 - orig.x));
      h = Math.max(1, Math.abs(y2 - orig.y));
      if (lock) {
        h = w / lock;
        if (y2 < orig.y) y = orig.y - h;
        if (x2 < orig.x) x = orig.x - w;
      }
      return clampRect({ x, y, w, h }, nat);
    }
    if (handle.includes("e")) w += dpx;
    if (handle.includes("s")) h += dpy;
    if (handle.includes("w")) { x += dpx; w -= dpx; }
    if (handle.includes("n")) { y += dpy; h -= dpy; }
    if (lock && handle.length === 2) {
      const anchor = { se: [orig.x, orig.y], sw: [right, orig.y], ne: [orig.x, bottom], nw: [right, bottom] }[handle];
      w = Math.max(32, Math.abs((handle.includes("e") ? orig.w + dpx : orig.w - dpx)));
      h = w / lock;
      x = handle.includes("w") ? anchor[0] - w : anchor[0];
      y = handle.includes("n") ? anchor[1] - h : anchor[1];
    } else if (lock && handle.length === 1) {
      if (handle === "e" || handle === "w") {
        h = w / lock;
        y = orig.y + (orig.h - h) / 2;
      } else {
        w = h * lock;
        x = orig.x + (orig.w - w) / 2;
      }
    }
    return clampRect({ x, y, w, h }, nat);
  }
  function beginCropDrag(e, handle) {
    const fileNow = active();
    if (!fileNow || state.mode !== "crop") return;
    e.preventDefault();
    e.stopPropagation();
    const nat = rotatedNative(fileNow);
    const start = localPoint(e);
    const orig = handle === "new"
      ? { x: start.x, y: start.y, w: 1, h: 1 }
      : {
        x: fileNow.crop.x * nat.w,
        y: fileNow.crop.y * nat.h,
        w: fileNow.crop.w * nat.w,
        h: fileNow.crop.h * nat.h,
      };
    let lock = ratioNumber();
    if (!lock && e.shiftKey) lock = orig.w / orig.h;
    const move = (ev) => {
      const p = localPoint(ev);
      const useLock = lock || (ev.shiftKey && !ratioNumber() ? orig.w / orig.h : null);
      const rect = dragCrop(handle, orig, p.x - start.x, p.y - start.y, nat, useLock);
      fileNow.crop = { x: rect.x / nat.w, y: rect.y / nat.h, w: rect.w / nat.w, h: rect.h / nat.h };
      applyCropBox();
      if (!state.crop.lockFrame) {
        const frame = outputFrame(fileNow);
        $("out-w").value = frame.w;
        $("out-h").value = frame.h;
        $("pixel-note").textContent = frame.note;
      }
    };
    const up = () => {
      fileNow.manualCrop = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function flashSheen() {
    const el = $("sheen");
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }
  function exportCanvas(fileNow) {
    const src = fileNow.preview;
    if (!src) return null;
    if (state.mode !== "crop") return state.mode === "convert" && fileNow.hasAlpha && state.convert.format === "jpg"
      ? paintAfter(src, state.convert.quality, state.convert.matte === "white" ? "#ffffff" : "#080a0c")
      : src;
    const rot = renderRotated(src);
    const nat = rotatedNative(fileNow);
    const sx = fileNow.crop.x * rot.width;
    const sy = fileNow.crop.y * rot.height;
    const sw = Math.max(1, fileNow.crop.w * rot.width);
    const sh = Math.max(1, fileNow.crop.h * rot.height);
    const frame = outputFrame(fileNow);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * (frame.w / Math.max(1, fileNow.crop.w * nat.w))));
    c.height = Math.max(1, Math.round(sh * (frame.h / Math.max(1, fileNow.crop.h * nat.h))));
    const g = c.getContext("2d");
    if (!state.crop.png && normExt(fileNow.ext) === "jpg") {
      g.fillStyle = "#080a0c";
      g.fillRect(0, 0, c.width, c.height);
    }
    g.drawImage(rot, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  }
  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ -1) >>> 0;
  }
  function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    entries.forEach((f) => {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x800, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, f.data.length, true);
      local.setUint32(22, f.data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, f.data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x800, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, f.data.length, true);
      cen.setUint32(24, f.data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + f.data.length;
    });
    const centralSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }
  function canvasBytes(canvas, ext) {
    return new Promise((resolve) => {
      const type = ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      const q = ext === "jpg" ? 0.85 : 0.8;
      canvas.toBlob(async (blob) => {
        if (!blob) { resolve(new Uint8Array()); return; }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      }, type, q);
    });
  }

  function bind() {
    document.querySelectorAll(".modes button").forEach((btn) => {
      btn.addEventListener("click", () => { setMode(btn.dataset.mode); render(); });
    });
    $("pick-files").addEventListener("click", () => $("file-input").click());
    $("pick-dir").addEventListener("click", () => $("dir-input").click());
    $("file-input").addEventListener("change", (e) => { addBrowserFiles([...e.target.files]); e.target.value = ""; });
    $("dir-input").addEventListener("change", (e) => { addBrowserFiles([...e.target.files]); e.target.value = ""; });
    $("load-samples").addEventListener("click", () => { loadSamples(); render(); });
    $("quality").addEventListener("input", () => {
      const fileNow = active();
      if (!fileNow) return;
      const k = lossyKind(fileNow);
      state.quality[k] = Number($("quality").value);
      $("quality-readout").textContent = state.quality[k];
      syncCanvases();
      const plan = previewPlan(fileNow);
      const delta = plan.bytes ? Math.round((1 - plan.bytes / fileNow.bytes) * 100) : 0;
      $("readouts").querySelectorAll("strong")[1].textContent = formatBytes(plan.bytes);
      $("readouts").querySelectorAll("strong")[2].textContent = (delta >= 0 ? "−" : "+") + Math.abs(delta) + "%";
    });
    $("png-level").addEventListener("input", () => { state.levels.png = Number($("png-level").value); $("png-readout").textContent = state.levels.png; renderControls(active()); });
    $("gif-level").addEventListener("input", () => { state.levels.gif = Number($("gif-level").value); renderControls(active()); });
    $("gif-lossy").addEventListener("input", () => { state.levels.gifLossy = Number($("gif-lossy").value); renderControls(active()); });
    $("method-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.method = btn.dataset.method;
      render();
    });
    $("size-presets").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.size.preset = btn.dataset.kb;
      if (btn.dataset.kb !== "custom") state.size.target = Number(btn.dataset.kb);
      render();
    });
    $("custom-kb").addEventListener("input", () => {
      state.size.preset = "custom";
      state.size.target = Number($("custom-kb").value);
      renderControls(active());
    });
    $("min-quality").addEventListener("input", () => {
      state.size.minQ = Number($("min-quality").value);
      $("minq-label").textContent = state.size.minQ;
      renderControls(active());
    });
    $("allow-scale").addEventListener("change", () => { state.size.allow = $("allow-scale").checked; render(); });
    $("strip-meta").addEventListener("change", () => { state.strip = $("strip-meta").checked; renderControls(active()); });
    $("strip-meta-2").addEventListener("change", () => { state.strip = $("strip-meta-2").checked; renderControls(active()); });
    $("goto-convert").addEventListener("click", () => { setMode("convert"); setFormat("jpg"); render(); });
    $("format-pick").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      setFormat(btn.dataset.fmt);
      render();
    });
    $("convert-quality").addEventListener("input", () => {
      state.convert.quality = Number($("convert-quality").value);
      $("convert-quality-readout").textContent = state.convert.quality;
      syncCanvases();
    });
    $("keep-anim").addEventListener("change", () => { state.convert.keepAnim = $("keep-anim").checked; renderControls(active()); });
    $("matte-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.convert.matte = btn.dataset.matte;
      render();
    });
    $("svg-width").addEventListener("change", () => { state.svgW = clamp(Number($("svg-width").value) || 1600, 1, 4096); });
    $("ratios").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      setRatio(btn.dataset.ratio);
      render();
    });
    $("socials").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      setSocial(btn.dataset.social);
      render();
    });
    function commitFrame() {
      const fileNow = active();
      if (!fileNow) return;
      let w = Number($("out-w").value);
      let h = Number($("out-h").value);
      const r = ratioNumber();
      if (r && document.activeElement === $("out-w")) h = Math.max(1, Math.round(w / r));
      if (r && document.activeElement === $("out-h")) w = Math.max(1, Math.round(h * r));
      state.crop.lockFrame = true;
      state.crop.social = null;
      state.crop.outW = w;
      state.crop.outH = h;
      renderControls(fileNow);
      applyCropBox();
    }
    $("out-w").addEventListener("change", commitFrame);
    $("out-h").addEventListener("change", commitFrame);
    $("rot-l").addEventListener("click", () => turn(-1));
    $("rot-r").addEventListener("click", () => turn(1));
    $("straighten").addEventListener("input", () => {
      state.rotate.straighten = Number($("straighten").value);
      $("straighten-label").textContent = state.rotate.straighten.toFixed(1) + "°";
      syncCanvases();
      layout();
    });
    $("crop-png").addEventListener("change", () => { state.crop.png = $("crop-png").checked; renderControls(active()); });
    $("reset-crop").addEventListener("click", () => {
      const fileNow = active();
      if (!fileNow) return;
      fileNow.manualCrop = false;
      fileNow.crop = initCrop(fileNow, ratioNumber());
      render();
    });
    $("do-raster").addEventListener("click", () => {
      const fileNow = active();
      if (!fileNow) return;
      fileNow.rasterized = true;
      render();
    });
    $("view-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.crop.view = btn.dataset.view;
      renderControls(active());
    });
    $("run-btn").addEventListener("click", () => startRun());
    $("fail-retry").addEventListener("click", () => {
      const fileNow = active();
      if (fileNow) startRun(fileNow.id);
    });
    $("download-one").addEventListener("click", async () => {
      const fileNow = active();
      if (!fileNow || fileNow.status !== "done") return;
      const canvas = exportCanvas(fileNow);
      if (!canvas) return;
      const ext = (fileNow.resultName.split(".").pop() || "png");
      const type = ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
      canvas.toBlob((blob) => blob && downloadBlob(blob, fileNow.resultName), type, 0.92);
    });
    $("download-zip").addEventListener("click", async () => {
      const done = files.filter((f) => f.status === "done" && f.included && f.preview);
      const entries = [];
      for (const f of done) {
        const canvas = exportCanvas(f);
        if (!canvas) continue;
        const ext = f.resultName.split(".").pop();
        entries.push({ name: f.resultName, data: await canvasBytes(canvas, ext) });
      }
      if (!entries.length) return;
      const g = shanghaiParts();
      const modeName = { compress: "压缩", convert: "转换", crop: "裁剪" }[state.mode];
      downloadBlob(zipStore(entries), "纯钧-" + modeName + "-" + g("year") + g("month") + g("day") + "-" + g("hour") + g("minute") + ".zip");
    });
    $("remove-one").addEventListener("click", () => {
      const id = state.active;
      files = files.filter((f) => f.id !== id);
      state.active = files[0] ? files[0].id : null;
      enterIfNeeded();
      render();
    });
    $("clear-done").addEventListener("click", () => {
      files = files.filter((f) => f.status !== "done");
      if (!active() && files[0]) state.active = files[0].id;
      enterIfNeeded();
      render();
    });
    $("clear-all").addEventListener("click", () => {
      const hasDone = files.some((f) => f.status === "done");
      if (hasDone && !armClear) {
        armClear = true;
        $("clear-all").textContent = "确认清空";
        return;
      }
      if (state.running) loopToken += 1;
      state.running = false;
      files = [];
      state.active = null;
      armClear = false;
      $("clear-all").textContent = "清空";
      state.phase = "entry";
      render();
    });
    $("queue-list").addEventListener("click", (e) => {
      const retry = e.target.closest("[data-retry]");
      if (retry) { startRun(retry.dataset.retry); return; }
      const check = e.target.closest("[data-check]");
      if (check) return;
      const row = e.target.closest(".q-item");
      if (row) select(row.dataset.id);
    });
    $("queue-list").addEventListener("change", (e) => {
      const check = e.target.closest("[data-check]");
      if (!check) return;
      const f = files.find((x) => x.id === check.dataset.check);
      if (f) f.included = check.checked;
      render();
    });
    $("zoom").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.zoom = btn.dataset.zoom === "fit" ? "fit" : Number(btn.dataset.zoom);
      renderControls(active());
      layout();
    });
    $("viewer").addEventListener("wheel", (e) => {
      if (state.phase !== "work") return;
      e.preventDefault();
      const cur = state.viewScale;
      const next = clamp(cur * (e.deltaY > 0 ? 0.9 : 1.1), 0.25, 4);
      state.zoom = Math.round(next * 100);
      layout();
      $("zoom-label").textContent = state.zoom + "%";
      document.querySelectorAll(".zoom button").forEach((b) => b.setAttribute("aria-pressed", "false"));
    }, { passive: false });
    $("viewer").addEventListener("dblclick", (e) => {
      if (e.target.closest(".wipe, .handle, .frame, button, .shade")) return;
      state.zoom = state.zoom === "fit" ? 100 : "fit";
      renderControls(active());
      layout();
    });
    $("wipe").addEventListener("pointerdown", (e) => {
      if (state.mode === "crop") return;
      e.preventDefault();
      const move = (ev) => {
        const rect = $("fit").getBoundingClientRect();
        state.wipe = clamp((ev.clientX - rect.left) / rect.width, 0.02, 0.98);
        state.holdOriginal = false;
        applyWipe();
      };
      const up = () => {
        flashSheen();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    $("wipe").addEventListener("dblclick", (e) => {
      e.stopPropagation();
      state.wipe = 0.5;
      applyWipe();
      flashSheen();
    });
    $("frame").addEventListener("pointerdown", (e) => {
      if (e.target.closest(".handle")) return;
      beginCropDrag(e, "move");
    });
    document.querySelectorAll(".handle").forEach((h) => {
      h.addEventListener("pointerdown", (e) => beginCropDrag(e, h.dataset.h));
    });
    ["shade-t", "shade-b", "shade-l", "shade-r"].forEach((id) => {
      $(id).addEventListener("pointerdown", (e) => beginCropDrag(e, "new"));
    });
    let dragDepth = 0;
    let lastRipple = 0;
    function spawn(x, y, host, frozen) {
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const el = document.createElement("i");
      el.className = "ripple" + (frozen ? " frozen" : "");
      el.style.left = (x - rect.left) + "px";
      el.style.top = (y - rect.top) + "px";
      host.appendChild(el);
      if (!frozen) setTimeout(() => el.remove(), 1500);
    }
    window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth += 1; document.body.dataset.drag = "1"; });
    window.addEventListener("dragover", (e) => {
      e.preventDefault();
      document.body.dataset.drag = "1";
      const now = performance.now();
      if (now - lastRipple > 80) {
        lastRipple = now;
        const host = state.phase === "entry" ? $("ripples") : $("veil-ripples");
        spawn(e.clientX, e.clientY, host, false);
      }
    });
    window.addEventListener("dragleave", () => {
      dragDepth -= 1;
      if (dragDepth <= 0) { dragDepth = 0; document.body.dataset.drag = "0"; }
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      document.body.dataset.drag = "0";
      if (e.dataTransfer) handleDrop(e.dataTransfer);
    });
    document.addEventListener("paste", (e) => {
      if (typing(e)) return;
      const found = [];
      [...e.clipboardData.items].forEach((it) => {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (!f) return;
          const ext = (it.type.split("/")[1] || "png").replace("jpeg", "jpg");
          const g = shanghaiParts();
          const name = f.name && f.name !== "image.png" ? f.name : "粘贴-" + g("hour") + g("minute") + g("second") + "." + ext;
          found.push(new File([f], name, { type: f.type }));
        }
      });
      if (found.length) { e.preventDefault(); addBrowserFiles(found); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        if (typing(e)) return;
        $("keys").hidden = !$("keys").hidden;
        e.preventDefault();
        return;
      }
      if (!$("keys").hidden && e.key === "Escape") { $("keys").hidden = true; return; }
      if (typing(e)) return;
      if (e.key === "1") setMode("compress");
      else if (e.key === "2") setMode("convert");
      else if (e.key === "3") setMode("crop");
      else if ((e.key === "o" || e.key === "O") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (e.shiftKey) $("dir-input").click();
        else $("file-input").click();
        return;
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startRun(); return; }
      else if (e.key === "Escape") {
        if (state.running) { loopToken += 1; state.running = false; }
        return;
      } else if ((e.key === "Delete" || e.key === "Backspace") && active()) {
        $("remove-one").click();
        return;
      } else if (e.key === "h" || e.key === "H") {
        state.holdOriginal = true;
        applyWipe();
        return;
      } else if (e.key === "+" || e.key === "=") {
        state.zoom = Math.round(clamp(state.viewScale * 1.1, 0.25, 4) * 100);
        layout(); renderControls(active()); return;
      } else if (e.key === "-" || e.key === "_") {
        state.zoom = Math.round(clamp(state.viewScale * 0.9, 0.25, 4) * 100);
        layout(); renderControls(active()); return;
      } else if (e.key === "0") { state.zoom = "fit"; layout(); renderControls(active()); return; }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        const fileNow = active();
        if (!fileNow) return;
        e.preventDefault();
        if (state.mode === "crop") {
          const nat = rotatedNative(fileNow);
          const step = e.shiftKey ? 10 : 1;
          let x = fileNow.crop.x * nat.w;
          let y = fileNow.crop.y * nat.h;
          const w = fileNow.crop.w * nat.w;
          const h = fileNow.crop.h * nat.h;
          if (e.key === "ArrowLeft") x -= step;
          if (e.key === "ArrowRight") x += step;
          if (e.key === "ArrowUp") y -= step;
          if (e.key === "ArrowDown") y += step;
          const rect = clampRect({ x, y, w, h }, nat);
          fileNow.crop = { x: rect.x / nat.w, y: rect.y / nat.h, w: rect.w / nat.w, h: rect.h / nat.h };
          fileNow.manualCrop = true;
          applyCropBox();
        } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const step = (e.shiftKey ? 0.1 : 0.02) * (e.key === "ArrowLeft" ? -1 : 1);
          state.wipe = clamp(state.wipe + step, 0.02, 0.98);
          applyWipe();
        }
        return;
      } else return;
      render();
    });
    document.addEventListener("keyup", (e) => {
      if (e.key === "h" || e.key === "H") {
        state.holdOriginal = false;
        applyWipe();
      }
    });
    $("keys").addEventListener("click", (e) => { if (e.target === $("keys")) $("keys").hidden = true; });
    window.addEventListener("resize", () => { layout(); placeModeLine(); });
  }
  function turn(dir) {
    state.rotate.quarter = (state.rotate.quarter + dir + 4) % 4;
    const r = ratioNumber();
    files.forEach((f) => { if (!f.manualCrop) f.crop = initCrop(f, r); });
    render();
  }

  function selectName(name) {
    const f = files.find((x) => x.name === name);
    if (f) state.active = f.id;
  }
  function frozenRipples() {
    const host = $("ripples");
    host.innerHTML = "";
    const pond = $("pond").getBoundingClientRect();
    [[0.42, 0.58], [0.6, 0.5]].forEach(([x, y], i) => {
      const el = document.createElement("i");
      el.className = "ripple frozen" + (i ? " late" : "");
      el.style.left = (pond.width * x) + "px";
      el.style.top = (pond.height * y) + "px";
      host.appendChild(el);
    });
  }
  function applyHash() {
    const h = (location.hash || "#entry").replace("#", "");
    if (h === "drag") {
      document.body.dataset.drag = "1";
      requestAnimationFrame(frozenRipples);
      return;
    }
    if (!h || h === "entry") return;
    loadSamples();
    if (h === "compress") {
      setMode("compress");
      state.wipe = 0.62;
      selectName("塘莲.jpg");
    } else if (h === "convert") {
      setMode("convert");
      selectName("霜刃.png");
      setFormat("jpg");
    } else if (h === "crop") {
      setMode("crop");
      selectName("霜刃.png");
      setSocial("ig-post");
    } else if (h === "size") {
      setMode("compress");
      state.method = "size";
      state.size.target = 200;
      state.size.preset = "200";
      selectName("塘莲.jpg");
    } else if (h === "queue") {
      setMode("compress");
      const by = Object.fromEntries(files.map((f) => [f.name, f]));
      Object.assign(by["塘莲.jpg"], settle(by["塘莲.jpg"]));
      by["霜刃.png"].status = "running";
      by["霜刃.png"].progress = 46;
      state.running = true;
      by["旧照.heic"].status = "failed";
      by["旧照.heic"].error = "HEIC 解码受限";
      selectName("霜刃.png");
    } else if (h === "done" || h === "fail") {
      setMode("compress");
      files.forEach((f) => {
        if (f.name === "旧照.heic") {
          f.status = "failed";
          f.error = "HEIC 解码受限";
        } else Object.assign(f, settle(f));
      });
      selectName(h === "fail" ? "旧照.heic" : "塘莲.jpg");
      state.wipe = 0.58;
    }
  }

  bind();
  applyHash();
  render();

  window.__cj = {
    get wipe() { return state.wipe; },
    get mode() { return state.mode; },
    get phase() { return state.phase; },
    get crop() {
      const f = active();
      return f ? { ...f.crop, name: f.name } : null;
    },
    files: () => files.map((f) => ({ name: f.name, status: f.status, error: f.error })),
  };
})();
