/**
 * bbotcivitai — Telegram bot that enhances photos with Civitai's Qwen-Image
 * img2img (createVariant). Long-polling, single-process, designed for systemd
 * on a Hetzner VPS.
 *
 * Flow per photo:
 *   1. User sends a photo (optionally with a caption used as the prompt)
 *   2. Bot downloads it from Telegram
 *   3. Bot writes it to temp/ and exposes it at PUBLIC_HOST_URL/photos/{id}
 *   4. Bot submits a Qwen createVariant workflow to Civitai
 *   5. Bot polls until done, downloads the result, sends it back as a photo
 *   6. Temp file is disposed
 */

import { Bot, InputFile } from 'grammy';
import { config } from './config/config.mjs';
import { enhancePhoto } from './services/civitai.mjs';
import {
  startPhotoHost,
  stopPhotoHost,
  hostPhoto,
  sweepStaleTempFiles,
} from './services/photoHost.mjs';

const bot = new Bot(config.botToken);

// --- Access control ---------------------------------------------------------
bot.use(async (ctx, next) => {
  if (config.allowedUserIds.length === 0) return next();
  const uid = ctx.from?.id;
  if (uid && config.allowedUserIds.includes(uid)) return next();
  console.warn(`[acl] denied user ${uid} (${ctx.from?.username || '?'})`);
  if (ctx.chat) {
    await ctx.reply('Sorry, this bot is private.').catch(() => {});
  }
});

// --- Commands ---------------------------------------------------------------
bot.command('start', (ctx) =>
  ctx.reply(
    [
      'Hi! Send me a photo and I will enhance it using Civitai\'s Qwen-Image model.',
      '',
      'Tip: add a caption — it becomes the enhancement prompt (e.g. "sharpen, photorealistic, studio lighting").',
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
      '',
      'Just send a photo (with optional caption as the prompt).',
    ].join('\n')
  )
);

// --- Photo handler ----------------------------------------------------------
bot.on('message:photo', async (ctx) => {
  const sizes = ctx.message.photo;
  // Telegram returns multiple sizes ascending — take the largest
  const largest = sizes[sizes.length - 1];
  const caption = (ctx.message.caption || '').trim();

  let statusMsg;
  let hosted;
  try {
    statusMsg = await ctx.reply('Got it. Enhancing... (~30–90s)');

    // 1) Pull the file from Telegram
    const file = await ctx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const fileResp = await fetch(fileUrl);
    if (!fileResp.ok) throw new Error(`Telegram file download failed: ${fileResp.status}`);
    const buffer = Buffer.from(await fileResp.arrayBuffer());

    // 2) Host it for Civitai
    const ext = (file.file_path?.split('.').pop() || 'jpg').toLowerCase();
    hosted = hostPhoto(buffer, ext);

    // 3) Submit + poll
    const { imageUrl: resultUrl } = await enhancePhoto({
      imageUrl: hosted.publicUrl,
      prompt: caption || config.qwenDefaultPrompt,
    });

    // 4) Download the result and send it back
    const resultResp = await fetch(resultUrl);
    if (!resultResp.ok) throw new Error(`Result download failed: ${resultResp.status}`);
    const resultBuf = Buffer.from(await resultResp.arrayBuffer());

    await ctx.replyWithPhoto(new InputFile(resultBuf, 'enhanced.jpg'), {
      caption: caption ? `Prompt: ${caption}` : undefined,
      reply_parameters: { message_id: ctx.message.message_id },
    });
    if (statusMsg) await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
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
  } finally {
    hosted?.dispose();
  }
});

bot.on('message', (ctx) =>
  ctx.reply('Send me a photo (optionally with a caption) and I\'ll enhance it.')
);

// --- Lifecycle --------------------------------------------------------------
bot.catch((err) => {
  console.error('[grammy error]', err);
});

async function main() {
  sweepStaleTempFiles();
  await startPhotoHost();
  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
  console.log('[bot] starting long-polling…');
  await bot.start({
    onStart: (info) => console.log(`[bot] @${info.username} ready`),
  });
}

async function shutdown(signal) {
  console.log(`\n[bot] received ${signal}, shutting down…`);
  try {
    await bot.stop();
  } catch {}
  try {
    await stopPhotoHost();
  } catch {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
