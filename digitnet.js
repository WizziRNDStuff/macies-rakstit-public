// In-browser handwritten-digit classifier (Option A: model runs on-device).
//
// Loads digitnet.json (a small MLP trained offline; see ml/train.py) and runs
// the identical forward pass verified in ml/verify.py. Drawings never leave the
// device. The model is an UPGRADE, not a dependency: it loads async, and the
// math pages fall back to the geometric recognizer (recognize.js) whenever the
// model isn't ready (first load offline, fetch error, old device).
//
// API:  DigitNet.ready            -> bool (model loaded)
//       DigitNet.whenReady        -> Promise (resolves once loaded/failed)
//       DigitNet.classify(strokes)-> {digit, prob, probs}
//       DigitNet.verify(strokes, numStr[, thresh]) -> bool
//   strokes: [ [ {x,y}, ... ], ... ] in ANY consistent linear space (the
//   rasterizer bbox-normalises internally, matching training).
"use strict";
var DigitNet = (function () {
  var model = null, ready = false, labels = null;
  var DEFAULT_T = 0.55;

  function b64f32(s) {
    var bin = atob(s), len = bin.length, buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return new Float32Array(buf.buffer);
  }

  // Load via a tiny manifest that names a CONTENT-HASHED model file. Only the
  // manifest is fetched fresh (no-store); the hashed model is cacheable forever,
  // so a retrain (new hash) can never be served stale. Offline before first
  // load -> manifest fetch fails -> caller falls back to the geometric engine.
  var whenReady = fetch("digitnet.manifest.json", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("manifest " + r.status); return r.json(); })
    .then(function (man) {
      labels = man.labels || null;
      return fetch(man.model).then(function (r) {
        if (!r.ok) throw new Error("model " + r.status); return r.json();
      });
    })
    .then(function (m) {
      m.MEAN = b64f32(m.mean); m.STD = b64f32(m.std);
      m.L = m.layers.map(function (L) {
        return { in: L.in, out: L.out, act: L.act, w: b64f32(L.w), b: b64f32(L.b) };
      });
      if (!labels) labels = m.labels || null;
      model = m; ready = true;
    })
    .catch(function () { ready = false; });   // stay silent; caller falls back

  // ---- rasterize: EXACT mirror of ml/prep.rasterize (the train/infer contract) ----
  function rasterize(strokes) {
    var size = model.size, margin = model.margin, brush = model.brush;
    var grid = new Float32Array(size * size);
    var i, s, p, pts = [];
    for (i = 0; i < strokes.length; i++) for (var j = 0; j < strokes[i].length; j++) pts.push(strokes[i][j]);
    if (!pts.length) return grid;
    var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (i = 0; i < pts.length; i++) {
      p = pts[i];
      if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
      if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
    }
    var w = Math.max(maxx - minx, 1e-6), h = Math.max(maxy - miny, 1e-6);
    var scale = (size - 2 * margin) / Math.max(w, h);
    var ox = (size - w * scale) / 2 - minx * scale;
    var oy = (size - h * scale) / 2 - miny * scale;

    function stamp(gx, gy) {
      var r = brush + 1.0;
      var x0 = Math.max(0, Math.floor(gx - r)), x1 = Math.min(size - 1, Math.ceil(gx + r));
      var y0 = Math.max(0, Math.floor(gy - r)), y1 = Math.min(size - 1, Math.ceil(gy + r));
      for (var yy = y0; yy <= y1; yy++) for (var xx = x0; xx <= x1; xx++) {
        var dx = xx + 0.5 - gx, dy = yy + 0.5 - gy;
        var d = Math.sqrt(dx * dx + dy * dy);
        var v = 1.0 - (d - (brush - 0.5)) / 1.2;
        if (v > 0.0) {
          if (v > 1.0) v = 1.0;
          var idx = yy * size + xx;
          if (v > grid[idx]) grid[idx] = v;
        }
      }
    }
    for (i = 0; i < strokes.length; i++) {
      s = strokes[i];
      if (s.length === 1) { stamp(s[0].x * scale + ox, s[0].y * scale + oy); continue; }
      for (var k = 1; k < s.length; k++) {
        var ax = s[k-1].x * scale + ox, ay = s[k-1].y * scale + oy;
        var bx = s[k].x * scale + ox,  by = s[k].y * scale + oy;
        var seg = Math.hypot(bx - ax, by - ay);
        var steps = Math.max(1, Math.ceil(seg / 0.5));
        for (var t = 0; t <= steps; t++) {
          var f = t / steps;
          stamp(ax + (bx - ax) * f, ay + (by - ay) * f);
        }
      }
    }
    return grid;
  }

  // ---- forward: EXACT mirror of ml/verify.py forward() ----
  function forward(x) {
    var i, o, h = new Float32Array(x.length);
    for (i = 0; i < x.length; i++) h[i] = (x[i] - model.MEAN[i]) / model.STD[i];
    for (var li = 0; li < model.L.length; li++) {
      var L = model.L[li], ni = L.in, no = L.out, z = new Float32Array(no);
      for (o = 0; o < no; o++) {
        var base = o * ni, ssum = L.b[o];
        for (i = 0; i < ni; i++) ssum += L.w[base + i] * h[i];
        z[o] = ssum;
      }
      if (L.act === "relu") {
        var hh = new Float32Array(no);
        for (o = 0; o < no; o++) hh[o] = z[o] > 0 ? z[o] : 0;
        h = hh;
      } else {
        var mx = -Infinity;
        for (o = 0; o < no; o++) if (z[o] > mx) mx = z[o];
        var tot = 0, e = new Float32Array(no);
        for (o = 0; o < no; o++) { e[o] = Math.exp(z[o] - mx); tot += e[o]; }
        for (o = 0; o < no; o++) e[o] /= tot;
        h = e;
      }
    }
    return h;
  }

  function classify(strokes) {
    var p = forward(rasterize(strokes));
    var bi = 0; for (var i = 1; i < p.length; i++) if (p[i] > p[bi]) bi = i;
    return { label: (labels ? labels[bi] : String(bi)), index: bi, prob: p[bi], probs: p };
  }

  // split ink into k left-to-right groups at the widest centroid gaps
  function splitByX(strokes, k) {
    var items = strokes.map(function (st) {
      var sx = 0; for (var i = 0; i < st.length; i++) sx += st[i].x;
      return { st: st, cx: sx / st.length };
    });
    items.sort(function (a, b) { return a.cx - b.cx; });
    if (items.length < k) return null;
    var gaps = [];
    for (var i = 1; i < items.length; i++) gaps.push({ i: i, g: items[i].cx - items[i-1].cx });
    gaps.sort(function (a, b) { return b.g - a.g; });
    var cuts = gaps.slice(0, k - 1).map(function (x) { return x.i; }).sort(function (a, b) { return a - b; });
    var groups = [], start = 0;
    cuts.forEach(function (c) { groups.push(items.slice(start, c).map(function (x) { return x.st; })); start = c; });
    groups.push(items.slice(start).map(function (x) { return x.st; }));
    return groups;
  }

  // verify the ink is the expected number (per-digit for multi-digit answers)
  function verify(strokes, numStr, thresh) {
    if (!ready) return false;
    var T = (typeof thresh === "number") ? thresh : DEFAULT_T;
    var ss = (strokes || []).filter(function (s) { return s && s.length > 1; });
    if (!ss.length || !numStr) return false;
    if (numStr.length <= 1) {
      var c = classify(ss);
      return c.label === numStr && c.prob >= T;
    }
    var groups = splitByX(ss, numStr.length);
    if (!groups || groups.length !== numStr.length) return false;
    for (var i = 0; i < numStr.length; i++) {
      var g = classify(groups[i]);
      if (!(g.label === numStr.charAt(i) && g.prob >= T)) return false;
    }
    return true;
  }

  return {
    get ready() { return ready; },
    whenReady: whenReady,
    classify: classify,
    verify: verify,
  };
})();
