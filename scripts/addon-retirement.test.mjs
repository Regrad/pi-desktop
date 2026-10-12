import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

test("retired activation addon is removed from catalog, packages and explicit extensions",async()=>{
  const source=readFileSync(new URL('../electron/data-store.ts',import.meta.url),'utf8');
  const constants=source.slice(source.indexOf('const MANAGED_PACKAGE_NAMES'),source.indexOf('const DEFAULT_BUILTIN_MODULES'));
  const method=source.slice(source.indexOf('  private async writeManagedPackageConfiguration('),source.indexOf('  private async loadBuiltinModuleSettings'));
  const helper=source.slice(source.indexOf('function isManagedPackage('),source.indexOf('function sessionTitle('));
  const code=stripTypeScriptTypes(`${constants}\n${helper}\nclass Store {${method}}`,{mode:'transform'});
  const outputs=[];
  const Store=new Function('path','readFile','writeFile',`${code};return Store;`)(
    {join:(...parts)=>parts.join('/')},async()=>{},async(_path,content)=>outputs.push(JSON.parse(content)));
  const store=new Store();
  store.agentDir='F:/Pi Desktop/data/agent';store.appRoot='F:/Pi Desktop/resources/app.asar';store.builtinModules={};
  store.getEffectivePackagePath=()=>{throw Error('disabled packages must not load');};
  await store.writeManagedPackageConfiguration({packages:['F:/Pi Desktop/resources/app.asar/resources/pi-lens-all-tools','F:/Pi Desktop/local-packages/pi-lens-all-tools','C:/my-addon'],extensions:['resources/pi-lens-all-tools/index.js','F:/Pi Desktop/resources/app.asar/resources/pi-lens-all-tools/index.js','C:/my-addon/index.js']});
  assert.deepEqual(outputs[0].packages,['C:/my-addon']);
  assert.deepEqual(outputs[0].extensions,['C:/my-addon/index.js']);
  const catalog=constants.slice(constants.indexOf('const BUILTIN_MODULES'));
  assert.ok(!catalog.includes('pi-lens-all-tools'));
  assert.ok(!existsSync(new URL('../resources/pi-lens-all-tools/index.js',import.meta.url)));
});
