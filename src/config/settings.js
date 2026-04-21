import 'dotenv/config';

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key, fallback = '') {
  return process.env[key] ?? fallback;
}

export const settings = {
  // Discord
  DISCORD_TOKEN:            required('DISCORD_TOKEN'),
  GUILD_ID:                 required('GUILD_ID'),
  ADMIN_ROLE_ID:            required('ADMIN_ROLE_ID'),
  MOD_ROLE_ID:              required('MOD_ROLE_ID'),

  // Channels
  VC_TRANSCRIPT_CHANNEL_ID: required('VC_TRANSCRIPT_CHANNEL_ID'),

  // Whisper
  WHISPER_MODE:             optional('WHISPER_MODE', 'openai'),
  WHISPER_LOCAL_URL:        optional('WHISPER_LOCAL_URL', 'http://localhost:9000/asr'),
  WHISPER_OPENAI_KEY:       optional('WHISPER_OPENAI_KEY'),
  WHISPER_OPENAI_BASE_URL:  optional('WHISPER_OPENAI_BASE_URL', 'https://api.openai.com/v1/audio/transcriptions'),
  WHISPER_OPENAI_MODEL:     optional('WHISPER_OPENAI_MODEL', 'whisper-1'),
  WHISPER_LANGUAGE:         optional('WHISPER_LANGUAGE', 'en'),
};
