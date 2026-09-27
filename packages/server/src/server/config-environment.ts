// Daemon configuration inputs. General provider credentials and executable/runtime
// controls remain available to managed launches and their agent processes.
export const DAEMON_SETTING_ENV_KEYS = [
  "MCP_DEBUG",
  "OPENAI_STT_BASE_URL",
  "OPENAI_TTS_BASE_URL",
  "ALP_ALLOWED_HOSTS",
  "ALP_APP_BASE_URL",
  "ALP_CORS_ORIGINS",
  "ALP_DICTATION_ENABLED",
  "ALP_DICTATION_LANGUAGE",
  "ALP_DICTATION_LOCAL_STT_MODEL",
  "ALP_DICTATION_STT_PROVIDER",
  "ALP_GIT_CONCURRENCY",
  "ALP_GIT_MAX_PROCESSES_PER_SECOND",
  "ALP_GIT_MAX_PROCESS_CONCURRENCY",
  "ALP_HOSTNAMES",
  "ALP_LISTEN",
  "ALP_LOCAL_MODELS_DIR",
  "ALP_LOG",
  "ALP_LOG_CONSOLE_FORMAT",
  "ALP_LOG_CONSOLE_LEVEL",
  "ALP_LOG_FILE_LEVEL",
  "ALP_LOG_FILE_PATH",
  "ALP_LOG_FILE_ROTATE_COUNT",
  "ALP_LOG_FILE_ROTATE_SIZE",
  "ALP_LOG_FORMAT",
  "ALP_LOG_LEVEL",
  "ALP_LOG_ROTATE_COUNT",
  "ALP_LOG_ROTATE_SIZE",
  "ALP_PASSWORD",
  "ALP_RELAY_ENABLED",
  "ALP_RELAY_ENDPOINT",
  "ALP_RELAY_PUBLIC_ENDPOINT",
  "ALP_RELAY_PUBLIC_USE_TLS",
  "ALP_RELAY_USE_TLS",
  "ALP_SERVICE_PROXY_ENABLED",
  "ALP_SERVICE_PROXY_LISTEN",
  "ALP_SERVICE_PROXY_PUBLIC_BASE_URL",
  "ALP_TRUSTED_PROXIES",
  "ALP_VOICE_LANGUAGE",
  "ALP_VOICE_LLM_PROVIDER",
  "ALP_VOICE_LOCAL_STT_MODEL",
  "ALP_VOICE_LOCAL_TTS_MODEL",
  "ALP_VOICE_LOCAL_TTS_SPEAKER_ID",
  "ALP_VOICE_LOCAL_TTS_SPEED",
  "ALP_VOICE_MODE_ENABLED",
  "ALP_VOICE_STT_PROVIDER",
  "ALP_VOICE_TTS_PROVIDER",
  "ALP_VOICE_TURN_DETECTION_PROVIDER",
  "ALP_WEB_UI_DIST_DIR",
  "ALP_WEB_UI_ENABLED",
  "PORT",
  "STT_CONFIDENCE_THRESHOLD",
  "STT_MODEL",
  "TTS_MODEL",
  "TTS_VOICE",
] as const;

const CONFIG_CONTEXT_ENV_KEYS = [
  "ALP_NODE_ENV",
  "ALP_DESKTOP_MANAGED",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_STT_API_KEY",
  "OPENAI_TTS_API_KEY",
] as const;

export function configurationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [...DAEMON_SETTING_ENV_KEYS, ...CONFIG_CONTEXT_ENV_KEYS].map((key) => [key, env[key]]),
  );
}

export function daemonLaunchEnvironment(input: {
  env: NodeJS.ProcessEnv;
  home: string;
  mode: "managed" | "deployment";
  desktopManaged?: boolean;
}): NodeJS.ProcessEnv {
  const env = { ...input.env };
  if (input.mode === "managed") {
    for (const key of DAEMON_SETTING_ENV_KEYS) delete env[key];
  }
  delete env.ALP_HOST;
  delete env.ALP_DESKTOP_MANAGED;
  env.ALP_HOME = input.home;
  if (input.desktopManaged) env.ALP_DESKTOP_MANAGED = "1";
  return env;
}
