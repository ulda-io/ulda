import UldaSign from "../ulda-sign/ulda-sign.js";

/**
 * ULDA Frontend API
 *
 * This file provides:
 * - UldaFront class (cabinet lifecycle + proxy data API)
 * - REST adapter factory
 * - Socket.IO adapter factory
 * - Security-focused envelope cryptography defaults
 *
 * Security note:
 * - This class does not persist secrets to local storage.
 * - Key material is kept in memory only and cleared on close().
 * - Insecure transport is rejected by default (except localhost when enabled).
 */

const DEFAULT_OPTIONS = Object.freeze({
  autosave: true,
  autosaveDebounceMs: 0,
  allowInsecureLocalhost: false,
  maxMutationDepth: 64,
  maxLogicalNameLength: 128
});

const REQUIRED_ADAPTER_METHODS = Object.freeze([
  "createMasterRecord",
  "readRecord",
  "createContentRecord",
  "updateRecord",
  "deleteRecord",
  "deriveMasterKey",
  "generateContentKey",
  "encryptEnvelope",
  "decryptEnvelope",
  "createInitialOrigin",
  "stepUpAndSign"
]);

const DEFAULT_KDF_ITERATIONS = 310_000;
const DEFAULT_CONTENT_KEY_BYTES = 32;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function hasBuffer() {
  return typeof Buffer !== "undefined";
}

function ensureWebCrypto() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new UldaSecurityError("WebCrypto is required (crypto.subtle + getRandomValues)");
  }
  return globalThis.crypto;
}

function utf8ToBytes(value) {
  return textEncoder.encode(value);
}

function bytesToUtf8(bytes) {
  return textDecoder.decode(bytes);
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === "string") return utf8ToBytes(value);
  throw new UldaStateError("Cannot convert value to Uint8Array");
}

function bytesToBase64(bytes) {
  if (typeof btoa === "function") {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunk));
    }
    return btoa(binary);
  }
  if (hasBuffer()) return Buffer.from(bytes).toString("base64");
  throw new UldaStateError("No base64 encoder available in this runtime");
}

