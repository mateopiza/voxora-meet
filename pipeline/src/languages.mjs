// Nombres legibles de idiomas para los prompts. Los códigos que no estén en
// la tabla se usan tal cual (el modelo entiende ISO 639-1 sin problema).

const LANGUAGE_NAMES = Object.freeze({
  es: "español",
  en: "inglés",
  pt: "portugués",
  fr: "francés",
  de: "alemán",
  it: "italiano",
  nl: "neerlandés",
  pl: "polaco",
  tr: "turco",
  ru: "ruso",
  uk: "ucraniano",
  ar: "árabe",
  hi: "hindi",
  ja: "japonés",
  ko: "coreano",
  zh: "chino",
  sv: "sueco",
  da: "danés",
  fi: "finés",
  no: "noruego",
  cs: "checo",
  el: "griego",
  he: "hebreo",
  id: "indonesio",
  vi: "vietnamita",
});

/** Devuelve el nombre del idioma en español, o el código si no se conoce. */
export function languageName(code) {
  const key = String(code ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[key] ?? (key || "desconocido");
}

/** Normaliza un código de idioma a ISO 639-1 en minúsculas (`es-AR` → `es`). */
export function normalizeLanguage(code, fallback = "es") {
  const key = String(code ?? "").trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(key) ? key : fallback;
}
