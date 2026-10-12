import { Ajv } from "ajv";
import { randomUUID } from "node:crypto";

// An adapter around Chromium's native WebMCP, not a replacement form engine.
// Installed independently in each document. Never exposes Electron/host APIs.
export const webMcpBootstrap = `(() => {
  if (!isSecureContext || window.__piBrowserSiteTools || !document.modelContext) return;
  const context=document.modelContext, tools=new Map(), registrations=new Map(), pending=new Map();
  const register=context.registerTool.bind(context);
  context.registerTool=async (tool,options={})=>{
    const controller=new AbortController();
    const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
    await register(tool,{...options,signal}); registrations.set(tool.name,controller);
  };
  if(!context.unregisterTool) context.unregisterTool=name=>{registrations.get(name)?.abort();registrations.delete(name)};
  if(!navigator.modelContext) Object.defineProperty(navigator,'modelContext',{value:context});
  context.addEventListener('toolchange',()=>tools.clear());
  const sync=async()=>{
    if(document.featurePolicy?.features().includes('tools') && !document.featurePolicy.allowsFeature('tools')) return [];
    const current=(await context.getTools()).filter(t=>t.window===window);
    const active=new Set();
    const result=current.map(tool=>{
      const schema=typeof tool.inputSchema==='string'?JSON.parse(tool.inputSchema):tool.inputSchema||{type:'object'};
      const signature=JSON.stringify([tool.name,tool.description,schema]); active.add(tool.name);
      let entry=tools.get(tool.name);
      if(!entry || entry.signature!==signature) {entry={id:crypto.randomUUID(),signature};tools.set(tool.name,entry)}
      entry.tool=tool;
      entry.form=[...document.forms].find(f=>f.getAttribute('toolname')===tool.name && f.hasAttribute('tooldescription'));
      return {id:entry.id,name:tool.name,description:tool.description,inputSchema:schema,origin:location.origin,kind:entry.form?'form':'imperative',autoSubmit:entry.form?entry.form.hasAttribute('toolautosubmit'):undefined};
    });
    for(const name of tools.keys()) if(!active.has(name))tools.delete(name);
    return result;
  };
  const cancel=callId=>{const call=pending.get(callId);if(call){call.controller.abort();pending.delete(callId)}};
  const invalidate=call=>{call.controller.abort();call.state='failed';call.error='Site form removed, changed or reset'};
  document.addEventListener('reset',event=>{for(const call of pending.values())if(call.form===event.target)invalidate(call)},true);
  new MutationObserver(()=>{for(const call of pending.values())if(call.form && (!call.form.isConnected || call.declaration!==JSON.stringify([call.form.getAttribute('toolname'),call.form.getAttribute('tooldescription')])))invalidate(call)}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['toolname','tooldescription']});
  const api={
    list:sync,
    call:async(id,input,callId)=>{
      await sync();const entry=[...tools.values()].find(t=>t.id===id);
      if(!entry)throw new Error('Stale WebMCP registration; list tools again');
      const controller=new AbortController();
      const call={controller,state:'running',form:entry.form,declaration:entry.form?JSON.stringify([entry.form.getAttribute('toolname'),entry.form.getAttribute('tooldescription')]):null};pending.set(callId,call);
      // Electron 44 / Chromium 152 uses DOMString inputArguments (not the
      // newer draft's object parameter). Never retry an execution blindly.
      call.promise=context.executeTool(entry.tool,JSON.stringify(input),{signal:controller.signal}).then(value=>{
        if(call.state==='failed')return;
        if(value===null){call.state='completed';call.observation=true;return}
        call.state='completed';call.result=typeof value==='string'?(()=>{try{return JSON.parse(value)}catch{return value}})():value;
      },error=>{call.state='failed';call.error=String(error)});
      while(call.state==='running'){
        if(entry.form && !entry.form.hasAttribute('toolautosubmit') && entry.form.matches(':tool-form-active'))
          return {status:'awaiting-user',callId,requiresUserSubmit:true};
        await Promise.race([call.promise,new Promise(resolve=>setTimeout(resolve,25))]);
      }
      if(call.state==='failed'){pending.delete(callId);throw new Error(call.error)}
      pending.delete(callId);return call.observation?{status:'needs-observation',needsObservation:true}:{status:'completed',result:call.result};
    },
    result:callId=>{
      const call=pending.get(callId);if(!call)throw new Error('Unknown or expired site call');
      if(call.state==='failed'){pending.delete(callId);throw new Error(call.error)}
      if(call.state==='completed'){pending.delete(callId);return call.observation?{status:'needs-observation',needsObservation:true}:{status:'completed',result:call.result}}
      return {status:'awaiting-user',callId,requiresUserSubmit:true};
    },cancel,
  };
  Object.defineProperty(window,'__piBrowserSiteTools',{value:api});
})()`;

type Frame = Electron.WebFrameMain;
type SiteTool = { id: string; name: string; description: string; inputSchema: object; origin: string; frameUrl: string; kind: string; autoSubmit?: boolean };