function base64ToBytes(value) {
  if (typeof atob === "function") {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (hasBuffer()) return new Uint8Array(Buffer.from(value, "base64"));
  throw new UldaStateError("No base64 decoder available in this runtime");
}

function randomBytes(length) {
  const out = new Uint8Array(length);
  ensureWebCrypto().getRandomValues(out);
  return out;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJsonValue(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = cloneJsonValue(v);
  return out;
}

function normalizeHttpBase(input) {
  if (!input) return null;
  const url = new URL(String(input));
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function importAesGcmKey(rawKeyBytes) {
  return ensureWebCrypto().subtle.importKey("raw", rawKeyBytes, "AES-GCM", false, [
    "encrypt",
    "decrypt"
  ]);
}

async function derivePbkdf2AesKey({ passwordBytes, saltBytes, iterations }) {
  const baseKey = await ensureWebCrypto().subtle.importKey(
    "raw",
    passwordBytes,
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return ensureWebCrypto().subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: saltBytes
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function decodeEnvelope(encrypted) {
  if (isPlainObject(encrypted)) return encrypted;
  if (encrypted instanceof Uint8Array) {
    return JSON.parse(bytesToUtf8(encrypted));
  }
  if (typeof encrypted !== "string") {
    throw new UldaSecurityError("Encrypted envelope must be object, Uint8Array, or base64 string");
  }
  const trimmed = encrypted.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const bytes = base64ToBytes(trimmed);
  return JSON.parse(bytesToUtf8(bytes));
}

function encodeEnvelope(envelopeObject) {
  const jsonBytes = utf8ToBytes(JSON.stringify(envelopeObject));
  return bytesToBase64(jsonBytes);
}

async function encryptEnvelopeInternal({ role, plaintext, key, kdfIterations }) {
  if (!isPlainObject(plaintext)) {
    throw new UldaSecurityError("Plaintext document must be a plain object");
  }
  const iv = randomBytes(12);
  const payloadBytes = utf8ToBytes(JSON.stringify(plaintext));

  let aesKey;
  let kdf = null;
  if (role === "master") {
    if (!isPlainObject(key) || key.kind !== "master-password" || !(key.passwordBytes instanceof Uint8Array)) {
      throw new UldaSecurityError("Master envelope requires password-derived key context");
    }
    const salt = randomBytes(16);
    const iterations = Number(kdfIterations ?? DEFAULT_KDF_ITERATIONS);
    aesKey = await derivePbkdf2AesKey({
      passwordBytes: key.passwordBytes,
      saltBytes: salt,
      iterations
    });
    kdf = {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: bytesToBase64(salt)
    };
  } else if (role === "content") {
    const keyBytes = base64ToBytes(String(key));
    if (keyBytes.length !== DEFAULT_CONTENT_KEY_BYTES) {
      throw new UldaSecurityError("Content key must be 32 bytes (base64-encoded)");
    }
    aesKey = await importAesGcmKey(keyBytes);
  } else {
    throw new UldaSecurityError(`Unsupported envelope role "${role}"`);
  }

  const encrypted = new Uint8Array(
    await ensureWebCrypto().subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: utf8ToBytes(`ulda-front:${role}:v1`)
      },
      aesKey,
      payloadBytes
    )
  );

  return encodeEnvelope({
    enc: "A256GCM",
    iv: bytesToBase64(iv),
    ct: bytesToBase64(encrypted),
    ...(kdf ? { kdf } : {})
  });
}

async function decryptEnvelopeInternal({ role, encrypted, key }) {
  const envelope = decodeEnvelope(encrypted);
  if (!isPlainObject(envelope) || envelope.enc !== "A256GCM") {
    throw new UldaSecurityError("Unsupported or malformed envelope");
  }
  if (envelope.v != null && envelope.v !== 1) {
    throw new UldaSecurityError("Unsupported envelope version");
  }
  const iv = base64ToBytes(String(envelope.iv ?? ""));
  const ct = base64ToBytes(String(envelope.ct ?? ""));
  if (iv.length !== 12) throw new UldaSecurityError("Invalid AES-GCM IV length");

  let aesKey;
  if (role === "master") {
    if (!isPlainObject(key) || key.kind !== "master-password" || !(key.passwordBytes instanceof Uint8Array)) {
      throw new UldaSecurityError("Master decryption requires password-derived key context");
    }
    const kdf = envelope.kdf;
    if (!isPlainObject(kdf) || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256") {
      throw new UldaSecurityError("Unsupported KDF metadata in envelope");
    }
    const salt = base64ToBytes(String(kdf.salt ?? ""));
    const iterations = Number(kdf.iterations ?? DEFAULT_KDF_ITERATIONS);
    aesKey = await derivePbkdf2AesKey({
      passwordBytes: key.passwordBytes,
      saltBytes: salt,
      iterations
    });
  } else if (role === "content") {
    const keyBytes = base64ToBytes(String(key));
    if (keyBytes.length !== DEFAULT_CONTENT_KEY_BYTES) {
      throw new UldaSecurityError("Content key must be 32 bytes (base64-encoded)");
    }
    aesKey = await importAesGcmKey(keyBytes);
  } else {
    throw new UldaSecurityError(`Unsupported envelope role "${role}"`);
  }

  const decrypted = new Uint8Array(
    await ensureWebCrypto().subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: utf8ToBytes(`ulda-front:${role}:v1`)
      },
      aesKey,
      ct
    )
  );

  const parsed = JSON.parse(bytesToUtf8(decrypted));
  if (!isPlainObject(parsed)) throw new UldaSecurityError("Envelope plaintext must be a JSON object");
  return parsed;
}

function createHttpJsonRequest(fetchImpl, { method, url, body }) {
  return fetchImpl(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body == null ? {} : { body: JSON.stringify(body) })
  });
}

async function parseJsonResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new UldaFrontError("Server returned a non-JSON response", "ULDA_TRANSPORT_ERROR", err);
  }
  if (!response.ok || !data?.ok) {
    throw new UldaFrontError(
      data?.error ?? `Transport request failed with status ${response.status}`,
      "ULDA_TRANSPORT_ERROR"
    );
  }
  return data;
}

function createSignerManager({
  fetchImpl,
  fixedSignConfig = null,
  configBaseUrl = null
}) {
  const signerCache = new Map();
  const configCache = new Map();

  async function resolveConfig(serverConnection) {
    if (fixedSignConfig) {
      return fixedSignConfig;
    }
    const httpBase = normalizeHttpBase(configBaseUrl ?? serverConnection);
    if (!httpBase) {
      throw new UldaStateError(
        "No sign config available. Provide signConfig or a serverConnection/configBaseUrl with /config endpoint."
      );
    }
    if (configCache.has(httpBase)) return configCache.get(httpBase);
    if (typeof fetchImpl !== "function") {
      throw new UldaStateError("fetch implementation is required to load /config");
    }
    const url = new URL("/config", httpBase).toString();
    const response = await createHttpJsonRequest(fetchImpl, { method: "GET", url });
    if (!response.ok) {
      throw new UldaFrontError(
        `Failed to load sign config from ${url} (status ${response.status})`,
        "ULDA_TRANSPORT_ERROR"
      );
    }
    const data = await response.json();
    if (!data?.originSize || !data?.sign) {
      throw new UldaFrontError(
        "Config response is missing ULDA sign parameters",
        "ULDA_TRANSPORT_ERROR"
      );
    }
    const resolved = {
      originSize: Number(data.originSize),
      N: Number(data.sign?.N),
      mode: String(data.sign?.mode ?? "S"),
      hash: String(data.sign?.hash ?? "SHA-256")
    };
    configCache.set(httpBase, resolved);
    return resolved;
  }

  async function getSigner(serverConnection) {
    const key = String(serverConnection ?? "__default__");
    if (signerCache.has(key)) return signerCache.get(key);
    const sign = await resolveConfig(serverConnection);
    const signer = new UldaSign({
      fmt: { export: "hex" },
      sign: {
        originSize: sign.originSize,
        N: sign.N,
        mode: sign.mode,
        hash: sign.hash
      }
    });
    signerCache.set(key, signer);
    return signer;
  }

  return { getSigner };
}

