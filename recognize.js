// Handwritten-digit recognizer for the math activities.
//
// The math page knows the expected answer, so this does NOT do open
// recognition — it builds a template from the EXPECTED number's digit
// shape(s) (from letters.js BASE) and checks whether the child's ink matches
// it. That is exactly the tracing app's "Grūti / draw from memory" test, so
// this reuses that engine's tuned align+coverage logic (see app.js): the right
// number passes, a scribble or a different number fails.
//
// API:  DigitRecog.build("7")   // or "10"  — sets the target
//       DigitRecog.test(inkStrokes)  -> true | false
//   inkStrokes: [ [ {x,y}, ... ], ... ]  in ANY consistent linear space; the
//   caller normalises to ~0..100 (see the math page) so the size gates match.
"use strict";
var DigitRecog = (function () {
  var SVGNS = "http://www.w3.org/2000/svg";

  // hidden SVG, only for measuring path geometry (getTotalLength/PointAtLength)
  var svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("width", "100"); svg.setAttribute("height", "100");
  svg.style.cssText = "position:absolute;left:-9999px;top:-9999px;" +
                      "width:100px;height:100px;pointer-events:none;opacity:0;";
  var attached = false;
  function ensure() { if (!attached) { document.body.appendChild(svg); attached = true; } }

  // tuned in tools/sim_align.py / engine2.py — kept in lockstep with app.js
  var ALIGN = {
    R: 7, thresh: 0.72, dirMin: 0.75, tailF: 6.5, tailB: 5.2,
    scaleMin: 0.5, scaleMax: 3, minDiag: 18, snapMax: 8, step: 2.0,
  };

  // module template state (rebuilt by build())
  var guidePaths = [], coverage = [], tplFlat = [], tplShortC = [], guideLen = 0;

  // ---------- geometry helpers (ported from app.js) ----------
  function samplePath(el, n) {
    var len = el.getTotalLength();
    var pts = [];
    var steps = Math.max(n, Math.ceil(len / 3));
    for (var i = 0; i <= steps; i++) {
      var p = el.getPointAtLength((len * i) / steps);
      pts.push({ x: p.x, y: p.y });
    }
    return pts;
  }
  function segDist(px, py, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var L2 = dx * dx + dy * dy;
    var t = L2 ? ((px - a.x) * dx + (py - a.y) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
  }
  function strokeDist(px, py, pts) {
    var m = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var d = segDist(px, py, pts[i], pts[i + 1]);
      if (d < m) m = d;
    }
    return m;
  }
  function creditSample(sx, sy, R) {
    var R2 = R * R;
    var d = guidePaths.map(function (g) { return strokeDist(sx, sy, g.points); });
    var best = 0;
    for (var i = 1; i < d.length; i++) if (d[i] < d[best]) best = i;
    if (d[best] > R) return false;
    for (var si = 0; si < guidePaths.length; si++) {
      if (d[si] > d[best] + 1e-9) continue;
      var g = guidePaths[si], pts = g.points, k;
      if (g.tiny) {
        for (k = 0; k < pts.length; k++) {
          var ddx = pts[k].x - sx, ddy = pts[k].y - sy;
          if (ddx * ddx + ddy * ddy <= R2) coverage[si].add(k);
        }
        continue;
      }
      var j = 0, bd = Infinity;
      for (k = 0; k < pts.length; k++) {
        var dx = pts[k].x - sx, dy = pts[k].y - sy;
        var dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; j = k; }
      }
      var hi = Math.min(pts.length - 1, j + g.win);
      for (k = Math.max(0, j - g.win); k <= hi; k++) coverage[si].add(k);
    }
    return true;
  }
  function resampleStroke(st) {
    var out = [{ x: st[0].x, y: st[0].y }];
    var acc = 0;
    for (var i = 1; i < st.length; i++) {
      var ax = st[i - 1].x, ay = st[i - 1].y;
      var bx = st[i].x, by = st[i].y;
      var seg = Math.hypot(bx - ax, by - ay);
      while (acc + seg >= ALIGN.step) {
        var t = (ALIGN.step - acc) / seg;
        ax += (bx - ax) * t; ay += (by - ay) * t;
        out.push({ x: ax, y: ay });
        seg = Math.hypot(bx - ax, by - ay);
        acc = 0;
      }
      acc += seg;
    }
    if (out.length < 2) out.push({ x: st[st.length - 1].x, y: st[st.length - 1].y });
    return out;
  }
  function nearestTpl(p) {
    var bd = Infinity, bi = 0;
    for (var i = 0; i < tplFlat.length; i++) {
      var dx = tplFlat[i].x - p.x, dy = tplFlat[i].y - p.y;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; }
    }
    return { d: Math.sqrt(bd), i: bi };
  }
  function polyLen(st) {
    var L = 0;
    for (var i = 1; i < st.length; i++) L += Math.hypot(st[i].x - st[i-1].x, st[i].y - st[i-1].y);
    return L;
  }
  function strokeDone(i, th, alignMode) {
    var g = guidePaths[i], n = g.points.length, cov = coverage[i];
    if (g.tiny)  return cov.size / n >= Math.min(th, 0.5);
    if (g.short || (alignMode && g.alignShort)) return cov.size / n >= Math.min(th, 0.7);
    if (cov.size / n < th) return false;
    var head = Math.max(1, Math.ceil(n * 0.12));
    var hasHead = false, hasTail = false;
    cov.forEach(function (k) {
      if (k < head) hasHead = true;
      if (k >= n - head) hasTail = true;
    });
    if (!hasHead || !hasTail) return false;
    var ks = [];
    cov.forEach(function (k) { ks.push(k); });
    ks.sort(function (a, b) { return a - b; });
    var bestRun = 0, runStart = ks[0], prev = ks[0];
    for (var x = 1; x <= ks.length; x++) {
      var k = x < ks.length ? ks[x] : n + 99;
      if (k - prev > 5) {
        if (prev - runStart + 1 > bestRun) bestRun = prev - runStart + 1;
        runStart = k;
      }
      prev = k;
    }
    return bestRun >= 0.7 * n;
  }

  // ---------- recognition core (ported from app.js recogCore) ----------
  function recogCore(A0) {
    var n = guidePaths.length;
    var A = A0.map(resampleStroke);

    for (var it = 0; it < 2; it++) {
      var pa = [], pq = [];
      for (var s0 = 0; s0 < A.length; s0++) for (var p0 = 0; p0 < A[s0].length; p0++) {
        var nn0 = nearestTpl(A[s0][p0]);
        if (nn0.d <= 3 * ALIGN.R) { pa.push(A[s0][p0]); pq.push(tplFlat[nn0.i]); }
      }
      if (pa.length < 8) break;
      var max_ = 0, may = 0, mqx = 0, mqy = 0, i;
      for (i = 0; i < pa.length; i++) { max_ += pa[i].x; may += pa[i].y; mqx += pq[i].x; mqy += pq[i].y; }
      max_ /= pa.length; may /= pa.length; mqx /= pa.length; mqy /= pa.length;
      var vax = 0, vay = 0, gxn = 0, gyn = 0;
      for (i = 0; i < pa.length; i++) {
        vax += Math.pow(pa[i].x - max_, 2); vay += Math.pow(pa[i].y - may, 2);
        gxn += (pa[i].x - max_) * (pq[i].x - mqx);
        gyn += (pa[i].y - may) * (pq[i].y - mqy);
      }
      var gx = gxn / (vax || 1e-9), gy = gyn / (vay || 1e-9);
      gx = Math.min(Math.max(gx, 0.8), 1.25);
      gy = Math.min(Math.max(gy, 0.8), 1.25);
      A = A.map(function (st) {
        return st.map(function (p) {
          return { x: mqx + (p.x - max_) * gx, y: mqy + (p.y - may) * gy };
        });
      });
    }

    for (var si = 0; si < A.length; si++) {
      var st = A[si];
      if (polyLen(st) > 30 || !tplShortC.length) continue;
      var scx = 0, scy = 0, pp;
      for (pp = 0; pp < st.length; pp++) { scx += st[pp].x; scy += st[pp].y; }
      scx /= st.length; scy /= st.length;
      var bv = Infinity, bdx = 0, bdy = 0;
      for (var c = 0; c < tplShortC.length; c++) {
        var dd = Math.pow(tplShortC[c].x - scx, 2) + Math.pow(tplShortC[c].y - scy, 2);
        if (dd < bv) { bv = dd; bdx = tplShortC[c].x - scx; bdy = tplShortC[c].y - scy; }
      }
      if (bv <= 100) {
        var dx = Math.max(-ALIGN.snapMax, Math.min(ALIGN.snapMax, bdx));
        var dy = Math.max(-ALIGN.snapMax, Math.min(ALIGN.snapMax, bdy));
        A[si] = st.map(function (p) { return { x: p.x + dx, y: p.y + dy }; });
      }
    }

    coverage = guidePaths.map(function () { return new Set(); });
    var junky = false, alen = 0;
    for (var q = 0; q < A.length; q++) {
      var jOk = 0, stq = A[q];
      for (var r = 0; r < stq.length; r++) if (creditSample(stq[r].x, stq[r].y, ALIGN.R)) jOk++;
      var L = polyLen(stq);
      alen += L;
      if (L >= 15 && stq.length > 0 && jOk / stq.length < 0.35) junky = true;
    }

    var doneN = 0;
    for (var d0 = 0; d0 < n; d0++) if (strokeDone(d0, ALIGN.thresh, true)) doneN++;

    var apts = [];
    for (var a1 = 0; a1 < A.length; a1++) for (var a2 = 0; a2 < A[a1].length; a2++) apts.push(A[a1][a2]);
    var fwd = [];
    for (var f = 0; f < tplFlat.length; f++) {
      var bdf = Infinity;
      for (var ap = 0; ap < apts.length; ap++) {
        var df = Math.pow(tplFlat[f].x - apts[ap].x, 2) + Math.pow(tplFlat[f].y - apts[ap].y, 2);
        if (df < bdf) bdf = df;
      }
      fwd.push(Math.sqrt(bdf));
    }
    fwd.sort(function (a, b) { return a - b; });
    var bwd = [], dirSum = 0, dirN = 0;
    for (var b1 = 0; b1 < A.length; b1++) {
      var m = A[b1].length;
      for (var b2 = 0; b2 < m; b2++) {
        var nn = nearestTpl(A[b1][b2]);
        bwd.push(nn.d);
        if (nn.d <= ALIGN.R * 1.5) {
          var aa = A[b1][Math.max(0, b2 - 2)], bb = A[b1][Math.min(m - 1, b2 + 2)];
          var LL = Math.hypot(bb.x - aa.x, bb.y - aa.y) || 1e-9;
          var qd = tplFlat[nn.i];
          dirSum += Math.abs(((bb.x - aa.x) / LL) * qd.tx + ((bb.y - aa.y) / LL) * qd.ty);
          dirN++;
        }
      }
    }
    bwd.sort(function (a, b) { return a - b; });
    var kf = Math.max(1, Math.floor(fwd.length / 10));
    var kb = Math.max(1, Math.floor(bwd.length / 10));
    var tailF = 0, tailB = 0, i2;
    for (i2 = fwd.length - kf; i2 < fwd.length; i2++) tailF += fwd[i2];
    for (i2 = bwd.length - kb; i2 < bwd.length; i2++) tailB += bwd[i2];
    tailF /= kf; tailB /= kb;
    var dirScore = dirN ? dirSum / dirN : 0;

    var over = alen >= 1.9 * guideLen ||
               (alen >= 1.1 * guideLen && doneN < 0.5 * n);
    var ok = doneN === n && alen >= 0.6 * guideLen && !junky && !over &&
             tailF <= ALIGN.tailF && tailB <= ALIGN.tailB &&
             dirScore >= ALIGN.dirMin;
    return { ok: ok, over: over, alen: alen, doneN: doneN };
  }

  // ---------- build a template from the expected number ----------
  function addGuide(pts) {
    var plen = 0;
    for (var k = 1; k < pts.length; k++) plen += Math.hypot(pts[k].x - pts[k-1].x, pts[k].y - pts[k-1].y);
    var spacing = plen / Math.max(1, pts.length - 1);
    guidePaths.push({
      points: pts, len: plen,
      win: Math.max(1, Math.round(2.0 / Math.max(spacing, 1e-6))),
      tiny: plen <= 8, short: plen <= 18, alignShort: plen <= 28,
    });
    coverage.push(new Set());
    guideLen += plen;
  }

  function build(numStr) {
    ensure();
    guidePaths = []; coverage = []; tplFlat = []; tplShortC = []; guideLen = 0;
    var k = numStr.length;
    for (var j = 0; j < k; j++) {
      var ch = numStr.charAt(j);
      var paths = (typeof BASE !== "undefined" && BASE[ch]) ? BASE[ch] : null;
      if (!paths) continue;
      // sample this digit's strokes in native 0..100 space
      var sampled = paths.map(function (ds) {
        var p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", ds);
        svg.appendChild(p);
        var pts = samplePath(p, 24);
        svg.removeChild(p);
        return pts;
      });
      // native x-centre of the whole digit, to slot it horizontally
      var sx = 0, cnt = 0;
      sampled.forEach(function (pts) { pts.forEach(function (q) { sx += q.x; cnt++; }); });
      var xc = cnt ? sx / cnt : 50;
      var slotC = (j + 0.5) * 100 / k;   // digit's target x-centre
      var kx = 0.9 / k;                   // shrink width so digits sit side by side
      sampled.forEach(function (pts) {
        addGuide(pts.map(function (q) { return { x: slotC + (q.x - xc) * kx, y: q.y }; }));
      });
    }
    // template flat point+tangent arrays + short-stroke centroids
    for (var g = 0; g < guidePaths.length; g++) {
      var pts = guidePaths[g].points, n = pts.length, i;
      for (i = 0; i < n; i++) {
        var a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
        var L = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
        tplFlat.push({ x: pts[i].x, y: pts[i].y, tx: (b.x - a.x) / L, ty: (b.y - a.y) / L });
      }
      if (guidePaths[g].len <= 34) {
        var cx = 0, cy = 0;
        for (i = 0; i < n; i++) { cx += pts[i].x; cy += pts[i].y; }
        tplShortC.push({ x: cx / n, y: cy / n });
      }
    }
    return guidePaths.length > 0;
  }

  // ---------- test the child's ink against the current template ----------
  function test(inkStrokes) {
    var n = guidePaths.length;
    if (!n || !tplFlat.length) return false;
    var strokes = (inkStrokes || []).filter(function (s) { return s && s.length > 1; });
    if (!strokes.length) return false;

    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    var cx = 0, cy = 0, cnt = 0;
    strokes.forEach(function (st) { st.forEach(function (p) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      cx += p.x; cy += p.y; cnt++;
    }); });
    if (Math.hypot(maxX - minX, maxY - minY) < ALIGN.minDiag) return false;
    cx /= cnt; cy /= cnt;

    var tx = 0, ty = 0, i;
    for (i = 0; i < tplFlat.length; i++) { tx += tplFlat[i].x; ty += tplFlat[i].y; }
    tx /= tplFlat.length; ty /= tplFlat.length;

    // per-axis alignment (the free path from app.js — works at any position)
    var irx = 0, iry = 0;
    strokes.forEach(function (st) { st.forEach(function (p) {
      irx += (p.x - cx) * (p.x - cx); iry += (p.y - cy) * (p.y - cy);
    }); });
    irx = Math.max(Math.sqrt(irx / cnt), 1e-6);
    iry = Math.max(Math.sqrt(iry / cnt), 1e-6);
    var trx = 0, tryy = 0;
    for (i = 0; i < tplFlat.length; i++) {
      trx += (tplFlat[i].x - tx) * (tplFlat[i].x - tx);
      tryy += (tplFlat[i].y - ty) * (tplFlat[i].y - ty);
    }
    trx = Math.max(Math.sqrt(trx / tplFlat.length), 1e-6);
    tryy = Math.max(Math.sqrt(tryy / tplFlat.length), 1e-6);
    var sx = trx / irx, sy = tryy / iry;
    if (sx < ALIGN.scaleMin || sx > ALIGN.scaleMax ||
        sy < ALIGN.scaleMin || sy > ALIGN.scaleMax) return false;

    var A0 = strokes.map(function (st) {
      return st.map(function (p) { return { x: tx + (p.x - cx) * sx, y: ty + (p.y - cy) * sy }; });
    });
    return recogCore(A0).ok;
  }

  return { build: build, test: test };
})();