export class BrowserSiteTools {
  private tools = new Map<string, { tool: SiteTool; frame: Frame }>();
  private pending = new Map<string, { frame: Frame; url: string; cancel: () => void; manual?: boolean }>();
  private wc: Electron.WebContents;
  private generation = 0;
  constructor(wc: Electron.WebContents) { this.wc = wc; }
  private async bounded<T>(operation: Promise<T>, timeout: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Таймаут WebMCP. Проверьте страницу перед повтором.")), timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async list(): Promise<SiteTool[]> {
    const generation = this.generation;
    const frames = this.wc.mainFrame.framesInSubtree;
    if (frames.length > 100) throw new Error("Слишком много iframe для WebMCP (более 100).");
    const entries = await Promise.all(frames.map(async frame => {
      if (frame.detached || !/^https?:/.test(frame.origin) || !/^(https?:|about:(?:blank|srcdoc)$|$)/.test(frame.url)) return [];
      try {
        const result = await this.bounded(frame.executeJavaScript(`${webMcpBootstrap};window.__piBrowserSiteTools?.list() || []`), 3000);
        if (!Array.isArray(result) || result.length > 100 || JSON.stringify(result).length > 256000) throw new Error("Некорректный список инструментов сайта.");
        return result.map(value => {
          if (!value || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.description !== "string" || !value.inputSchema || typeof value.inputSchema !== "object" || JSON.stringify(value.inputSchema).length > 16000) throw new Error("Некорректная схема WebMCP.");
          const tool: SiteTool = { ...value, origin: frame.origin, frameUrl: frame.url };
          return { tool, frame };
        });
      } catch (error) {
        if (frame.detached || !this.wc.mainFrame.framesInSubtree.includes(frame)) return [];
        throw error;
      }
    }));
    if (generation !== this.generation) throw new Error("Получение WebMCP отменено.");
    const all = entries.flat();
    if (all.length > 100 || JSON.stringify(all.map(entry => entry.tool)).length > 256000) throw new Error("Список WebMCP превышает лимит.");
    this.tools.clear(); for (const entry of all) this.tools.set(entry.tool.id, entry);
    return all.map(entry => entry.tool);
  }
  describe(id: unknown): SiteTool | undefined { return typeof id === "string" ? this.tools.get(id)?.tool : undefined; }
  async call(id: unknown, input: unknown, timeout: number): Promise<unknown> {
    const entry = typeof id === "string" ? this.tools.get(id) : undefined;
    if (!entry) throw new Error("Сначала получите webmcp-list и выберите актуальный id.");
    if (this.pending.size >= 100) throw new Error("Слишком много незавершённых вызовов сайта.");
    if (entry.frame.detached || !this.wc.mainFrame.framesInSubtree.includes(entry.frame)) throw new Error("Iframe инструмента закрыта. Получите webmcp-list заново.");
    if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(input).length > 64000) throw new Error("Аргументы сайта: объект до 64 КБ.");
    const validate = new Ajv({ strict: false, allErrors: false }).compile(entry.tool.inputSchema);
    if (!validate(input)) throw new Error("Аргументы не соответствуют схеме инструмента сайта.");
    const callId = randomUUID(), url = entry.frame.url;
    let timer: ReturnType<typeof setTimeout> | undefined, navigation: ReturnType<typeof setInterval> | undefined;
    const interrupted = new Promise<unknown>((resolve, reject) => {
      this.pending.set(callId, { frame: entry.frame, url, cancel: () => reject(new Error("Вызов инструмента сайта отменён.")) });
      timer = setTimeout(() => reject(new Error("Таймаут инструмента сайта. Он мог начать действие; проверьте страницу перед повтором.")), timeout);
      navigation = setInterval(() => {
        if (entry.frame.detached || entry.frame.url !== url) resolve({ status: "navigated", needsObservation: true });
      }, 25);
    });
    let manual = false;
    try {
      const result = await Promise.race([entry.frame.executeJavaScript(`window.__piBrowserSiteTools?.call(${JSON.stringify(id)},${JSON.stringify(input)},${JSON.stringify(callId)}) || Promise.reject(new Error('Stale WebMCP document; list tools again'))`).catch(error => {
        if (entry.frame.detached || entry.frame.url !== url) return { status: "navigated", needsObservation: true };
        throw error;
      }), interrupted]) as { status?: string };
      if (JSON.stringify(result)?.length > 256000) throw new Error("Результат сайта превышает 256 КБ.");
      manual = result?.status === "awaiting-user";
      if (manual) this.pending.get(callId)!.manual = true;
      return result;
    } finally {
      clearTimeout(timer); clearInterval(navigation);
      if (!manual) this.cancelCall(callId);
    }
  }
  async result(id: unknown): Promise<unknown> {
    const call = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!call || !call.manual) throw new Error("Ручное подтверждение завершено или страница сменилась.");
    if (call.frame.detached || call.frame.url !== call.url) { this.pending.delete(id as string); return { status: "navigated", needsObservation: true }; }
    let result: { status?: string };
    try { result = await this.bounded(call.frame.executeJavaScript(`window.__piBrowserSiteTools.result(${JSON.stringify(id)})`), 3000) as { status?: string }; }
    catch (error) { this.cancelCall(id as string); throw error; }
    if (JSON.stringify(result)?.length > 256000) throw new Error("Результат сайта превышает 256 КБ.");
    if (result.status !== "awaiting-user") this.pending.delete(id as string);
    return result;
  }
  private cancelCall(id: string): void {
    const call = this.pending.get(id); this.pending.delete(id);
    if (!call) return;
    call.cancel();
    if (!call.frame.detached && !this.wc.isDestroyed()) void call.frame.executeJavaScript(`window.__piBrowserSiteTools?.cancel(${JSON.stringify(id)})`).catch(() => undefined);
  }
  cancel(keepManual = false): void {
    this.generation++;
    for (const [id, call] of this.pending) if (!keepManual || !call.manual) this.cancelCall(id);
    this.tools.clear();
  }
}
