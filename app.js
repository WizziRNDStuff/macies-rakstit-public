"use strict";
(function () {
  var APPV = "3aebb71";   // keep in lockstep with the ?v= cache-buster in index.html
  const guideSvg = document.getElementById("guide");
  const canvas   = document.getElementById("pad");
  const ctx      = canvas.getContext("2d", { willReadFrequently: false });
  const okBox    = document.getElementById("ok");
  const badBox   = document.getElementById("bad");
  const prog     = document.getElementById("prog");
  const nameEl   = document.getElementById("letterChar");
  const SVGNS = "http://www.w3.org/2000/svg";

  // ---------- difficulty levels ----------
  // R: tolerance radius (0..100 units) | thresh: fraction of each stroke to cover
  // guideW: gray guide (shadow) stroke width — thinner on harder levels
  // Stroke order and travel direction are deliberately NOT enforced anywhere;
  // dots/chevrons/animation teach them, validation stays forgiving.
  // guideW is purely the grey shadow's width — tolerance is R, so thinning it
  // costs no difficulty. guideW 0 = no shadow at all (memory mode).
  // Numbers/arrows are gone everywhere: on recorded handwriting strokes they
  // landed on top of the letter and pointed misleading directions.
  // prec = min fraction of the attempt's ink that must land on the letter
  const LEVELS = {
    1: { R: 12,  thresh: 0.70, prec: 0.60, guideW: 7, arrows: true }, // Viegli: fat shadow + start dots + chevrons
    2: { R: 6.5, thresh: 0.85, prec: 0.60, guideW: 4 },               // Vidēji: thin shadow, tighter tolerance
    3: { R: 12,  thresh: 0.65, prec: 0.50, guideW: 0, align: true },  // Grūti: from memory, anywhere on screen
  };

  let level = parseInt(localStorage.getItem("lv_level") || "2", 10);
  if (!LEVELS[level]) level = 2;
  let animOn = localStorage.getItem("lv_anim") !== "off"; // default ON
  // digits mode (Raksti ciparus): the page sets window.LV_MODE before app.js.
  // Same engine, but a fixed 0-9 set and no upper/lower case toggle.
  const DIGITS = window.LV_MODE === "digits";
  let lower = !DIGITS && localStorage.getItem("lv_case") === "lower"; // default UPPER
  LETTERS = DIGITS ? LETTERS_DIGITS : (lower ? LETTERS_LOWER : LETTERS_UPPER);

  // ---------- letter transform ----------
  // Letters render upright (no slant). The size slider scales about the centre.
  let size = parseInt(localStorage.getItem("lv_size") || "55", 10);   // default: small
  if (!(size >= 55 && size <= 100)) size = 100;   // 100 = frame-filling; see index.html

  let M = null;   // current local->display matrix; rebuilt by loadLetter

  // Scale about (50,50), as one matrix. Used for BOTH the SVG transform and
  // hit-testing, so the two cannot drift apart.
  function letterMatrix() {
    const s = size / 100;
    return { a: s, b: 0, c: 0, d: s, e: 50 * (1 - s), f: 50 * (1 - s) };
  }
  function applyM(m, p) {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }
  function matrixStr(m) {
    return "matrix(" + [m.a, m.b, m.c, m.d, m.e, m.f].join(",") + ")";
  }

  let idx = 0;
  let artG = null;           // <g> holding all letter art, carries the transform
  let guidePaths = [];       // {el, points, len, win, tiny, short} DISPLAY coords
  let guideLen = 0;          // total letter length, for ink-economy checks
  let inkTotal = 0, inkOk = 0, inkLen = 0;   // attempt-wide ink stats
  let sTotal = 0, sOk = 0, sLen = 0;         // current pen-stroke ink stats
  let lastS = null;          // previous pointer position in letter units
  let inkStrokes = [];       // recorded pen strokes (unit coords) — align replay
  let curStroke = null;
  let tplFlat = [];          // template points + tangents, flat (recognition v2)
  let tplShortC = [];        // centroids of short template strokes (accent snap)
  let ruleBand = null;       // [topY, baselineY] of the writing ruling (display)
  let coverage = [];         // per-stroke Set of covered sample indices
  let drawing = false;
  let lastPt = null;
  let drewAnything = false;
  let demoPlaying = false;
  let demoGen = 0;   // bumped on each loadLetter to cancel a stale demo loop

  // ---------- layout (JS-driven; CSS units alone break on older tablets) ----------
  // Older WebViews (e-ink tablets ship Chrome <105) lack container-query units,
  // and 100dvh/100vh over-report the viewport when browser chrome is visible —
  // the frame then overflows past the bottom of the screen. Measuring in JS
  // works everywhere: pin #app to the real visible height and make #frame the
  // largest square that fits the stage.
  const appEl   = document.getElementById("app");
  const stageEl = document.getElementById("stage");
  const frameEl = document.getElementById("frame");

  function layout() {
    const vh = (window.visualViewport && window.visualViewport.height) ||
               window.innerHeight;
    appEl.style.height = Math.round(vh) + "px";

    const cs = getComputedStyle(stageEl);
    const w = stageEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = stageEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const s = Math.max(80, Math.floor(Math.min(w, h)));
    frameEl.style.width = s + "px";
    frameEl.style.height = s + "px";
    sizeCanvas();
    updateDebug();
  }

  // ---------- ?debug overlay: real numbers straight from the device ----------
  const DEBUG = /\bdebug\b/.test(location.search);
  let dbgEl = null;
  function updateDebug() {
    if (!DEBUG) return;
    if (!dbgEl) {
      dbgEl = document.createElement("pre");
      dbgEl.style.cssText = "position:fixed;left:4px;top:4px;z-index:99;margin:0;" +
        "padding:6px 8px;background:#fff;border:2px solid #000;font:11px/1.45 monospace;" +
        "white-space:pre;max-width:96vw;overflow:hidden;pointer-events:none;";
      document.body.appendChild(dbgEl);
    }
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return Math.round(b.left) + "," + Math.round(b.top) + " " +
             Math.round(b.width) + "x" + Math.round(b.height);
    };
    const vv = window.visualViewport;
    dbgEl.textContent =
      "v " + APPV + "\n" +
      "ua " + navigator.userAgent.slice(0, 72) + "\n" +
      "inner " + window.innerWidth + "x" + window.innerHeight +
      "  vv " + (vv ? Math.round(vv.width) + "x" + Math.round(vv.height) : "-") +
      "  dpr " + (window.devicePixelRatio || 1) + "\n" +
      "cq " + (window.CSS && CSS.supports ? CSS.supports("width", "1cqw") : "?") +
      "  dvh " + (window.CSS && CSS.supports ? CSS.supports("height", "100dvh") : "?") + "\n" +
      "app    " + r(appEl) + "\n" +
      "stage  " + r(stageEl) + "\n" +
      "frame  " + r(frameEl) + "\n" +
      "bar    " + r(document.getElementById("actionbar"));
  }

  // Pencil width, two modes:
  //  auto   — matches the guide shadow exactly (guideW × size × frame px)
  //  manual — fixed px from the drawer's Zīmulis slider (6..37)
  // lv_ink stores "auto" or the manual number. Default: auto.
  const inkStored = localStorage.getItem("lv_ink");
  let inkAuto = inkStored === null || inkStored === "auto";
  let inkW = parseInt(inkStored || "12", 10);
  if (!(inkW >= 6 && inkW <= 37)) { inkW = 12; }

  function autoInkWidth() {
    const r = canvas.getBoundingClientRect();
    // memory mode has no shadow to match — track the demo stroke width instead
    return (LEVELS[level].guideW || 5) * (size / 100) * (r.width / 100);
  }
  function inkWidth() { return inkAuto ? autoInkWidth() : inkW; }

  // ---------- canvas sizing (retina) ----------
  function sizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = inkWidth();
    applyInkColor();
  }

  // pen colour = the theme's --ink (indigo in colourful, black in e-ink)
  function applyInkColor() {
    ctx.strokeStyle = getComputedStyle(document.documentElement)
      .getPropertyValue("--ink").trim() || "#000";
  }

  function toPx(p) {
    const r = canvas.getBoundingClientRect();
    return { x: (p.x / 100) * r.width, y: (p.y / 100) * r.height };
  }
  function toSvg(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * 100,
      y: ((ev.clientY - r.top) / r.height) * 100,
    };
  }

  function updateProgress() {
    prog.textContent = (idx + 1) + " / " + LETTERS.length;
  }

  // ---------- build guide for current letter ----------
  function samplePath(el, n) {
    const len = el.getTotalLength();
    const pts = [];
    const steps = Math.max(n, Math.ceil(len / 3));
    for (let i = 0; i <= steps; i++) {
      const p = el.getPointAtLength((len * i) / steps);
      pts.push({ x: p.x, y: p.y });
    }
    return pts;
  }

  function loadLetter(playAnim) {
    const entry = LETTERS[idx];
    const strokes = strokesFor(entry);
    const cfg = LEVELS[level];

    guideSvg.innerHTML = "";
    M = letterMatrix();
    // writing ruling: cap band for uppercase, body band for lowercase —
    // scaled by the same matrix as the letter, so it tracks Burtu izmērs
    const ruleYs = lower ? [44, 82] : [14, 87];
    ruleBand = ruleYs.map(y => M.d * y + M.f);
    for (const ry of ruleBand) {
      const ln = document.createElementNS(SVGNS, "line");
      ln.setAttribute("x1", 2);  ln.setAttribute("x2", 98);
      ln.setAttribute("y1", ry); ln.setAttribute("y2", ry);
      ln.setAttribute("class", "rule-line");
      guideSvg.appendChild(ln);
    }
    // everything visual lives inside this group, so the slant/size transform
    // applies uniformly to guides, numbers, arrows and the demo pen
    artG = document.createElementNS(SVGNS, "g");
    artG.setAttribute("transform", matrixStr(M));
    guideSvg.appendChild(artG);
    guidePaths = [];
    coverage = [];
    guideLen = 0;
    inkTotal = inkOk = inkLen = 0;
    inkStrokes = []; curStroke = null;
    demoGen++;            // invalidate any in-flight demo from a previous letter
    demoPlaying = false;
    // cancel pending ✓-advance / ✗-clear: navigating during an overlay must
    // not advance twice or wipe the next letter's ink
    clearTimeout(advanceTimer);
    clearTimeout(failTimer);
    clearTimeout(verdictTimer);
    okBox.classList.remove("show");
    badBox.classList.remove("show");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drewAnything = false;
    nameEl.textContent = entry.char;
    updateProgress();

    strokes.forEach((d, i) => {
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "guide-stroke");
      path.style.strokeWidth = cfg.guideW;   // inline style beats the CSS class rule
      // memory mode: no shadow. visibility (not display) — the path must stay
      // in the render tree so samplePath can still measure its geometry.
      if (!cfg.guideW) path.style.visibility = "hidden";
      artG.appendChild(path);

      // local = the path's own coords; numbers/arrows live inside artG and use
      // those. Coverage compares against pointer coords, so it needs display
      // coords — map them through the same matrix artG is drawn with.
      const local = samplePath(path, 24);
      const dpts = local.map(p => applyM(M, p));
      let plen = 0;
      for (let k = 1; k < dpts.length; k++) {
        plen += Math.hypot(dpts[k].x - dpts[k-1].x, dpts[k].y - dpts[k-1].y);
      }
      const spacing = plen / Math.max(1, dpts.length - 1);
      guidePaths.push({
        el: path, points: dpts, len: plen,
        // progression credit: a sample credits only ~2 units of arc around its
        // closest approach, so completing a stroke means travelling along it
        win: Math.max(1, Math.round(2.0 / Math.max(spacing, 1e-6))),
        tiny:  plen <= 8,    // dots: tap-friendly, whole-stroke credit
        short: plen <= 18,   // commas/short bars: no ends/run requirements
        alignShort: plen <= 28,   // accents, relaxed in align mode only
      });
      coverage.push(new Set());
      guideLen += plen;

      // Viegli: start dot + direction chevrons. Both are GUIDANCE, not
      // enforced rules — validation accepts either travel direction.
      if (cfg.arrows) {
        addChevrons(local);
        if (plen >= 12 * M.a) {
          const dot = document.createElementNS(SVGNS, "circle");
          dot.setAttribute("cx", local[0].x);
          dot.setAttribute("cy", local[0].y);
          dot.setAttribute("r", 2.6);
          dot.setAttribute("class", "startdot");
          artG.appendChild(dot);
        }
      }
    });

    // recognition v2 needs the template as flat point+tangent arrays and the
    // centroids of its short strokes (accent snap targets)
    tplFlat = [];
    tplShortC = [];
    for (const g of guidePaths) {
      const pts = g.points, n = pts.length;
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
        tplFlat.push({ x: pts[i].x, y: pts[i].y,
                       tx: (b.x - a.x) / L, ty: (b.y - a.y) / L });
      }
      if (g.len <= 34) {
        let sx = 0, sy = 0;
        for (const p of pts) { sx += p.x; sy += p.y; }
        tplShortC.push({ x: sx / n, y: sy / n });
      }
    }

    // memory mode always demos — with no shadow, the animation is the only
    // way to see the letter, whatever the Animācija toggle says
    if ((animOn || !cfg.guideW) && playAnim !== false) setTimeout(playDemo, 350);
  }

  function addChevrons(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i-1].x, pts[i].y - pts[i-1].y));
    }
    const total = cum[cum.length - 1];
    if (total < 12) return;
    for (let s = 12; s <= total - 8; s += 22) {
      let j = 0;
      while (j < cum.length - 1 && cum[j] < s) j++;
      let a = j, b = j;
      while (a > 0 && cum[j] - cum[a] < 2.5) a--;
      while (b < pts.length - 1 && cum[b] - cum[j] < 2.5) b++;
      const dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
      const L = Math.hypot(dx, dy) || 1e-9;
      const tx = dx / L, ty = dy / L, nx = -ty, ny = tx;
      const sz = 2.2, px = pts[j].x, py = pts[j].y;
      const d = "M" + (px - tx*sz*0.7 + nx*sz).toFixed(1) + "," + (py - ty*sz*0.7 + ny*sz).toFixed(1) +
                " L" + (px + tx*sz).toFixed(1) + "," + (py + ty*sz).toFixed(1) +
                " L" + (px - tx*sz*0.7 - nx*sz).toFixed(1) + "," + (py - ty*sz*0.7 - ny*sz).toFixed(1);
      const el = document.createElementNS(SVGNS, "path");
      el.setAttribute("d", d);
      el.setAttribute("class", "dirarrow");
      artG.appendChild(el);
    }
  }

  // ---------- animation demo ----------
  function playDemo() {
    if (demoPlaying || !guidePaths.length) return;
    demoPlaying = true;
    const myGen = demoGen;   // this demo belongs to the current letter only
    clearInk();

    // pen dot
    const pen = document.createElementNS(SVGNS, "circle");
    pen.setAttribute("r", "4.5");
    pen.setAttribute("class", "demo-pen");
    artG.appendChild(pen);   // inside the transform, like the guides it follows

    const demoEls = [];   // black strokes drawn during the demo, cleared at the end

    let si = 0;
    function animStroke() {
      if (myGen !== demoGen) { return; }   // letter changed mid-demo: abort quietly
      if (si >= guidePaths.length) {
        pen.remove();
        demoEls.forEach(el => el.remove());   // wipe the black demo so only the gray guide remains
        demoPlaying = false;
        return;
      }
      const el = guidePaths[si].el;
      const len = el.getTotalLength();
      // reveal path via dash offset
      const demo = document.createElementNS(SVGNS, "path");
      demo.setAttribute("d", el.getAttribute("d"));
      demo.setAttribute("class", "demo-stroke");
      demo.style.strokeWidth = LEVELS[level].guideW || 5;   // visible even in memory mode
      demo.style.strokeDasharray = len;
      demo.style.strokeDashoffset = len;
      artG.appendChild(demo);
      demoEls.push(demo);

      const dur = Math.max(500, len * 12); // ms, proportional to stroke length
      const t0 = performance.now();
      function frame(t) {
        if (myGen !== demoGen) { return; }   // stop cleanly if letter changed
        const k = Math.min(1, (t - t0) / dur);
        demo.style.strokeDashoffset = len * (1 - k);
        const p = el.getPointAtLength(len * k);
        pen.setAttribute("cx", p.x);
        pen.setAttribute("cy", p.y);
        if (k < 1) {
          requestAnimationFrame(frame);
        } else {
          si++;
          setTimeout(animStroke, 250);
        }
      }
      requestAnimationFrame(frame);
    }
    animStroke();
  }

  // ---------- drawing ----------
  // Exact point-to-segment distance. Distance to the sampled POINTS is noisy at
  // roughly half the sample spacing (~1.5 units) — wider than the gap between a
  // letter and its accent (Ļ's comma sits 1 unit below the L's bar), so it
  // cannot tell them apart.
  function segDist(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - a.x) * dx + (py - a.y) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
  }
  function strokeDist(px, py, pts) {
    let m = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = segDist(px, py, pts[i], pts[i + 1]);
      if (d < m) m = d;
    }
    return m;
  }

  // Nearest stroke only (ties credit both — touching strokes). Within it,
  // PROGRESSION CREDIT: only ~2 units of arc around the closest approach.
  // Crediting the whole R-ball let an X or scribble complete letters: one
  // sample painted a 24-unit window, so crossings counted as tracing.
  // Pure: updates coverage only; callers keep their own ink stats.
  function creditSample(sx, sy, R) {
    const R2 = R * R;
    const d = guidePaths.map(g => strokeDist(sx, sy, g.points));
    let best = 0;
    for (let i = 1; i < d.length; i++) if (d[i] < d[best]) best = i;
    if (d[best] > R) return false;
    for (let si = 0; si < guidePaths.length; si++) {
      if (d[si] > d[best] + 1e-9) continue;
      const g = guidePaths[si], pts = g.points;
      if (g.tiny) {
        // dots: a tap anywhere near credits the whole mark
        for (let k = 0; k < pts.length; k++) {
          const dx = pts[k].x - sx, dy = pts[k].y - sy;
          if (dx * dx + dy * dy <= R2) coverage[si].add(k);
        }
        continue;
      }
      let j = 0, bd = Infinity;
      for (let k = 0; k < pts.length; k++) {
        const dx = pts[k].x - sx, dy = pts[k].y - sy;
        const dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; j = k; }
      }
      const hi = Math.min(pts.length - 1, j + g.win);
      for (let k = Math.max(0, j - g.win); k <= hi; k++) coverage[si].add(k);
    }
    return true;
  }

  function markCoverage(sx, sy) {
    if (!guidePaths.length) return;
    inkTotal++; sTotal++;
    // align mode scores via alignedCheck's replay — live position is
    // irrelevant there (the whole point is drawing anywhere)
    if (LEVELS[level].align) return;
    // scale tolerance with the letter: a fixed radius on a shrunken letter
    // would span neighbouring strokes and let a scribble pass
    const R = LEVELS[level].R * (size / 100);
    if (creditSample(sx, sy, R)) { inkOk++; sOk++; }
  }

  // fast swipes deliver sparse events; mark along the segment so progression
  // credit has no gaps (its window is only ~2 units wide)
  function markAlong(a, b) {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    inkLen += dist; sLen += dist;
    const steps = Math.max(1, Math.ceil(dist / 1.2));
    for (let i = 1; i <= steps; i++) {
      markCoverage(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
    }
  }

  // one pointer draws at a time; a pen preempts a resting palm (touch)
  let activeId = null, activeType = "";

  function startDraw(ev) {
    ev.preventDefault();
    if (demoPlaying) return;
    if (okBox.classList.contains("show") || badBox.classList.contains("show")) return;
    if (drawing) {
      if (ev.pointerType === "pen" && activeType !== "pen") {
        drawing = false;   // abandon the palm's stroke, no junk verdict for it
      } else {
        return;            // second finger/palm while drawing: ignore
      }
    }
    activeId = ev.pointerId;
    activeType = ev.pointerType || "";
    drawing = true;
    drewAnything = true;
    clearTimeout(verdictTimer);   // still drawing — no verdict yet
    sTotal = sOk = 0; sLen = 0;
    curStroke = [];
    ctx.lineWidth = inkWidth();   // re-read: level/size may have changed since
    const s = toSvg(ev);
    lastPt = toPx(s);
    lastS = s;
    curStroke.push(s);
    markCoverage(s.x, s.y);
    ctx.beginPath();
    ctx.moveTo(lastPt.x, lastPt.y);
    ctx.lineTo(lastPt.x + 0.1, lastPt.y + 0.1);
    ctx.stroke();
  }
  function moveDraw(ev) {
    if (!drawing || ev.pointerId !== activeId) return;
    ev.preventDefault();
    let evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : null;
    if (!evs || evs.length === 0) evs = [ev];
    for (const e of evs) {
      const s = toSvg(e);
      const p = toPx(s);
      ctx.beginPath();
      ctx.moveTo(lastPt.x, lastPt.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastPt = p;
      curStroke.push(s);
      markAlong(lastS, s);
      lastS = s;
    }
  }
  function endDraw(ev) {
    if (!drawing || (ev && ev.pointerId !== activeId)) return;
    drawing = false;
    if (curStroke && curStroke.length > 1) inkStrokes.push(curStroke);
    curStroke = null;
    if (LEVELS[level].align) { alignedCheck(); return; }
    // a substantial pen stroke that mostly missed the letter is junk — ✗ now
    if (sLen >= 15 && sTotal > 0 && sOk / sTotal < 0.35) { fail(); return; }
    check();
  }

  // ---------- validation ----------
  // A stroke counts as traced when: enough of it is covered, BOTH ends were
  // reached, and the coverage forms one long sweep (gap-tolerant run) — not
  // fragments left by crossings. Tiny/short strokes (dots, commas, short
  // bars) relax the rules a wandering hand can't satisfy at that scale.
  // Constants tuned by simulation against X/scribble attacks vs split /
  // one-drag / sloppy tracing on all 66 letters (see memory notes).
  function strokeDone(i, thArg, alignMode) {
    const g = guidePaths[i], n = g.points.length, cov = coverage[i];
    const th = thArg || LEVELS[level].thresh;
    if (g.tiny)  return cov.size / n >= Math.min(th, 0.5);
    // in align mode accents (macrons, carons, commas <= 28 units) relax too:
    // their GAP from the body varies between hands, ends/run are unfair there
    if (g.short || (alignMode && g.alignShort)) return cov.size / n >= Math.min(th, 0.7);
    if (cov.size / n < th) return false;
    const head = Math.max(1, Math.ceil(n * 0.12));
    let hasHead = false, hasTail = false;
    cov.forEach(k => {
      if (k < head) hasHead = true;
      if (k >= n - head) hasTail = true;
    });
    if (!hasHead || !hasTail) return false;
    // longest run, bridging holes of <= 4 indices (adjacent doubled segments
    // in recorded handwriting steal a few indices from an honest trace)
    const ks = [...cov].sort((a, b) => a - b);
    let bestRun = 0, runStart = ks[0], prev = ks[0];
    for (let x = 1; x <= ks.length; x++) {
      const k = x < ks.length ? ks[x] : n + 99;
      if (k - prev > 5) {
        if (prev - runStart + 1 > bestRun) bestRun = prev - runStart + 1;
        runStart = k;
      }
      prev = k;
    }
    return bestRun >= 0.7 * n;
  }

  function check() {
    const cfg = LEVELS[level];
    if (!drewAnything || !guidePaths.length) return;

    let doneN = 0;
    for (let i = 0; i < guidePaths.length; i++) if (strokeDone(i)) doneN++;
    const total = guidePaths.length;
    const prec = inkTotal ? inkOk / inkTotal : 0;

    if (doneN === total && inkLen >= 0.6 * guideLen) {
      if (prec >= cfg.prec) succeed();
      else fail();                      // "complete" but mostly junk ink
      return;
    }
    // wrong-attempt signals: far too much ink, or a letter's worth of ink
    // with less than half the strokes to show for it
    if (inkLen >= 1.9 * guideLen ||
        (inkLen >= 1.1 * guideLen && doneN < 0.5 * total)) {
      fail();
    }
  }

  let verdictTimer = null;   // Grūti: pending "you stopped — is it right?" ✗

  // ---------- Grūti: aligned shape matching ----------
  // The letter may be drawn ANYWHERE at any size: the ink is translated and
  // uniformly scaled so its centroid and RMS radius match the template's,
  // then validated with the standard machinery at a TIGHTER tolerance —
  // position is already forgiven, so the fat live R is not justified.
  // No rotation: a rotated letter is wrong. Stroke count/order are ignored:
  // the template's segmentation is idiosyncratic to the recording (H was
  // recorded as one looping stroke; families draw it as three).
  // Constants tuned in tools/sim_align.py: correct-anywhere 264/264,
  // attacks 2/132, confusions 2/198.
  // Recognition engine v2 (tools/engine2.py is the tuned reference):
  //  1. per-axis centroid/RMS alignment  2. resample ink at 2-unit spacing
  //  3. two ICP refinement passes        4. bounded local snap for accents
  //  5. coverage/ends/run replay + symmetric worst-10% distance tails +
  //     tangent-direction agreement + ink economy.
  // Three-seed simulation: legit 785/792, attacks 0/396, confusions 1/594.
  const ALIGN = {
    R: 7, thresh: 0.72, dirMin: 0.75, tailF: 6.5, tailB: 5.2,
    scaleMin: 0.5, scaleMax: 3, minDiag: 18, snapMax: 8, step: 2.0,
  };

  function resampleStroke(st) {
    const out = [{ x: st[0].x, y: st[0].y }];
    let acc = 0;
    for (let i = 1; i < st.length; i++) {
      let ax = st[i - 1].x, ay = st[i - 1].y;
      const bx = st[i].x, by = st[i].y;
      let seg = Math.hypot(bx - ax, by - ay);
      while (acc + seg >= ALIGN.step) {
        const t = (ALIGN.step - acc) / seg;
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
    let bd = Infinity, bi = 0;
    for (let i = 0; i < tplFlat.length; i++) {
      const dx = tplFlat[i].x - p.x, dy = tplFlat[i].y - p.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = i; }
    }
    return { d: Math.sqrt(bd), i: bi };
  }

  function polyLen(st) {
    let L = 0;
    for (let i = 1; i < st.length; i++) L += Math.hypot(st[i].x - st[i-1].x, st[i].y - st[i-1].y);
    return L;
  }

  // shared recognition core: A0 = initialized (translated/scaled) ink strokes
  function recogCore(A0) {
    const n = guidePaths.length;
    let A = A0.map(resampleStroke);

    // ICP refinement: per-axis regression onto nearest template points
    for (let it = 0; it < 2; it++) {
      const pa = [], pq = [];
      for (const st of A) for (const p of st) {
        const nn = nearestTpl(p);
        if (nn.d <= 3 * ALIGN.R) { pa.push(p); pq.push(tplFlat[nn.i]); }
      }
      if (pa.length < 8) break;
      let max_ = 0, may = 0, mqx = 0, mqy = 0;
      for (let i = 0; i < pa.length; i++) {
        max_ += pa[i].x; may += pa[i].y; mqx += pq[i].x; mqy += pq[i].y;
      }
      max_ /= pa.length; may /= pa.length; mqx /= pa.length; mqy /= pa.length;
      let vax = 0, vay = 0, gxn = 0, gyn = 0;
      for (let i = 0; i < pa.length; i++) {
        vax += (pa[i].x - max_) ** 2; vay += (pa[i].y - may) ** 2;
        gxn += (pa[i].x - max_) * (pq[i].x - mqx);
        gyn += (pa[i].y - may) * (pq[i].y - mqy);
      }
      let gx = gxn / (vax || 1e-9), gy = gyn / (vay || 1e-9);
      gx = Math.min(Math.max(gx, 0.8), 1.25);
      gy = Math.min(Math.max(gy, 0.8), 1.25);
      A = A.map(st => st.map(p => ({ x: mqx + (p.x - max_) * gx,
                                     y: mqy + (p.y - may) * gy })));
    }

    // bounded local snap: small ink strokes onto nearest small template stroke
    for (let si = 0; si < A.length; si++) {
      const st = A[si];
      if (polyLen(st) > 30 || !tplShortC.length) continue;
      let scx = 0, scy = 0;
      for (const p of st) { scx += p.x; scy += p.y; }
      scx /= st.length; scy /= st.length;
      let bv = Infinity, bdx = 0, bdy = 0;
      for (const c of tplShortC) {
        const d = (c.x - scx) ** 2 + (c.y - scy) ** 2;
        if (d < bv) { bv = d; bdx = c.x - scx; bdy = c.y - scy; }
      }
      if (bv <= 100) {
        const dx = Math.max(-ALIGN.snapMax, Math.min(ALIGN.snapMax, bdx));
        const dy = Math.max(-ALIGN.snapMax, Math.min(ALIGN.snapMax, bdy));
        A[si] = st.map(p => ({ x: p.x + dx, y: p.y + dy }));
      }
    }

    // coverage replay + junk
    coverage = guidePaths.map(() => new Set());
    let junky = false, alen = 0;
    for (const st of A) {
      let jOk = 0;
      for (const p of st) if (creditSample(p.x, p.y, ALIGN.R)) jOk++;
      const L = polyLen(st);
      alen += L;
      if (L >= 15 && st.length > 0 && jOk / st.length < 0.35) junky = true;
    }

    let doneN = 0;
    for (let i = 0; i < n; i++) if (strokeDone(i, ALIGN.thresh, true)) doneN++;

    // symmetric worst-10% distance tails + direction agreement
    const apts = [];
    for (const st of A) for (const p of st) apts.push(p);
    const fwd = [];
    for (const q of tplFlat) {
      let bd = Infinity;
      for (const p of apts) {
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < bd) bd = d;
      }
      fwd.push(Math.sqrt(bd));
    }
    fwd.sort((a, b) => a - b);
    const bwd = [];
    let dirSum = 0, dirN = 0;
    for (const st of A) {
      const m = st.length;
      for (let i = 0; i < m; i++) {
        const nn = nearestTpl(st[i]);
        bwd.push(nn.d);
        if (nn.d <= ALIGN.R * 1.5) {
          const a = st[Math.max(0, i - 2)], b = st[Math.min(m - 1, i + 2)];
          const L = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
          const q = tplFlat[nn.i];
          dirSum += Math.abs(((b.x - a.x) / L) * q.tx + ((b.y - a.y) / L) * q.ty);
          dirN++;
        }
      }
    }
    bwd.sort((a, b) => a - b);
    const kf = Math.max(1, Math.floor(fwd.length / 10));
    const kb = Math.max(1, Math.floor(bwd.length / 10));
    let tailF = 0, tailB = 0;
    for (let i = fwd.length - kf; i < fwd.length; i++) tailF += fwd[i];
    for (let i = bwd.length - kb; i < bwd.length; i++) tailB += bwd[i];
    tailF /= kf; tailB /= kb;
    const dirScore = dirN ? dirSum / dirN : 0;

    const over = alen >= 1.9 * guideLen ||
                 (alen >= 1.1 * guideLen && doneN < 0.5 * n);
    const ok = doneN === n && alen >= 0.6 * guideLen && !junky && !over &&
               tailF <= ALIGN.tailF && tailB <= ALIGN.tailB &&
               dirScore >= ALIGN.dirMin;
    return { ok: ok, over: over, alen: alen, doneN: doneN };
  }

  function alignedCheck() {
    const n = guidePaths.length;
    if (!inkStrokes.length || !n || !tplFlat.length) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let cx = 0, cy = 0, cnt = 0;
    for (const st of inkStrokes) for (const p of st) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      cx += p.x; cy += p.y; cnt++;
    }
    if (Math.hypot(maxX - minX, maxY - minY) < ALIGN.minDiag) return;
    cx /= cnt; cy /= cnt;

    // ML recognition — the same on-device engine as the numbers. If the letter
    // model recognizes the ink as the target glyph, accept it; otherwise fall
    // through to the geometric align check below (union).
    if (typeof LetterNet !== "undefined" && LetterNet.ready &&
        LetterNet.verify(inkStrokes, LETTERS[idx].char)) { succeed(); return; }

    let tx = 0, ty = 0;
    for (const q of tplFlat) { tx += q.x; ty += q.y; }
    tx /= tplFlat.length; ty /= tplFlat.length;

    // RULED PATH first: written between the lines -> y is trusted as-is,
    // only x translates. This is the strong prior that fixes the misses.
    let ruled = null;
    if (ruleBand) {
      const bT = ruleBand[0], bB = ruleBand[1];
      const bh = Math.max(bB - bT, 1e-6);
      const span = maxY - minY;
      if (Math.abs((minY + maxY) / 2 - (bT + bB) / 2) <= 0.45 * bh &&
          span / bh >= 0.45 && span / bh <= 2.0) {
        ruled = recogCore(inkStrokes.map(st =>
          st.map(p => ({ x: p.x - cx + tx, y: p.y }))));
        if (ruled.ok) { succeed(); return; }
      }
    }

    // FREE PATH: per-axis alignment, works anywhere on screen
    let irx = 0, iry = 0;
    for (const st of inkStrokes) for (const p of st) {
      irx += (p.x - cx) * (p.x - cx); iry += (p.y - cy) * (p.y - cy);
    }
    irx = Math.max(Math.sqrt(irx / cnt), 1e-6);
    iry = Math.max(Math.sqrt(iry / cnt), 1e-6);
    let trx = 0, tryy = 0;
    for (const q of tplFlat) {
      trx += (q.x - tx) * (q.x - tx); tryy += (q.y - ty) * (q.y - ty);
    }
    trx = Math.max(Math.sqrt(trx / tplFlat.length), 1e-6);
    tryy = Math.max(Math.sqrt(tryy / tplFlat.length), 1e-6);
    const sx = trx / irx, sy = tryy / iry;

    let free = null;
    if (sx >= ALIGN.scaleMin && sx <= ALIGN.scaleMax &&
        sy >= ALIGN.scaleMin && sy <= ALIGN.scaleMax) {
      free = recogCore(inkStrokes.map(st =>
        st.map(p => ({ x: tx + (p.x - cx) * sx, y: ty + (p.y - cy) * sy }))));
      if (free.ok) { succeed(); return; }
    }

    const best = free || ruled;
    if (!best) return;                 // not judgeable yet — keep waiting
    if (best.over) { fail(); return; }
    if (best.alen >= 0.4 * guideLen) {
      clearTimeout(verdictTimer);
      verdictTimer = setTimeout(() => {
        if (!drawing && !okBox.classList.contains("show") &&
            !badBox.classList.contains("show")) fail();
      }, 3000);
    }
  }

  let failTimer = null;
  function fail() {
    if (badBox.classList.contains("show") || okBox.classList.contains("show")) return;
    clearTimeout(verdictTimer);
    badBox.classList.add("show");
    beep(150);
    clearTimeout(failTimer);
    failTimer = setTimeout(() => {
      badBox.classList.remove("show");
      clearInk();
      // memory mode: show the letter again after every miss, not just the
      // first — the demo is the only reference the child has
      if (LEVELS[level].align) setTimeout(playDemo, 250);
    }, 950);
  }

  let advanceTimer = null;
  function succeed() {
    okBox.classList.add("show");
    beep();
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(() => {
      idx = (idx + 1) % LETTERS.length;
      loadLetter();
    }, 1100);
  }

  // tiny sound — 660 Hz success chirp; fail() passes a low 150 Hz buzz
  let actx = null;
  function beep(freq) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.connect(g); g.connect(actx.destination);
      o.type = "sine"; o.frequency.value = freq || 660;
      g.gain.setValueAtTime(0.001, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, actx.currentTime + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.4);
      o.start(); o.stop(actx.currentTime + 0.42);
    } catch (e) {}
  }

  // ---------- settings drawer ----------
  const menu     = document.getElementById("menu");
  const backdrop = document.getElementById("backdrop");
  const menuBtn  = document.getElementById("menuBtn");
  const menuClose = document.getElementById("menuClose");
  let menuOpen = false;

  function setMenu(open) {
    menuOpen = open;
    menu.classList.toggle("open", open);
    backdrop.classList.toggle("open", open);
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    menuBtn.classList.toggle("active", open);
    (open ? menuClose : menuBtn).focus();
  }

  // ---------- setting explanations (ⓘ popups) ----------
  const INFO = {
    grutiba: { t: "Grūtība", p: [
      "Viegli — burts redzams kā pelēka ēna ar sākuma punktu un virziena bultiņām. Liela pielaide.",
      "Vidēji — tieva ēna bez palīgzīmēm. Jāraksta precīzāk.",
      "Grūti — ēnas nav! Noskaties animāciju un uzraksti burtu no galvas. Rakstīt var jebkurā vietā starp līnijām.",
    ]},
    burti: { t: "Burti", p: [
      "ABC / abc — pārslēdz starp lielajiem un mazajiem burtiem.",
      "Animācija — vai katram jaunam burtam automātiski parādīt, kā to raksta. Grūtajā līmenī animācija rādās vienmēr.",
    ]},
    cipari: { t: "Cipari", p: [
      "Animācija — vai katram jaunam ciparam automātiski parādīt, kā to raksta. Grūtajā līmenī animācija rādās vienmēr.",
    ]},
    izmers: { t: "Burtu izmērs", p: [
      "Cik liels burts redzams uz ekrāna. Rakstīšanas līnijas pielāgojas izmēram.",
    ]},
    zimulis: { t: "Zīmulis", p: [
      "Zīmuļa līnijas resnums.",
      "↺ Auto — resnums pielāgojas burta ēnai automātiski.",
      "Pavelc slīdni, lai iestatītu savu resnumu — tad Auto izslēdzas.",
    ]},
    ekrans: { t: "Ekrāns", p: [
      "Izvēlies ekrāna režīmu.",
      "E-tinte — augsts kontrasts, melns uz balta. Piemērots e-tintes (E-ink) planšetēm.",
      "Krāsains — dzīvīgas krāsas parastiem (LED/OLED) ekrāniem.",
    ]},
  };
  const infoPop   = document.getElementById("infoPop");
  const infoTitle = document.getElementById("infoTitle");
  const infoBody  = document.getElementById("infoBody");

  function openInfo(key) {
    const inf = INFO[key];
    if (!inf) return;
    infoTitle.textContent = inf.t;
    infoBody.textContent = "";
    for (const line of inf.p) {
      const p = document.createElement("p");
      p.textContent = line;
      infoBody.appendChild(p);
    }
    infoPop.classList.add("show");
  }
  document.querySelectorAll(".infobtn").forEach(b => {
    b.addEventListener("click", () => openInfo(b.dataset.info));
  });
  document.getElementById("infoClose").addEventListener("click", () => {
    infoPop.classList.remove("show");
  });
  infoPop.addEventListener("click", (e) => {
    if (e.target === infoPop) infoPop.classList.remove("show");
  });

  // ---------- display theme (E-ink vs colourful) ----------
  // The inline <head> script already set data-theme before first paint;
  // here we sync the toggle buttons and the canvas pen colour.
  let theme = localStorage.getItem("lv_theme") === "color" ? "color" : "eink";
  function applyTheme() {
    if (theme === "color") document.documentElement.dataset.theme = "color";
    else document.documentElement.removeAttribute("data-theme");
    document.querySelectorAll("[data-theme-btn]").forEach(b =>
      b.classList.toggle("active", b.dataset.themeBtn === theme));
    applyInkColor();
  }
  document.querySelectorAll("[data-theme-btn]").forEach(b => {
    b.addEventListener("click", () => {
      theme = b.dataset.themeBtn === "color" ? "color" : "eink";
      localStorage.setItem("lv_theme", theme);
      applyTheme();
    });
  });

  // ---------- letter picker ----------
  const picker      = document.getElementById("picker");
  const pickerGrid  = document.getElementById("pickerGrid");
  const pickerClose = document.getElementById("pickerClose");
  const gridBtn     = document.getElementById("gridBtn");
  let pickerOpen = false;

  function buildPicker() {
    pickerGrid.innerHTML = "";
    LETTERS.forEach((entry, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pcell" + (i === idx ? " cur" : "");
      b.dataset.idx = i;
      b.setAttribute("aria-label", entry.char);
      const c = document.createElement("span");
      c.className = "pch";
      c.textContent = entry.char;
      b.appendChild(c);
      pickerGrid.appendChild(b);
    });
  }

  function setPicker(open) {
    pickerOpen = open;
    if (open) buildPicker();   // rebuilt on open: case/stars/position may have moved
    picker.classList.toggle("open", open);
    gridBtn.setAttribute("aria-expanded", open ? "true" : "false");
    (open ? pickerClose : gridBtn).focus();
  }

  // ---------- controls ----------
  function clearInk() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    coverage = coverage.map(() => new Set());
    drewAnything = false;
    inkTotal = inkOk = inkLen = 0;
    inkStrokes = []; curStroke = null;
    clearTimeout(verdictTimer);
  }

  function setLevel(n) {
    level = n;
    localStorage.setItem("lv_level", String(n));
    document.querySelectorAll("[data-level]").forEach(b => {
      b.classList.toggle("active", parseInt(b.dataset.level, 10) === n);
    });
    loadLetter(!menuOpen);   // no point animating behind an open drawer
  }

  function updateAnimBtn() {
    document.getElementById("animToggle").textContent =
      "Animācija: " + (animOn ? "IESL." : "IZSL.");
    document.getElementById("animToggle").classList.toggle("active", animOn);
  }

  function updateCaseBtn() {
    // highlight the currently active case in the "ABC / abc" label
    const b = document.getElementById("caseToggle");
    if (!b) return;   // digits page has no case toggle
    b.textContent = lower ? "abc" : "ABC";
    b.classList.add("active");
  }

  function toggleCase() {
    lower = !lower;
    localStorage.setItem("lv_case", lower ? "lower" : "upper");
    LETTERS = lower ? LETTERS_LOWER : LETTERS_UPPER;
    idx = Math.min(idx, LETTERS.length - 1);   // keep position (both sets are 33)
    updateCaseBtn();
    loadLetter(!menuOpen);
  }

  function setSize(n) {
    size = n;
    localStorage.setItem("lv_size", String(n));
    sizeCanvas();          // pencil width tracks the letter size
    loadLetter(false);     // rebuild guides at the new scale, but don't replay
                           // the demo — dragging fires this on every tick
  }

  document.getElementById("clear").addEventListener("click", clearInk);
  document.getElementById("next").addEventListener("click", () => {
    idx = (idx + 1) % LETTERS.length; loadLetter();
  });
  document.getElementById("prev").addEventListener("click", () => {
    idx = (idx - 1 + LETTERS.length) % LETTERS.length; loadLetter();
  });
  document.querySelectorAll("[data-level]").forEach(b => {
    b.addEventListener("click", () => setLevel(parseInt(b.dataset.level, 10)));
  });
  document.getElementById("animToggle").addEventListener("click", () => {
    animOn = !animOn;
    localStorage.setItem("lv_anim", animOn ? "on" : "off");
    updateAnimBtn();
  });
  document.getElementById("showDemo").addEventListener("click", playDemo);
  var caseBtn = document.getElementById("caseToggle");
  if (caseBtn) caseBtn.addEventListener("click", toggleCase);
  menuBtn.addEventListener("click", () => setMenu(!menuOpen));
  menuClose.addEventListener("click", () => setMenu(false));
  backdrop.addEventListener("click", () => setMenu(false));

  gridBtn.addEventListener("click", () => setPicker(!pickerOpen));
  pickerClose.addEventListener("click", () => setPicker(false));
  pickerGrid.addEventListener("click", (e) => {
    const cell = e.target.closest(".pcell");
    if (!cell) return;
    idx = parseInt(cell.dataset.idx, 10);
    setPicker(false);
    loadLetter();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (infoPop.classList.contains("show")) infoPop.classList.remove("show");
    else if (pickerOpen) setPicker(false); // picker sits above the drawer
    else if (menuOpen) setMenu(false);
  });
  const sizeRange = document.getElementById("sizeRange");
  sizeRange.addEventListener("input", () => setSize(parseInt(sizeRange.value, 10)));
  const inkRange = document.getElementById("inkRange");
  const inkAutoBtn = document.getElementById("inkAuto");
  function updateInkUI() {
    inkAutoBtn.classList.toggle("active", inkAuto);
    // show the effective width on the slider thumb either way
    inkRange.value = Math.max(6, Math.min(37, Math.round(inkWidth())));
  }
  inkRange.addEventListener("input", () => {
    inkAuto = false;
    inkW = parseInt(inkRange.value, 10);
    localStorage.setItem("lv_ink", String(inkW));
    ctx.lineWidth = inkW;
    inkAutoBtn.classList.remove("active");
  });
  inkAutoBtn.addEventListener("click", () => {
    inkAuto = true;
    localStorage.setItem("lv_ink", "auto");
    ctx.lineWidth = inkWidth();
    updateInkUI();
  });

  // pointer events
  canvas.addEventListener("pointerdown", startDraw);
  canvas.addEventListener("pointermove", moveDraw);
  canvas.addEventListener("pointerup", endDraw);
  canvas.addEventListener("pointercancel", endDraw);
  canvas.addEventListener("pointerleave", endDraw);

  // resize / orientation
  let rzTimer = null;
  function onResize() {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      layout();
      if (!okBox.classList.contains("show") && !demoPlaying) clearInk();
    }, 150);
  }
  window.addEventListener("resize", onResize);
  window.addEventListener("orientationchange", () => setTimeout(onResize, 250));
  // browser chrome show/hide fires here but not always on window.resize
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onResize);
  }

  // init
  document.getElementById("appVer").textContent = "Versija: " + APPV;
  layout();
  sizeRange.value = size;
  updateInkUI();
  applyTheme();
  updateCaseBtn();
  setLevel(level);   // sets active button + loads first letter
  updateAnimBtn();
  // slow browsers (e-ink) settle their chrome/layout well after first paint;
  // re-measure once things calm down — cheap, and a no-op when nothing moved
  window.addEventListener("load", () => setTimeout(onResize, 300));
})();
