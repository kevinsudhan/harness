/*
 * Araxys Builder — composing a business from the module catalogue.
 *
 * Loaded before app.js and run only after it: every function here is called from
 * app.js's render(), boot and mode switch, by which time S, $, esc, api, post and the
 * rest exist. Nothing at the top level of this file touches them.
 *
 * A composed run is drawn from the server's composeView(): the composition already put in
 * the page's terms (modules, stages, what waits for whom, what the agent may do), so this
 * file renders and never has to understand a composition. The one thing it edits is the
 * config, which goes back to the server and is composed again there.
 */
"use strict";

const COMPOSE_EXAMPLES = [
  ["Dental clinic", "A dental clinic in Chennai. Patients phone in to book appointments with a dentist; we send reminders the day before, give estimates for treatment, bill and take payment, and handle insurance claims."],
  ["MMA gym", "An MMA gym in Bengaluru with monthly and 10-class memberships, group classes with limited spots, personal training with coaches, and leads from Instagram who come in for a trial week."],
  ["Law firm", "A law firm handling litigation and property matters: intake, a conflict check, an engagement letter, billable hours on each matter, court deadlines, and invoices to clients and companies."],
  ["Event caterer", "A wedding and event caterer. We quote menus per head, take a 30% advance, buy ingredients from suppliers, and run each event from booking to tasting to the day itself."],
];

const COMPOSE_STEPS = ["Draft", "Check", "Approve", "Build"];
const COMPOSE_STEP_OF = { REQUEST_RECEIVED: 0, DRAFTING: 0, CLARIFICATION_REQUIRED: 1, WAITING_FOR_APPROVAL: 2, APPROVED: 3, BUILT: 4 };
const CATEGORY_TITLES = { core: "Customers & work", sales: "Selling", finance: "Money", operations: "Operations", people: "Team", engagement: "Conversations", control: "Controls" };

// ------------------------------------------------------------------------ starting

