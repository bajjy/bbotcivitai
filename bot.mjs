/**
 * bbotcivitai — Telegram bot that enhances photos with Civitai's Qwen-Image
 * img2img (createVariant). Long-polling, single-process.
 *
 * Works in:
 *   - Private chats: any photo enhances (caption optional)
 *   - Groups: only when caption mentions @<bot_username>
 *
 * Access:
 *   - If ALLOWED_CHAT_IDS or ALLOWED_USER_IDS are set, request must match one.
 *   - If both are empty, anyone anywhere can use the bot.
 */

import { Bot, InputFile, GrammyError } from 'grammy';
import { config } from './config/config.mjs';
import { enhancePhoto } from './services/civitai.mjs';
import {
  startPhotoHost,
  stopPhotoHost,
  sweepStaleTempFiles,
} from './services/photoHost.mjs';

const bot = new Bot(config.botToken);

// Cached lowercase bot username, populated in main() before polling starts.
let botUsernameLower = '';

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------
function isAllowed(ctx) {
  const noUserList = config.allowedUserIds.length === 0;
  const noChatList = config.allowedChatIds.length === 0;
  if (noUserList && noChatList) return true;

  const uid = ctx.from?.id;
  const cid = ctx.chat?.id;
  const userOk = uid && config.allowedUserIds.includes(uid);
  const chatOk = cid && config.allowedChatIds.includes(cid);
  return userOk || chatOk;
}

bot.use(async (ctx, next) => {
  if (isAllowed(ctx)) return next();
  console.warn(
    `[acl] denied user=${ctx.from?.id} (${ctx.from?.username || '?'}) chat=${ctx.chat?.id} (${ctx.chat?.type})`
  );
  // Don't shout at random groups. Only DM users get a polite "private" reply.
  if (ctx.chat?.type === 'private') {
    await ctx.reply('Sorry, this bot is private.').catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
bot.command('start', (ctx) =>
  ctx.reply(
    [
      'Hi! Send me a photo and I will enhance it using Civitai\'s Qwen-Image model.',
      '',
      'In a DM: send any photo (caption is used as the prompt).',
      `In a group: tag me with the photo, e.g. "@${botUsernameLower} sharper, more detail".`,
      '',
      `Default strength: ${config.qwenStrength} (lower = closer to original, higher = more re-imagined).`,
    ].join('\n')
  )
);

bot.command('help', (ctx) =>
  ctx.reply(
    [
      'Commands:',
      '/start — intro',
      '/help — this message',
      '/chatid — print this chat\'s ID (useful for ALLOWED_CHAT_IDS)',
    ].join('\n')
  )
);

// Useful for finding the chat ID to put in ALLOWED_CHAT_IDS.
bot.command('chatid', (ctx) =>
  ctx.reply(
    [
      `Chat ID: \`${ctx.chat?.id}\``,
      `Chat type: ${ctx.chat?.type}`,
      `Your user ID: \`${ctx.from?.id}\``,
    ].join('\n'),
    { parse_mode: 'Markdown' }
  )
);

// ---------------------------------------------------------------------------
// Photo handler
// ---------------------------------------------------------------------------

/**
 * Strip a leading "@botname" mention from a caption and return the remaining
 * text as the prompt. Returns null if no mention found (caller decides what to do).
 */
function extractPromptFromGroupCaption(caption) {
  if (!caption) return null;
  const lower = caption.toLowerCase();
  const tag = `@${botUsernameLower}`;
  const idx = lower.indexOf(tag);
  if (idx === -1) return null;
  const before = caption.slice(0, idx);
  const after = caption.slice(idx + tag.length);
  return (before + ' ' + after).trim();
}

bot.on('message:photo', async (ctx) => {
  const isPrivate = ctx.chat?.type === 'private';
  const caption = (ctx.message.caption || '').trim();

  // Group-chat trigger: bot must be @-mentioned in the caption.
  let prompt;
  if (isPrivate) {
    prompt = caption || config.qwenDefaultPrompt;
  } else {
    const extracted = extractPromptFromGroupCaption(caption);
    if (extracted === null) return; // not addressed to us — stay quiet
    prompt = extracted || config.qwenDefaultPrompt;
  }

  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];

  let statusMsg;
  try {
    statusMsg = await ctx.reply('Got it. Enhancing... (~30–90s)', {
      reply_parameters: { message_id: ctx.message.message_id },
    });

    const file = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) throw new Error(`Telegram file download failed: ${fileResp.status}`);
    const buffer = Buffer.from(await fileResp.arrayBuffer());

    const ext = (file.file_path?.split('.').pop() || 'jpg').toLowerCase();
    const mimeType =
      ext === 'png' ? 'image/png' :
      ext === 'webp' ? 'image/webp' :
      'image/jpeg';

    const { imageUrl: resultUrl } = await enhancePhoto({
      imageBuffer: buffer,
      mimeType,
      prompt,
    });

    const resultResp = await fetch(resultUrl);
    if (!resultResp.ok) throw new Error(`Result download failed: ${resultResp.status}`);
    const resultBuf = Buffer.from(await resultResp.arrayBuffer());

    await ctx.replyWithPhoto(new InputFile(resultBuf, 'enhanced.jpg'), {
      caption: prompt && prompt !== config.qwenDefaultPrompt ? `Prompt: ${prompt}` : undefined,
      reply_parameters: { message_id: ctx.message.message_id },
    });
    if (statusMsg) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
    }
  } catch (err) {
    console.error('[photo handler]', err);
    const msg =
      err?.reason === 'blocked'
        ? 'Civitai blocked that request (moderation). Try a different photo or prompt.'
        : `Sorry, that failed: ${err?.message || err}`;
    if (statusMsg) {
      await ctx.api
        .editMessageText(ctx.chat.id, statusMsg.message_id, msg)
        .catch(() => ctx.reply(msg));
    } else {
      await ctx.reply(msg).catch(() => {});
    }
  }
});

// In private chats only: if someone sends text/sticker/etc, give a hint.
bot.on('message', (ctx) => {
  if (ctx.chat?.type === 'private') {
    return ctx.reply('Send me a photo (with a caption as the prompt) and I\'ll enhance it.');
  }
});

bot.catch((err) => {
  console.error('[grammy handler error]', err);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function startBotWithRetry({ retries = 12, delayMs = 5000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      console.log(`[bot] starting long-polling… (attempt ${attempt}/${retries})`);
      await bot.start({
        onStart: (info) => console.log(`[bot] @${info.username} ready`),
      });
      return;
    } catch (err) {
      const is409 =
        err instanceof GrammyError &&
        (err.error_code === 409 ||
          /conflict.*getUpdates/i.test(err.description || ''));
      if (is409 && attempt < retries) {
        console.warn(
          `[bot] 409 conflict (another instance polling). Sleeping ${delayMs}ms then retrying…`
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  sweepStaleTempFiles();
  await startPhotoHost();

  // Pre-populate the bot username so command handlers can reference it.
  try {
    const me = await bot.api.getMe();
    botUsernameLower = (me.username || '').toLowerCase();
    console.log(`[bot] resolved username: @${botUsernameLower}`);
  } catch (err) {
    console.warn('[bot] could not resolve own username yet:', err?.message || err);
  }

  await startBotWithRetry();
}

async function shutdown(signal) {
  console.log(`\n[bot] received ${signal}, shutting down…`);
  try { await bot.stop(); } catch {}
  try { await stopPhotoHost(); } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
