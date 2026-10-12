import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
registerHooks({ resolve(s, c, next) {
  if (s.startsWith('.') && s.endsWith('.js') && c.parentURL) {
    const u = new URL(s.slice(0, -3) + '.ts', c.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href, c);
  }
  return next(s, c);
} });
const { imageGraph } = await import('../resources/pi-comfyui/tools/comfyui_generate_image/workflow.ts');
const { DEFAULT_COMFY_SETTINGS } = await import('../resources/pi-comfyui/shared/comfy.ts');
const settings = { ...DEFAULT_COMFY_SETTINGS, diffusionModel: 'qwen_image_2.1_turbo_int8_convrot.safetensors', steps: 8 };
test('Turbo uses the exact official eight-step grid, Euler, CFG 1 and seed zero', () => {
  const g = imageGraph(settings, 'generate', { prompt: 'a cat', seed: 0 }, []);
  assert.equal(g.model.inputs.unet_name, 'qwen_image_2.1_turbo_int8_convrot.safetensors');
  assert.equal(g.sample.class_type, 'SamplerCustom');
  assert.equal(g.sample.inputs.noise_seed, 0);
  assert.equal(g.sample.inputs.cfg, 1);
  assert.equal(g.turbo_sampler.inputs.sampler_name, 'euler');
  assert.deepEqual(g.turbo_sigmas.inputs.sigmas.split(',').map(Number), [1, .978453, .95418, .926626, .89508, .845148, .704534, .414568, 0]);
  assert.throws(() => imageGraph(settings, 'generate', { prompt: 'cat', steps: 25 }, []), /8-step/);
});
test('Turbo editing retains original dimensions, references, masks and partial denoising', () => {
  const g = imageGraph(settings, 'edit', { prompt: 'make it blue', denoise: .5 }, ['cat.png'], [{ width: 512, height: 512 }]);
  assert.deepEqual(g.sample.inputs.model, ['cache', 0]);
  assert.deepEqual(g.sample.inputs.latent_image, ['encoded_canvas', 0]);
  assert.equal(g.latent.inputs.width, 512);
  assert.deepEqual(g.turbo_sigmas.inputs.sigmas.split(',').map(Number), [.89508, .845148, .704534, .414568, 0]);
  const masked = imageGraph(settings, 'inpaint', { prompt: 'blue' }, ['cat.png'], [{ width: 512, height: 512 }], 'mask.png');
  assert.deepEqual(masked.sample.inputs.latent_image, ['masked_latent', 0]);
  assert.equal(masked.preserve_unmasked.class_type, 'ImageCompositeMasked');
});
test('Base model and non-generative background removal retain their original path', () => {
  const g = imageGraph({ ...settings, diffusionModel: 'qwen_image_2.1_int8_convrot.safetensors', steps: 25 }, 'generate', { prompt: 'cat' }, []);
  assert.equal(g.sample.class_type, 'KSampler');
  assert.equal(g.sample.inputs.steps, 25);
  assert.equal(imageGraph(settings, 'remove_background', {}, ['cat.png']).model, undefined);
});
