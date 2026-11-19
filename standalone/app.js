"use strict";
/* Comparateur de plans PDF — 100 % dans le navigateur (pdf.js + jsPDF). */
const MM = 72 / 25.4, CHUNK = 50;
const OPS = pdfjsLib.OPS;
const $ = s => document.querySelector(s);

/* ------------------------------------------------------------------ extraction */
const compose = (m1, m2) => [m1[0]*m2[0]+m1[2]*m2[1], m1[1]*m2[0]+m1[3]*m2[1], m1[0]*m2[2]+m1[2]*m2[3],
  m1[1]*m2[2]+m1[3]*m2[3], m1[0]*m2[4]+m1[2]*m2[5]+m1[4], m1[1]*m2[4]+m1[3]*m2[5]+m1[5]];

function pushChunked(out, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const n = Math.max(1, Math.ceil(len / CHUNK));
  for (let k = 0; k < n; k++) out.push(x0 + dx*k/n, y0 + dy*k/n, x0 + dx*(k+1)/n, y0 + dy*(k+1)/n);
}

async function extractPage(page) {
  const vp = page.getViewport({ scale: 1 });
  const ol = await page.getOperatorList();
  const out = [], stack = [];
  let ctm = vp.transform.slice(), path = [], cx = 0, cy = 0, sx = 0, sy = 0;
  const P = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
  const addPath = (ops, c) => {
    let ci = 0;
    const seg = (a, b) => path.push([a[0], a[1], b[0], b[1]]);
    for (const op of ops) {
      if (op === OPS.moveTo) { [cx, cy] = [c[ci], c[ci+1]]; ci += 2; sx = cx; sy = cy; }
      else if (op === OPS.lineTo) { const x = c[ci], y = c[ci+1]; ci += 2; seg(P(ctm,cx,cy), P(ctm,x,y)); cx = x; cy = y; }
      else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
        let x1, y1, x2, y2, x3, y3;
        if (op === OPS.curveTo) { [x1,y1,x2,y2,x3,y3] = c.slice(ci, ci+6); ci += 6; }
        else if (op === OPS.curveTo2) { x1 = cx; y1 = cy; [x2,y2,x3,y3] = c.slice(ci, ci+4); ci += 4; }
        else { [x1,y1,x3,y3] = c.slice(ci, ci+4); x2 = x3; y2 = y3; ci += 4; }
        let prev = P(ctm, cx, cy);
        for (let i = 1; i <= 8; i++) {
          const t = i/8, u = 1-t;
          const x = u*u*u*cx + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3, y = u*u*u*cy + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3;
          const q = P(ctm, x, y); seg(prev, q); prev = q;
        }
        cx = x3; cy = y3;
      } else if (op === OPS.rectangle) {
        const x = c[ci], y = c[ci+1], w = c[ci+2], h = c[ci+3]; ci += 4;
        const a = P(ctm,x,y), b = P(ctm,x+w,y), d = P(ctm,x+w,y+h), e = P(ctm,x,y+h);
        seg(a,b); seg(b,d); seg(d,e); seg(e,a); cx = x; cy = y; sx = x; sy = y;
      } else if (op === OPS.closePath) { if (cx !== sx || cy !== sy) { seg(P(ctm,cx,cy), P(ctm,sx,sy)); cx = sx; cy = sy; } }
    }
  };
  const paint = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.transform) ctm = compose(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a && a[0]) ctm = compose(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.constructPath) addPath(a[0], a[1]);
    else if (fn === OPS.endPath) { path = []; cx = cy = sx = sy = 0; }
    else if (paint.has(fn)) { for (const s of path) pushChunked(out, s[0], s[1], s[2], s[3]); path = []; cx = cy = sx = sy = 0; }
  }
  // textes -> lignes
  const tc = await page.getTextContent();
  const raw = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = it.transform, m = vp.transform;
    const o = P(m, t[4], t[5]);
    const lu = Math.hypot(t[0], t[1]) || 1, lv = Math.hypot(t[2], t[3]) || 1;
    const u = [(m[0]*t[0] + m[2]*t[1]) / lu, (m[1]*t[0] + m[3]*t[1]) / lu];
    const v = [(m[0]*t[2] + m[2]*t[3]) / lv, (m[1]*t[2] + m[3]*t[3]) / lv];
    const w = it.width, h = it.height || lv;
    const xs = [o[0], o[0]+u[0]*w, o[0]+v[0]*h, o[0]+u[0]*w+v[0]*h], ys = [o[1], o[1]+u[1]*w, o[1]+v[1]*h, o[1]+u[1]*w+v[1]*h];
    raw.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), s: it.str, h });
  }
  const lines = [];
  for (const r of raw) {
    const l = lines[lines.length - 1];
    if (l && Math.abs(l.y0 - r.y0) < 1 && Math.abs(l.y1 - r.y1) < 1 && r.x0 - l.x1 > -1 && r.x0 - l.x1 < r.h) {
      l.s += (r.x0 - l.x1 > r.h * 0.15 ? " " : "") + r.s; l.x1 = Math.max(l.x1, r.x1);
    } else lines.push({ ...r });
  }
  return { w: vp.width, h: vp.height, segs: Float64Array.from(out), words: lines.map(l => [l.x0, l.y0, l.x1, l.y1, l.s.trim()]) };
}

