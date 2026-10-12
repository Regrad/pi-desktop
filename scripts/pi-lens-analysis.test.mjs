import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as sg from "@ast-grep/napi";
import yaml from "js-yaml";
import { createAstPreflight } from "../resources/pi-lens/ast-preflight.mjs";
import { patchPiLensAnalysis, patchPiLensIsolation, patchPiLensScanIsolation, patchPiLensDispatchDeadline } from "../resources/pi-lens/analysis-patch.mjs";

const fixtures = [
  "const catalog = { first: { count: 42, text: 'пример' }, second: { count: 1024 } };",
  "var jwt = require('express-jwt'); app.use(jwt({ secret: 'unsafe' }));",
  "import jwt from 'express-jwt'; const secret = 'unsafe'; app.use(jwt({ secret }));",
  "import session from 'express-session'; const options = { secret: 'unsafe' }; app.use(session(options));",
  "import session from 'express-session'; const secret = 'unsafe'; app.use(session({ secret }));",
  "const Sequelize = require('sequelize'); const db = new Sequelize('db', 'user', '');",
  "const Sequelize = require('sequelize'); const db = new Sequelize('db', 'user', 'unsafe');",
  "const NodeRSA = require('node-rsa'); const key = new NodeRSA({ b: 1024 });",
  "const crypto = require('crypto'); crypto.generateKeyPair('rsa', { modulusLength: 1024 }, callback);",
  "const forge = require('node-forge'); const rsa = forge.pki.rsa; const key = rsa.generateKeyPair(1024);",
  "const fs = require('fs'); const text = fs.readFileSync('/tmp/input'); eval(text);",
  "const express = require('express'); app.use('/path', (req,res) => res.send(req.query.x));",
  "const jwt = require('jwt-simple'); const claims = jwt.decode(token, 'key', true);",
  "const app = angular.module('app'); app.config(($sceProvider) => $sceProvider.enabled(false));",
  "function nested() { const a = 'old'; { const b = 'new'; return call(a, b); } }",
  "for(let i=0;i<4;i++) { if(i == 1) console.log(i); else throw 'failed'; } const p=eval('1+2');",
  "const catalog={a:{n:10,s:'text'},b:{n:42,s:'next'}}; const fn=()=>({}); const s={secret:'unsafe'};",
];