function createCoreAdapter({
  transport,
  fetchImpl,
  signConfig,
  configBaseUrl,
  kdfIterations = DEFAULT_KDF_ITERATIONS,
  contentKeyBytes = DEFAULT_CONTENT_KEY_BYTES
}) {
  if (contentKeyBytes !== 32) {
    throw new UldaSecurityError("Only 32-byte AES-256 content keys are supported");
  }

  const signers = createSignerManager({
    fetchImpl,
    fixedSignConfig: signConfig ?? null,
    configBaseUrl: configBaseUrl ?? null
  });

  return {
    async createMasterRecord({ serverConnection, uldaKey, content }) {
      return transport.createRecord({
        serverConnection,
        uldaKey,
        content
      });
    },
    async readRecord({ serverConnection, id }) {
      return transport.readRecord({
        serverConnection,
        id
      });
    },
    async createContentRecord({ serverConnection, uldaKey, content }) {
      return transport.createRecord({
        serverConnection,
        uldaKey,
        content
      });
    },
    async updateRecord({ serverConnection, id, uldaKey, content }) {
      return transport.updateRecord({
        serverConnection,
        id,
        uldaKey,
        content
      });
    },
    async deleteRecord({ serverConnection, id, uldaKey }) {
      return transport.deleteRecord({
        serverConnection,
        id,
        uldaKey
      });
    },
    async deriveMasterKey({ password }) {
      const passwordBytes =
        typeof password === "string" ? utf8ToBytes(password) : toUint8Array(password);
      return {
        kind: "master-password",
        passwordBytes
      };
    },
    async generateContentKey() {
      return bytesToBase64(randomBytes(contentKeyBytes));
    },
    async encryptEnvelope({ role, plaintext, key }) {
      return encryptEnvelopeInternal({
        role,
        plaintext,
        key,
        kdfIterations
      });
    },
    async decryptEnvelope({ role, encrypted, key }) {
      return decryptEnvelopeInternal({
        role,
        encrypted,
        key
      });
    },
    async createInitialOrigin({ serverConnection }) {
      const signer = await signers.getSigner(serverConnection);
      return signer.New(0n);
    },
    async stepUpAndSign({ originPkg, serverConnection }) {
      const signer = await signers.getSigner(serverConnection);
      const nextOriginPkg = signer.stepUp(originPkg);
      const nextSignature = await signer.sign(nextOriginPkg);
      return { nextOriginPkg, nextSignature };
    }
  };
}

export function createRestAdapter({
  fetchImpl = globalThis.fetch,
  signConfig = null,
  configBaseUrl = null,
  kdfIterations = DEFAULT_KDF_ITERATIONS
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new UldaStateError("createRestAdapter requires fetch implementation");
  }

  const transport = {
    async createRecord({ serverConnection, uldaKey, content }) {
      const base = normalizeHttpBase(serverConnection);
      if (!base) throw new UldaStateError("REST adapter requires serverConnection URL");
      const url = new URL("/records", base).toString();
      const response = await createHttpJsonRequest(fetchImpl, {
        method: "POST",
        url,
        body: {
          ulda_key: String(uldaKey),
          content: String(content),
          format: "hex",
          contentFormat: "base64"
        }
      });
      const data = await parseJsonResponse(response);
      return { id: data.id };
    },
    async readRecord({ serverConnection, id }) {
      const base = normalizeHttpBase(serverConnection);
      if (!base) throw new UldaStateError("REST adapter requires serverConnection URL");
      const url = new URL(`/records/${id}`, base);
      url.searchParams.set("format", "hex");
      url.searchParams.set("contentFormat", "base64");
      const response = await createHttpJsonRequest(fetchImpl, {
        method: "GET",
        url: url.toString()
      });
      const data = await parseJsonResponse(response);
      return {
        id: data.id,
        uldaKey: data.ulda_key,
        content: data.content
      };
    },
    async updateRecord({ serverConnection, id, uldaKey, content }) {
      const base = normalizeHttpBase(serverConnection);
      if (!base) throw new UldaStateError("REST adapter requires serverConnection URL");
      const url = new URL(`/records/${id}`, base).toString();
      const response = await createHttpJsonRequest(fetchImpl, {
        method: "PUT",
        url,
        body: {
          ulda_key: String(uldaKey),
          content: String(content),
          format: "hex",
          contentFormat: "base64"
        }
      });
      await parseJsonResponse(response);
      return { ok: true };
    },
    async deleteRecord({ serverConnection, id, uldaKey }) {
      const base = normalizeHttpBase(serverConnection);
      if (!base) throw new UldaStateError("REST adapter requires serverConnection URL");
      const url = new URL(`/records/${id}`, base).toString();
      const response = await createHttpJsonRequest(fetchImpl, {
        method: "DELETE",
        url,
        body: {
          ulda_key: String(uldaKey),
          format: "hex"
        }
      });
      await parseJsonResponse(response);
      return { ok: true };
    }
  };

  return createCoreAdapter({
    transport,
    fetchImpl,
    signConfig,
    configBaseUrl,
    kdfIterations
  });
}

