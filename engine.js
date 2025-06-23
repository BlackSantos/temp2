/* ====================================================================
   engine.js – парсер, движок, главное/пауза-меню, fade-переходы и концовка
   ==================================================================== */

/* ---------- УТИЛИТЫ ------------------------------------------------ */
const ind = s => s.length - s.trimStart().length;               // длина отступа
const noComment = s => {                                        // убирает # … (не в кавычках)
  let out = "", str = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && s[i - 1] !== "\\") str = !str;
    if (c === "#" && !str) break;
    out += c;
  }
  return out;
};

/* ---------- 1. PARSER --------------------------------------------- */
function parseStory(raw) {
  const chars = {}, sprites = {}, images = {}, script = [];
  const ls = raw.replace(/\r/g, "").split("\n");

  let sec = null, i = 0;
  while (i < ls.length) {
    const raw = noComment(ls[i++]); if (!raw.trim()) continue;
    const pad = ind(raw), line = raw.trimStart();

    /* --- разделы --- */
    if (pad === 0 && line.endsWith(":")) {
      const k = line.toLowerCase();
      sec =
        k.startsWith("define characters") ? "chars"   :
        k.startsWith("define sprites")    ? "sprites" :
        k.startsWith("define images")     ? "images"  :
        k.startsWith("script")            ? "script"  : null;
      continue;
    }

    /* --- defines --- */
    if (sec === "chars" || sec === "sprites" || sec === "images") {
      const [lhs, rhs = ""] = line.split("=").map(t => t.trim());
      const v = rhs.replace(/^"|"$/g, "");
      if (sec === "chars")   chars[lhs]   = v || lhs;
      if (sec === "sprites") sprites[lhs] = v;
      if (sec === "images")  images[lhs]  = v;
      continue;
    }

    /* --- SCRIPT -------------------------------------------------- */
    if (sec !== "script") continue;

    /* label */
    const mLabel = line.match(/^label\s+(\w+):$/);
    if (mLabel) { script.push({ type: "label", name: mLabel[1] }); continue; }

    /* scene / show / jump */
    if (line.startsWith("scene ")) { const id = line.slice(6).trim();
      script.push({ type: "scene", src: images[id] || id }); continue; }
    if (line.startsWith("show "))  { const id = line.slice(5).trim();
      script.push({ type: "show", sprite: sprites[id] || id }); continue; }
    if (line.startsWith("jump "))  { script.push({ type: "jump", label: line.slice(5).trim() }); continue; }
    if (line.startsWith("call "))  { script.push({ type: "call", label: line.slice(5).trim() }); continue; }

    /* return;  -> конец игры */
    if (/^return\s*;?\s*$/.test(line)) { script.push({ type: "return" }); continue; }

    /* menu(...) */
    const mMenu = line.match(/^menu(?:\((.+)\))?:$/);
    if (mMenu) {
      const hdr = mMenu[1] || "";
      if (hdr) {
        const h = hdr.match(/^(\w+)\s+"(.+)"$/);
        if (h) script.push({ type: "say", who: chars[h[1]] || h[1], what: h[2] });
      }
      const base = pad, opts = [];
      while (i < ls.length) {
        const rawOpt = noComment(ls[i]); if (!rawOpt.trim()) { i++; continue; }
        if (ind(rawOpt) <= base) break;                       // конец menu
        const optPad = ind(rawOpt), t = rawOpt.trimStart().match(/^"(.+)"\s*:\s*$/);
        if (!t) { i++; continue; }
        const text = t[1]; i++;
        let jump = null, isCall = false;
        while (i < ls.length) {
          const inr = noComment(ls[i]); if (!inr.trim()) { i++; continue; }
          if (ind(inr) <= optPad) break;
          const jm = inr.trimStart().match(/^(jump|call)\s+(\w+)$/);
          if (jm) { isCall = jm[1] === "call"; jump = jm[2]; }
          i++;
        }
        opts.push({ text, jump, call: isCall });
      }
      script.push({ type: "choice", options: opts });
      continue;
    }

    /* реплики */
    const d = line.match(/^(\w+)\s+"(.+)"$/);
    if (d) { script.push({ type: "say", who: chars[d[1]] || d[1], what: d[2] }); continue; }
    const n = line.match(/^"(.+)"$/);
    if (n) { script.push({ type: "say", who: "", what: n[1] }); }
  }
  return script;
}

/* ---------- 2. ДВИЖОК --------------------------------------------- */
class VNEngine {
  constructor({ script, assetsPath = "" }) {
    this.script = script; this.assetsPath = assetsPath;
    this.labels = Object.fromEntries(script.map((c, i) => c.type === "label" ? [c.name, i] : null).filter(Boolean));
    this.pos = 0; this.justJumped = true; this.paused = false;
    this.stack = [];

    this.isTyping = false; this.fullText = ""; this.timer = null;

    /* DOM */
    this.bg = document.getElementById("vn-background");
    this.sp = document.getElementById("vn-sprite");
    this.nm = document.getElementById("vn-name");
    this.tx = document.getElementById("vn-text");
    this.ch = document.getElementById("vn-choices");
    this.ui = document.getElementById("vn-ui");
    this.fadeIn(this.ui);

    document.addEventListener("click", e => {
      if (this.paused) return;
      if (e.target.classList.contains("vn-choice")) return;
      if (this.isTyping) { this.finishText(); return; }
      const cur = this.script[this.pos];
      if (cur && cur.type === "label") return;           // label «пустой» — ждём
      if (!this.ch.childElementCount) this.next();
    });

    this.run();
  }

