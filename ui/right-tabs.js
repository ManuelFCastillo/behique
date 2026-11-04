// Tabs for the dashboard's right column: Evidence chain, Ask the model why, AI stages. One shows at a time instead of one long stack.
// It only adds a tab bar and a data attribute on .rightcol; the cards keep their own show and hide logic, and CSS hides the inactive ones.
(function () {
  "use strict";
  var TABS = [
    { id: "chain", label: "Evidence chain", short: "Chain", card: "evidenceCard" },
    { id: "ask", label: "Ask the model why", short: "Ask why", card: "askCard" },
    { id: "ai", label: "AI stages", short: "AI stages", card: "aiCard" },
  ];
  var KEY = "behique.rightTab";
  var CSS = [
    ".rtabs{display:flex;flex:none;gap:4px;margin-bottom:10px;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:30;background:var(--bg);max-width:100%;overflow-x:auto;scrollbar-width:none}",
    "html:not(.rd) body{overflow-x:clip}", // Classic's overflow-x:hidden makes body a scroll container, so nothing could stick to the page; clip hides the same overflow without that
    ".rtabs::-webkit-scrollbar{display:none}",
    ".rtabs button{flex:0 0 auto;background:none;border:none;border-bottom:2px solid transparent;color:var(--muted);font-size:13px;font-weight:700;padding:8px 10px;cursor:pointer;margin-bottom:-1px;white-space:nowrap}",
    ".rtabs.compact button{padding:8px 7px;font-size:12px}",
    ".rtabs button:hover{color:var(--text)}",
    ".rtabs button[aria-selected=true]{color:var(--text);border-bottom-color:var(--amber)}",
    ".rtabs .rt-n{margin-left:6px;font-size:11px;color:var(--purple);border:1px solid var(--purple);border-radius:999px;padding:0 6px}",
    ".rightcol[data-tab=chain] #askCard,.rightcol[data-tab=chain] #aiCard,.rightcol[data-tab=ask] #evidenceCard,.rightcol[data-tab=ask] #aiCard,.rightcol[data-tab=ai] #evidenceCard,.rightcol[data-tab=ai] #askCard{display:none !important}",
    ".rightcol[data-tab=ask] #askCard,.rightcol[data-tab=ai] #aiCard{margin-top:0}",
  ].join("\n");

  function stored() { try { var v = localStorage.getItem(KEY); return TABS.some(function (t) { return t.id === v; }) ? v : "chain"; } catch (e) { return "chain"; } }
  function remember(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function init() {
    var col = document.querySelector(".rightcol");
    if (!col || col.querySelector(".rtabs")) return;
    var st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    var bar = document.createElement("div"); bar.className = "rtabs"; bar.setAttribute("role", "tablist"); bar.setAttribute("aria-label", "Report details");
    var btns = {};
    var stickNow = function () {};
    function select(id, focus) {
      col.setAttribute("data-tab", id); remember(id);
      TABS.forEach(function (t) { var b = btns[t.id]; b.setAttribute("aria-selected", t.id === id ? "true" : "false"); b.tabIndex = t.id === id ? 0 : -1; });
      if (focus) btns[id].focus();
    }
    TABS.forEach(function (t, i) {
      var b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "tab"); b.id = "rtab-" + t.id; b.textContent = t.label;
      b.addEventListener("click", function () { select(t.id, false); });
      b.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault(); select(TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length].id, true);
      });
      btns[t.id] = b; bar.appendChild(b);
    });
    col.insertBefore(bar, col.firstChild);
    select(stored(), false);

    // a narrow column (Classic, or a small window) gets short labels so every tab stays on screen
    function fit() {
      var narrow = col.clientWidth < 440; bar.classList.toggle("compact", narrow);
      TABS.forEach(function (t) { var b = btns[t.id], text = narrow ? t.short : t.label; if (b.firstChild && b.firstChild.nodeType === 3) { if (b.firstChild.nodeValue !== text) b.firstChild.nodeValue = text; } });
    }
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(col); else window.addEventListener("resize", fit);

    // stick just below the dashboard's own fixed top bar when it is showing, at the very top otherwise;
    // in a layout where the column scrolls by itself (Dock) the top of the column is the top
    function stick() {
      var rd = document.getElementById("rdBar"), shown = rd && getComputedStyle(rd).position === "fixed" && rd.offsetHeight > 0;
      var own = /(auto|scroll)/.test(getComputedStyle(col).overflowY);
      var top = !own && shown ? rd.offsetHeight + 6 + "px" : "0px";
      if (bar.style.top !== top) bar.style.top = top;
    }
    stick(); stickNow = stick;
    // switching layout changes who scrolls, so do not wait for the timer below
    var seg = document.getElementById("rdSeg"); if (seg) seg.addEventListener("click", function () { setTimeout(stickNow, 0); });
    // a count on the AI tab once the card has drawn stages
    setInterval(function () {
      stick();
      var n = document.querySelectorAll("#aiCard .ai-stage").length, b = btns.ai, old = b.querySelector(".rt-n");
      if (!n) { if (old) old.remove(); return; }
      if (!old) { old = document.createElement("span"); old.className = "rt-n"; b.appendChild(old); }
      if (old.textContent !== String(n)) old.textContent = String(n);
    }, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
