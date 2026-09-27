const LOCAL_SPEECH_ENV_KEYS = [
  "ALP_LOCAL_MODELS_DIR",
  "ALP_DICTATION_LOCAL_STT_MODEL",
  "ALP_VOICE_LOCAL_STT_MODEL",
  "ALP_VOICE_LOCAL_TTS_MODEL",
  "ALP_VOICE_LOCAL_TTS_SPEAKER_ID",
  "ALP_VOICE_LOCAL_TTS_SPEED",
] as const;

const DISABLED_E2E_SPEECH_ENV = {
  ALP_DICTATION_ENABLED: "0",
  ALP_VOICE_MODE_ENABLED: "0",
  ALP_DICTATION_STT_PROVIDER: "openai",
  ALP_VOICE_TURN_DETECTION_PROVIDER: "openai",
  ALP_VOICE_STT_PROVIDER: "openai",
  ALP_VOICE_TTS_PROVIDER: "openai",
} as const;

export function withDisabledE2ESpeechEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Default app E2E does not cover speech flows; keep restarts from starting
  // background local-model downloads for unrelated tests.
  const next: NodeJS.ProcessEnv = {
    ...env,
    ...DISABLED_E2E_SPEECH_ENV,
  };

  for (const key of LOCAL_SPEECH_ENV_KEYS) {
    delete next[key];
  }

  return next;
}
