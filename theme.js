// Shared screen theme: "eink" (default), "color", "dark" — one lv_theme key
// for every page. Load in <head> (sync) so data-theme is set before first
// paint. Any [data-theme-btn="eink|color|dark"] button works with no page
// code; pages that need to redraw (canvas pen colour, accents) listen for the
// "lvtheme" event on document.
(function () {
  "use strict";
  var THEMES = ["eink", "color", "dark"];

  function get() {
    var t = null;
    try { t = localStorage.getItem("lv_theme"); } catch (e) {}
    return THEMES.indexOf(t) >= 0 ? t : "eink";
  }
  function apply() {
    var t = get(), root = document.documentElement;
    if (t === "eink") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
    if (document.body) {
      var bs = document.querySelectorAll("[data-theme-btn]");
      for (var i = 0; i < bs.length; i++) {
        var on = bs[i].getAttribute("data-theme-btn") === t;
        bs[i].classList.toggle("active", on);
        bs[i].setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    return t;
  }
  function set(t) {
    if (THEMES.indexOf(t) < 0) t = "eink";
    try { localStorage.setItem("lv_theme", t); } catch (e) {}
    apply();
    var ev;
    try { ev = new CustomEvent("lvtheme", { detail: t }); }
    catch (e) { ev = document.createEvent("CustomEvent"); ev.initCustomEvent("lvtheme", false, false, t); }
    document.dispatchEvent(ev);
  }

  apply();
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-theme-btn]") : null;
    if (b) set(b.getAttribute("data-theme-btn"));
  });

  window.LVTheme = { get: get, set: set, apply: apply };
})();
