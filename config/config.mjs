function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v.trim();
}

function optional(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

export const config = {
  botToken: required('BOT_TOKEN'),
  civitaiApiKey: required('CIVITAI_API_KEY'),

  publicHostUrl: required('PUBLIC_HOST_URL').replace(/\/$/, ''),
  photoHostPort: parseInt(optional('PHOTO_HOST_PORT', '8088'), 10),

  qwenStrength: parseFloat(optional('QWEN_STRENGTH', '0.35')),
  qwenDefaultPrompt: optional(
    'QWEN_DEFAULT_PROMPT',
    'high quality, sharp focus, fine detail, photorealistic, enhanced, 4k'
  ),

  photoTtlSeconds: parseInt(optional('PHOTO_TTL_SECONDS', '900'), 10),

  allowedUserIds: optional('ALLOWED_USER_IDS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n)),
};