export function createSocketIOAdapter({
  socket,
  fetchImpl = globalThis.fetch,
  signConfig = null,
  configBaseUrl = null,
  kdfIterations = DEFAULT_KDF_ITERATIONS,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS
} = {}) {
  if (!socket || typeof socket.emit !== "function") {
    throw new UldaStateError("createSocketIOAdapter requires socket with emit(event, payload, cb)");
  }

  function socketRequest(event, payload) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new UldaFrontError(`Socket timeout for event "${event}"`, "ULDA_TRANSPORT_TIMEOUT"));
      }, timeoutMs);
      try {
        socket.emit(event, payload, data => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (!data?.ok) {
            reject(
              new UldaFrontError(
                data?.error ?? `Socket event "${event}" failed`,
                "ULDA_TRANSPORT_ERROR"
              )
            );
            return;
          }
          resolve(data);
        });
      } catch (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new UldaFrontError(`Socket emit failed for "${event}"`, "ULDA_TRANSPORT_ERROR", err));
      }
    });
  }

  const transport = {
    async createRecord({ uldaKey, content }) {
      const data = await socketRequest("create", {
        ulda_key: String(uldaKey),
        content: String(content),
        format: "hex",
        contentFormat: "base64"
      });
      return { id: data.id };
    },
    async readRecord({ id }) {
      const data = await socketRequest("read", {
        id,
        format: "hex",
        contentFormat: "base64"
      });
      return {
        id: data.id,
        uldaKey: data.ulda_key,
        content: data.content
      };
    },
    async updateRecord({ id, uldaKey, content }) {
      await socketRequest("update", {
        id,
        ulda_key: String(uldaKey),
        content: String(content),
        format: "hex",
        contentFormat: "base64"
      });
      return { ok: true };
    },
    async deleteRecord({ id, uldaKey }) {
      await socketRequest("delete", {
        id,
        ulda_key: String(uldaKey),
        format: "hex"
      });
      return { ok: true };
    }
  };

  return createCoreAdapter({
    transport,
    fetchImpl,
    signConfig,
    configBaseUrl,
    kdfIterations
  });
}

export class UldaFrontError extends Error {
  constructor(message, code = "ULDA_FRONT_ERROR", cause) {
    super(message);
    this.name = "UldaFrontError";
    this.code = code;
    this.cause = cause;
  }
}

export class UldaSecurityError extends UldaFrontError {
  constructor(message, cause) {
    super(message, "ULDA_SECURITY_ERROR", cause);
    this.name = "UldaSecurityError";
  }
}

export class UldaStateError extends UldaFrontError {
  constructor(message, cause) {
    super(message, "ULDA_STATE_ERROR", cause);
    this.name = "UldaStateError";
  }
}

export class UldaNotImplementedError extends UldaFrontError {
  constructor(message, cause) {
    super(message, "ULDA_NOT_IMPLEMENTED", cause);
    this.name = "UldaNotImplementedError";
  }
}

/**
 * Frontend client for ULDA "cabinet" model.
 *
 * Public goals:
 * - connect/create/reload/close/update/delete lifecycle
 * - proxy-based data mutations (`ulda.data.*`)
 * - automatic save scheduling after proxy mutations
 *
 * Current non-goals:
 * - conflict resolution across concurrent writers
 * - transaction-like atomicity across master + multiple content records
 * - advanced retry policy tuning
 */
export default class UldaFront {
  #adapter;
  #options;
  #serverUrl;
  #masterId;
  #masterKey;
  #passwordSeed;
  #connected;
  #closed;

  #masterDoc;
  #contentDocs;

  #dataRoot;
  #dataProxy;

  #dirtyLogicalNames;
  #pendingCreateLogicalNames;
  #pendingDeleteLogicalNames;

  #flushChain;
  #autosaveTimer;