async function startCompose(requestArg, forceArg) {
  S.build = null;
  const request = (requestArg ?? $("#request").value).trim();
  if (request.length < 10) return toast("Describe the business in at least a sentence.");
  const force = forceArg ?? $("#force").checked;
  const btn = $("#go");
  btn.disabled = true;
  try {
    S.run = await post("/api/compose", { request, force });
    S.cTab = "overview";
    S.configText = null;
    render();
    startPolling();
    loadRuns();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/** A shipped example: composed at once, with no model — the quickest way to see one. */
async function startExample(name) {
  S.build = null;
  try {
    S.run = await post("/api/compose/example", { name });
    S.cTab = "overview";
    S.configText = null;
    if (S.view === "simple" || S.mode !== "compose") setMode("compose", false);
    render();
    loadRuns();
  } catch (e) { toast(e.message); }
}

async function loadComposeExtras() {
  try { S.catalogue = await api("/api/catalogue"); } catch { S.catalogue = []; }
  try { S.examples = await api("/api/compose/examples"); } catch { S.examples = []; }
  renderCatalogueCard();
  renderExampleChips();
}

function renderExampleChips() {
  const el = $("#compose-examples");
  if (!el) return;
  el.hidden = S.mode !== "compose";
  el.innerHTML = (S.examples || []).length
    ? `<span class="muted small">Or open a ready-made one, no model needed:</span> ${S.examples.map((x) => `<button type="button" class="chip" data-example="${esc(x.name)}">${esc(x.business)} · ${esc(x.label)}</button>`).join("")}`
    : "";
  $$("#compose-examples [data-example]").forEach((b) => b.addEventListener("click", () => startExample(b.dataset.example)));
}

function renderCatalogueCard() {
  const card = $("#catalogue-card");
  if (!card) return;
  card.hidden = S.mode !== "compose";
  $("#tpl-card").hidden = S.mode === "compose";
  const list = S.catalogue || [];
  $("#cat-count").textContent = list.length ? `${list.length} modules` : "";
  $("#cat-body").innerHTML = Object.entries(CATEGORY_TITLES).map(([cat, title]) => {
    const mods = list.filter((m) => m.category === cat);
    if (!mods.length) return "";
    return `<div class="tpl-section">
      <h4><span>${esc(title)}</span><span>${mods.length}</span></h4>
      <ul class="tpl-list">${mods.map((m) => `<li title="${esc(m.summary)}"><span class="name">${esc(m.label)}</span><span class="grow"></span><span class="muted">${m.actions} actions</span></li>`).join("")}</ul>
    </div>`;
  }).join("") || '<div class="muted small">Loading…</div>';
}

// ------------------------------------------------------------------------ the run

function composeStepper(run) {
  let cur = COMPOSE_STEP_OF[run.state];
  let failedAt = -1;
  if (cur === undefined) {
    failedAt = run.state === "FAILED" ? (run.history.some((h) => h.state === "APPROVED") ? 3 : 1) : 2;
    cur = failedAt;
  }
  const d = run.draft;
  const drafting = run.history.find((h) => h.state === "DRAFTING");
  const liveModel = S.status && S.status.inFlight ? shortModel(S.status.inFlight.model) : "";
  const subs = [
    run.state === "DRAFTING" ? `${liveModel || "drafting"} · ${drafting ? since(drafting.at) : ""}` : d ? (d.cached ? "cache · 0 tokens" : `${fmt(d.usage.input + d.usage.output)} tokens`) : "from a config",
    run.summary ? `${run.summary.counts.modules} modules · ${run.problems.length ? `${run.problems.length} problems` : "every rule checked"}` : run.problems.length ? `${run.problems.length} problems` : "",
    run.approval ? `by ${run.approval.by}` : run.state === "WAITING_FOR_APPROVAL" ? "your decision" : "",
    run.buildDir || "",
  ];
  return `<div class="stepper">${COMPOSE_STEPS.map((label, i) => {
    let cls = "";
    if (failedAt === i) cls = run.state === "FAILED" ? "failed" : "";
    else if (i < cur) cls = "done";
    else if (i === cur && run.state !== "BUILT") cls = "active";
    return `<div class="step ${cls}"><div class="bar"></div><div class="label">${label}</div><div class="sub" title="${esc(subs[i])}">${esc(subs[i])}</div></div>`;
  }).join("")}</div>`;
}

function renderCompose() {
  const el = $("#run");
  const run = S.run;
  if (!run) { el.hidden = true; return; }
  el.hidden = false;
  const parts = [`<div class="card">${composeStepper(run)}</div>`];

  if (RUNNING.has(run.state)) {
    parts.push(`<div class="callout info"><div style="display:flex;gap:10px;align-items:center"><span class="spinner"></span><span>Choosing modules from the catalogue and adapting them to this business — usually 20 to 60 seconds.</span></div></div>`);
  }
  if (run.state === "FAILED") {
    const d = run.draft;
    parts.push(`<div class="callout bad">
      <div class="callout-title">It does not compose yet</div>
      <div>${esc(run.error || "The draft could not be composed.")}</div>
      ${run.problems.length ? `<ul>${run.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${d && d.raw ? `<details><summary>What the model returned</summary><pre class="code">${esc(d.raw)}</pre></details>` : ""}
      ${run.config
        ? '<div class="small" style="margin-top:6px">Fix it in the <b>Config</b> tab — it is composed again as you save, at no cost. Or draft it again.</div>'
        : '<div class="small" style="margin-top:6px">There is no configuration to fix by hand — the model\'s answer could not be read. A new draft usually reads fine.</div>'}
      <div style="margin-top:8px"><button class="btn primary small" type="button" data-redraft>Draft again</button></div>
    </div>`);
  }
  if (run.state === "CLARIFICATION_REQUIRED" && run.summary) {
    const qs = run.summary.openQuestions.filter((q) => q.blocks === "structure");
    parts.push(`<div class="card">
      <div class="card-head"><div><div class="eyebrow">Before anything is built</div><h2>These change which modules it needs</h2></div></div>
      <ul class="qlist">${qs.map((q) => `<li><span class="badge warn">structure</span><span>${esc(q.question)}</span></li>`).join("")}</ul>
      <textarea id="c-answers" rows="3" style="margin-top:12px" placeholder="Answer in your own words — one line per question is fine."></textarea>
      <div class="composer-foot" style="margin-top:10px">
        <span class="muted small">Answers are added to the request and drafted again.</span>
        <div class="grow"></div>
        <button class="btn" id="c-skip" type="button">Proceed with assumptions</button>
        <button class="btn primary" id="c-answer" type="button">Answer and re-draft</button>
      </div>
    </div>`);
  }
  if (run.summary || run.config) parts.push(composeHero(run));
  el.innerHTML = parts.join("");
  bindCompose(renderCompose);
  bindAppControls(renderCompose);

  if (run.draft && !run.draft.cached && !(run.runId in S.sessionTokens)) {
    S.sessionTokens[run.runId] = run.draft.usage.input + run.draft.usage.output;
    $("#session-tokens-n").textContent = fmt(Object.values(S.sessionTokens).reduce((a, b) => a + b, 0));
  }
}

/** The composition, tabbed — shared by a run before approval and a build after it. */
function composeHero(run, build) {
  const s = run.summary;
  const tab = S.cTab || "overview";
  const editable = !build && (run.state === "WAITING_FOR_APPROVAL" || run.state === "FAILED");
  const d = run.draft;
  const tabs = [
    ["overview", "Overview", (run.problems || []).length + (s ? s.openQuestions.length : 0)],
    ["modules", "Modules", s ? s.counts.modules : 0],
    ["stages", "Stages & approvals", s ? s.counts.held : 0],
    ["agent", "Agent & ArmorIQ", s ? s.agent.blocked.length : 0],
    ["config", editable ? "Config · edit" : "Config", ""],
    ...(build ? [["files", "Files", build.files.length]] : []),
  ];
  let panel = "";
  if (tab === "modules") panel = s ? modulesPanel(s) : "";
  else if (tab === "stages") panel = s ? stagesPanel(s) : "";
  else if (tab === "agent") panel = s ? agentPanel(s) : "";
  else if (tab === "config") panel = configPanel(run, editable);
  else if (tab === "files" && build) panel = filesView(build.files, build.buildDir);
  else panel = composeOverview(run);

  const models = d && d.calls ? [...new Set(d.calls.map((c) => shortModel(c.resolvedModel)))].join(" → ") : "";
  return `<section class="card hero">
    <div class="hero-top">
      <div>
        <div class="eyebrow">${build ? "Built business" : "Composition"} · ${esc(s ? s.id : "draft")}</div>
        <h2>${esc(s ? s.business.name : "Not composed yet")}</h2>
        <div class="muted small">${s ? `${esc(s.label)} · ${esc(s.business.currency)} · ${esc(s.business.timezone)} · ${s.counts.modules} modules from the catalogue` : "fix the config to see it"}${build ? ` · ${esc(build.buildDir)}/` : ""}</div>
      </div>
      <div class="hero-actions">${build ? `${appControl(build.name)}<span class="badge ok">built</span>` : stateBadge(run.state)}</div>
    </div>
    ${s ? `<div class="stats">
      <div class="stat"><div class="v">${s.counts.modules}</div><div class="l">Modules</div></div>
      <div class="stat"><div class="v">${s.counts.tables}</div><div class="l">Tables</div></div>
      <div class="stat"><div class="v">${s.counts.actions}</div><div class="l">Actions</div></div>
      <div class="stat"><div class="v">${s.counts.held}</div><div class="l">Wait for a person</div></div>
      <div class="stat"><div class="v">${s.counts.custom}</div><div class="l">Its own actions</div></div>
      ${d ? `<div class="stat wide"><div class="model">${esc(models || "cache")}</div><div class="l">${d.cached ? "Drafted earlier, served from cache" : `${fmt(d.usage.input)} in / ${fmt(d.usage.output)} out · ${d.calls.length} call${d.calls.length === 1 ? "" : "s"} · free`}</div></div>`
        : `<div class="stat wide"><div class="model">no model</div><div class="l">${build ? "Composed from its config" : "Composed from a config"}</div></div>`}
    </div>` : ""}
    <div class="tabs" role="tablist">${tabs.map(([id, label, n]) => `<button role="tab" data-ctab="${id}" aria-selected="${tab === id}">${label}${n !== "" ? `<span class="count">${n}</span>` : ""}</button>`).join("")}</div>
    <div class="tab-panel">${panel}</div>
  </section>
  ${build ? "" : composeApprovalBar(run)}`;
}

function composeOverview(run) {
  const s = run.summary;
  const out = [];
  if (run.problems && run.problems.length) {
    out.push(`<div class="callout bad"><div class="callout-title">${run.problems.length} problem${run.problems.length === 1 ? "" : "s"} — nothing is built until these are fixed</div><ul>${run.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`);
  }
  if (s && s.openQuestions.length) {
    out.push(`<div class="callout info"><div class="callout-title">Still open</div><ul class="qlist">${s.openQuestions.map((x) => `<li><span class="badge ${x.blocks === "structure" ? "warn" : ""}">${esc(x.blocks)}</span><span>${esc(x.question)}</span></li>`).join("")}</ul></div>`);
  }
  if (s) {
    out.push(`<div class="group"><h3>What it is made of</h3><div class="flow">${s.modules.map((m) => `<span class="st" title="${esc(m.summary)}">${esc(m.label)}</span>`).join("")}</div></div>`);
    const board = s.stages.find((x) => x.board);
    if (board) out.push(`<div class="group"><h3>The board — ${esc(board.label)}</h3><div class="flow">${board.states.map((st, i) => `${i ? '<span class="arrow">›</span>' : ""}<span class="st">${esc(st.label)}</span>`).join("")}</div></div>`);
  }
  if (run.notes && run.notes.length) {
    out.push(`<details${run.problems && run.problems.length ? "" : " open"}><summary>${run.notes.length} thing${run.notes.length === 1 ? "" : "s"} composing changed or assumed, in code</summary><ul class="small">${run.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`);
  }
  const d = run.draft;
  if (d && d.repaired && d.repaired.length) {
    out.push(`<details><summary>Needed one repair call — what the first answer got wrong</summary><ul class="small">${d.repaired.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>`);
  }
  if (run.edits && run.edits.length) {
    out.push(`<div class="muted small">Edited by hand ${run.edits.length} time${run.edits.length === 1 ? "" : "s"} since the draft.</div>`);
  }
  return out.join("") || '<div class="muted small">Nothing to flag.</div>';
}

function modulesPanel(s) {
  return Object.entries(CATEGORY_TITLES).map(([cat, title]) => {
    const mods = s.modules.filter((m) => m.category === cat);
    if (!mods.length) return "";
    return `<div class="group"><h3>${esc(title)}</h3><div class="mod-grid">${mods.map((m) => `
      <div class="mod">
        <div class="mod-head"><b>${esc(m.label)}</b><span class="mono muted small">${esc(m.id)}</span></div>
        <div class="small muted">${esc(m.summary)}</div>
        <div class="flow" style="margin-top:6px">${m.tables.map((t) => `<span class="st">${esc(t)}</span>`).join("")}</div>
        ${Object.keys(m.settings).length ? `<div class="small muted" style="margin-top:6px">${Object.entries(m.settings).map(([k, v]) => `${esc(k.replace(/_/g, " "))}: <b>${esc(String(v))}</b>`).join(" · ")}</div>` : ""}
      </div>`).join("")}</div></div>`;
  }).join("");
}

function stagesPanel(s) {
  const stages = s.stages.map((x) => `<div class="group">
    <h3>${esc(x.label)}${x.board ? ' <span class="badge ok">the board</span>' : ""}</h3>
    <div class="flow">${x.states.map((st, i) => `${i ? '<span class="arrow">›</span>' : ""}<span class="st" title="${esc(st.requirements.length ? `to leave: ${st.requirements.join(", ")}` : st.terminal ? "ends here" : "")}">${esc(st.label)}${st.requirements.length ? ` · ${st.requirements.length}` : ""}</span>`).join("")}</div>
  </div>`).join("");
  const held = s.held.length
    ? `<ul class="policy">${s.held.map((h) => `<li><span class="act held">${esc(h.label)}</span> on ${esc(h.on.toLowerCase())} — ${esc(h.rule)} <span class="badge">${esc(h.approver)}</span>${h.custom ? ' <span class="badge info">its own</span>' : ""}</li>`).join("")}</ul>`
    : '<div class="muted small">Nothing waits for a person: every action acts alone.</div>';
  const custom = s.custom.length
    ? `<div class="group"><h3>This business's own actions</h3><ul class="policy">${s.custom.map((c) => `<li><span class="act">${esc(c.label)}</span> — ${esc(c.summary)} <span class="muted small">${esc(c.when.join(", ") || "any stage")}${c.to ? ` → ${esc(c.to)}` : ""}</span></li>`).join("")}</ul></div>`
    : "";
  return `${stages}<div class="group"><h3>What waits for a person</h3>${held}</div>${custom}`;
}

function agentPanel(s) {
  const a = s.agent;
  return `<div class="callout info small">Every build comes with an MCP server (<span class="mono">POST /mcp</span> in the running app) and an agent that works through it. This is the agent's ArmorIQ policy, compiled from the modules: anything not listed as allowed is blocked. The business's own approvals still apply underneath.</div>
    <div class="stats" style="margin-top:10px">
      <div class="stat"><div class="v">${a.allowed}</div><div class="l">Tools allowed</div></div>
      <div class="stat"><div class="v">${a.blocked.length}</div><div class="l">Blocked</div></div>
      <div class="stat wide"><div class="model">${esc(a.mcpId)}</div><div class="l">MCP server id to register</div></div>
      <div class="stat wide"><div class="model">${esc(a.agentId)}</div><div class="l">Agent id to register</div></div>
    </div>
    <div class="group"><h3>Blocked for the agent</h3>
      <ul class="policy">${a.blocked.map((b) => `<li><span class="act held">${esc(b.tool)}</span> — ${esc(b.why)}</li>`).join("") || '<li class="muted">Nothing.</li>'}</ul>
    </div>
    <div class="muted small">Written to <span class="mono">armoriq/policy.yaml</span> and <span class="mono">armoriq/armoriq.yaml</span> in the build. Setup steps: docs/ARMORIQ.md.</div>`;
}

function configPanel(run, editable) {
  const text = S.configText ?? JSON.stringify(run.config, null, 2);
  return `<div class="muted small" style="margin-bottom:8px">${editable
      ? "The whole business, as the model wrote it. Change labels, thresholds, modules or stages and compose again — it is checked in code, instantly, at no cost."
      : "The whole business, as composed. To change a built business, edit this as a new draft — the old build stays as it is."}</div>
    <textarea id="c-config" class="config-editor" spellcheck="false"${editable ? "" : " readonly"}>${esc(text)}</textarea>
    <div class="composer-foot" style="margin-top:8px">
      ${S.configMsg ? `<span class="small ${S.configMsg.ok ? "ok-text" : "bad-text"}">${esc(S.configMsg.text)}</span>` : ""}
      <div class="grow"></div>
      ${editable
        ? `<button class="btn" id="c-reset" type="button">Undo my edits</button><button class="btn primary" id="c-save" type="button">Compose again</button>`
        : `<button class="btn" id="c-copy" type="button">Copy</button>${S.build ? '<button class="btn primary" id="c-fork" type="button">Edit as a new draft</button>' : ""}`}
    </div>`;
}

function composeApprovalBar(run) {
  if (run.state === "WAITING_FOR_APPROVAL") {
    return `<div class="approval">
      <div class="grow"><b>Build this business?</b><div class="note">Approving writes it to builds/ — config, app, schema, agent policy. Nothing reaches a live database, phone line or payment provider.</div></div>
      <input type="text" id="c-approver" placeholder="Your name" value="${esc(store("builder.approver") || "")}" aria-label="Approver name" />
      <button class="btn danger" id="c-reject" type="button">Reject</button>
      <button class="btn primary" id="c-approve" type="button">Approve &amp; build</button>
    </div>`;
  }
  if (run.state === "APPROVED") {
    return `<div class="approval"><div class="grow"><b>Approved by ${esc(run.approval.by)}</b><div class="note">Not built yet.</div></div><button class="btn primary" id="c-build" type="button">Build</button></div>`;
  }
  if (run.state === "BUILT" && run.buildDir) {
    const name = run.buildDir.split("/").pop();
    return `<div class="callout ok"><div class="callout-title">Built — ${esc(run.buildDir)}/</div>
      <div class="small">It runs as its own app, with its own data, an MCP server and an agent page. Nothing was applied to a live system.</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">${appControl(name)}<button class="btn ghost small" data-open-build="${esc(name)}" type="button">See the build</button></div></div>`;
  }
  return "";
}

function bindCompose(rerender) {
  $$("#run [data-ctab]").forEach((b) => b.addEventListener("click", () => { S.cTab = b.dataset.ctab; rerender(); }));
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener("click", fn); };
  const editor = $("#c-config");
  if (editor) editor.addEventListener("input", () => { S.configText = editor.value; });
  on("#c-save", saveConfig);
  on("#c-reset", () => { S.configText = null; S.configMsg = null; rerender(); });
  on("#c-copy", async () => { try { await navigator.clipboard.writeText($("#c-config").value); toast("Copied."); } catch { toast("Copy failed."); } });
  on("#c-fork", forkBuildConfig);
  on("#c-approve", () => decideComposeRun(true));
  on("#c-reject", () => decideComposeRun(false));
  on("#c-build", buildComposeRun);
  on("#c-answer", () => clarifyComposeRun(false));
  on("#c-skip", () => clarifyComposeRun(true));
  $$("[data-open-build]").forEach((b) => b.addEventListener("click", () => openBuild(b.dataset.openBuild)));
  bindRedraft();
  $$("#run [data-file]").forEach((x) => x.addEventListener("click", () => { S.file = x.dataset.file; rerender(); }));
  const copy = $("#copy-file");
  if (copy && S.build) copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(buildFile(S.file)); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
  });
}

async function saveConfig() {
  let config;
  try {
    config = JSON.parse($("#c-config").value);
  } catch (e) {
    S.configMsg = { ok: false, text: `Not valid JSON: ${e.message}` };
    return render();
  }
  try {
    S.run = await post(`/api/compose/${encodeURIComponent(S.run.runId)}/config`, { config });
    S.configText = null;
    S.configMsg = S.run.summary && !S.run.problems.length
      ? { ok: true, text: `Composed — ${S.run.summary.counts.modules} modules, ${S.run.summary.counts.actions} actions, every rule checked.` }
      : { ok: false, text: `${S.run.problems.length} problem${S.run.problems.length === 1 ? "" : "s"} — see Overview.` };
    render();
    loadRuns();
  } catch (e) { toast(e.message); }
}

/** A built business's config, opened as a new draft — the build it came from is left alone. */
async function forkBuildConfig() {
  let config;
  try { config = JSON.parse($("#c-config").value); } catch { return toast("The config is not valid JSON."); }
  try {
    S.build = null;
    S.run = await post("/api/compose/from-config", { config, label: `Edit of ${S.lastBuildName || "a build"}` });
    S.cTab = "config";
    S.configText = null;
    S.configMsg = null;
    history.replaceState(null, "", location.pathname);
    render();
    loadRuns();
  } catch (e) { toast(e.message); }
}

async function decideComposeRun(approve, byArg) {
  const by = (byArg || ($("#c-approver") && $("#c-approver").value.trim()) || "").trim();
  if (!by) return toast("Add your name — approval is recorded with it.");
  store("builder.approver", by);
  try {
    S.run = await post(`/api/compose/${encodeURIComponent(S.run.runId)}/decide`, { approve, by });
    if (approve) return buildComposeRun();
    render();
    loadRuns();
  } catch (e) { toast(e.message); }
}

async function buildComposeRun() {
  try {
    S.run = await post(`/api/compose/${encodeURIComponent(S.run.runId)}/build`, {});
    await loadApps();
    render();
    loadRuns();
    loadBuilds();
  } catch (e) { toast(e.message); }
}

async function clarifyComposeRun(force) {
  const answers = ($("#c-answers") && $("#c-answers").value) || "";
  if (!force && !answers.trim()) return toast("Answer the questions, or proceed with assumptions.");
  try {
    S.run = await post(`/api/compose/${encodeURIComponent(S.run.runId)}/clarify`, { answers, force: force || undefined });
    render();
    if (RUNNING.has(S.run.state)) startPolling();
    loadRuns();
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------------ a build

function renderComposedBuild() {
  const b = S.build;
  const el = $("#run");
  el.hidden = false;
  S.lastBuildName = b.name;
  if (!b.summary) {
    el.innerHTML = `<div class="callout bad"><div class="callout-title">${esc(b.buildDir)}/ no longer composes</div><ul>${(b.problems || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul><div class="small">The catalogue has changed since it was built. Its app still runs from app.json.</div><div style="margin-top:8px">${appControl(b.name)}</div></div>`;
    bindAppControls(renderComposedBuild);
    return;
  }
  if (!["overview", "modules", "stages", "agent", "config", "files"].includes(S.cTab)) S.cTab = "overview";
  const asRun = { summary: b.summary, problems: b.problems || [], notes: [], config: b.config, state: "BUILT" };
  el.innerHTML = composeHero(asRun, b);
  bindCompose(renderComposedBuild);
  bindAppControls(renderComposedBuild);
}

// ------------------------------------------------------------------------ simple view

const COMPOSE_PHASES = [
  { label: "Choosing the modules", short: "Choosing" },
  { label: "Checking every rule", short: "Checking" },
  { label: "Ready for your decision", short: "Ready" },
];

function renderSimpleCompose() {
  const run = S.run;
  const el = $("#simple-run");
  const busy = RUNNING.has(run.state);
  const failed = run.state === "FAILED";
  const phase = busy ? 0 : run.state === "CLARIFICATION_REQUIRED" || failed ? 1 : 2;
  const steps = COMPOSE_PHASES.map((p, i) => {
    const done = !failed && (phase > i || (phase === i && !busy));
    const now = phase === i && busy;
    const cls = failed && phase === i ? "bad" : done ? "done" : now ? "now" : "";
    return `<li class="${cls}"><span class="tick">${done ? "&#10003;" : now ? '<span class="spinner"></span>' : failed && phase === i ? "&times;" : ""}</span><span class="grow">${esc(p.label)}</span></li>`;
  }).join("");

  const parts = [`<div class="said">${esc(run.request)}</div>`];
  if (busy) {
    const started = run.history && run.history.length ? run.history[0].at : null;
    parts.push(`<div class="live" role="status" aria-live="polite"><span class="spinner"></span><span class="live-word">${esc(COMPOSE_PHASES[phase].short)}<span class="live-dots" aria-hidden="true"><i></i><i></i><i></i></span></span>${started ? `<span class="live-meta mono">${esc(since(started))}</span>` : ""}</div>`);
  }
  parts.push(`<ol class="phases">${steps}</ol>`);

  const s = run.summary;
  if (failed) {
    parts.push(`<div class="callout bad"><div class="callout-title">It does not compose yet</div><div>${esc(run.error || "")}</div><div class="act" style="margin-top:8px">
      <button class="btn primary" type="button" data-redraft>Draft again</button>
      ${run.config ? '<button class="btn ghost" data-goto="detailed">Fix the config by hand</button>' : '<button class="btn ghost" data-goto="detailed">See what came back</button>'}
    </div></div>`);
  } else if (run.state === "CLARIFICATION_REQUIRED") {
    parts.push(`<div class="outcome"><h3>A few things change what gets built</h3><ul class="qlist">${(s ? s.openQuestions : []).filter((q) => q.blocks === "structure").map((q) => `<li><span class="badge warn">structure</span><span>${esc(q.question)}</span></li>`).join("")}</ul><div class="act"><button class="btn ghost" data-goto="detailed">Answer them</button></div></div>`);
  } else if (s) {
    const built = run.state === "BUILT";
    const board = s.stages.find((x) => x.board);
    const qs = s.openQuestions.length;
    parts.push(`<div class="outcome">
      <div class="outcome-top">
        <div><h3>${esc(s.business.name)}</h3><div class="muted small">${esc(s.label)} · ${esc(s.business.currency)} · ${esc(s.business.timezone)}</div></div>
        ${built ? '<span class="badge ok">built</span>' : '<span class="badge warn">awaiting approval</span>'}
      </div>
      <div class="figures">
        <div><b>${s.counts.modules}</b><span>modules</span></div>
        <div><b>${s.counts.tables}</b><span>tables</span></div>
        <div><b>${s.counts.actions}</b><span>actions</span></div>
        <div><b>${s.counts.held}</b><span>need a person</span></div>
      </div>
      <div class="chain">${s.modules.map((m, i) => `${i ? '<span class="arrow">·</span>' : ""}<span class="st">${esc(m.label)}</span>`).join("")}</div>
      ${board ? `<div class="chain" style="margin-top:6px">${board.states.map((x, i) => `${i ? '<span class="arrow">&rsaquo;</span>' : ""}<span class="st">${esc(x.label)}</span>`).join("")}</div>` : ""}
      ${qs ? `<button class="carried" data-goto="detailed">${qs} question${qs === 1 ? "" : "s"} carried as assumptions<span class="arrow">&rsaquo;</span></button>` : ""}
      ${built
        ? `<div class="act">${appControl(run.buildDir ? run.buildDir.split("/").pop() : "")}<button class="btn ghost" data-goto="detailed">See everything</button></div>`
        : `<div class="act"><input type="text" id="s-approver" placeholder="Your name" value="${esc(store("builder.approver") || "")}" /><button class="btn primary" id="s-approve">Approve &amp; build</button><button class="btn ghost" data-goto="detailed">Review it first</button></div>`}
    </div>`);
  }
  parts.push(`<div class="restart"><button class="btn ghost small" id="s-new">Start something else</button></div>`);
  el.innerHTML = parts.join("");

  $$("#simple-run [data-goto]").forEach((b) => b.addEventListener("click", () => { setMode("compose", false); setView(b.dataset.goto); }));
  const ap = $("#s-approve");
  if (ap) ap.addEventListener("click", () => {
    const name = ($("#s-approver").value || "").trim();
    if (!name) return toast("Put your name on the approval — it goes in the ledger.");
    decideComposeRun(true, name);
  });
  const nu = $("#s-new");
  if (nu) nu.addEventListener("click", () => { S.run = null; S.build = null; stopPolling(); $("#ask-input").value = ""; render(); $("#ask-input").focus(); });
  bindRedraft();
  bindAppControls(render);
}

/** A failed draft, asked again with the same words. A failed answer is never cached, so this is a fresh call. */
function bindRedraft() {
  $$("[data-redraft]").forEach((b) => b.addEventListener("click", () => {
    if (!S.run) return;
    b.disabled = true;
    startCompose(S.run.request, true);
  }));
}
