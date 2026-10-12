import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { patchPiLensAnalysis } from '../resources/pi-lens/analysis-patch.mjs';

// Diagnostic only: never executes the recorded shell command or touches the site.
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
  const root = process.argv[3];
  process.env.PI_LENS_HOME = path.join(root, 'logs');
  registerHooks({ load(url, context, next) {
    const result = next(url, context);
    if (url.endsWith('/dispatch/runners/ast-grep-napi.js')) {
      const source = String(result.source);
      // Once installed, exercise the actual isolated runner, not a reconstructed
      // old implementation. --skip-suspect remains a pre-install diagnostic only.
      if (source.includes('// Pi Desktop: necessary-condition AST preflight')) return result;
      if (!source.includes('found = scope.root.findAll(nativeConfig);')) throw new Error('Rule probe anchor missing');
      const probe = 'console.log("RULE", rule.id); const probeStart = Date.now(); found = scope.root.findAll(nativeConfig); console.log("RULE-DONE", rule.id, Date.now() - probeStart);';
      const probed = source.replace('found = scope.root.findAll(nativeConfig);', process.argv.includes('--skip-suspect')
        ? 'if (rule.id.endsWith("-javascript")) { console.log("SKIP-CONTROL", rule.id); found = []; } else { ' + probe + ' }'
        : probe);
      let patched = process.argv.includes('--optimized') ? patchPiLensAnalysis(probed) : probed;
      if (process.argv.includes('--trace')) patched = patched
        .replace('const kinds = candidateKinds(config.rule, config.utils);', 'console.log("PREFLIGHT-DONE"); const kinds = candidateKinds(config.rule, config.utils);')
        .replace('for (const node of candidatesByKind.get(key)) {', 'let traceCount = 0; console.log("CANDIDATES", candidatesByKind.get(key).length); for (const node of candidatesByKind.get(key)) { if (++traceCount % 1000 === 0) console.log("CANDIDATE", traceCount);');
      return { ...result, source: patched };
    }
    return result;
  } });
  const { default: astGrepNapiRunner } = await import('../node_modules/pi-lens/dist/clients/dispatch/runners/ast-grep-napi.js');
  const { createDispatchContext } = await import('../node_modules/pi-lens/dist/clients/dispatch/dispatcher.js');
  const { FactStore } = await import('../node_modules/pi-lens/dist/clients/dispatch/fact-store.js');
  const file = path.join(root, 'admin', 'builder-catalog.js');
  const pi = { getFlag() { return undefined; } };
  const ctx = createDispatchContext(file, root, pi, new FactStore(), true, undefined, root);
  console.log('START ast-grep-napi');
  const start = Date.now();
  const result = await astGrepNapiRunner.run(ctx);
  console.log(JSON.stringify({ phase: 'DONE', ms: Date.now() - start, status: result.status, diagnostics: result.diagnostics.length }));
  process.exit(0);
} else {
  const source = String.raw`\\192.168.31.254\htdocs\KDPI\admin\builder-catalog.js`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-lens-hang-repro-'));
  await mkdir(path.join(root, 'admin'));
  await copyFile(source, path.join(root, 'admin', 'builder-catalog.js'));
  if (process.argv.includes('--stress')) {
    const file = path.join(root, 'admin', 'builder-catalog.js');
    const prefix = "import session from 'express-session';\nvar jwt = require('express-jwt');\nconst Sequelize = require('sequelize');\nconst NodeRSA = require('node-rsa');\nconst crypto = require('crypto');\n";
    const suffix = "\nconst options = {secret: 'unsafe'}; app.use(session(options)); app.use(jwt({secret:'unsafe'})); const db = new Sequelize('db','user',''); const key = new NodeRSA({b:1024}); crypto.generateKeyPair('rsa',{modulusLength:1024},callback);\n";
    await writeFile(file, prefix + await readFile(file, 'utf8') + suffix, 'utf8');
  }
  console.log(JSON.stringify({ fixture: root, bytes: (await readFile(source)).length }));
  const result = spawnSync(process.execPath, [self, '--child', root, ...process.argv.slice(2)], {
    cwd: root, timeout: 20000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  console.log(JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.code, stdout: result.stdout, stderr: result.stderr }));
}
