// Real Chromium integration test: no mocks for WebMCP, forms or iframe policy.
const {app,BrowserWindow}=require('electron');
const {createServer}=require('node:http');
const {readFileSync,mkdtempSync,writeFileSync}=require('node:fs');
const {stripTypeScriptTypes}=require('node:module');
const {tmpdir}=require('node:os');
const path=require('node:path');
const assert=require('node:assert/strict');
const temporary=mkdtempSync(path.join(tmpdir(),'pi-webmcp-native-'));
app.setPath('userData',temporary);
app.whenReady().then(async()=>{
  let win,server,host,phase='startup';
  const timer=setTimeout(()=>{writeFileSync(path.join(temporary,'result.json'),JSON.stringify({passed:false,phase,error:'Timeout'}));app.exit(1)},30000);
  try{
    const source=stripTypeScriptTypes(readFileSync(path.join(__dirname,'../electron/browser-site-tools.ts'),'utf8')).replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'');
    const packaged=process.argv.indexOf('--packaged');
    const {BrowserSiteTools}=packaged>=0?require(path.join(process.argv[packaged+1],'dist-electron','electron','browser-site-tools.js')):new Function('Ajv','randomUUID',source+';return {BrowserSiteTools};')(require('ajv').Ajv,require('node:crypto').randomUUID);
    const frameHtml=`<!doctype html><script>document.modelContext.registerTool({name:'frame_tool',description:'Frame tool',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},execute:async input=>{document.body.dataset.result=input.text;return {origin:location.origin,text:input.text}}})</script><body>Frame</body>`;
    server=createServer((req,res)=>{
      res.setHeader('Content-Type','text/html; charset=utf-8');
      if(req.url.startsWith('/land')){res.end('<!doctype html><h1>Form navigation result</h1>');return}
      if(req.url==='/blocked'){res.setHeader('Permissions-Policy','tools=()');res.end('<!doctype html><form toolname="blocked_tool" tooldescription="Blocked"><input name="q"></form>');return}
      if(req.url==='/frame'){res.end(frameHtml);return}
      res.end(`<!doctype html><form id="auto" toolautosubmit toolname="auto_form" tooldescription="Search"><input name="q" required toolparamdescription="Query"><select name="choice"><option value="a">A</option><option value="b">B</option></select><button>Send</button></form><form id="manual" toolname="manual_form" tooldescription="Review first"><input name="q" required><button>Review submit</button></form><iframe id="same" src="/frame"></iframe><iframe id="cross" src="http://localhost:${server.address().port}/frame" allow="tools *"></iframe><iframe src="/blocked"></iframe><script>for(const form of document.forms)form.addEventListener('submit',e=>{e.preventDefault();document.body.dataset.submitted=(Number(document.body.dataset.submitted)||0)+1;if(e.agentInvoked)e.respondWith(Promise.resolve({q:form.elements.q.value,choice:form.elements.choice?.value||null,agent:e.agentInvoked}))})</script>`);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,enableBlinkFeatures:'WebMCP'}});
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    host=new BrowserSiteTools(win.webContents);
    const list=async()=>{await new Promise(resolve=>setTimeout(resolve,50));return host.list()};
    phase='native discovery';
    let tools=await list();
    assert.equal(tools.filter(t=>t.name==='frame_tool').length,2);
    assert.equal(tools.some(t=>t.name==='blocked_tool'),false);
    assert.equal(tools.find(t=>t.name==='auto_form').inputSchema.required.includes('q'),true);
    assert.equal(tools.find(t=>t.name==='manual_form').autoSubmit,false);
    phase='cross-origin iframe calls';
    for(const tool of tools.filter(t=>t.name==='frame_tool')){
      const result=await host.call(tool.id,{text:tool.origin},3000);
      assert.deepEqual(result,{status:'completed',result:{origin:tool.origin,text:tool.origin}});
    }
    phase='srcdoc iframe';
    await win.webContents.executeJavaScript(`const srcdoc=document.createElement('iframe');srcdoc.srcdoc=${JSON.stringify(frameHtml)};document.body.append(srcdoc)`);
    await new Promise(resolve=>setTimeout(resolve,100));
    tools=await list();
    const inline=tools.find(t=>t.frameUrl==='about:srcdoc');assert.ok(inline);
    assert.match(inline.origin,/^http:\/\/127\.0\.0\.1:/);
    assert.equal((await host.call(inline.id,{text:'srcdoc'},3000)).status,'completed');
    phase='native form automatic submit';
    await assert.rejects(host.call(tools.find(t=>t.name==='auto_form').id,{},3000),/схеме/);
    let result=await host.call(tools.find(t=>t.name==='auto_form').id,{q:'Search text',choice:'b'},3000);
    assert.deepEqual(result,{status:'completed',result:{q:'Search text',choice:'b',agent:true}});
    phase='native form manual review';
    result=await host.call(tools.find(t=>t.name==='manual_form').id,{q:'Review text'},3000);
    assert.equal(result.status,'awaiting-user');assert.ok(result.callId);
    assert.equal(await win.webContents.executeJavaScript('document.body.dataset.submitted'),'1');
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('#manual input').value"),'Review text');
    assert.equal((await host.result(result.callId)).status,'awaiting-user');
    host.cancel(true); // Handoff stops model actions, not the user's pending review.
    assert.equal((await host.result(result.callId)).status,'awaiting-user');
    await win.webContents.executeJavaScript("document.querySelector('#manual').requestSubmit()");
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.deepEqual(await host.result(result.callId),{status:'completed',result:{q:'Review text',choice:null,agent:true}});
    assert.equal(await win.webContents.executeJavaScript('document.body.dataset.submitted'),'2');
    tools=await list();
    phase='manual cancellation';
    result=await host.call(tools.find(t=>t.name==='manual_form').id,{q:'Do not send'},3000);host.cancel();
    await assert.rejects(host.result(result.callId),/подтверждение/);
    assert.equal(await win.webContents.executeJavaScript('document.body.dataset.submitted'),'2');
    phase='changed form invalidates ID';
    tools=await list();const old=tools.find(t=>t.name==='auto_form').id;
    await win.webContents.executeJavaScript("document.querySelector('#auto').setAttribute('tooldescription','Changed search')");
    await new Promise(resolve=>setTimeout(resolve,50));
    await assert.rejects(host.call(old,{q:'stale'},3000),/Stale/);
    tools=await list();assert.notEqual(tools.find(t=>t.name==='auto_form').id,old);
    phase='manual form reset';
    result=await host.call(tools.find(t=>t.name==='manual_form').id,{q:'Reset this'},3000);
    await win.webContents.executeJavaScript("document.querySelector('#manual').reset()");
    await new Promise(resolve=>setTimeout(resolve,50));
    await assert.rejects(host.result(result.callId));
    phase='detached iframe';
    const cross=tools.find(t=>t.name==='frame_tool' && t.origin.includes('localhost'));
    await win.webContents.executeJavaScript("document.querySelector('#cross').remove()");
    await assert.rejects(host.call(cross.id,{text:'stale'},3000),/Iframe/);
    phase='navigation';
    const before=tools.find(t=>t.name==='auto_form').id;
    await win.loadURL(`http://127.0.0.1:${server.address().port}/frame`);
    await assert.rejects(host.call(before,{q:'old document'},3000));
    assert.equal((await list()).some(t=>t.name==='auto_form'),false);
    phase='plain HTML form navigation';
    await win.webContents.executeJavaScript("const f=document.createElement('form');f.setAttribute('toolname','navigation_form');f.setAttribute('tooldescription','Navigate');f.setAttribute('toolautosubmit','');f.action='/land';f.innerHTML='<input name=q required><button>Send</button>';document.body.append(f)");
    tools=await list();
    const navigation=await host.call(tools.find(t=>t.name==='navigation_form').id,{q:'Go there'},3000);
    assert.ok(['navigated','needs-observation','completed'].includes(navigation.status));
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.match(win.webContents.getURL(),/\/land\?q=Go/);
    writeFileSync(path.join(temporary,'result.json'),JSON.stringify({passed:true,nativeForms:true,autoSubmit:true,manualReview:true,manualResult:true,cancellation:true,formReset:true,crossOriginFrames:true,srcdoc:true,permissionsPolicy:true,staleForm:true,detachedFrame:true,navigation:true,plainFormNavigation:true}));
    console.log(temporary);app.exit(0);
  }catch(error){writeFileSync(path.join(temporary,'result.json'),JSON.stringify({passed:false,phase,error:error.stack}));console.error(phase,error);app.exit(1)}
  finally{clearTimeout(timer);host?.cancel();if(win&&!win.isDestroyed())win.destroy();server?.close()}
});