/* ------------------------------------------------------------------ comparaison */
function sample(segs, step) {
  const n = segs.length / 4; let tot = 0; const cnt = new Int32Array(n);
  for (let i = 0; i < n; i++) { const l = Math.hypot(segs[4*i+2]-segs[4*i], segs[4*i+3]-segs[4*i+1]); cnt[i] = Math.max(1, Math.ceil(l/step)); tot += cnt[i]; }
  const pts = new Float64Array(tot * 2), seg = new Int32Array(tot); let k = 0;
  for (let i = 0; i < n; i++) {
    const x0 = segs[4*i], y0 = segs[4*i+1], dx = segs[4*i+2]-x0, dy = segs[4*i+3]-y0, c = cnt[i];
    for (let j = 0; j < c; j++) { const t = (j+.5)/c; pts[2*k] = x0+dx*t; pts[2*k+1] = y0+dy*t; seg[k++] = i; }
  }
  return { pts, seg, cnt, n: tot, nseg: n };
}
function buildGrid(pts, cell, ox, oy) {
  const n = pts.length / 2; let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) { const x = pts[2*i]+ox, y = pts[2*i+1]+oy; if (x<minx) minx=x; if (x>maxx) maxx=x; if (y<miny) miny=y; if (y>maxy) maxy=y; }
  if (!n) { minx = miny = 0; maxx = maxy = 1; }
  const nx = Math.floor((maxx-minx)/cell)+1, ny = Math.floor((maxy-miny)/cell)+1;
  const start = new Int32Array(nx*ny+1), key = new Int32Array(n);
  for (let i = 0; i < n; i++) { const c = Math.floor((pts[2*i+1]+oy-miny)/cell)*nx + Math.floor((pts[2*i]+ox-minx)/cell); key[i] = c; start[c+1]++; }
  for (let i = 0; i < nx*ny; i++) start[i+1] += start[i];
  const fill = start.slice(0, nx*ny), idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[fill[key[i]]++] = i;
  return { pts, cell, ox, oy, minx, miny, nx, ny, start, idx };
}
function near(g, x, y, r) {
  const cx = Math.floor((x-g.minx)/g.cell), cy = Math.floor((y-g.miny)/g.cell), r2 = r*r;
  for (let j = cy-1; j <= cy+1; j++) { if (j < 0 || j >= g.ny) continue;
    for (let i = cx-1; i <= cx+1; i++) { if (i < 0 || i >= g.nx) continue;
      const c = j*g.nx+i;
      for (let k = g.start[c]; k < g.start[c+1]; k++) { const p = g.idx[k], dx = g.pts[2*p]+g.ox-x, dy = g.pts[2*p+1]+g.oy-y; if (dx*dx+dy*dy <= r2) return true; } } }
  return false;
}
function unmatched(S, sx, sy, grid, thr) {
  const bad = new Int32Array(S.nseg);
  for (let i = 0; i < S.n; i++) if (!near(grid, S.pts[2*i]+sx, S.pts[2*i+1]+sy, thr)) bad[S.seg[i]]++;
  const m = new Uint8Array(S.nseg); for (let i = 0; i < S.nseg; i++) m[i] = bad[i]/S.cnt[i] >= 0.5 ? 1 : 0; return m;
}
function pick(segs, mask) { const o = []; for (let i = 0; i < mask.length; i++) if (mask[i]) o.push(segs[4*i], segs[4*i+1], segs[4*i+2], segs[4*i+3]); return Float64Array.from(o); }

function estimateShift(sa, sb, tol, W, H) { // translation A->B : recherche grossière puis fine sur bitmaps d'occupation
  const sub = []; const stepN = Math.max(1, Math.floor(sa.n / 6000)); for (let i = 0; i < sa.n; i += stepN) sub.push(sa.pts[2*i], sa.pts[2*i+1]);
  const bitmap = cell => { const nx = Math.ceil(W/cell)+2, ny = Math.ceil(H/cell)+2, b = new Uint8Array(nx*ny);
    for (let i = 0; i < sb.n; i++) { const x = Math.floor(sb.pts[2*i]/cell), y = Math.floor(sb.pts[2*i+1]/cell); if (x>=0&&y>=0&&x<nx&&y<ny) b[y*nx+x] = 1; } return { b, nx, ny, cell }; };
  const score = (bm, dx, dy) => { let s = 0; for (let i = 0; i < sub.length; i += 2) { const x = Math.floor((sub[i]+dx)/bm.cell), y = Math.floor((sub[i+1]+dy)/bm.cell); if (x>=0&&y>=0&&x<bm.nx&&y<bm.ny) s += bm.b[y*bm.nx+x]; } return s; };
  const search = (bm, cx, cy, R, st) => { let best = [cx, cy], bs = -1, s0 = score(bm, cx, cy);
    for (let dx = cx-R; dx <= cx+R+1e-9; dx += st) for (let dy = cy-R; dy <= cy+R+1e-9; dy += st) { const s = score(bm, dx, dy); if (s > bs) { bs = s; best = [dx, dy]; } }
    return { best, bs, s0 }; };
  const c1 = bitmap(tol), r1 = search(c1, 0, 0, Math.max(60, tol*40), tol);
  let best = r1.best; if (r1.bs < r1.s0 * 1.02) best = [0, 0]; // préférer 0 si pas de gain net
  const c2 = bitmap(tol/4), r2 = search(c2, best[0], best[1], tol, tol/4);
  return r2.best;
}
const dice = (a, b) => { if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0; const g = s => { const m = new Map(); for (let i = 0; i < s.length-1; i++) { const k = s.slice(i, i+2); m.set(k, (m.get(k)||0)+1); } return m; };
  const A = g(a), B = g(b); let inter = 0; for (const [k, v] of A) inter += Math.min(v, B.get(k)||0); return 2*inter/(a.length+b.length-2); };

