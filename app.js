"use strict";
(function () {
  var APPV = "a1b627a";   // keep in lockstep with the ?v= cache-buster in index.html
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
  // numbers/arrows: show hints | order: strokes must be traced in sequence
  // guideW: gray guide (shadow) stroke width — thinner on harder levels
  // guideW is purely the grey shadow's width — tolerance is R, so thinning it
  // costs no difficulty. guideW 0 = no shadow at all (memory mode).
  // Numbers/arrows are gone everywhere: on recorded handwriting strokes they
  // landed on top of the letter and pointed misleading directions.
  // prec = min fraction of the attempt's ink that must land on the letter
  const LEVELS = {
    1: { R: 12,  thresh: 0.70, prec: 0.60, order: false, guideW: 7 }, // Viegli: fat shadow, any order
    2: { R: 6.5, thresh: 0.85, prec: 0.60, order: true,  guideW: 4 }, // Vidēji: thin shadow, in order
    3: { R: 12,  thresh: 0.65, prec: 0.50, order: true,  guideW: 0 }, // Grūti: animation only, from memory
  };

  let level = parseInt(localStorage.getItem("lv_level") || "2", 10);
  if (!LEVELS[level]) level = 2;
  let animOn = localStorage.getItem("lv_anim") !== "off"; // default ON
  let lower = localStorage.getItem("lv_case") === "lower"; // default UPPER
  LETTERS = lower ? LETTERS_LOWER : LETTERS_UPPER;

  // ---------- letter transform ----------
  // Letters render upright (no slant). The size slider scales about the centre.
  let size = parseInt(localStorage.getItem("lv_size") || "100", 10);
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
  let coverage = [];         // per-stroke Set of covered sample indices
  let expected = 0;          // next stroke index (order mode)
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
      "footer " + r(document.querySelector("footer"));
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
    ctx.strokeStyle = "#000";
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
    // everything visual lives inside this group, so the slant/size transform
    // applies uniformly to guides, numbers, arrows and the demo pen
    artG = document.createElementNS(SVGNS, "g");
    artG.setAttribute("transform", matrixStr(M));
    guideSvg.appendChild(artG);
    guidePaths = [];
    coverage = [];
    expected = 0;
    guideLen = 0;
    inkTotal = inkOk = inkLen = 0;
    demoGen++;            // invalidate any in-flight demo from a previous letter
    demoPlaying = false;
    // cancel pending ✓-advance / ✗-clear: navigating during an overlay must
    // not advance twice or wipe the next letter's ink
    clearTimeout(advanceTimer);
    clearTimeout(failTimer);
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
      });
      coverage.push(new Set());
      guideLen += plen;
    });

    // memory mode always demos — with no shadow, the animation is the only
    // way to see the letter, whatever the Animācija toggle says
    if ((animOn || !cfg.guideW) && playAnim !== false) setTimeout(playDemo, 350);
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

  function markCoverage(sx, sy) {
    // scale tolerance with the letter: a fixed radius on a shrunken letter
    // would span neighbouring strokes and let a scribble pass
    const R = LEVELS[level].R * (size / 100);
    const R2 = R * R;
    if (!guidePaths.length) return;

    // Nearest stroke only (ties credit both — touching strokes). Within it,
    // PROGRESSION CREDIT: only ~2 units of arc around the closest approach.
    // Crediting the whole R-ball let an X or scribble complete letters: one
    // sample painted a 24-unit window, so crossings counted as tracing.
    const d = guidePaths.map(g => strokeDist(sx, sy, g.points));
    let best = 0;
    for (let i = 1; i < d.length; i++) if (d[i] < d[best]) best = i;

    let credited = false;
    if (d[best] <= R) {
      for (let si = 0; si < guidePaths.length; si++) {
        if (d[si] > d[best] + 1e-9) continue;
        const g = guidePaths[si], pts = g.points;
        if (g.tiny) {
          // dots: a tap anywhere near credits the whole mark
          for (let k = 0; k < pts.length; k++) {
            const dx = pts[k].x - sx, dy = pts[k].y - sy;
            if (dx * dx + dy * dy <= R2) coverage[si].add(k);
          }
          credited = true;
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
        credited = true;
      }
    }
    inkTotal++; sTotal++;
    if (credited) { inkOk++; sOk++; }
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
    sTotal = sOk = 0; sLen = 0;
    ctx.lineWidth = inkWidth();   // re-read: level/size may have changed since
    const s = toSvg(ev);
    lastPt = toPx(s);
    lastS = s;
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
      markAlong(lastS, s);
      lastS = s;
    }
  }
  function endDraw(ev) {
    if (!drawing || (ev && ev.pointerId !== activeId)) return;
    drawing = false;
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
  function strokeDone(i) {
    const g = guidePaths[i], n = g.points.length, cov = coverage[i];
    const th = LEVELS[level].thresh;
    if (g.tiny)  return cov.size / n >= Math.min(th, 0.5);
    if (g.short) return cov.size / n >= Math.min(th, 0.7);
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
    if (cfg.order) {
      while (expected < guidePaths.length && strokeDone(expected)) expected++;
      doneN = expected;
    } else {
      for (let i = 0; i < guidePaths.length; i++) if (strokeDone(i)) doneN++;
    }
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

  let failTimer = null;
  function fail() {
    if (badBox.classList.contains("show") || okBox.classList.contains("show")) return;
    badBox.classList.add("show");
    beep(150);
    clearTimeout(failTimer);
    failTimer = setTimeout(() => {
      badBox.classList.remove("show");
      clearInk();
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
    expected = 0;
    drewAnything = false;
    inkTotal = inkOk = inkLen = 0;
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
  document.getElementById("caseToggle").addEventListener("click", toggleCase);
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
    if (pickerOpen) setPicker(false);      // picker sits above the drawer
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
  layout();
  sizeRange.value = size;
  updateInkUI();
  updateCaseBtn();
  setLevel(level);   // sets active button + loads first letter
  updateAnimBtn();
  // slow browsers (e-ink) settle their chrome/layout well after first paint;
  // re-measure once things calm down — cheap, and a no-op when nothing moved
  window.addEventListener("load", () => setTimeout(onResize, 300));
})();