for (const file of ["dist/index.js", "dist/clients/dispatch/runners/ast-grep-napi.js"]) {
  test(`AST bridge is idempotent and retains native matching: ${file}`, () => {
    const source = readFileSync(new URL(`../node_modules/pi-lens/${file}`, import.meta.url), "utf8");
    const patched = patchPiLensAnalysis(source);
    assert.equal(patchPiLensAnalysis(patched), patched);
    assert.match(patched, /preflight\.findAll\(nativeConfig, maxMatchesPerRule - collected.length\)/);
    if (file !== "dist/index.js") assert.match(patched, /export function evaluateAstGrepRules\(/);
  });
}

test("unknown upstream layout refuses partial patches", () => {
  assert.throws(() => patchPiLensAnalysis("unknown"), /incompatible/);
});

test("positive relations are necessary; negatives, bindings and cycles are not hoisted", () => {
  const root = sg.parse(sg.Lang.JavaScript, "const obj = { value: 'safe' }; use(obj);").root();
  const check = createAstPreflight(root);
  assert.equal(check({ rule: { kind: "pair", inside: { kind: "lexical_declaration", has: { kind: "new_expression", stopBy: "end" } } } }), false);
  assert.equal(check({ rule: { kind: "pair", not: { kind: "call_expression", has: { kind: "new_expression" } } } }), true);
  assert.equal(check({ rule: { kind: "pair", any: [{ kind: "new_expression" }, { kind: "pair" }] } }), true);
  assert.equal(check({ rule: { kind: "pair", matches: "global-unknown" } }), true);
  assert.equal(check({ rule: { matches: "cycle" }, utils: { cycle: { matches: "cycle" } } }), true);
  assert.equal(check({ rule: { kind: "not-a-javascript-kind" } }), true);
  assert.equal(check({ rule: { kind: "program" } }), true, "the complete root is considered too");
});

test("subtree matching can depend on relatives outside that subtree", () => {
  const root = sg.parse(sg.Lang.JavaScript, "const a = 'secret'; use({ value: a });").root();
  const scope = root.find({ rule: { kind: "pair" } });
  const config = { rule: { kind: "pair", inside: { kind: "expression_statement", follows: { kind: "lexical_declaration", stopBy: "end" }, stopBy: "end" } } };
  assert.equal(scope.findAll(config).length, 1);
  assert.equal(createAstPreflight(scope)(config), true);
  assert.deepEqual(createAstPreflight(scope).findAll(config).map(node => node.range()), scope.findAll(config).map(node => node.range()));
});

for (const file of ["dist/index.js", "dist/clients/dispatch/runners/ast-grep-napi.js"]) {
  test(`native parse/matching is isolated but parent coverage/telemetry remains: ${file}`, () => {
    const source = readFileSync(new URL(`../node_modules/pi-lens/${file}`, import.meta.url), "utf8");
    const patched = patchPiLensIsolation(source, file === "dist/index.js");
    assert.equal(patchPiLensIsolation(patched, file === "dist/index.js"), patched);
    const start = patched.indexOf(file === "dist/index.js" ? "astGrepNapiRunner = {" : "const astGrepNapiRunner = {");
    const runner = patched.slice(start, patched.indexOf(file === "dist/index.js" ? "ast_grep_napi_default =" : "export default astGrepNapiRunner", start));
    assert.doesNotMatch(runner, /lang\.parse\(content\)|loadSg\(\)|root\.root\(\)/);
    assert.match(runner, /await desktopEvaluateAstGrepRules/);
    assert.ok(runner.indexOf("await desktopEvaluateAstGrepRules") < runner.indexOf("recordNapiFallbackCoverage(ctx.filePath)"));
    assert.match(runner, /deadlineAt: ctx.desktopAnalysisDeadlineAt/);
    assert.doesNotMatch(patched.slice(patched.indexOf("async function desktopEvaluateAstGrepRules"), start), /await readFile/);
  });
}

for (const file of ["dist/index.js", "dist/clients/dispatch/dispatcher.js"]) {
  test(`supervisor respects the existing configured dispatch budget: ${file}`, () => {
    const source = readFileSync(new URL(`../node_modules/pi-lens/${file}`, import.meta.url), "utf8");
    const patched = patchPiLensDispatchDeadline(source);
    assert.equal(patchPiLensDispatchDeadline(patched), patched);
    assert.match(patched, /desktopAnalysisDeadlineAt: Date\.now\(\) \+ timeoutMs/);
  });
}

for (const file of ["dist/index.js", "dist/clients/project-diagnostics/scanner.js"]) {
  test(`project scans await cancellation-aware analysis and do not cache incomplete results: ${file}`, () => {
    const source = readFileSync(new URL(`../node_modules/pi-lens/${file}`, import.meta.url), "utf8");
    const patched = patchPiLensScanIsolation(source);
    assert.equal(patchPiLensScanIsolation(patched), patched);
    const scanner = patched.slice(patched.indexOf("async function scanFileMajorRules("));
    assert.match(scanner, /await desktopEvaluateAstGrepRules/);
    assert.match(scanner, /await scanAstGrepFile/);
    assert.doesNotMatch(scanner, /lang\.parse\(content\)|const sgModule = await loadSg/);
    assert.match(scanner, /wasmAborted, astGrepFailed/);
    assert.match(scanner, /snapshot\.astGrepStatus = "incomplete"/);
    assert.match(scanner, /options\.files \|\| wasmAborted \|\| nativeAnalysisIncomplete/);
  });
}

test("all shipped JavaScript security rules keep every native finding on regression fixtures", () => {
  const dir = new URL("../node_modules/pi-lens/rules/ast-grep-rules/coderabbit/rules/javascript/security/", import.meta.url);
  const rules = readdirSync(dir).filter(name => name.endsWith(".yml")).map(name => yaml.load(readFileSync(new URL(name, dir), "utf8")));
  let positives = 0;
  for (const content of fixtures) {
    const root = sg.parse(sg.Lang.JavaScript, content).root();
    const check = createAstPreflight(root);
    for (const rule of rules) {
      const config = { rule: rule.rule, ...(rule.utils && { utils: rule.utils }), ...(rule.constraints && { constraints: rule.constraints }) };
      let expected;
      try { expected = root.findAll(config).map(node => node.range()); } catch { continue; }
      if (expected.length) positives++;
      const actual = check.findAll(config).map(node => node.range());
      assert.deepEqual(actual, expected, `${rule.id}: ${content}`);
    }
  }
  assert.ok(positives >= 6, `real positive matches required, found ${positives}`);
});

test("boolean/relational filters preserve native results, ordering and existing match limits", () => {
  const rules = [
    { kind: "pair", has: { kind: "property_identifier", regex: "^value$", field: "key" } },
    { kind: "number", inside: { kind: "lexical_declaration", stopBy: "end", has: { kind: "call_expression", stopBy: "end" } } },
    { kind: "identifier", follows: { kind: "identifier", stopBy: "end" } },
    { kind: "identifier", precedes: { kind: "arguments", stopBy: "end" } },
    { kind: "pair", inside: { kind: "object", stopBy: { kind: "function_expression" } } },
    { any: [{ kind: "pair", has: { kind: "number", stopBy: "end" } }, { kind: "call_expression", inside: { kind: "expression_statement" } }] },
    { all: [{ kind: "identifier" }, { not: { inside: { kind: "object", stopBy: "end" } } }] },
    { kind: "pair", has: { kind: "string", stopBy: "end", not: { has: { kind: "string_fragment" } } } },
  ];
  const content = fixtures.join("\n") + "\nconst extra={value:1,deep:{value:'',next:{value:2}}}; target(extra);";
  const root = sg.parse(sg.Lang.JavaScript, content).root();
  const check = createAstPreflight(root);
  for (const rule of rules) {
    const config = { rule };
    const expected = root.findAll(config).map(node => node.range());
    for (const limit of [1, 10, 25, Infinity]) assert.deepEqual(check.findAll(config, limit).map(node => node.range()), expected.slice(0, limit));
  }
});

test("all supported shipped rule catalogs preserve native findings across grammars", t => {
  const directory = new URL("../node_modules/pi-lens/rules/ast-grep-rules/", import.meta.url);
  const files = readdirSync(directory, { recursive: true }).filter(name => /\.ya?ml$/.test(name));
  const languages = {
    javascript: [sg.Lang.JavaScript, fixtures.join("\n")],
    typescript: [sg.Lang.TypeScript, "interface X { value:any }; const x:any = 1; function run(v:any) { if(v == 1) console.log(v); return Promise.resolve(v); }"],
    tsx: [sg.Lang.Tsx, "const Button=()=> <button onClick={()=>eval('1')}>go</button>;"],
    css: [sg.Lang.Css, "a { color:red !important; width:0px; color:blue; }"],
    html: [sg.Lang.Html, '<a target="_blank" href="javascript:alert(1)">go</a><img src="x"><script>eval("1");</script>'],
  };
  let compared = 0, positives = 0;
  for (const name of files) {
    const rule = yaml.load(readFileSync(new URL(name.replaceAll("\\", "/"), directory), "utf8"));
    const fixture = languages[rule?.language?.toLowerCase()];
    if (!fixture || !rule.rule) continue;
    const root = sg.parse(fixture[0], fixture[1]).root();
    const config = { rule: rule.rule, ...(rule.utils && { utils: rule.utils }), ...(rule.constraints && { constraints: rule.constraints }) };
    let expected;
    try { expected = root.findAll(config).map(node => node.range()); } catch { continue; }
    const actual = createAstPreflight(root).findAll(config).map(node => node.range());
    assert.deepEqual(actual, expected, rule.id);
    compared++;
    if (expected.length) positives++;
  }
  assert.ok(compared >= 200, `compared ${compared} rules`);
  assert.ok(positives >= 10, `matched ${positives} rules`);
  t.diagnostic(`${compared} valid native rules compared; ${positives} rules produced positive findings`);
});