function compare(A, B, p) {
  const tol = p.tol*MM, step = Math.max(Math.min(tol/2, 3), 0.5), thr = tol + step*0.5;
  const sa = sample(A.segs, step), sb = sample(B.segs, step);
  let shift = [0, 0]; if (p.fixedShift) shift = p.fixedShift.slice(); else if (p.align && sa.n > 100 && sb.n > 100) shift = estimateShift(sa, sb, tol, B.w, B.h);
  const gB = buildGrid(sb.pts, thr, 0, 0), gA = buildGrid(sa.pts, thr, shift[0], shift[1]);
  const removed = pick(A.segs, unmatched(sa, shift[0], shift[1], gB, thr));
  const added = pick(B.segs, unmatched(sb, 0, 0, gA, thr));
  // textes
  const texts = [];
  if (p.text) {
    const tt = Math.max(tol, 3), la = A.words.map(w => ({ b: [w[0]+shift[0], w[1]+shift[1], w[2]+shift[0], w[3]+shift[1]], raw: w.slice(0,4), t: w[4] })),
      lb = B.words.map(w => ({ b: w.slice(0,4), t: w[4] }));
    const byText = new Map(); lb.forEach((w, j) => { if (!byText.has(w.t)) byText.set(w.t, []); byText.get(w.t).push(j); });
    const usedB = new Set(), unA = [];
    la.forEach((w, i) => { const hit = (byText.get(w.t)||[]).find(j => !usedB.has(j) && [0,1,2,3].every(k => Math.abs(lb[j].b[k]-w.b[k]) <= tt)); if (hit === undefined) unA.push(i); else usedB.add(hit); });
    const unB = lb.map((_, j) => j).filter(j => !usedB.has(j));
    const gap = (r, s) => Math.hypot(Math.max(r[0]-s[2], s[0]-r[2], 0), Math.max(r[1]-s[3], s[1]-r[3], 0));
    const iou = (r, s) => { const w = Math.min(r[2],s[2])-Math.max(r[0],s[0]), h = Math.min(r[3],s[3])-Math.max(r[1],s[1]); if (w<=0||h<=0) return 0; const i = w*h; return i/((r[2]-r[0])*(r[3]-r[1])+(s[2]-s[0])*(s[3]-s[1])-i); };
    const cand = []; if (unA.length*unB.length < 4e6) for (const i of unA) for (const j of unB) { const g = gap(la[i].b, lb[j].b); if (g > tt) continue;
      const sim = dice(la[i].t, lb[j].t), ov = iou(la[i].b, lb[j].b); if (sim >= .4 || ov >= .3) cand.push([g+(1-sim)*tt-ov*tt, i, j]); }
    cand.sort((x, y) => x[0]-y[0]);
    const pa = new Set(), pb = new Set();
    for (const [, i, j] of cand) { if (pa.has(i) || pb.has(j)) continue; pa.add(i); pb.add(j); texts.push({ kind: "modified", old: la[i].t, nw: lb[j].t, a: la[i].raw, b: lb[j].b }); }
    for (const i of unA) if (!pa.has(i)) texts.push({ kind: "removed", old: la[i].t, nw: "", a: la[i].raw, b: null });
    for (const j of unB) if (!pb.has(j)) texts.push({ kind: "added", old: "", nw: lb[j].t, a: null, b: lb[j].b });
  }
  // zones (repère de A)
  const items = [];
  for (let i = 0; i < removed.length; i += 4) items.push(["removed", removed[i], removed[i+1], removed[i+2], removed[i+3]]);
  for (let i = 0; i < added.length; i += 4) items.push(["added", added[i]-shift[0], added[i+1]-shift[1], added[i+2]-shift[0], added[i+3]-shift[1]]);
  for (const t of texts) { const b = t.a || [t.b[0]-shift[0], t.b[1]-shift[1], t.b[2]-shift[0], t.b[3]-shift[1]]; items.push(["text_" + t.kind, b[0], b[1], b[2], b[3]]); }
  const R = p.cluster*MM, par = items.map((_, i) => i), find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  const cells = new Map();
  items.forEach((it, i) => { const mx = (it[1]+it[3])/2, my = (it[2]+it[4])/2, cx = Math.floor(mx/R), cy = Math.floor(my/R); it.mx = mx; it.my = my;
    for (let a = cx-1; a <= cx+1; a++) for (let b = cy-1; b <= cy+1; b++) for (const j of cells.get(a+","+b)||[]) if (Math.hypot(items[j].mx-mx, items[j].my-my) <= R) par[find(i)] = find(j);
    const k = cx+","+cy; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(i); });
  const gz = new Map(); items.forEach((it, i) => { const r = find(i); if (!gz.has(r)) gz.set(r, []); gz.get(r).push(it); });
  const zones = [...gz.values()].map(m => ({ bbox: [Math.min(...m.map(i=>Math.min(i[1],i[3]))), Math.min(...m.map(i=>Math.min(i[2],i[4]))), Math.max(...m.map(i=>Math.max(i[1],i[3]))), Math.max(...m.map(i=>Math.max(i[2],i[4])))],
    removed: m.filter(i=>i[0]==="removed").length, added: m.filter(i=>i[0]==="added").length,
    text: m.filter(i=>i[0].startsWith("text_")).length }));
  zones.sort((a, b) => Math.round(a.bbox[0]/200)-Math.round(b.bbox[0]/200) || a.bbox[1]-b.bbox[1]); zones.forEach((z, i) => z.id = i+1);
  return { w: B.w, h: B.h, shift, removed, added, texts, zones, nA: sa.nseg, nB: sb.nseg };
}

/* ------------------------------------------------------------------ état / UI */
let docA, docB, R = null, page = 0, mode = "overlay", tool = "pan", view = { k: 1, x: 0, y: 0 }, sliderX = .5, sel = null, ras = null,
  names = ["A", "B"], blinkB = false, blinkT = null, blinkMs = 600, fast = false, recT = 0, cvs = [], pendingText = null;
const RED = "#ff3b4e", BLUE = "#1e90ff";
const status = t => { clearInterval(blinkT); cvs = []; $("#views").innerHTML = `<div id="msg"><div class="card">${/^Erreur/.test(t) ? "" : '<div class="spin"></div>'}<p style="color:var(--tx);font-size:14px">${t}</p></div></div>`; };
const readDoc = async f => pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
const toast = t => { const e = $("#toast"); e.textContent = t; e.style.opacity = 1; clearTimeout(toast.t); toast.t = setTimeout(() => e.style.opacity = 0, 3000); };
const resScale = P => Math.min(+$("#res").value || 2, 8000 / Math.max(P.w, P.h));