  /* --- helpers --- */
  fadeOut(el) { el.style.opacity = 0; }
  fadeIn(el)  { el.style.opacity = 1; }

  setImage(el, src) {
    if (!src) { this.fadeOut(el); return; }              // спрятать элемент
    if (el.dataset.current === src) return;              // уже нужная картинка
    this.fadeOut(el);
    setTimeout(() => {                                   // 0.5 s — выставлено в CSS
      el.src = this.assetsPath + src;
      el.dataset.current = src;
      this.fadeIn(el);
    }, 500);
  }

  next() { this.pos++; this.run(); }
  jump(l) { if (this.labels[l] != null) { this.pos = this.labels[l]; this.justJumped = true; this.run(); } }
  call(l) {
    if (this.labels[l] != null) {
      this.stack.push(this.pos + 1);
      this.pos = this.labels[l];
      this.justJumped = true;
      this.run();
    }
  }

  run() {
    if (this.paused) return;
    const c = this.script[this.pos]; if (!c) return;

    switch (c.type) {
      case "scene":  this.setImage(this.bg, c.src);             this.next(); break;
      case "show":   this.setImage(this.sp, c.sprite);          this.next(); break;
      case "say":    this.showSay(c);                           break;
      case "choice": this.showChoices(c.options);               break;
      case "jump":   this.jump(c.label);                        break;
      case "call":   this.call(c.label);                        break;
      case "label":
        if (this.justJumped) { this.justJumped = false; this.next(); }
        else if (this.stack.length) { this.pos = this.stack.pop(); this.run(); }
        break;
      case "return":
        if (this.stack.length) { this.pos = this.stack.pop(); this.justJumped = false; this.next(); }
        else this.endGame();
        break;
    }
  }

  /* --- текст --- */
  showSay({ who, what }) {
    if (this.isTyping) this.finishText();
    this.nm.textContent = who || "";
    this.tx.textContent = "";
    this.fullText = what; this.isTyping = true;

    const step = i => {
      if (i < this.fullText.length) {
        this.tx.textContent += this.fullText[i];
        this.timer = setTimeout(() => step(i + 1), 20);
      } else { this.isTyping = false; }
    };
    step(0);
  }
  finishText() { clearTimeout(this.timer); this.tx.textContent = this.fullText; this.isTyping = false; }

  /* --- меню выбора --- */
  showChoices(opts) {
    this.ch.innerHTML = "";
    opts.forEach(o => {
      const b = document.createElement("button");
      b.className = "vn-choice";
      b.textContent = o.text;
      b.onclick = () => {
        this.ch.innerHTML = "";
        if (o.jump) {
          o.call ? this.call(o.jump) : this.jump(o.jump);
        } else {
          this.next();
        }
      };
      this.ch.appendChild(b);
    });
  }

  /* --- пауза (Esc) --- */
  pause()  { this.paused = true; }
  resume() { if (this.paused) { this.paused = false; this.run(); } }

  /* --- завершение игры (return) --- */
  endGame() {
    /* Плавно затемняем сцену и UI */
    this.fadeOut(this.bg); this.fadeOut(this.sp); this.fadeOut(document.getElementById("vn-ui"));
    setTimeout(() => {
      /* показываем главное меню */
      document.getElementById("main-menu").classList.remove("hidden");
      /* сбрасываем ссылку на движок, чтобы начать заново */
      if (window.engine) delete window.engine;
    }, 500);
  }
}

/* ---------- 3. ГЛАВНОЕ / ПАУЗА-МЕНЮ ------------------------------ */
const show = id => document.getElementById(id).classList.remove("hidden");
const hide = id => document.getElementById(id).classList.add("hidden");

let scriptCache = null;   // сценарий
window.engine   = null;   // экземпляр движка (делаем глобально для endGame)

window.addEventListener("DOMContentLoaded", () => {
  fetch("story.txt").then(r => r.text()).then(t => scriptCache = parseStory(t));

  /* старт */
  document.getElementById("btn-start").onclick = () => {
    hide("main-menu");
    window.engine = new VNEngine({ script: scriptCache });
  };

  /* пауза */
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !window.engine) return;
    const pm = document.getElementById("pause-menu");
    if (window.engine.paused) { hide("pause-menu"); window.engine.resume(); }
    else { window.engine.pause(); show("pause-menu"); }
  });

  document.getElementById("btn-continue").onclick = () => {
    hide("pause-menu");
    if (window.engine) window.engine.resume();
  };
  document.getElementById("btn-to-main").onclick = () => location.reload();
});
