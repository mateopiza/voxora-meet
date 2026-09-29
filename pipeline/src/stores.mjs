// Persistencia JSON atómica en disco para datos por usuario del pipeline:
//   - GlossaryStore: términos que NO se traducen o se traducen de forma fija.
//   - VocabularyStore: vocabulario custom (nombres propios, jerga) para el STT.
//   - ProfileStore: perfil del usuario (voiceId clonado, idiomas, tono, estilo).
//
// Cada store es un archivo `<dir>/<nombre>.json` con forma `{ [userId]: ... }`.
// Las escrituras se serializan (cola por store) y son atómicas: se escribe a
// un temporal y se renombra, así un corte a mitad nunca deja JSON corrupto.

import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_USER = "default";

function normalizeUserId(userId) {
  const id = String(userId ?? DEFAULT_USER).trim();
  if (!id || /[\\/]/.test(id)) throw new TypeError(`userId inválido: ${JSON.stringify(userId)}`);
  return id;
}

/** Base común: carga perezosa, caché en memoria y escritura atómica serializada. */
export class JsonStore {
  #dir;
  #file;
  #data = null;
  #loading = null;
  #writeChain = Promise.resolve();

  constructor({ dir, name }) {
    if (!dir) throw new TypeError("JsonStore: `dir` es obligatorio");
    if (!name) throw new TypeError("JsonStore: `name` es obligatorio");
    this.#dir = dir;
    this.#file = join(dir, `${name}.json`);
  }

  get path() {
    return this.#file;
  }

  async load() {
    if (this.#data) return this.#data;
    if (!this.#loading) {
      this.#loading = (async () => {
        try {
          const raw = await readFile(this.#file, "utf8");
          const parsed = JSON.parse(raw);
          this.#data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
          if (error?.code !== "ENOENT") {
            // JSON corrupto o ilegible: se arranca vacío pero se conserva el
            // archivo original con sufijo para diagnóstico, no se pisa en silencio.
            await this.#quarantine().catch(() => {});
          }
          this.#data = {};
        }
        return this.#data;
      })();
    }
    return this.#loading;
  }

  async #quarantine() {
    await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`);
  }

  /** Aplica `mutator(data)` sobre la copia en memoria y persiste. */
  async mutate(mutator) {
    const data = await this.load();
    const run = this.#writeChain.then(async () => {
      const result = await mutator(data);
      await this.#persist(data);
      return result;
    });
    // La cadena nunca se rompe: un fallo de escritura no bloquea las siguientes.
    this.#writeChain = run.catch(() => {});
    return run;
  }

  async #persist(data) {
    await mkdir(this.#dir, { recursive: true });
    const tmp = `${this.#file}.${process.pid}.${Date.now()}.tmp`;
    const json = JSON.stringify(data, null, 2);
    try {
      await writeFile(tmp, json, "utf8");
      await rename(tmp, this.#file);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async getUser(userId) {
    const data = await this.load();
    return data[normalizeUserId(userId)];
  }

  async setUser(userId, value) {
    const id = normalizeUserId(userId);
    return this.mutate((data) => {
      data[id] = value;
      return value;
    });
  }

  async deleteUser(userId) {
    const id = normalizeUserId(userId);
    return this.mutate((data) => {
      const existed = id in data;
      delete data[id];
      return existed;
    });
  }

  async listUsers() {
    return Object.keys(await this.load());
  }
}

/**
 * Glosario por usuario. Cada entrada: `{ term, translation, note }`.
 *   - `translation: null` → el término se conserva tal cual (no se traduce).
 *   - `translation: "X"` → se traduce siempre como "X".
 * Los términos se comparan sin distinguir mayúsculas.
 */
export class GlossaryStore extends JsonStore {
  constructor({ dir }) {
    super({ dir, name: "glossary" });
  }

  static normalizeEntry(entry) {
    const term = String(entry?.term ?? "").trim();
    if (!term) throw new TypeError("GlossaryStore: `term` vacío");
    const translation = entry?.translation == null || String(entry.translation).trim() === "" ? null : String(entry.translation).trim();
    const note = entry?.note ? String(entry.note).trim() : undefined;
    return note ? { term, translation, note } : { term, translation };
  }

  async get(userId) {
    return (await this.getUser(userId)) ?? [];
  }

  async set(userId, entries) {
    const normalized = dedupeByTerm((entries ?? []).map(GlossaryStore.normalizeEntry));
    return this.setUser(userId, normalized);
  }

  /** Añade o reemplaza (por término) una entrada. */
  async add(userId, entry) {
    const normalized = GlossaryStore.normalizeEntry(entry);
    const id = normalizeUserId(userId);
    return this.mutate((data) => {
      const list = Array.isArray(data[id]) ? data[id] : [];
      data[id] = dedupeByTerm([...list.filter((e) => !sameTerm(e.term, normalized.term)), normalized]);
      return data[id];
    });
  }

  async remove(userId, term) {
    const id = normalizeUserId(userId);
    return this.mutate((data) => {
      const list = Array.isArray(data[id]) ? data[id] : [];
      const next = list.filter((e) => !sameTerm(e.term, term));
      data[id] = next;
      return list.length !== next.length;
    });
  }

  /** Líneas listas para el prompt del traductor. */
  async toPromptLines(userId) {
    const entries = await this.get(userId);
    return entries.map((e) => (e.translation ? `- "${e.term}" → "${e.translation}"` : `- "${e.term}" → se mantiene sin traducir`));
  }
}

/** Vocabulario custom por usuario: lista de términos (strings) para sesgar el STT. */
export class VocabularyStore extends JsonStore {
  constructor({ dir, maxTerms = 200 }) {
    super({ dir, name: "vocabulary" });
    this.maxTerms = maxTerms;
  }

  #normalizeList(terms) {
    const seen = new Set();
    const out = [];
    for (const raw of terms ?? []) {
      const term = String(raw ?? "").trim().replace(/\s+/g, " ");
      if (!term) continue;
      const key = term.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= this.maxTerms) break;
    }
    return out;
  }

