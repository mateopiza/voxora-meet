import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { GlossaryStore, VocabularyStore, ProfileStore, JsonStore } from "./stores.mjs";
import { tmpDir } from "./_test-helpers.mjs";

test("JsonStore persiste JSON atómico y sobrevive a una nueva instancia", async (t) => {
  const dir = await tmpDir(t);
  const store = new JsonStore({ dir, name: "demo" });
  await store.setUser("ana", { a: 1 });
  await store.setUser("beto", { b: 2 });
  const raw = JSON.parse(await readFile(join(dir, "demo.json"), "utf8"));
  assert.deepEqual(raw, { ana: { a: 1 }, beto: { b: 2 } });
  const files = await readdir(dir);
  assert.ok(!files.some((f) => f.endsWith(".tmp")), "no quedan temporales");

  const again = new JsonStore({ dir, name: "demo" });
  assert.deepEqual(await again.getUser("ana"), { a: 1 });
  assert.deepEqual(await again.listUsers(), ["ana", "beto"]);
  assert.equal(await again.deleteUser("ana"), true);
  assert.equal(await again.deleteUser("ana"), false);
});

test("JsonStore serializa escrituras concurrentes sin perder datos", async (t) => {
  const dir = await tmpDir(t);
  const store = new JsonStore({ dir, name: "race" });
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.setUser(`u${i}`, i)));
  const raw = JSON.parse(await readFile(join(dir, "race.json"), "utf8"));
  assert.equal(Object.keys(raw).length, 20);
});

test("JsonStore pone en cuarentena un archivo corrupto y arranca vacío", async (t) => {
  const dir = await tmpDir(t);
  await writeFile(join(dir, "bad.json"), "{ esto no es json", "utf8");
  const store = new JsonStore({ dir, name: "bad" });
  assert.deepEqual(await store.listUsers(), []);
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith("bad.json.corrupt-")));
});

test("JsonStore rechaza userIds con separadores de ruta", async (t) => {
  const dir = await tmpDir(t);
  const store = new JsonStore({ dir, name: "x" });
  await assert.rejects(store.setUser("../evil", {}), /userId inválido/);
  assert.throws(() => new JsonStore({ name: "x" }), /dir/);
});

test("GlossaryStore normaliza, deduplica por término y genera líneas de prompt", async (t) => {
  const dir = await tmpDir(t);
  const glossary = new GlossaryStore({ dir });
  assert.deepEqual(await glossary.get("ana"), []);
  await glossary.set("ana", [
    { term: " VOXORA ", translation: "" },
    { term: "sprint", translation: "sprint", note: "no traducir" },
    { term: "Voxora", translation: "VOXORA Inc." },
  ]);
  const entries = await glossary.get("ana");
  assert.equal(entries.length, 2, "VOXORA duplicado se colapsa");
  assert.deepEqual(entries.find((e) => e.term === "Voxora"), { term: "Voxora", translation: "VOXORA Inc." });

  await glossary.add("ana", { term: "backlog", translation: null });
  await glossary.add("ana", { term: "SPRINT", translation: "iteración" });
  const lines = await glossary.toPromptLines("ana");
  assert.ok(lines.includes('- "backlog" → se mantiene sin traducir'));
  assert.ok(lines.includes('- "SPRINT" → "iteración"'));
  assert.equal(lines.length, 3);

  assert.equal(await glossary.remove("ana", "backlog"), true);
  assert.equal(await glossary.remove("ana", "backlog"), false);
  await assert.rejects(glossary.add("ana", { term: "  " }), /term/);
});

test("VocabularyStore deduplica sin distinguir mayúsculas y respeta maxTerms", async (t) => {
  const dir = await tmpDir(t);
  const vocab = new VocabularyStore({ dir, maxTerms: 3 });
  await vocab.set("ana", ["Kubernetes", "kubernetes", "  ", "Grafana"]);
  assert.deepEqual(await vocab.get("ana"), ["Kubernetes", "Grafana"]);
  await vocab.add("ana", ["Prometheus", "Loki"]);
  assert.deepEqual(await vocab.get("ana"), ["Kubernetes", "Grafana", "Prometheus"], "maxTerms=3");
  assert.equal(await vocab.remove("ana", "grafana"), true);
  assert.deepEqual(await vocab.get("ana"), ["Kubernetes", "Prometheus"]);
  await vocab.add("beto", "Terraform");
  assert.deepEqual(await vocab.get("beto"), ["Terraform"]);
});

test("ProfileStore aplica defaults, actualiza parcialmente y registra la voz", async (t) => {
  const dir = await tmpDir(t);
  let clock = 0;
  const profiles = new ProfileStore({ dir, now: () => `t${clock++}` });
  const empty = await profiles.get("ana");
  assert.equal(empty.voiceId, null);
  assert.equal(empty.tone, "professional");
  assert.equal(empty.targetLanguage, "en");

  const updated = await profiles.update("ana", { targetLanguage: "pt", styleInstruction: "breve" });
  assert.equal(updated.targetLanguage, "pt");
  assert.equal(updated.createdAt, "t0");
  assert.equal(updated.updatedAt, "t1");

  const withVoice = await profiles.setVoice("ana", { voiceId: "v123", voiceName: "Ana", cloneType: "ivc" });
  assert.equal(withVoice.voiceId, "v123");
  assert.equal(withVoice.cloneStatus, "ready");
  assert.equal(withVoice.targetLanguage, "pt", "update no pisa campos ajenos");
  assert.equal(withVoice.createdAt, "t0", "createdAt no cambia");

  await profiles.clearVoice("ana");
  assert.equal((await profiles.get("ana")).voiceId, null);
  await assert.rejects(profiles.setVoice("ana", {}), /voiceId/);
});
