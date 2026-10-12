const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Exercise the actual component in Chromium, without starting Pi or a model.
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/App.tsx"), "utf8");
const component = source.slice(source.indexOf("interface VirtualFilmLayout"), source.indexOf("function createRevealTailPlugin"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  try {
    const errors = [];
    window.webContents.on("console-message", event => {
      if (event.level === "error") errors.push(event.message);
    });
    const { transformSync } = await import("rolldown/utils");
    const compiled = transformSync("fixture.tsx", component, { jsx: { runtime: "classic" } }).code;
    await window.loadURL("data:text/html,<div id='root'></div>");
    await window.webContents.executeJavaScript(`
      var React = require(${JSON.stringify(path.join(root, "node_modules/react"))});
      var {useRef,useState,useLayoutEffect,useCallback} = React;
      var {createRoot} = require(${JSON.stringify(path.join(root, "node_modules/react-dom/client"))});
      ${compiled}
      var style = document.createElement('style');
      style.textContent = ${JSON.stringify(fs.readFileSync(path.join(root, "src/styles.css"), "utf8"))};
      document.head.append(style);
      var setRows;
      function Fixture() {
        const [rows, update] = useState([{id:'a',lines:1},{id:'b',lines:2},{id:'c',lines:1}]);
        setRows = update;
        const ref = useRef(null);
        return React.createElement('div', {ref, className:'conversation-scroll', style:{height:450,width:600,position:'relative'}},
          React.createElement(VirtualFilm,{items:rows,itemKey:r=>r.id,resetKey:'test',scrollRef:ref,
            renderItem:r=>r.lines===0?null:React.createElement('article',{className:'message', 'data-id':r.id, style:r.height===undefined?undefined:{height:r.height}}, ('word '.repeat(30)+'\\n').repeat(r.lines))}));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    `);
    const settle = () => window.webContents.executeJavaScript("new Promise(r=>setTimeout(r,200))");
    const check = async label => {
      await settle();
      const boxes = await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-virtual-index]')).map(e=>({index:Number(e.dataset.virtualIndex),top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom})).sort((a,b)=>a.index-b.index)`);
      assert.ok(boxes.length > 0, label);
      for (let i=1;i<boxes.length;i++) assert.ok(boxes[i].top >= boxes[i-1].bottom-0.5, label+': rows overlap '+JSON.stringify(boxes));
      const overflow = await window.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.conversation-scroll'),f=document.querySelector('.virtual-film');return s.scrollHeight-Math.max(s.clientHeight,f.getBoundingClientRect().bottom-s.getBoundingClientRect().top+s.scrollTop)})()`);
      assert.ok(overflow <= 1, label+': stale scrollable overflow '+overflow);
      assert.deepEqual(errors, [], label+': React errors');
      console.log('PASS', label);
    };
    await check('initial measurement');
    await window.webContents.executeJavaScript("setRows([{id:'replaced',lines:6},{id:'b',lines:2},{id:'c',lines:1}])");
    await check('replaced non-final row, same count and range');
    await window.webContents.executeJavaScript("setRows([{id:'replaced',lines:8},{id:'b',lines:3},{id:'c',lines:1}])");
    await check('streaming growth with stable keys');
    await window.webContents.executeJavaScript("setRows([{id:'c',lines:1},{id:'replaced',lines:8},{id:'new',lines:2},{id:'b',lines:3}])");
    await check('reorder and insertion');
    await window.webContents.executeJavaScript("setRows([{id:'replaced',lines:2},{id:'b',lines:3}])");
    await check('regroup and collapse');
    await window.webContents.executeJavaScript("document.querySelector('.conversation-scroll').style.width='300px'");
    // Hidden Chromium windows can defer resize delivery until their next frame.
    await window.webContents.executeJavaScript("new Promise(r=>setTimeout(r,1500))");
    await check('width change');
    await window.webContents.executeJavaScript("document.querySelector('.conversation-scroll').style.width='600px';setRows(Array.from({length:300},(_,i)=>({id:'same-timestamp-'+i,lines:1,height:i>270?4000:50})))");
    await window.webContents.executeJavaScript("new Promise(r=>setTimeout(r,1500))");
    await window.webContents.executeJavaScript("document.querySelector('.conversation-scroll').scrollTop=1e9");
    await check('large history at tail');
    await window.webContents.executeJavaScript("setRows(Array.from({length:300},(_,i)=>({id:'same-timestamp-'+i,lines:i>270?0:1,height:50})))");
    await window.webContents.executeJavaScript("new Promise(r=>setTimeout(r,2000))");
    await check('mass collapse does not recursively exhaust React updates');
    await window.webContents.executeJavaScript("setRows([{id:'remaining',lines:1}]);document.querySelector('.conversation-scroll').scrollTop=1e9");
    await check('removed tail leaves no invisible scrollable field');
    await window.webContents.executeJavaScript("setRows([])");
    await settle();
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.virtual-film').getBoundingClientRect().height"), 0);
    assert.deepEqual(errors, []);
    console.log('PASS empty history releases all height');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
