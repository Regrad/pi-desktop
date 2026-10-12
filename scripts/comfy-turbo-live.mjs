import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
registerHooks({ resolve(s, c, next) {
  if (s.startsWith('.') && s.endsWith('.js') && c.parentURL) {
    const u = new URL(s.slice(0, -3) + '.ts', c.parentURL);
    if (existsSync(fileURLToPath(u))) return next(u.href, c);
  }
  return next(s, c);
} });
const { imageGraph } = await import('../release/Pi Desktop/data/agent/extensions/pi-comfyui/tools/comfyui_generate_image/workflow.ts');
const settings = JSON.parse(await readFile(new URL('../release/Pi Desktop/data/comfyui.json', import.meta.url), 'utf8'));
const url = settings.url;
const json = async (p, options) => { const r = await fetch(url + p, options); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; };
async function run(mode, input, images = [], sizes = []) {
  const graph = imageGraph(settings, mode, input, images, sizes);
  graph.save.inputs.filename_prefix = 'checks/Qwen21_Turbo_' + mode;
  await writeFile('C:/AI/ComfyUI/ComfyUI/output/Qwen21_Turbo_' + mode + '_api.json', JSON.stringify(graph, null, 2));
  const q = await json('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph }) });
  console.log('Queued', mode, q.prompt_id);
  for (let t = 0; t < 600; t++) {
    await new Promise(r => setTimeout(r, 2000));
    const h = (await json('/history/' + q.prompt_id))[q.prompt_id];
    if (!h) continue;
    if (h.status.status_str !== 'success') throw new Error(JSON.stringify(h.status));
    const image = h.outputs.save.images[0];
    console.log('Succeeded', mode, JSON.stringify(image));
    return image;
  }
  throw new Error('Generation timeout');
}
const generated = await run('generate', { prompt: 'A clear detailed photograph of a red ceramic teapot on a wooden table, daylight, green garden in the background. No text.', width: 1024, height: 1024, seed: 12345 });
const params = new URLSearchParams(generated);
const bytes = await (await fetch(url + '/view?' + params)).arrayBuffer();
const upload = new FormData();
upload.append('image', new Blob([bytes], { type: 'image/png' }), 'Qwen21_Turbo_test_source.png');
upload.append('overwrite', 'true');
const source = await json('/upload/image', { method: 'POST', body: upload });
await run('edit', { prompt: 'Change only the red ceramic teapot to bright blue. Preserve the wooden table, garden, composition and lighting.', seed: 12345 }, [source.name], [{ width: 1024, height: 1024 }]);
await run('generate', { prompt: 'An isometric game icon of a small green glass potion bottle with a cork and a leather strap, isolated.', transparent_background: true, width: 1024, height: 1024, seed: 12345 });