  /**
   * @param {number|string|null} id
   * @param {string|Uint8Array|null} password
   * @param {string|null} serverConnection
   * @param {object} [cfg]
   * @param {object} cfg.adapter Required adapter with transport+crypto methods.
   * @param {object} [cfg.options] Runtime options (security + autosave).
   */
  constructor(id = null, password = null, serverConnection = null, cfg = {}) {
    this.#adapter = cfg.adapter ?? null;
    this.#options = Object.freeze({ ...DEFAULT_OPTIONS, ...(cfg.options ?? {}) });
    this.#serverUrl = serverConnection ?? null;
    this.#masterId = id ?? null;
    this.#masterKey = null;
    this.#passwordSeed = password ?? null;
    this.#connected = false;
    this.#closed = false;

    this.#masterDoc = null;
    this.#contentDocs = new Map();

    this.#dataRoot = {};
    this.#dataProxy = this.#createProxy(this.#dataRoot, [], 0);

    this.#dirtyLogicalNames = new Set();
    this.#pendingCreateLogicalNames = new Set();
    this.#pendingDeleteLogicalNames = new Set();

    this.#flushChain = Promise.resolve();
    this.#autosaveTimer = null;

    this.#validateAdapter();
    this.#validateServerUrl(this.#serverUrl);

  }

  /**
   * Proxy view over decrypted logical cabinet data.
   * Mutations schedule autosave (unless disabled).
   */
  get data() {
    this.#assertOpen();
    return this.#dataProxy;
  }

  /**
   * Master record id for current session.
   */
  get id() {
    return this.#masterId;
  }

  /**
   * Connect to existing master cabinet.
   */
  async connect({ id = this.#masterId, password, serverConnection = this.#serverUrl } = {}) {
    this.#assertOpen();
    this.#assertAdapterReady();
    this.#validateServerUrl(serverConnection);
    if (id == null) throw new UldaStateError("connect() requires a master id");
    const resolvedPassword = password ?? this.#passwordSeed;
    if (resolvedPassword == null && !this.#masterKey) {
      throw new UldaStateError("connect() requires password (or an active master key)");
    }

    if (resolvedPassword != null) await this.#setPassword(resolvedPassword);
    this.#serverUrl = serverConnection;
    this.#masterId = id;

    const encryptedMaster = await this.#adapter.readRecord({
      serverConnection: this.#serverUrl,
      id: this.#masterId
    });