$("#go").onclick = async () => {
  const fa = $("#fa").files[0], fb = $("#fb").files[0];
  if (!fa || !fb) return alert("Sélectionnez les deux PDF.");
  const p = { tol: +$("#tol").value || 2, cluster: +$("#clu").value || 15, align: $("#al").checked, text: $("#ct").checked };
  $("#go").disabled = true; names = [fa.name, fb.name];
  try {
    status("Lecture des PDF…"); docA = await readDoc(fa); docB = await readDoc(fb);
    const n = Math.min(docA.numPages, docB.numPages), pages = [];
    for (let i = 1; i <= n; i++) {
      status(`Analyse de la page ${i}/${n}…`); await new Promise(r => setTimeout(r, 30));
      const A = await extractPage(await docA.getPage(i)), B = await extractPage(await docB.getPage(i));
      const r = compare(A, B, p); r.page = i; r.ex = { A, B }; r.ann = []; r.cur = null; r.identical = !r.removed.length && !r.added.length && !r.texts.length; pages.push(r);
    }
    R = { pages, p, nA: docA.numPages, nB: docB.numPages };
  } catch (e) { console.error(e); status("Erreur : " + e.message); $("#go").disabled = false; return; }
  $("#go").disabled = false;
  $("#pg").innerHTML = R.pages.map((p, i) => `<option value="${i}">Page ${p.page}${p.identical ? " (identique)" : ""}</option>`).join("");
  ["#xpdf", "#xcsv", "#xpng"].forEach(s => $(s).disabled = false);
  page = 0; sel = null; await loadPage(true);
};
$("#pg").onchange = async e => { page = +e.target.value; sel = null; await loadPage(true); };
$("#res").onchange = () => R && loadPage(false);
$("#sens").oninput = () => { if (ras) ras.ovKey = ""; draw(); };
$("#bspeed").oninput = e => { blinkMs = +e.target.value; if (mode === "blink") startBlink(); };
document.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { mode = b.dataset.m; document.querySelectorAll("[data-m]").forEach(x => x.classList.toggle("on", x === b)); if (R) buildView(false); });
document.querySelectorAll("[data-t]").forEach(b => b.onclick = () => setTool(b.dataset.t));
$("#fit").onclick = () => R && fit();
function setTool(t) { tool = t; document.querySelectorAll("[data-t]").forEach(x => x.classList.toggle("on", x.dataset.t === t));
  document.querySelectorAll(".vp").forEach(v => v.style.cursor = t === "pan" ? "grab" : t === "align" ? "move" : "crosshair");
  if (t === "align") toast("Recalage : glissez sur le plan pour déplacer le plan B (ou flèches du clavier)."); }

async function renderRaster(doc, n, scale) {
  const pg = await doc.getPage(n), vp = pg.getViewport({ scale }), c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: x, viewport: vp }).promise; return c;
}
async function loadPage(refit) {
  const P = R.pages[page]; status("Rendu de la page…");
  const sc = resScale(P);
  ras = { sc, a: await renderRaster(docA, P.page, sc), b: await renderRaster(docB, P.page, sc), ov: null, ovKey: "" };
  buildView(refit);
}

/* superposition « pixels » : noir = identique, rouge = A seul, bleu = B seul */
function composite(P, rr) {
  const sens = +$("#sens").value, key = P.shift[0].toFixed(3) + "," + P.shift[1].toFixed(3) + "," + sens + "," + rr.sc;
  if (rr.ov && rr.ovKey === key) return rr.ov;
  const w = rr.a.width, h = rr.a.height, get = (src, dx, dy) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(src, dx, dy); return x.getImageData(0, 0, w, h).data; };
  const dA = get(rr.a, 0, 0), dB = get(rr.b, -P.shift[0]*rr.sc, -P.shift[1]*rr.sc), out = new ImageData(w, h), o = out.data, thr = 255 - sens * .6;
  for (let i = 0; i < dA.length; i += 4) {
    const la = dA[i]*.299 + dA[i+1]*.587 + dA[i+2]*.114, lb = dB[i]*.299 + dB[i+1]*.587 + dB[i+2]*.114, ia = la < thr, ib = lb < thr;
    o[i+3] = 255;
    if (!ia && !ib) { o[i] = o[i+1] = o[i+2] = 255; }
    else if (ia && ib) { const v = Math.min(la, lb); o[i] = o[i+1] = o[i+2] = v; }
    else if (ia) { const t = 1 - la/255; o[i] = 225; o[i+1] = 255*(1 - t*.88); o[i+2] = 255*(1 - t*.85); }
    else { const t = 1 - lb/255; o[i] = 255*(1 - t*.92); o[i+1] = 255*(1 - t*.45); o[i+2] = 235; }
  }
  const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").putImageData(out, 0, 0);
  rr.ov = c; rr.ovKey = key; return c;
}

/* annotations (repère du plan A, en points) */
function cloudPath(ctx, x1, y1, x2, y2) {
  const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2), w = r-l, h = b-t; if (w < 10 || h < 10) return;
  const nx = Math.max(1, Math.round(w/24)), dx = w/nx, ny = Math.max(1, Math.round(h/24)), dy = h/ny; ctx.beginPath();
  for (let i = 0; i < nx; i++) ctx.arc(l+(i+.5)*dx, t, dx/2, Math.PI, 0, false);
  for (let i = 0; i < ny; i++) ctx.arc(r, t+(i+.5)*dy, dy/2, -Math.PI/2, Math.PI/2, false);
  for (let i = nx-1; i >= 0; i--) ctx.arc(l+(i+.5)*dx, b, dx/2, 0, Math.PI, false);
  for (let i = ny-1; i >= 0; i--) ctx.arc(l, t+(i+.5)*dy, dy/2, Math.PI/2, -Math.PI/2, false);
  ctx.stroke();
}
function drawAnnotations(ctx, P, k) {
  const list = P.cur ? [...P.ann, P.cur] : P.ann, lw = Math.max(3, 2.5/k), fs = Math.max(14, 14/k);
  ctx.save(); ctx.strokeStyle = ctx.fillStyle = "#dc2626"; ctx.lineWidth = lw; ctx.lineJoin = "round";
  for (const a of list) {
    if (a.type === "cloud") cloudPath(ctx, a.x1, a.y1, a.x2, a.y2);
    else if (a.type === "arrow") { const hl = fs*1.2, an = Math.atan2(a.y2-a.y1, a.x2-a.x1);
      ctx.beginPath(); ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(a.x2, a.y2); ctx.lineTo(a.x2-hl*Math.cos(an-Math.PI/6), a.y2-hl*Math.sin(an-Math.PI/6)); ctx.lineTo(a.x2-hl*Math.cos(an+Math.PI/6), a.y2-hl*Math.sin(an+Math.PI/6)); ctx.closePath(); ctx.fill(); }
    else if (a.type === "text") { ctx.font = `bold ${fs}px sans-serif`; const w = ctx.measureText(a.text).width + fs*.8;
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.fillRect(a.x1, a.y1-fs*1.1, w, fs*1.5); ctx.strokeRect(a.x1, a.y1-fs*1.1, w, fs*1.5);
      ctx.fillStyle = "#dc2626"; ctx.fillText(a.text, a.x1 + fs*.4, a.y1); }
  }
  ctx.restore();
}

