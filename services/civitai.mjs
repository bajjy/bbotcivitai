/**
 * Civitai orchestrator client — Qwen-Image img2img (createVariant).
 *
 * Endpoint contract:
 *   POST https://orchestration.civitai.com/v2/consumer/workflows?wait=<seconds>
 *   Authorization: Bearer <token>
 *   { "steps": [ { "$type": "imageGen", "input": { ... } } ] }
 *
 * Image input: The "image" field is base64-encoded (NOT a URL — runtime
 * confirmed "Input image failed to decode Base64 data" when a URL was sent).
 * We send a data-URI ("data:image/jpeg;base64,..."); flip useDataUri=false
 * inside encodeImage() if Civitai ever wants plain base64 instead.
 */

import { config } from '../config/config.mjs';

const ORCHESTRATOR = 'https://orchestration.civitai.com';
const SUBMIT_WAIT_SECONDS = 60;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60_000;

function buildCreateVariantPayload({ imageData, prompt, strength }) {
  return {
    steps: [
      {
        $type: 'imageGen',
        input: {
          engine: 'sdcpp',
          ecosystem: 'qwen',
          model: '20b',
          operation: 'createVariant',
          prompt,
          image: imageData,
          strength,
        },
      },
    ],
  };
}

function encodeImage(buffer, mimeType = 'image/jpeg', useDataUri = true) {
  const b64 = Buffer.from(buffer).toString('base64');
  return useDataUri ? `data:${mimeType};base64,${b64}` : b64;
}

async function civitaiFetch(pathname, init = {}) {
  const res = await fetch(`${ORCHESTRATOR}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.civitaiApiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(
      `Civitai ${init.method || 'GET'} ${pathname} -> ${res.status} ${res.statusText}: ${text}`
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function extractFinishedImageUrl(workflow) {
  const step = workflow?.steps?.[0];
  if (!step) return null;
  if (step.status === 'failed') {
    const reason = step.reason || workflow.reason || 'unknown';
    const err = new Error(`Civitai job failed: ${reason}`);
    err.reason = reason;
    err.workflow = workflow;
    throw err;
  }
  return step?.output?.images?.[0]?.url || null;
}

export async function enhancePhoto({ imageBuffer, mimeType, prompt, strength }) {
  if (!Buffer.isBuffer(imageBuffer)) {
    throw new Error('enhancePhoto: imageBuffer must be a Buffer');
  }
  const imageData = encodeImage(imageBuffer, mimeType || 'image/jpeg', true);

  const payload = buildCreateVariantPayload({
    imageData,
    prompt: prompt || config.qwenDefaultPrompt,
    strength: typeof strength === 'number' ? strength : config.qwenStrength,
  });

  const submitted = await civitaiFetch(
    `/v2/consumer/workflows?wait=${SUBMIT_WAIT_SECONDS}`,
    { method: 'POST', body: JSON.stringify(payload) }
  );

  const earlyUrl = extractFinishedImageUrl(submitted);
  if (earlyUrl) return { imageUrl: earlyUrl, workflow: submitted };

  const workflowId = submitted.id || submitted.workflowId;
  if (!workflowId) {
    throw new Error('Civitai response missing workflow id: ' + JSON.stringify(submitted));
  }

  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const wf = await civitaiFetch(`/v2/consumer/workflows/${workflowId}`);
    const url = extractFinishedImageUrl(wf);
    if (url) return { imageUrl: url, workflow: wf };
    if (wf.status === 'failed' || wf.status === 'cancelled') {
      throw new Error(`Workflow ${workflowId} ended with status ${wf.status}`);
    }
  }
  throw new Error(`Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for workflow ${workflowId}`);
}

export const _internals = { buildCreateVariantPayload, extractFinishedImageUrl, encodeImage };
