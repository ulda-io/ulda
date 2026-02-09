import UldaSign from "./ulda-sign.js";

const recordIdEl = document.querySelector("#recordId");
const currentSigEl = document.querySelector("#currentSig");
const currentContentEl = document.querySelector("#currentContent");
const outputEl = document.querySelector("#output");
const statusEl = document.querySelector("#status");
const serverEl = document.querySelector("#server");
const configEl = document.querySelector("#config");
const createBtn = document.querySelector("#createBtn");
const updateBtn = document.querySelector("#updateBtn");
const readBtn = document.querySelector("#readBtn");
const deleteBtn = document.querySelector("#deleteBtn");

const fallbackOrigin = location.origin === "null" ? "http://localhost:8787" : location.origin;
const serverBase = new URLSearchParams(location.search).get("server") ?? fallbackOrigin;
serverEl.textContent = serverBase;

const state = {
  config: null,
  ulda: null,
  originPkg: null,
  currentSig: null,
  currentContent: null,
  signatures: [],
  contents: [],
  id: null,
  index: 0
};

function setStatus(text, tone = "idle") {
  statusEl.textContent = text;
  statusEl.style.background = tone === "error" ? "#ffe5e5" : "#e9efff";
  statusEl.style.color = tone === "error" ? "#b91c1c" : "#2f6bff";
}

function show(result) {
  outputEl.textContent = JSON.stringify(result, null, 2);
}

async function fetchJsonWithTiming(url, options) {
  const start = performance.now();
  const res = await fetch(url, options);
  const data = await res.json();
  const clientMs = Number((performance.now() - start).toFixed(2));
  return { data, clientMs };
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunk));
  }
  return btoa(binary);
}

function randomBytes(size) {
  const arr = new Uint8Array(size);
  crypto.getRandomValues(arr);
  return arr;
}

async function loadConfig() {
  const res = await fetch(`${serverBase}/config`);
  const data = await res.json();
  if (!data?.originSize) throw new Error("config unavailable");
  state.config = data;
  configEl.textContent = `originSize=${data.originSize}, N=${data.sign.N}, mode=${data.sign.mode}, hash=${data.sign.hash}`;
}

function ensureSigner() {
  if (!state.config) throw new Error("Config not loaded");
  if (state.ulda) return;
  state.ulda = new UldaSign({
    fmt: { export: "hex" },
    sign: {
      originSize: state.config.originSize,
      N: state.config.sign.N,
      mode: state.config.sign.mode,
      hash: state.config.sign.hash
    }
  });
}

function updateUiState() {
  currentSigEl.value = state.currentSig ?? "";
  currentContentEl.value = state.currentContent ?? "";
  recordIdEl.value = state.id ?? "";
}

async function createRecord() {
  setStatus("creating...");
  if (!state.config) await loadConfig();
  ensureSigner();

  if (state.signatures.length) {
    state.signatures = [];
    state.contents = [];
  }

  const originPkg = state.ulda.New(0n);
  const sigA = await state.ulda.sign(originPkg);
  const content = bytesToBase64(randomBytes(state.config.contentBytes));

  const { data, clientMs } = await fetchJsonWithTiming(`${serverBase}/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ulda_key: sigA,
      content,
      format: "hex",
      contentFormat: "base64"
    })
  });
  if (!data.ok) {
    setStatus("error", "error");
    show({ ...data, clientMs });
    return;
  }

  state.id = data.id;
  state.originPkg = originPkg;
  state.currentSig = sigA;
  state.currentContent = content;
  state.signatures.push(sigA);
  state.contents.push(content);
  state.index = 0;

  updateUiState();
  setStatus(`created #${data.id}`);
  show({ ...data, clientMs, localIndex: state.index, signatureCount: state.signatures.length });
}

async function updateRecord() {
  setStatus("updating...");
  if (!state.id || !state.ulda || !state.originPkg) {
    setStatus("missing session", "error");
    show({ ok: false, error: "Create a record first" });
    return;
  }

  state.originPkg = state.ulda.stepUp(state.originPkg);
  const sigB = await state.ulda.sign(state.originPkg);
  const content = bytesToBase64(randomBytes(state.config.contentBytes));

  const { data, clientMs } = await fetchJsonWithTiming(`${serverBase}/records/${state.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ulda_key: sigB,
      content,
      format: "hex",
      contentFormat: "base64"
    })
  });
  if (!data.ok) {
    setStatus("error", "error");
    show({ ...data, clientMs });
    return;
  }

  state.currentSig = sigB;
  state.currentContent = content;
  state.signatures.push(sigB);
  state.contents.push(content);
  state.index += 1;

  updateUiState();
  setStatus(`updated #${state.id}`);
  show({ ...data, clientMs, localIndex: state.index, signatureCount: state.signatures.length });
}

async function readRecord() {
  const id = recordIdEl.value ? Number(recordIdEl.value) : null;
  if (!id) {
    setStatus("missing id", "error");
    show({ ok: false, error: "Provide an id" });
    return;
  }
  setStatus("reading...");
  const { data, clientMs } = await fetchJsonWithTiming(
    `${serverBase}/records/${id}?format=hex&contentFormat=base64`
  );
  if (!data.ok) {
    setStatus("error", "error");
    show({ ...data, clientMs });
    return;
  }
  setStatus(`read #${id}`);
  show({ ...data, clientMs });
}

async function deleteRecord() {
  const id = recordIdEl.value ? Number(recordIdEl.value) : null;
  if (!id) {
    setStatus("missing id", "error");
    show({ ok: false, error: "Provide an id" });
    return;
  }
  if (!state.currentSig) {
    setStatus("missing signature", "error");
    show({ ok: false, error: "No signature in memory" });
    return;
  }
  setStatus("deleting...");
  const { data, clientMs } = await fetchJsonWithTiming(`${serverBase}/records/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ulda_key: state.currentSig, format: "hex" })
  });
  if (!data.ok) {
    setStatus("error", "error");
    show({ ...data, clientMs });
    return;
  }
  setStatus(`deleted #${id}`);
  show({ ...data, clientMs, preservedSignatures: state.signatures.length });
  state.id = null;
  state.originPkg = null;
  state.currentSig = null;
  state.currentContent = null;
  updateUiState();
}

createBtn.addEventListener("click", () => {
  createRecord().catch(err => {
    setStatus("error", "error");
    show({ ok: false, error: err?.message ?? String(err) });
  });
});

updateBtn.addEventListener("click", () => {
  updateRecord().catch(err => {
    setStatus("error", "error");
    show({ ok: false, error: err?.message ?? String(err) });
  });
});

readBtn.addEventListener("click", () => {
  readRecord().catch(err => {
    setStatus("error", "error");
    show({ ok: false, error: err?.message ?? String(err) });
  });
});

deleteBtn.addEventListener("click", () => {
  deleteRecord().catch(err => {
    setStatus("error", "error");
    show({ ok: false, error: err?.message ?? String(err) });
  });
});

loadConfig().catch(err => {
  setStatus("config error", "error");
  show({ ok: false, error: err?.message ?? String(err) });
});
