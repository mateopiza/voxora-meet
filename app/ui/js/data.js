// Datos estáticos de la UI: idiomas y textos guía para grabar muestras de voz.

// Idiomas de origen: los que transcribe Whisper large-v3 con buena calidad.
// Códigos ISO 639-1 (los acepta el motor tal cual; `normalizeLanguage` en pipeline).
const COMMON = ['es', 'en', 'pt', 'fr', 'de', 'it'];

export const LANGUAGES = {
  es: 'Español', en: 'Inglés', pt: 'Portugués', fr: 'Francés', de: 'Alemán', it: 'Italiano',
  ar: 'Árabe', bg: 'Búlgaro', ca: 'Catalán', cs: 'Checo', zh: 'Chino (mandarín)', ko: 'Coreano',
  hr: 'Croata', da: 'Danés', sk: 'Eslovaco', sl: 'Esloveno', et: 'Estonio', tl: 'Filipino',
  fi: 'Finés', gl: 'Gallego', el: 'Griego', he: 'Hebreo', hi: 'Hindi', hu: 'Húngaro',
  id: 'Indonesio', ja: 'Japonés', lv: 'Letón', lt: 'Lituano', ms: 'Malayo', nl: 'Neerlandés',
  no: 'Noruego', fa: 'Persa', pl: 'Polaco', ro: 'Rumano', ru: 'Ruso', sr: 'Serbio', sv: 'Sueco',
  th: 'Tailandés', ta: 'Tamil', tr: 'Turco', uk: 'Ucraniano', ur: 'Urdu', vi: 'Vietnamita',
};

// Destino: idiomas que sintetiza ElevenLabs eleven_multilingual_v2 (29).
const TARGETS = new Set(['en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'tl',
  'pl', 'sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru']);

function ordered(codes) {
  const rest = codes.filter((c) => !COMMON.includes(c)).sort((a, b) => LANGUAGES[a].localeCompare(LANGUAGES[b], 'es'));
  return [...COMMON.filter((c) => codes.includes(c)), ...rest];
}

export const SOURCE_LANGS = ordered(Object.keys(LANGUAGES));
export const TARGET_LANGS = ordered(Object.keys(LANGUAGES).filter((c) => TARGETS.has(c)));
export const COMMON_LANGS = COMMON;
export const langName = (code) => LANGUAGES[code] ?? String(code || '').toUpperCase();

export const TONES = { professional: 'Profesional', formal: 'Formal', neutral: 'Neutral' };

export const CATEGORY_LABELS = {
  cloned: 'Clonada por ti',
  professional: 'Clon profesional',
  generated: 'Diseñada',
  premade: 'Biblioteca de ElevenLabs',
};

// Textos para leer en voz alta al clonar: frases variadas (preguntas, números, pausas)
// para que la muestra cubra entonación y ritmo reales de una reunión.
export const READING_SCRIPTS = {
  es: [
    'Buenos días a todos. Antes de empezar, quiero agradecerles por conectarse hoy. En esta reunión vamos a revisar los resultados del trimestre, hablar de las prioridades para las próximas seis semanas y acordar quién se encarga de cada tarea. Si en algún momento tienen una pregunta, interrúmpanme sin problema.',
    'El proyecto avanza según lo previsto, aunque tuvimos un par de retrasos en marzo. La buena noticia es que el equipo de producto ya terminó la primera versión, y los clientes que la probaron nos dieron comentarios muy positivos. ¿Les parece si repasamos juntos los números más importantes?',
    'Me gustaría proponer algo distinto: en lugar de enviar el informe el viernes, podríamos compartir un avance el miércoles para recibir comentarios con tiempo. Así evitamos correr al final y tomamos mejores decisiones. Díganme qué opinan y lo ajustamos entre todos.',
    'Para cerrar, resumo los acuerdos: Laura prepara la propuesta comercial, Andrés revisa el presupuesto y yo me encargo de coordinar la reunión con el cliente del jueves a las diez. Muchas gracias por su tiempo; fue una conversación muy productiva.',
  ],
  en: [
    'Good morning, everyone. Before we start, I want to thank you all for joining today. In this meeting we will review the quarterly results, talk about our priorities for the next six weeks, and agree on who owns each task. If you have a question at any point, feel free to jump in.',
    'The project is on track, although we had a couple of delays back in March. The good news is that the product team has finished the first version, and the customers who tried it gave us very positive feedback. Shall we go through the key numbers together?',
    'I would like to suggest something different: instead of sending the report on Friday, we could share a draft on Wednesday and get feedback early. That way we avoid the last-minute rush and make better decisions. Let me know what you think and we can adjust it together.',
    'To wrap up, here are the action items: Laura will prepare the proposal, Andrew will review the budget, and I will set up the client meeting on Thursday at ten. Thank you so much for your time; this was a really productive conversation.',
  ],
  pt: [
    'Bom dia a todos. Antes de começar, quero agradecer por estarem aqui hoje. Nesta reunião vamos revisar os resultados do trimestre, falar sobre as prioridades das próximas seis semanas e combinar quem fica responsável por cada tarefa. Se tiverem alguma pergunta, podem me interromper.',
    'O projeto está avançando conforme o planejado, apesar de alguns atrasos em março. A boa notícia é que a equipe de produto terminou a primeira versão, e os clientes que testaram deram um retorno muito positivo. Vamos revisar juntos os números mais importantes?',
  ],
  fr: [
    'Bonjour à tous. Avant de commencer, je tiens à vous remercier d’être présents aujourd’hui. Dans cette réunion, nous allons passer en revue les résultats du trimestre, parler des priorités pour les six prochaines semaines et décider qui s’occupe de chaque tâche. N’hésitez pas à m’interrompre si vous avez une question.',
    'Le projet avance comme prévu, même si nous avons eu quelques retards en mars. La bonne nouvelle, c’est que l’équipe produit a terminé la première version, et les clients qui l’ont testée nous ont fait des retours très positifs. On regarde ensemble les chiffres clés ?',
  ],
  de: [
    'Guten Morgen zusammen. Bevor wir anfangen, möchte ich mich bei euch allen bedanken, dass ihr heute dabei seid. In diesem Meeting schauen wir uns die Quartalsergebnisse an, sprechen über die Prioritäten der nächsten sechs Wochen und klären, wer welche Aufgabe übernimmt. Unterbrecht mich gern, wenn ihr Fragen habt.',
    'Das Projekt liegt im Plan, auch wenn es im März ein paar Verzögerungen gab. Die gute Nachricht ist, dass das Produktteam die erste Version fertiggestellt hat und die Kunden, die sie getestet haben, sehr positives Feedback gegeben haben. Sollen wir die wichtigsten Zahlen gemeinsam durchgehen?',
  ],
  it: [
    'Buongiorno a tutti. Prima di iniziare, voglio ringraziarvi per esservi collegati oggi. In questa riunione rivedremo i risultati del trimestre, parleremo delle priorità per le prossime sei settimane e decideremo chi si occupa di ogni attività. Se avete domande, interrompetemi pure.',
    'Il progetto procede secondo i piani, anche se a marzo abbiamo avuto un paio di ritardi. La buona notizia è che il team di prodotto ha completato la prima versione e i clienti che l’hanno provata ci hanno dato un riscontro molto positivo. Vogliamo rivedere insieme i numeri principali?',
  ],
};

export function scriptsFor(code) {
  return READING_SCRIPTS[code] ?? READING_SCRIPTS.en;
}
