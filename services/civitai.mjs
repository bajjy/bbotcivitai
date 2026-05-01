/**
 * Civitai orchestrator client — Qwen-Image img2img (createVariant).
 *
 * Endpoint contract (verified against developer.civitai.com/orchestration/recipes/qwen):
 *   POST https://orchestration.civitai.com/v2/consumer/workflows?wait=<seconds>
 *   Authorization: Bearer <token>
 *   { "steps": [ { "$type": "imageGen", "input": { ... } } ] }
 *
 * Important constraints:
 *   - "image" is a PLAIN STRING URL (not { url: ... }), and Civitai must be able to GET it.
 *   - "strength" is the denoise strength: 0.0 returns source unchanged, 1.0 discards source.
 *   - For createVariant width/height are inferred from the source — do not set them.
 *   - "ecosystem" must be lowercase "qwen", engine "sdcpp" uses the open-weights pipeline.
 */

import { config } from '../config/config.mjs';

const ORCHESTRATOR = 'https://orchestration.civitai.com';
const SUBMIT_WAIT_SECONDS = 60;     // synchronous wait on submit (max ~100s)
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60_000; // 5 min hard cap

function buildCreateVariantPayload({ imageUrl, prompt, strength }) {
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
          image: imageUrl,
          strength,
        },
      },
    ],
  };
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
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
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
  const url = step?.output?.images?.[0]?.url;
  return url || null;
}

/**
 * Submit a Qwen createVariant job and wait (synchronously up to SUBMIT_WAIT_SECONDS,
 * then poll) until it finishes or the timeout hits.
 */
export async function enhancePhoto({ imageUrl, prompt, strength }) {
  const payload = buildCreateVariantPayload({
    imageUrl,
    prompt: prompt || config.qwenDefaultPrompt,
    strength: typeof strength === 'number' ? strength : config.qwenStrength,
  });

  const submitted = await civitaiFetch(
    `/v2/consumer/workflows?wait=${SUBMIT_WAIT_SECONDS}`,
    { method: 'POST', body: JSON.stringify(payload) }
  );

  // Synchronous wait may have already produced the image
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

// Exported for tests / dry-runs
export const _internals = { buildCreateVariantPayload, extractFinishedImageUrl };