  async get(userId) {
    return (await this.getUser(userId)) ?? [];
  }

  async set(userId, terms) {
    return this.setUser(userId, this.#normalizeList(terms));
  }

  async add(userId, terms) {
    const id = normalizeUserId(userId);
    const incoming = Array.isArray(terms) ? terms : [terms];
    return this.mutate((data) => {
      const current = Array.isArray(data[id]) ? data[id] : [];
      data[id] = this.#normalizeList([...current, ...incoming]);
      return data[id];
    });
  }

  async remove(userId, term) {
    const id = normalizeUserId(userId);
    return this.mutate((data) => {
      const current = Array.isArray(data[id]) ? data[id] : [];
      const next = current.filter((t) => !sameTerm(t, term));
      data[id] = next;
      return current.length !== next.length;
    });
  }
}

/**
 * Perfil por usuario:
 * `{ voiceId, voiceName, cloneType: 'ivc'|'pvc'|null, cloneStatus, sourceLanguage,
 *    targetLanguage, tone, styleInstruction, voiceSettings, createdAt, updatedAt }`.
 */
export class ProfileStore extends JsonStore {
  static DEFAULTS = Object.freeze({
    voiceId: null,
    voiceName: null,
    cloneType: null,
    cloneStatus: null,
    sourceLanguage: "es",
    targetLanguage: "en",
    tone: "professional",
    styleInstruction: "",
    voiceSettings: null,
  });

  constructor({ dir, now = () => new Date().toISOString() }) {
    super({ dir, name: "profiles" });
    this.now = now;
  }

  async get(userId) {
    const stored = await this.getUser(userId);
    return { ...ProfileStore.DEFAULTS, ...(stored ?? {}) };
  }

  async update(userId, patch) {
    const id = normalizeUserId(userId);
    const clean = { ...(patch ?? {}) };
    delete clean.createdAt;
    return this.mutate((data) => {
      const current = data[id] ?? { createdAt: this.now() };
      data[id] = { ...ProfileStore.DEFAULTS, ...current, ...clean, updatedAt: this.now() };
      return data[id];
    });
  }

  /** Registra la voz clonada activa del usuario. */
  async setVoice(userId, { voiceId, voiceName = null, cloneType = "ivc", cloneStatus = "ready" }) {
    if (!voiceId) throw new TypeError("ProfileStore.setVoice: `voiceId` obligatorio");
    return this.update(userId, { voiceId, voiceName, cloneType, cloneStatus });
  }

  async clearVoice(userId) {
    return this.update(userId, { voiceId: null, voiceName: null, cloneType: null, cloneStatus: null });
  }
}

function sameTerm(a, b) {
  return String(a ?? "").trim().toLocaleLowerCase() === String(b ?? "").trim().toLocaleLowerCase();
}

function dedupeByTerm(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.term.toLocaleLowerCase(), e);
  return [...map.values()];
}