/* dessin d'une couche (contexte déjà en coordonnées « points ») */
function drawLayer(ctx, P, which, k, rr, selZone, o = {}) {
  const lw = Math.max(3, 2.5/k), sh = P.shift, vec = o.vec !== false;
  const lines = (arr, col, ox, oy) => { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.beginPath();
    for (let i = 0; i < arr.length; i += 4) { ctx.moveTo(arr[i]+ox, arr[i+1]+oy); ctx.lineTo(arr[i+2]+ox, arr[i+3]+oy); } ctx.stroke(); };
  const boxes = (col, f) => { ctx.lineWidth = Math.max(1.5, 1.5/k); ctx.fillStyle = col + "2e"; ctx.strokeStyle = col;
    for (const t of P.texts) { const b = f(t); if (b) { ctx.fillRect(b[0]-2, b[1]-2, b[2]-b[0]+4, b[3]-b[1]+4); ctx.strokeRect(b[0]-2, b[1]-2, b[2]-b[0]+4, b[3]-b[1]+4); } } };
  if (which === "ov") {
    if (o.fast) { ctx.drawImage(rr.a, 0, 0, P.w, P.h); ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = .65; ctx.drawImage(rr.b, -sh[0], -sh[1], P.w, P.h); ctx.restore(); }
    else ctx.drawImage(composite(P, rr), 0, 0, P.w, P.h);
    if (vec && !o.fast) { lines(P.removed, RED, 0, 0); lines(P.added, BLUE, -sh[0], -sh[1]);
      boxes(RED, t => t.a); boxes(BLUE, t => t.b && [t.b[0]-sh[0], t.b[1]-sh[1], t.b[2]-sh[0], t.b[3]-sh[1]]); }
  } else if (which === "a") { ctx.drawImage(rr.a, 0, 0, P.w, P.h); if (vec) { lines(P.removed, RED, 0, 0); boxes(RED, t => t.a); } }
  else { ctx.save(); ctx.translate(-sh[0], -sh[1]); ctx.drawImage(rr.b, 0, 0, P.w, P.h); if (vec) { lines(P.added, BLUE, 0, 0); boxes(BLUE, t => t.b); } ctx.restore(); }
  if (selZone) { const [x0, y0, x1, y1] = selZone.bbox; ctx.lineWidth = 2/k; ctx.strokeStyle = "#2563eb"; ctx.fillStyle = "#2563eb14";
    ctx.fillRect(x0-14, y0-14, x1-x0+28, y1-y0+28); ctx.strokeRect(x0-14, y0-14, x1-x0+28, y1-y0+28); }
  drawAnnotations(ctx, P, k);
}

function buildView(refit) {
  const V = $("#views"); V.innerHTML = ""; cvs = []; clearInterval(blinkT);
  const mk = (which, tag) => { const vp = document.createElement("div"); vp.className = "vp"; const c = document.createElement("canvas"); vp.append(c);
    const t = document.createElement("div"); t.className = "tag"; if (tag) t.textContent = tag; else t.style.display = "none"; vp.append(t); V.append(vp); const o = { vp, c, which, tag: t }; cvs.push(o); bind(vp); return o; };
  if (mode === "overlay") mk("ov");
  else if (mode === "side") { mk("a", "A — " + names[0]); mk("b", "B — " + names[1]); }
  else if (mode === "blink") { mk("blink", "A"); startBlink(); }
  else { const o = mk("slider", "A ◀ ▶ B"); const h = document.createElement("div"); h.id = "handle"; o.vp.append(h); h.style.display = "block";
    h.onpointerdown = e => { e.stopPropagation(); h.setPointerCapture(e.pointerId); h.onpointermove = ev => { sliderX = Math.min(1, Math.max(0, (ev.clientX - o.vp.getBoundingClientRect().left) / o.vp.clientWidth)); draw(); }; }; h.onpointerup = () => h.onpointermove = null; }
  setTool(tool); renderList(); updateOff(); requestAnimationFrame(() => { refit ? fit() : draw(); });
}
function startBlink() { clearInterval(blinkT); blinkT = setInterval(() => { blinkB = !blinkB; draw(); }, blinkMs); }
let raf = 0; const draw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(drawNow); };
function drawNow() {
  if (!R || !ras) return; const P = R.pages[page], dpr = window.devicePixelRatio || 1, z = P.zones.find(z => z.id === sel);
  for (const { vp, c, which, tag } of cvs) {
    const W = vp.clientWidth, H = vp.clientHeight; if (c.width !== Math.round(W*dpr) || c.height !== Math.round(H*dpr)) { c.width = Math.round(W*dpr); c.height = Math.round(H*dpr); c.style.width = W+"px"; c.style.height = H+"px"; }
    const ctx = c.getContext("2d"); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, c.width, c.height);
    const T = () => ctx.setTransform(dpr*view.k, 0, 0, dpr*view.k, dpr*view.x, dpr*view.y), opt = { fast, vec: $("#vec").checked };
    const pageBg = () => { ctx.save(); T(); ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 28*dpr; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, P.w, P.h); ctx.restore(); };
    if (which === "slider") { const cx = sliderX * c.width;
      pageBg(); ctx.save(); T(); drawLayer(ctx, P, "a", view.k, ras, z, opt); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(cx, 0, c.width - cx, c.height); ctx.clip(); ctx.clearRect(0, 0, c.width, c.height); pageBg(); T(); drawLayer(ctx, P, "b", view.k, ras, z, opt); ctx.restore();
      const h = vp.querySelector("#handle"); if (h) h.style.left = (sliderX*W - 2) + "px"; }
    else if (which === "blink") { pageBg(); T(); drawLayer(ctx, P, blinkB ? "b" : "a", view.k, ras, z, opt); tag.textContent = blinkB ? "PLAN B (nouveau)" : "PLAN A (ancien)"; tag.style.background = blinkB ? "#1e90ffcc" : "#ff3b4ecc"; }
    else { pageBg(); T(); drawLayer(ctx, P, which, view.k, ras, z, opt); }
  }
  $("#zl").textContent = Math.round(view.k * 100) + "%";
}
function fit() { const P = R.pages[page], vp = cvs[0].vp; view.k = Math.min(vp.clientWidth/P.w, vp.clientHeight/P.h) * .98; view.x = (vp.clientWidth - P.w*view.k)/2; view.y = (vp.clientHeight - P.h*view.k)/2; draw(); }