    const masterDoc = await this.#adapter.decryptEnvelope({
      role: "master",
      encrypted: encryptedMaster.content,
      key: this.#masterKey
    });

    this.#assertMasterDoc(masterDoc);
    this.#masterDoc = masterDoc;
    this.#contentDocs.clear();

    const logicalNames = Object.keys(masterDoc.links ?? {});
    for (const logicalName of logicalNames) {
      const link = masterDoc.links[logicalName];
      const encryptedContent = await this.#adapter.readRecord({
        serverConnection: this.#serverUrl,
        id: link.id
      });
      const contentDoc = await this.#adapter.decryptEnvelope({
        role: "content",
        encrypted: encryptedContent.content,
        key: link.key
      });
      this.#assertContentDoc(contentDoc, logicalName);
      this.#contentDocs.set(logicalName, {
        id: link.id,
        key: link.key,
        doc: contentDoc
      });
    }

    this.#rebuildDataRootFromContent();
    this.#clearDirtyState();
    this.#connected = true;
    return { ok: true, id: this.#masterId };
  }

  /**
   * Create a new master cabinet.
   *
   * Security-first default:
   * - caller supplies password
   * - master record created with empty links/data
   */
  async create({ password, serverConnection = this.#serverUrl } = {}) {
    this.#assertOpen();
    this.#assertAdapterReady();
    this.#validateServerUrl(serverConnection);
    const resolvedPassword = password ?? this.#passwordSeed;
    if (resolvedPassword == null) throw new UldaStateError("create() requires a password");
    await this.#setPassword(resolvedPassword);
    this.#serverUrl = serverConnection;

    const originPkg = await this.#adapter.createInitialOrigin({
      role: "master",
      serverConnection: this.#serverUrl
    });
    const { nextOriginPkg, nextSignature } = await this.#adapter.stepUpAndSign({
      originPkg,
      serverConnection: this.#serverUrl
    });

    const masterDoc = {
      originPkg: nextOriginPkg,
      links: {},
      data: {}
    };

    const encrypted = await this.#adapter.encryptEnvelope({
      role: "master",
      plaintext: masterDoc,
      key: this.#masterKey
    });

    const createResult = await this.#adapter.createMasterRecord({
      serverConnection: this.#serverUrl,
      uldaKey: nextSignature,
      content: encrypted
    });

    this.#masterId = createResult.id;
    this.#masterDoc = masterDoc;
    this.#contentDocs.clear();
    this.#rebuildDataRootFromContent();
    this.#clearDirtyState();
    this.#connected = true;
    return { ok: true, id: this.#masterId };
  }

  /**
   * Force synchronization of all pending mutations.
   */
  async update() {
    this.#assertConnected();
    return this.#queueFlush();
  }

  /**
   * Reload all data from server and rebuild local cache.
   */
  async reload() {
    this.#assertConnected();
    return this.connect({
      id: this.#masterId,
      serverConnection: this.#serverUrl
    });
  }

  /**
   * Delete cabinet or logical content key.
   *
   * - delete()             -> delete whole master cabinet (+ best-effort contents)
   * - delete("name")       -> delete one logical content entry
   */
  async delete(target) {
    this.#assertConnected();
    if (target == null) {
      return this.#deleteMasterCabinet();
    }
    if (typeof target !== "string" || !target.trim()) {
      throw new UldaStateError("delete(target) expects a non-empty string key");
    }
    return this.#deleteLogicalKey(target.trim());
  }

  /**
   * Close client, clear secrets and in-memory state.
   */
  async close() {
    if (this.#closed) return { ok: true };
    clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = null;
    this.#connected = false;
    this.#closed = true;

    this.#clearDirtyState();
    this.#masterId = null;
    this.#serverUrl = null;
    this.#masterDoc = null;
    this.#contentDocs.clear();
    this.#dataRoot = {};
    this.#dataProxy = this.#createProxy(this.#dataRoot, [], 0);
    this.#passwordSeed = null;
    this.#clearMasterKey();
    return { ok: true };
  }

  async #deleteMasterCabinet() {
    const snapshot = Array.from(this.#contentDocs.entries());
    for (const [, entry] of snapshot) {
      try {
        const stepped = await this.#adapter.stepUpAndSign({
          originPkg: entry.doc.originPkg,
          serverConnection: this.#serverUrl
        });
        await this.#adapter.deleteRecord({
          serverConnection: this.#serverUrl,
          id: entry.id,
          uldaKey: stepped.nextSignature
        });
      } catch {
        // Best-effort demo behavior; detailed conflict recovery is out of scope.
      }
    }

    const masterStepped = await this.#adapter.stepUpAndSign({
      originPkg: this.#masterDoc?.originPkg,
      serverConnection: this.#serverUrl
    });
    await this.#adapter.deleteRecord({
      serverConnection: this.#serverUrl,
      id: this.#masterId,
      uldaKey: masterStepped.nextSignature
    });

    await this.close();
    return { ok: true };
  }

  async #deleteLogicalKey(logicalName) {
    this.#assertLogicalName(logicalName);
    if (!this.#contentDocs.has(logicalName)) {
      return { ok: false, reason: "not_found", key: logicalName };
    }
    delete this.#dataRoot[logicalName];
    this.#pendingDeleteLogicalNames.add(logicalName);
    this.#dirtyLogicalNames.delete(logicalName);
    this.#scheduleAutosave();
    return this.#options.autosave ? this.#queueFlush() : { ok: true, scheduled: true };
  }

  #createProxy(target, path, depth) {
    if (depth > this.#options.maxMutationDepth) {
      throw new UldaStateError("Maximum proxy mutation depth exceeded");
    }
    const self = this;
    return new Proxy(target, {
      get(obj, prop, receiver) {
        if (prop === "__isUldaProxy") return true;
        if (prop === "delete") {
          const logicalName = self.#extractTopLevelLogicalName(path);
          if (!logicalName) return undefined;
          return async () => self.delete(logicalName);
        }
        const value = Reflect.get(obj, prop, receiver);
        if (!self.#isPlainObject(value)) return value;
        return self.#createProxy(value, path.concat(String(prop)), depth + 1);
      },
      set(obj, prop, value) {
        self.#assertConnected();
        const ok = Reflect.set(obj, prop, value);
        if (!ok) return false;
        const logicalName = self.#extractTopLevelLogicalName(path.concat(String(prop)));
        if (logicalName) self.#registerMutation(logicalName);
        return true;
      },
      deleteProperty(obj, prop) {
        self.#assertConnected();
        const existed = Reflect.has(obj, prop);
        const ok = Reflect.deleteProperty(obj, prop);
        if (!ok || !existed) return ok;
        const nextPath = path.concat(String(prop));
        if (path.length === 0) {
          self.#registerDeletion(String(prop));
          return ok;
        }
        const logicalName = self.#extractTopLevelLogicalName(nextPath);
        if (logicalName) self.#registerMutation(logicalName);
        return true;
      }
    });
  }

  #registerMutation(logicalName) {
    this.#assertLogicalName(logicalName);
    const known = this.#contentDocs.has(logicalName);
    if (!known) this.#pendingCreateLogicalNames.add(logicalName);
    this.#dirtyLogicalNames.add(logicalName);
    this.#pendingDeleteLogicalNames.delete(logicalName);
    this.#scheduleAutosave();
  }

  #registerDeletion(logicalName) {
    this.#assertLogicalName(logicalName);
    this.#pendingCreateLogicalNames.delete(logicalName);
    this.#dirtyLogicalNames.delete(logicalName);
    this.#pendingDeleteLogicalNames.add(logicalName);
    this.#scheduleAutosave();
  }

  #scheduleAutosave() {
    if (!this.#options.autosave) return;
    clearTimeout(this.#autosaveTimer);
    this.#autosaveTimer = setTimeout(() => {
      void this.#queueFlush().catch(() => {});
    }, this.#options.autosaveDebounceMs);
  }

  #queueFlush() {
    this.#flushChain = this.#flushChain.then(() => this.#flushOnce());
    return this.#flushChain;
  }

  async #flushOnce() {
    if (!this.#connected) throw new UldaStateError("Client is not connected");
    if (!this.#masterDoc) throw new UldaStateError("Master document is not loaded");
    if (
      this.#dirtyLogicalNames.size === 0 &&
      this.#pendingCreateLogicalNames.size === 0 &&
      this.#pendingDeleteLogicalNames.size === 0
    ) {
      return { ok: true, skipped: true };
    }

    const creates = Array.from(this.#pendingCreateLogicalNames);
    const updates = Array.from(this.#dirtyLogicalNames).filter(
      logicalName => !this.#pendingCreateLogicalNames.has(logicalName)
    );
    const deletes = Array.from(this.#pendingDeleteLogicalNames);

    for (const logicalName of creates) {
      await this.#createContent(logicalName, this.#dataRoot[logicalName]);
    }
    for (const logicalName of updates) {
      await this.#updateContent(logicalName, this.#dataRoot[logicalName]);
    }
    for (const logicalName of deletes) {
      await this.#deleteContent(logicalName);
    }

    const nextMaster = await this.#adapter.stepUpAndSign({
      originPkg: this.#masterDoc.originPkg,
      serverConnection: this.#serverUrl
    });
    this.#masterDoc.originPkg = nextMaster.nextOriginPkg;
    this.#masterDoc.data = this.#cloneTopLevelData(this.#dataRoot);

    const encryptedMaster = await this.#adapter.encryptEnvelope({
      role: "master",
      plaintext: this.#masterDoc,
      key: this.#masterKey
    });

    await this.#adapter.updateRecord({
      serverConnection: this.#serverUrl,
      id: this.#masterId,
      uldaKey: nextMaster.nextSignature,
      content: encryptedMaster
    });

    this.#clearDirtyState();
    return {
      ok: true,
      created: creates.length,
      updated: updates.length,
      deleted: deletes.length
    };
  }

  async #createContent(logicalName, value) {
    this.#assertLogicalName(logicalName);
    const contentKey = await this.#adapter.generateContentKey();
    const initialOrigin = await this.#adapter.createInitialOrigin({
      role: "content",
      serverConnection: this.#serverUrl
    });
    const stepped = await this.#adapter.stepUpAndSign({
      originPkg: initialOrigin,
      serverConnection: this.#serverUrl
    });
    const contentDoc = { originPkg: stepped.nextOriginPkg, data: value };
    const encrypted = await this.#adapter.encryptEnvelope({
      role: "content",
      plaintext: contentDoc,
      key: contentKey
    });
    const createResult = await this.#adapter.createContentRecord({
      serverConnection: this.#serverUrl,
      uldaKey: stepped.nextSignature,
      content: encrypted
    });

    this.#masterDoc.links[logicalName] = { id: createResult.id, key: contentKey };
    this.#contentDocs.set(logicalName, {
      id: createResult.id,
      key: contentKey,
      doc: contentDoc
    });
  }

  async #updateContent(logicalName, value) {
    this.#assertLogicalName(logicalName);
    const entry = this.#contentDocs.get(logicalName);
    if (!entry) {
      throw new UldaStateError(`Cannot update unknown logical key "${logicalName}"`);
    }
    const stepped = await this.#adapter.stepUpAndSign({
      originPkg: entry.doc.originPkg,
      serverConnection: this.#serverUrl
    });
    entry.doc.originPkg = stepped.nextOriginPkg;
    entry.doc.data = value;
    const encrypted = await this.#adapter.encryptEnvelope({
      role: "content",
      plaintext: entry.doc,
      key: entry.key
    });
    await this.#adapter.updateRecord({
      serverConnection: this.#serverUrl,
      id: entry.id,
      uldaKey: stepped.nextSignature,
      content: encrypted
    });
  }

  async #deleteContent(logicalName) {
    this.#assertLogicalName(logicalName);
    const entry = this.#contentDocs.get(logicalName);
    if (!entry) return;

    const stepped = await this.#adapter.stepUpAndSign({
      originPkg: entry.doc.originPkg,
      serverConnection: this.#serverUrl
    });
    await this.#adapter.deleteRecord({
      serverConnection: this.#serverUrl,
      id: entry.id,
      uldaKey: stepped.nextSignature
    });

    delete this.#masterDoc.links[logicalName];
    this.#contentDocs.delete(logicalName);
  }

  #rebuildDataRootFromContent() {
    const data = {};
    for (const [logicalName, entry] of this.#contentDocs.entries()) {
      data[logicalName] = entry.doc.data;
    }
    this.#dataRoot = data;
    this.#dataProxy = this.#createProxy(this.#dataRoot, [], 0);
  }

  #extractTopLevelLogicalName(path) {
    if (!Array.isArray(path) || path.length === 0) return null;
    return String(path[0]);
  }

  async #setPassword(password) {
    this.#assertOpen();
    this.#assertAdapterReady();
    if (typeof password !== "string" && !(password instanceof Uint8Array)) {
      throw new UldaStateError("password must be a string or Uint8Array");
    }
    this.#clearMasterKey();
    this.#masterKey = await this.#adapter.deriveMasterKey({ password });
    this.#passwordSeed = null;
  }

  #clearMasterKey() {
    if (this.#masterKey instanceof Uint8Array) {
      this.#masterKey.fill(0);
    }
    if (isPlainObject(this.#masterKey) && this.#masterKey.passwordBytes instanceof Uint8Array) {
      this.#masterKey.passwordBytes.fill(0);
    }
    this.#masterKey = null;
  }

  #clearDirtyState() {
    this.#dirtyLogicalNames.clear();
    this.#pendingCreateLogicalNames.clear();
    this.#pendingDeleteLogicalNames.clear();
  }

  #assertMasterDoc(doc) {
    if (!doc || !this.#isPlainObject(doc)) {
      throw new UldaSecurityError("Invalid master document shape");
    }
    if (!("originPkg" in doc)) {
      throw new UldaSecurityError("Master document is missing originPkg");
    }
    if (!this.#isPlainObject(doc.links ?? {})) {
      throw new UldaSecurityError("Master document links must be an object");
    }
    if (!this.#isPlainObject(doc.data ?? {})) {
      throw new UldaSecurityError("Master document data must be an object");
    }
  }

  #assertContentDoc(doc, logicalName) {
    if (!doc || !this.#isPlainObject(doc)) {
      throw new UldaSecurityError(`Invalid content document shape for "${logicalName}"`);
    }
    if (!("originPkg" in doc)) {
      throw new UldaSecurityError(`Content document for "${logicalName}" is missing originPkg`);
    }
    if (!("data" in doc)) {
      throw new UldaSecurityError(`Content document for "${logicalName}" is missing data`);
    }
  }

  #assertConnected() {
    this.#assertOpen();
    if (!this.#connected) throw new UldaStateError("Client is not connected");
  }

  #assertOpen() {
    if (this.#closed) throw new UldaStateError("Client is closed");
  }

  #assertAdapterReady() {
    if (!this.#adapter) {
      throw new UldaStateError("No adapter provided");
    }
  }

  #assertLogicalName(logicalName) {
    if (typeof logicalName !== "string" || !logicalName.trim()) {
      throw new UldaStateError("Logical content name must be a non-empty string");
    }
    if (logicalName.length > this.#options.maxLogicalNameLength) {
      throw new UldaStateError("Logical content name exceeds max length");
    }
  }

  #validateAdapter() {
    if (!this.#adapter) return;
    for (const key of REQUIRED_ADAPTER_METHODS) {
      if (typeof this.#adapter[key] !== "function") {
        throw new UldaStateError(`Adapter is missing required method "${key}"`);
      }
    }
  }

  #validateServerUrl(value) {
    if (value == null) return;
    let url;
    try {
      url = new URL(String(value));
    } catch (err) {
      throw new UldaStateError("Invalid serverConnection URL", err);
    }
    const isHttps = url.protocol === "https:";
    const isWss = url.protocol === "wss:";
    const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const isLocalHttp = url.protocol === "http:" && isLocalHost;
    const isLocalWs = url.protocol === "ws:" && isLocalHost;
    if (!isHttps && !isWss && !((isLocalHttp || isLocalWs) && this.#options.allowInsecureLocalhost)) {
      throw new UldaSecurityError(
        "Insecure transport blocked. Use HTTPS/WSS or set allowInsecureLocalhost=true for local demo."
      );
    }
  }

  #cloneTopLevelData(input) {
    const out = {};
    for (const [key, value] of Object.entries(input ?? {})) {
      out[key] = value;
    }
    return out;
  }

  #isPlainObject(value) {
    if (value === null || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
}
