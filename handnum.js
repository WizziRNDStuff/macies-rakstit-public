// Handwritten numbers for the maths pages: the user's own recorded digits
// (letters.js, LETTERS_DIGITS) plus simple hand-drawn + − = < > ?, laid out as
// one inline SVG that is 1em tall, so it scales with the surrounding font and
// takes its colour from CSS `color` (good/bad/guide classes keep working).
// Needs letters.js loaded first. Setting: localStorage lv_num_hand ("0" = printed; default handwritten).
var HandNum = (function () {
  "use strict";
  var SVGNS = "http://www.w3.org/2000/svg";
  var Y0 = 8, YH = 86;          // vertical window of the 0..100 glyph box -> 1em
  var GAP = 7, STROKE = 6.5;    // glyph spacing and line weight, glyph units

  var G = {};
  LETTERS_DIGITS.forEach(function (e) { G[e.char] = strokesFor(e); });
  // operators, centred on the digits' middle (~y 51)
  G["+"] = ["M32,52 L68,52", "M50,34 L50,70"];
  G["−"] = G["-"] = ["M32,52 L68,52"];
  G["="] = ["M32,42 L68,42", "M32,62 L68,62"];
  G["<"] = ["M66,32 L34,52 L66,72"];
  G[">"] = ["M34,32 L66,52 L34,72"];
  G["?"] = ["M37,33 Q38,19 51,18 Q65,18 65,32 Q65,42 54,47 Q50,50 50,58 L50,63", "M50,76 L50,78"];

  // x extent from the path's absolute coordinates (letters.js uses M/L/Q only)
  var EXT = {};
  function ext(ch) {
    if (EXT[ch]) return EXT[ch];
    var lo = Infinity, hi = -Infinity;
    G[ch].forEach(function (d) {
      var n = d.match(/-?\d+(\.\d+)?/g) || [];
      for (var i = 0; i < n.length; i += 2) {
        var x = parseFloat(n[i]);
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    });
    return (EXT[ch] = [lo, hi]);
  }

  function svg(str) {
    var s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "hn");
    s.setAttribute("aria-hidden", "true");
    var cursor = 0;
    String(str).split("").forEach(function (ch) {
      if (!G[ch]) return;
      var e = ext(ch);
      var g = document.createElementNS(SVGNS, "g");
      g.setAttribute("transform", "translate(" + (cursor - e[0]) + ",0)");
      G[ch].forEach(function (d) {
        var p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", d);
        g.appendChild(p);
      });
      s.appendChild(g);
      cursor += (e[1] - e[0]) + GAP;
    });
    var w = Math.max(1, cursor - GAP);
    var pad = STROKE;              // keep round caps inside the box
    s.setAttribute("viewBox", (-pad) + " " + Y0 + " " + (w + 2 * pad) + " " + YH);
    s.style.width = ((w + 2 * pad) / YH) + "em";
    return s;
  }

  function on() {
    // default ON (handwritten) — only an explicit "0" means printed
    try { return localStorage.getItem("lv_num_hand") !== "0"; } catch (e) { return true; }
  }

  // render `str` into el, handwritten or as plain text; remembers the value
  // so rerender() can switch styles in place
  function put(el, str) {
    str = String(str);
    el.setAttribute("data-v", str);
    var keep = el.hasAttribute("data-label-fixed");   // e.g. "mazāks" on < buttons
    if (on()) {
      el.textContent = "";
      el.appendChild(svg(str));
      if (!keep) el.setAttribute("aria-label", str);
    } else {
      el.textContent = str;
      if (!keep) el.removeAttribute("aria-label");
    }
  }
  function rerender(els) {
    els.forEach(function (el) { if (el.hasAttribute("data-v")) put(el, el.getAttribute("data-v")); });
  }

  return { svg: svg, put: put, rerender: rerender, on: on, STROKE: STROKE };
})();