/* recalage manuel : P.shift = translation A->B ; B est affiché à -shift */
function updateOff() { if (!R) return; const P = R.pages[page]; $("#off").textContent = `ΔX ${(-P.shift[0]/MM).toFixed(2)} mm · ΔY ${(-P.shift[1]/MM).toFixed(2)} mm`; }
function setShift(sx, sy) {
  const P = R.pages[page]; P.shift = [sx, sy]; fast = true; updateOff(); draw(); clearTimeout(recT);
  recT = setTimeout(() => { const r = compare(P.ex.A, P.ex.B, { ...R.p, fixedShift: P.shift });
    Object.assign(P, { removed: r.removed, added: r.added, texts: r.texts, zones: r.zones }); P.identical = !r.removed.length && !r.added.length && !r.texts.length;
    sel = null; fast = false; ras.ovKey = ""; renderList(); draw(); }, 350);
}
const nudge = (dx, dy) => { const P = R.pages[page], st = 1 / ras.sc; setShift(P.shift[0] - dx*st, P.shift[1] - dy*st); };   // B se déplace de (+dx,+dy)
$("#reset").onclick = () => R && setShift(0, 0);
$("#auto").onclick = () => { if (!R) return; const P = R.pages[page], tol = R.p.tol*MM, step = Math.max(Math.min(tol/2, 3), .5);
  const s = estimateShift(sample(P.ex.A.segs, step), sample(P.ex.B.segs, step), tol, P.w, P.h); setShift(s[0], s[1]); toast("Recalage automatique appliqué."); };
document.querySelectorAll("[data-n]").forEach(b => b.onclick = () => { if (R) { const [dx, dy] = b.dataset.n.split(",").map(Number); nudge(dx, dy); } });
window.addEventListener("keydown", e => { if (!R || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const m = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]; if (m) { e.preventDefault(); const st = e.shiftKey ? 10 : 1; nudge(m[0]*st, m[1]*st); } });

/* souris */
function bind(vp) {
  const world = e => { const r = vp.getBoundingClientRect(); return [(e.clientX - r.left - view.x)/view.k, (e.clientY - r.top - view.y)/view.k]; };
  vp.addEventListener("wheel", e => { e.preventDefault(); const r = vp.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const nk = Math.min(80, Math.max(.02, view.k * Math.exp(-e.deltaY * .0015))), q = nk / view.k; view.x = mx - (mx-view.x)*q; view.y = my - (my-view.y)*q; view.k = nk; draw(); }, { passive: false });
  vp.addEventListener("pointerdown", e => {
    if (e.target.id === "handle" || !R) return; const P = R.pages[page]; vp.setPointerCapture(e.pointerId); let lx = e.clientX, ly = e.clientY;
    if (tool === "text") { pendingText = world(e); $("#tm").style.display = "flex"; $("#tmi").value = ""; setTimeout(() => $("#tmi").focus(), 30); return; }
    if (tool === "cloud" || tool === "arrow") { const [x, y] = world(e); P.cur = { type: tool, x1: x, y1: y, x2: x, y2: y }; }
    if (tool === "pan") vp.classList.add("drag");
    vp.onpointermove = ev => {
      if (tool === "pan") { view.x += ev.clientX-lx; view.y += ev.clientY-ly; draw(); }
      else if (tool === "align") { setShift(P.shift[0] - (ev.clientX-lx)/view.k, P.shift[1] - (ev.clientY-ly)/view.k); }
      else if (P.cur) { const [x, y] = world(ev); P.cur.x2 = x; P.cur.y2 = y; draw(); }
      lx = ev.clientX; ly = ev.clientY; };
  });
  vp.addEventListener("pointerup", () => { vp.onpointermove = null; vp.classList.remove("drag"); if (R) { const P = R.pages[page]; if (P.cur) { P.ann.push(P.cur); P.cur = null; draw(); } } });
}
$("#tmok").onclick = () => { const v = $("#tmi").value.trim(); if (v && pendingText) { R.pages[page].ann.push({ type: "text", x1: pendingText[0], y1: pendingText[1], text: v }); draw(); } $("#tm").style.display = "none"; };
$("#tmno").onclick = () => $("#tm").style.display = "none";
$("#tmi").onkeydown = e => { if (e.key === "Enter") $("#tmok").click(); if (e.key === "Escape") $("#tmno").click(); };
$("#undo").onclick = () => { if (R) { R.pages[page].ann.pop(); draw(); } };
$("#clear").onclick = () => { if (R) { R.pages[page].ann = []; draw(); } };

