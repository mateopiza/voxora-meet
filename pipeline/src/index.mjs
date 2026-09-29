// Punto de entrada de @voxora-meet/pipeline.

export { GroqWhisperStt, SttError, DEFAULT_WHISPER_MODEL, clampSttTemperature, buildVocabularyPrompt, whisperDiscardReason, shouldDiscardWhisperTranscript, summarizeSegments } from "./stt/groq-whisper.mjs";
export {
  ContextTranslator,
  TranslationError,
  TONES,
  DEFAULT_TRANSLATE_MODEL,
  REASONING_EFFORTS,
  buildSystemPrompt,
  cleanTranslation,
  chatReasoningProfile,
  reasoningParamsFor,
  clampTranslateTemperature,
} from "./translate/groq-translate.mjs";
export {
  ElevenLabsTts,
  VoiceCloning,
  TtsError,
  ELEVEN_PCM_FORMATS,
  ELEVEN_MP3_FALLBACK,
  DEFAULT_VOICE_SETTINGS,
  IVC_REQUIREMENTS,
  PVC_REQUIREMENTS,
  normalizeVoiceSettings,
  voiceSettingsFromFlat,
  ttsModelCapabilities,
  resolveTtsCapabilities,
  buildTtsBody,
  snapToPreset,
  isLanguageCodeRejected,
  DEFAULT_TTS_MODEL,
  V3_STABILITY_PRESETS,
  TEXT_NORMALIZATION_MODES,
  SPEED_RANGE,
} from "./tts/elevenlabs.mjs";
export { VoiceOnboarding, VoiceOnboardingError, validateSamples, normalizeSample } from "./voice-onboarding.mjs";
export { DubbingPipeline, DubbingError, StageQueue } from "./dubbing-pipeline.mjs";
export { GlossaryStore, VocabularyStore, ProfileStore, JsonStore } from "./stores.mjs";
export { pcmToWav, readWavInfo, wavToPcm, pcmDurationMs } from "./util/wav.mjs";
export { HttpError, fetchWithRetry } from "./util/http.mjs";
export { languageName, normalizeLanguage } from "./languages.mjs";
