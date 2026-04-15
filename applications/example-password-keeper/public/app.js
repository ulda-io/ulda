import UldaFront, {
  createRestAdapter,
  createSocketIOAdapter
} from "/packages/ulda-front/ulda-front.js";

const ENTRY_PREFIX = "entry_";

const ui = {
  serverUrl: document.querySelector("#serverUrl"),
  transport: document.querySelector("#transport"),
  cabinetId: document.querySelector("#cabinetId"),
  masterPassword: document.querySelector("#masterPassword"),
  createBtn: document.querySelector("#createBtn"),
  connectBtn: document.querySelector("#connectBtn"),
  reloadBtn: document.querySelector("#reloadBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  deleteCabinetBtn: document.querySelector("#deleteCabinetBtn"),
  closeBtn: document.querySelector("#closeBtn"),
  addBtn: document.querySelector("#addBtn"),
  newTitle: document.querySelector("#newTitle"),
  newUser: document.querySelector("#newUser"),
  newPass: document.querySelector("#newPass"),
  newNote: document.querySelector("#newNote"),
  entries: document.querySelector("#entries"),
  status: document.querySelector("#status"),
  log: document.querySelector("#log")
};

const state = {
  client: null,
  socket: null,
  connected: false
};

ui.serverUrl.value = location.origin;

function log(message, data) {
  const time = new Date().toISOString();
  const line = `[${time}] ${message}`;
  const payload = data == null ? "" : `\n${JSON.stringify(data, null, 2)}`;
  ui.log.textContent = `${line}${payload}\n${ui.log.textContent}`.slice(0, 30_000);
}

function setStatus(text) {
  ui.status.textContent = text;
}

function ensureConnected() {
  if (!state.client || !state.connected) {
    throw new Error("Connect or create cabinet first");
  }
}

function normalizeServerUrl(raw) {
  const base = raw?.trim() || location.origin;
  return new URL(base).toString();
}

function toHttpBase(raw) {
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function toSocketBase(raw) {
  const url = new URL(raw);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function entryKey(id) {
  return `${ENTRY_PREFIX}${id}`;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map(v => v.toString(16).padStart(2, "0")).join("");
}

function listEntryIds() {
  if (!state.client?.data) return [];
  return Object.keys(state.client.data)
    .filter(k => k.startsWith(ENTRY_PREFIX))
    .map(k => k.slice(ENTRY_PREFIX.length));
}

async function closeSession() {
  if (state.client) {
    try {
      await state.client.close();
    } catch (err) {
      log("close() failed", { error: err?.message ?? String(err) });
    }
  }
  if (state.socket) {
    state.socket.disconnect();
  }
  state.client = null;
  state.socket = null;
  state.connected = false;
  renderEntries();
}

function createClientBundle({ serverUrl, transport, cabinetId, password }) {
  let socket = null;
  let adapter = null;
  if (transport === "rest") {
    adapter = createRestAdapter({
      configBaseUrl: toHttpBase(serverUrl)
    });
  } else {
    if (typeof globalThis.io !== "function") {
      throw new Error("Socket.IO client script is not available");
    }
    const socketUrl = toSocketBase(serverUrl);
    socket = globalThis.io(socketUrl, { transports: ["websocket", "polling"] });
    adapter = createSocketIOAdapter({
      socket,
      configBaseUrl: toHttpBase(serverUrl)
    });
  }
  const client = new UldaFront(cabinetId, password, serverUrl, {
    adapter,
    options: {
      allowInsecureLocalhost: true,
      autosave: false
    }
  });
  return { client, socket };
}

async function createCabinet() {
  const serverUrl = normalizeServerUrl(ui.serverUrl.value);
  const password = ui.masterPassword.value;
  const transport = ui.transport.value;
  if (!password) throw new Error("Master password is required");

  await closeSession();
  const bundle = createClientBundle({
    serverUrl,
    transport,
    cabinetId: null,
    password
  });

  state.client = bundle.client;
  state.socket = bundle.socket;

  const result = await state.client.create({ password, serverConnection: serverUrl });
  state.connected = true;
  ui.cabinetId.value = String(result.id);
  renderEntries();
  setStatus(`Connected to cabinet #${result.id}`);
  log("Cabinet created", result);
}

async function connectCabinet() {
  const serverUrl = normalizeServerUrl(ui.serverUrl.value);
  const cabinetId = Number(ui.cabinetId.value);
  const password = ui.masterPassword.value;
  const transport = ui.transport.value;
  if (!Number.isInteger(cabinetId) || cabinetId <= 0) throw new Error("Cabinet ID must be a positive integer");
  if (!password) throw new Error("Master password is required");

  await closeSession();
  const bundle = createClientBundle({
    serverUrl,
    transport,
    cabinetId,
    password
  });
  state.client = bundle.client;
  state.socket = bundle.socket;

  const result = await state.client.connect({
    id: cabinetId,
    password,
    serverConnection: serverUrl
  });
  state.connected = true;
  renderEntries();
  setStatus(`Connected to cabinet #${result.id}`);
  log("Cabinet connected", result);
}

async function forceSave() {
  ensureConnected();
  const result = await state.client.update();
  renderEntries();
  setStatus("Saved");
  log("Update complete", result);
}

async function reloadCabinet() {
  ensureConnected();
  const result = await state.client.reload();
  renderEntries();
  setStatus("Reloaded");
  log("Reload complete", result);
}

async function deleteCabinet() {
  ensureConnected();
  const id = state.client.id;
  const result = await state.client.delete();
  await closeSession();
  setStatus("Cabinet deleted");
  log("Cabinet deleted", { id, result });
}

async function addSecret() {
  ensureConnected();
  const title = ui.newTitle.value.trim();
  const username = ui.newUser.value.trim();
  const password = ui.newPass.value;
  const note = ui.newNote.value.trim();
  if (!title) throw new Error("Title is required");

  const id = randomId();
  const key = entryKey(id);
  state.client.data[key] = {
    title,
    username,
    password,
    note,
    updatedAt: new Date().toISOString()
  };
  await state.client.update();

  ui.newTitle.value = "";
  ui.newUser.value = "";
  ui.newPass.value = "";
  ui.newNote.value = "";

  renderEntries();
  setStatus(`Secret added (${id})`);
  log("Secret added", { id, key });
}

async function saveEntry(id, element) {
  ensureConnected();
  const title = element.querySelector('[data-field="title"]').value.trim();
  const username = element.querySelector('[data-field="username"]').value.trim();
  const password = element.querySelector('[data-field="password"]').value;
  const note = element.querySelector('[data-field="note"]').value.trim();
  if (!title) throw new Error("Title is required");
  state.client.data[entryKey(id)] = {
    title,
    username,
    password,
    note,
    updatedAt: new Date().toISOString()
  };
  await state.client.update();
  setStatus(`Secret ${id} saved`);
  log("Secret saved", { id });
}

async function deleteEntry(id) {
  ensureConnected();
  delete state.client.data[entryKey(id)];
  await state.client.update();
  renderEntries();
  setStatus(`Secret ${id} deleted`);
  log("Secret deleted", { id });
}

function renderEntries() {
  ui.entries.textContent = "";
  if (!state.connected || !state.client) {
    const empty = document.createElement("p");
    empty.textContent = "No active connection.";
    ui.entries.appendChild(empty);
    return;
  }

  const ids = listEntryIds();
  if (!ids.length) {
    const empty = document.createElement("p");
    empty.textContent = "No secrets yet.";
    ui.entries.appendChild(empty);
    return;
  }

  for (const id of ids) {
    const payload = state.client.data[entryKey(id)] ?? {};
    const row = document.createElement("article");
    row.className = "entry";
    row.innerHTML = `
      <div class="entry-header">
        <strong>${id}</strong>
        <span>${payload.updatedAt ?? "n/a"}</span>
      </div>
      <div class="entry-grid">
        <label>Title<input data-field="title" type="text" value="${escapeHtml(payload.title ?? "")}"></label>
        <label>Username<input data-field="username" type="text" value="${escapeHtml(payload.username ?? "")}"></label>
        <label>Password<input data-field="password" type="password" value="${escapeHtml(payload.password ?? "")}"></label>
        <label>Note<input data-field="note" type="text" value="${escapeHtml(payload.note ?? "")}"></label>
      </div>
      <div class="entry-actions">
        <button data-action="save">Save</button>
        <button class="secondary" data-action="toggle">Show/Hide</button>
        <button class="danger" data-action="delete">Delete</button>
      </div>
    `;

    row.querySelector('[data-action="save"]').addEventListener("click", async () => {
      try {
        await saveEntry(id, row);
      } catch (err) {
        setStatus("Error while saving entry");
        log("Save entry failed", { id, error: err?.message ?? String(err) });
      }
    });

    row.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      try {
        await deleteEntry(id);
      } catch (err) {
        setStatus("Error while deleting entry");
        log("Delete entry failed", { id, error: err?.message ?? String(err) });
      }
    });

    row.querySelector('[data-action="toggle"]').addEventListener("click", () => {
      const passInput = row.querySelector('[data-field="password"]');
      passInput.type = passInput.type === "password" ? "text" : "password";
    });

    ui.entries.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

ui.createBtn.addEventListener("click", async () => {
  try {
    setStatus("Creating cabinet...");
    await createCabinet();
  } catch (err) {
    setStatus("Create failed");
    log("Create failed", { error: err?.message ?? String(err) });
  }
});

ui.connectBtn.addEventListener("click", async () => {
  try {
    setStatus("Connecting...");
    await connectCabinet();
  } catch (err) {
    setStatus("Connect failed");
    log("Connect failed", { error: err?.message ?? String(err) });
  }
});

ui.reloadBtn.addEventListener("click", async () => {
  try {
    setStatus("Reloading...");
    await reloadCabinet();
  } catch (err) {
    setStatus("Reload failed");
    log("Reload failed", { error: err?.message ?? String(err) });
  }
});

ui.saveBtn.addEventListener("click", async () => {
  try {
    setStatus("Saving...");
    await forceSave();
  } catch (err) {
    setStatus("Save failed");
    log("Save failed", { error: err?.message ?? String(err) });
  }
});

ui.deleteCabinetBtn.addEventListener("click", async () => {
  try {
    const ok = confirm("Delete the whole cabinet and all linked records?");
    if (!ok) return;
    setStatus("Deleting cabinet...");
    await deleteCabinet();
  } catch (err) {
    setStatus("Delete cabinet failed");
    log("Delete cabinet failed", { error: err?.message ?? String(err) });
  }
});

ui.closeBtn.addEventListener("click", async () => {
  await closeSession();
  setStatus("Disconnected");
  log("Session closed");
});

ui.addBtn.addEventListener("click", async () => {
  try {
    setStatus("Adding secret...");
    await addSecret();
  } catch (err) {
    setStatus("Add failed");
    log("Add failed", { error: err?.message ?? String(err) });
  }
});

renderEntries();
