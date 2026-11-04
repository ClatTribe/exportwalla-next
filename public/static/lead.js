/* "Ask the desk": one contact form for the whole site. Any element with data-ask opens it; data-ask-title,
   data-ask-step, data-ask-product, data-ask-country and data-ask-message pre-fill it. Posts to /api/lead.
   A floating "Ask the desk" button sits on every page that loads this script (except the workspace, which has its own). */
(function () {
  const css = `
  .ask-fab{position:fixed;right:16px;bottom:16px;z-index:50;display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border:0;border-radius:999px;
    background:#0B1F3A;color:#fff;font:600 15px/1 Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(11,31,58,.28);cursor:pointer}
  .ask-fab:hover{background:#14315a}.ask-fab .ph{width:30px;height:30px;margin:-6px 0 -6px -8px;border-radius:50%;display:grid;place-items:center;background:#F7941D;color:#0B1F3A;box-shadow:0 0 0 4px rgba(247,148,29,.25);animation:ewring 3s ease-in-out infinite}
  @keyframes ewring{0%,86%,100%{transform:rotate(0)}88%{transform:rotate(-14deg)}92%{transform:rotate(14deg)}96%{transform:rotate(-8deg)}}
  @media (prefers-reduced-motion:reduce){.ask-fab .ph{animation:none}}
  dialog.ask{border:0;border-radius:18px;padding:0;width:min(520px,calc(100vw - 24px));box-shadow:0 30px 80px rgba(11,31,58,.35);color:#0B1F3A}
  dialog.ask::backdrop{background:rgba(11,31,58,.45)}
  .ask form{display:grid;gap:10px;padding:20px 20px 18px;font:15px/1.5 Inter,system-ui,sans-serif}
  .ask h2{margin:0;font:700 22px/1.2 'Baloo 2',system-ui,sans-serif}.ask p{margin:0;color:#5B6472;font-size:14px}
  .ask label{display:grid;gap:4px;font-size:13px;font-weight:600}
  .ask input,.ask textarea{font:inherit;font-weight:400;padding:10px 12px;border:1px solid #E7E1D6;border-radius:10px;background:#fff;color:#0B1F3A;width:100%;box-sizing:border-box}
  .ask .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .ask .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .ask button.go{border:0;border-radius:999px;padding:11px 20px;background:#F7941D;color:#0B1F3A;font:700 15px Inter,system-ui,sans-serif;cursor:pointer}
  .ask button.x{position:absolute;top:10px;right:12px;border:0;background:none;font-size:24px;line-height:1;color:#5B6472;cursor:pointer}
  .ask .msg{font-size:14px}.ask .ok{background:#DCFCE7;color:#14532D;border-radius:10px;padding:10px 12px}
  .ask .alt{font-size:13px;color:#5B6472}.ask .alt a{color:#1B4F8F}
  @media (max-width:600px){
    .ask .two{grid-template-columns:1fr}.ask input,.ask textarea{font-size:16px}
    .ask-fab{right:14px;bottom:calc(14px + env(safe-area-inset-bottom));width:58px;height:58px;padding:0;justify-content:center;font-size:0;gap:0}
    .ask-fab .ph{margin:0;width:58px;height:58px;box-shadow:0 8px 24px rgba(11,31,58,.3),0 0 0 4px rgba(247,148,29,.22)}.ask-fab .ph svg{width:24px;height:24px}
    body{padding-bottom:84px}
    dialog.ask{width:100vw;max-width:100vw;max-height:92vh;margin:auto 0 0;border-radius:20px 20px 0 0;overflow:auto}
    .ask form{padding:18px 16px calc(18px + env(safe-area-inset-bottom))}.ask button.go{width:100%;padding:14px}
  }
  body:has(dialog.ask[open]) .ask-fab,body:has(.mnav[open]) .ask-fab{display:none}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const cfg = window.EW_CONTACT || {};
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  const alt = () => [cfg.phone && `call <a href="tel:${esc(cfg.phone.replace(/\s/g, ""))}">${esc(cfg.phone)}</a>`,
                     cfg.whatsapp && `<a href="https://wa.me/${esc(cfg.whatsapp)}">WhatsApp</a>`,
                     cfg.email && `email <a href="mailto:${esc(cfg.email)}">${esc(cfg.email)}</a>`].filter(Boolean).join(", ");
  const dlg = document.createElement("dialog"); dlg.className = "ask";
  dlg.innerHTML = `<form method="dialog" novalidate><button class="x" type="button" aria-label="Close">×</button>
    <h2 id="askTitle">Ask the export desk</h2><p id="askSub">A person replies within one working day, in Hindi or English. Free, no obligation.</p>
    <input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px">
    <div class="two"><label>Your name<input name="name" required autocomplete="name"></label>
    <label>Mobile (WhatsApp)<input name="phone" inputmode="tel" autocomplete="tel" placeholder="10-digit number"></label></div>
    <label>Email <small style="font-weight:400;color:#5B6472">(mobile or email is enough)</small><input name="email" type="email" autocomplete="email"></label>
    <div class="two"><label>Product<input name="product" placeholder="e.g. leather shoes"></label><label>Country<input name="country" placeholder="optional"></label></div>
    <label>How can we help?<textarea name="message" rows="3" maxlength="900"></textarea></label>
    <div class="row"><button class="go" type="submit">Send to the desk</button><span class="msg" aria-live="polite"></span></div>
    <p class="alt"></p></form>`;
  document.body.appendChild(dlg);
  const f = dlg.querySelector("form"), msg = dlg.querySelector(".msg");
  let ctx = {};
  function open(el) {
    const d = el ? el.dataset : {};
    ctx = {step: d.askStep || "", page: location.pathname};
    dlg.querySelector("#askTitle").textContent = d.askTitle || "Ask the export desk";
    f.product.value = d.askProduct || f.product.value; f.country.value = d.askCountry || f.country.value;
    f.message.value = d.askMessage || ""; msg.textContent = ""; f.querySelector("button.go").disabled = false;
    dlg.querySelector(".alt").innerHTML = alt() ? "Or " + alt() + "." : "";
    dlg.showModal(); (f.name.value ? f.message : f.name).focus();
  }
  document.addEventListener("click", e => { const el = e.target.closest("[data-ask]"); if (el) { e.preventDefault(); open(el); } });
  dlg.querySelector("button.x").onclick = () => dlg.close();
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); });
  f.addEventListener("submit", async e => {
    e.preventDefault();
    const body = {...Object.fromEntries(new FormData(f).entries()), ...ctx, source: "ask-desk", whatsapp_ok: true};
    if (!body.name.trim() || !(body.phone.replace(/\D/g, "").length >= 10 || /\S+@\S+\.\S+/.test(body.email))) {
      msg.textContent = "Please add your name and a mobile number or email."; return; }
    msg.textContent = "Sending…"; f.querySelector("button.go").disabled = true;
    try {
      const r = await fetch("/api/lead", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
      const d = await r.json(); if (!r.ok) throw new Error(d.detail || "Please check your details");
      msg.innerHTML = d.saved ? `<span class="ok">✓ Sent. We'll reply within one working day.</span>`
                              : `We could not send this right now. Please ${alt() || "try again later"}.`;
    } catch (err) { msg.textContent = err.message; f.querySelector("button.go").disabled = false; }
  });
  if (!cfg.noFab) {
    const b = document.createElement("button"); b.className = "ask-fab"; b.type = "button"; b.setAttribute("data-ask", "");
    b.innerHTML = '<span class="ph" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z"/></svg></span>Ask the desk';
    b.setAttribute("aria-label", "Ask the export desk: call back or message"); document.body.appendChild(b);
  }
  window.EW_ASK = open;
})();