function zoomTo(z) { const vp = cvs[0].vp, [x0, y0, x1, y1] = z.bbox, p = 40, w = x1-x0+2*p, h = y1-y0+2*p;
  view.k = Math.min(vp.clientWidth/w, vp.clientHeight/h, 12); view.x = vp.clientWidth/2 - (x0+x1)/2*view.k; view.y = vp.clientHeight/2 - (y0+y1)/2*view.k; draw(); }
const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const inZone = (t, z, sh) => { const b = t.a || (t.b && [t.b[0]-sh[0], t.b[1]-sh[1], t.b[2]-sh[0], t.b[3]-sh[1]]); return b && b[0] >= z.bbox[0]-20 && b[2] <= z.bbox[2]+20 && b[1] >= z.bbox[1]-20 && b[3] <= z.bbox[3]+20; };
function renderList() {
  const P = R.pages[page], L = $("#list"); L.innerHTML = "";
  const nr = P.removed.length/4, na = P.added.length/4;
  $("#sum").textContent = `Page ${P.page} · ${P.zones.length} zone${P.zones.length > 1 ? "s" : ""} modifiée${P.zones.length > 1 ? "s" : ""}`;
  $("#chips").innerHTML = `<span class="pill r">− ${nr} traits</span><span class="pill b">+ ${na} traits</span><span class="pill t">${P.texts.length} texte${P.texts.length > 1 ? "s" : ""}</span>`;
  const add = (html, cls = "z") => { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; L.append(d); return d; };
  if (R.nA !== R.nB) add(`⚠ Nombre de pages différent (A : ${R.nA}, B : ${R.nB}). Seules les pages communes sont comparées.`, "note");
  if (P.identical) add(`<div class="ok"><svg class="i" style="width:24px;height:24px"><use href="#i-check"/></svg></div><b style="color:var(--tx)">Aucune différence</b><br>à cette tolérance (${R.p.tol} mm).`, "empty");
  P.zones.forEach(z => {
    const tx = P.texts.filter(t => inZone(t, z, P.shift));
    const d = add(`<div class="top"><span class="num">${z.id}</span><b>Zone ${z.id}</b><span class="cnt"><span class="r">− ${z.removed}</span><span class="b">+ ${z.added}</span><span style="color:var(--acc)">${z.text} T</span></span></div>` +
      tx.slice(0, 4).map(t => `<div class="t">${t.kind === "modified" ? `<s>${esc(t.old)}</s> → <u>${esc(t.nw)}</u>` : t.kind === "added" ? `<u>+ ${esc(t.nw)}</u>` : `<s>${esc(t.old)}</s>`}</div>`).join("") +
      (tx.length > 4 ? `<div class="t">… +${tx.length-4} autres textes</div>` : ""));
    if (z.id === sel) d.classList.add("sel");
    d.onclick = () => { sel = z.id; renderList(); zoomTo(z); };
  });
}
window.addEventListener("resize", () => R && draw());

/* exports */
const download = (blob, name) => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); };
const KIND = { modified: "Texte modifié", added: "Texte ajouté", removed: "Texte supprimé" };
async function exportCanvas(P, maxSc) {
  const sc = Math.min(maxSc, 8000 / Math.max(P.w, P.h)), rr = { sc, a: await renderRaster(docA, P.page, sc), b: await renderRaster(docB, P.page, sc), ov: null, ovKey: "" };
  const c = document.createElement("canvas"); c.width = Math.ceil(P.w*sc); c.height = Math.ceil(P.h*sc); const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.scale(sc, sc); drawLayer(ctx, P, "ov", sc, rr, null, { vec: $("#vec").checked });
  ctx.lineWidth = 1.5/sc; ctx.strokeStyle = ctx.fillStyle = "#2563eb";
  P.zones.forEach(z => { const [x0, y0, x1, y1] = z.bbox; ctx.setLineDash([6, 4]); ctx.strokeRect(x0-8, y0-8, x1-x0+16, y1-y0+16); ctx.setLineDash([]); ctx.font = `bold ${Math.max(16, 16/sc)}px sans-serif`; ctx.fillText(String(z.id), x0-8, Math.max(14, y0-12)); });
  return c;
}
$("#xpng").onclick = async () => { $("#xpng").disabled = true; toast("Génération de l'image…"); const c = await exportCanvas(R.pages[page], +$("#res").value || 2);
  c.toBlob(b => { download(b, `Comparaison_p${R.pages[page].page}.png`); $("#xpng").disabled = false; toast("Image exportée."); }, "image/png"); };
$("#xcsv").onclick = () => {
  const q = v => `"${String(v).replace(/"/g, '""')}"`, rows = [["Page", "Zone", "Traits supprimés", "Traits ajoutés", "Textes", "x0 (pt)", "y0 (pt)", "x1 (pt)", "y1 (pt)"]];
  R.pages.forEach(P => P.zones.forEach(z => rows.push([P.page, z.id, z.removed, z.added, z.text, ...z.bbox.map(v => v.toFixed(1))])));
  rows.push([], ["Page", "Type", "Ancien texte", "Nouveau texte"]);
  R.pages.forEach(P => P.texts.forEach(t => rows.push([P.page, KIND[t.kind], t.old, t.nw])));
  download(new Blob(["﻿" + rows.map(r => r.map(q).join(";")).join("\n")], { type: "text/csv" }), "differences.csv");
};
$("#xpdf").onclick = async () => {
  $("#xpdf").disabled = true; toast("Génération du PDF…"); const { jsPDF } = window.jspdf, doc = new jsPDF({ unit: "pt", format: [595, 842] });
  let y = 50; const ln = (t, b) => { if (y > 800) { doc.addPage([595, 842], "p"); y = 50; } doc.setFont("helvetica", b ? "bold" : "normal").setFontSize(b ? 10 : 8.5); doc.text(String(t).slice(0, 110), 40, y); y += 12; };
  doc.setFont("helvetica", "bold").setFontSize(18); doc.text("Comparaison de plans", 40, y); y += 22;
  ln("A (ancien) : " + names[0]); ln("B (nouveau) : " + names[1]); ln(`Tolérance : ${R.p.tol} mm — regroupement : ${R.p.cluster} mm`); ln("Rouge : présent dans A seulement.   Bleu : présent dans B seulement.   Noir : identique."); y += 10;
  R.pages.forEach(P => { ln(`Page ${P.page} — ${P.zones.length} zone(s), ${P.removed.length/4} traits supprimés, ${P.added.length/4} ajoutés, ${P.texts.length} texte(s), recalage B : ${(-P.shift[0]/MM).toFixed(2)} / ${(-P.shift[1]/MM).toFixed(2)} mm`, true);
    P.zones.forEach(z => ln(`   Zone ${z.id} : -${z.removed} / +${z.added} traits, ${z.text} texte(s)   @ (${z.bbox[0].toFixed(0)}, ${z.bbox[1].toFixed(0)}) pt`));
    P.texts.forEach(t => ln(`   ${t.kind === "modified" ? `« ${t.old} » -> « ${t.nw} »` : t.kind === "added" ? `Ajouté : « ${t.nw} »` : `Supprimé : « ${t.old} »`}`)); y += 6; });
  for (const P of R.pages) { const c = await exportCanvas(P, 1.5); doc.addPage([P.w, P.h], P.w > P.h ? "l" : "p"); doc.addImage(c.toDataURL("image/jpeg", .88), "JPEG", 0, 0, P.w, P.h); }
  doc.save("comparaison.pdf"); $("#xpdf").disabled = false;
};

/* ------------------------------------------------------------------ ergonomie */
const slot = { A: null, B: null };
function setFile(side, f) {
  if (!f || !/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) return toast("Fichier PDF requis.");
  slot[side] = f; const inp = $(side === "A" ? "#fa" : "#fb"), dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files;
  $(side === "A" ? "#na" : "#nb").textContent = f.name; $(side === "A" ? "#ca" : "#cb").classList.add("has");
  if ($("#fa").files[0] && $("#fb").files[0]) $("#go").click(); else toast(`Plan ${side} chargé — choisissez maintenant le plan ${side === "A" ? "B" : "A"}.`);
}
["fa", "fb"].forEach(id => $("#" + id).addEventListener("change", e => { const f = e.target.files[0]; if (f && slot[id === "fa" ? "A" : "B"] !== f) setFile(id === "fa" ? "A" : "B", f); }));
$("#swp").onclick = () => { const a = $("#fa").files[0], b = $("#fb").files[0]; if (!a || !b) return toast("Chargez d'abord les deux plans."); slot.A = slot.B = null; setFile("A", b); slot.B = null; setFile("B", a); };
document.addEventListener("click", e => { const d = e.target.closest(".drop"); if (d) $(d.dataset.side === "A" ? "#fa" : "#fb").click(); });
const dz = (el, side) => { el.addEventListener("dragover", e => { e.preventDefault(); el.classList.add("drop", "drop-on"); }); el.addEventListener("dragleave", () => el.classList.remove("drop-on"));
  el.addEventListener("drop", e => { e.preventDefault(); el.classList.remove("drop-on"); const fs = [...e.dataTransfer.files]; if (side) setFile(side, fs[0]); else { if (fs[0]) setFile(el.dataset.side, fs[0]); } e.stopPropagation(); }); };
dz($("#ca"), "A"); dz($("#cb"), "B");
document.addEventListener("dragover", e => e.preventDefault());
document.addEventListener("drop", e => { e.preventDefault(); const t = e.target.closest(".drop"); const fs = [...e.dataTransfer.files].filter(f => /\.pdf$/i.test(f.name));
  if (t) return setFile(t.dataset.side, fs[0]);
  if (fs.length >= 2) { setFile("A", fs[0]); setFile("B", fs[1]); } else if (fs.length === 1) setFile($("#fa").files[0] ? "B" : "A", fs[0]); });
/* menus déroulants */
const toggle = (btn, pop) => { $(btn).onclick = e => { e.stopPropagation(); const on = !$(pop).classList.contains("show"); document.querySelectorAll(".pop").forEach(p => p.classList.remove("show")); $(pop).classList.toggle("show", on); }; };
toggle("#sbtn", "#spop"); toggle("#ebtn", "#epop");
document.addEventListener("click", e => { if (!e.target.closest(".pop")) document.querySelectorAll(".pop").forEach(p => p.classList.remove("show")); });
document.querySelectorAll("#epop button").forEach(b => b.addEventListener("click", () => $("#epop").classList.remove("show")));
/* zoom */
const zoomC = f => { if (!R || !cvs.length) return; const vp = cvs[0].vp, mx = vp.clientWidth/2, my = vp.clientHeight/2, nk = Math.min(80, Math.max(.02, view.k*f)), q = nk/view.k; view.x = mx-(mx-view.x)*q; view.y = my-(my-view.y)*q; view.k = nk; draw(); };
$("#zi").onclick = () => zoomC(1.3); $("#zo").onclick = () => zoomC(1/1.3);
/* raccourcis */
window.addEventListener("keydown", e => { if (!R || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || e.ctrlKey && e.key !== "z" || e.metaKey) return;
  const k = e.key.toLowerCase(), T = { v: "pan", h: "pan", r: "align", c: "cloud", f: "arrow", t: "text" }, M = { 1: "overlay", 2: "slider", 3: "blink", 4: "side" };
  if (T[k]) setTool(T[k]); else if (M[k]) document.querySelector(`[data-m=${M[k]}]`).click(); else if (k === "0") fit(); else if (k === "z" && e.ctrlKey) $("#undo").click(); else if (k === "+" || k === "=") zoomC(1.3); else if (k === "-") zoomC(1/1.3); });
