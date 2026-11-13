// Read-only comparison of transport captures and SDK results. Never calls a model.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export function decodeCapturedSse(bytes) {
  const chunks=[], parseErrors=[];
  for (const event of bytes.toString('utf8').split(/\r?\n\r?\n/)) {
    const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')continue;
    try {chunks.push(JSON.parse(data));}catch {parseErrors.push(data.slice(0,120));}
  }
  const ids=[...new Set(chunks.map(chunk=>chunk.id).filter(Boolean))];
  let thinking='',text='';
  const calls=new Map();
  for(const chunk of chunks) {
    const delta=chunk.choices?.[0]?.delta;
    if(!delta)continue;
    const reasoning=['reasoning_content','reasoning','reasoning_text'].map(key=>delta[key]).find(value=>typeof value==='string'&&value.length);
    if(reasoning)thinking+=reasoning;
    if(typeof delta.content==='string')text+=delta.content;
    for(const call of delta.tool_calls||[]) {
      const item=calls.get(call.index)||{id:'',name:'',arguments:''};
      if(call.id)item.id=call.id;
      if(call.function?.name&&!item.name)item.name=call.function.name;
      if(call.function?.arguments)item.arguments+=call.function.arguments;
      calls.set(call.index,item);
    }
  }
  return {chunks:chunks.length,ids,parseErrors,thinking,text,toolCalls:[...calls.values()]};
}

export async function analyzeTraces(directory) {
  const reports=[];
  for(const folder of (await readdir(directory)).filter(name=>name.startsWith('request-')).sort()) {
    const root=path.join(directory,folder);
    const identity=JSON.parse(await readFile(path.join(root,'identity.json'),'utf8'));
    let output;try {output=JSON.parse(await readFile(path.join(root,'sdk-output.json'),'utf8'));}catch {}
    for(const attempt of (await readdir(root)).filter(name=>name.startsWith('http-')).sort()) {
      const prefix=path.join(root,attempt);
      const meta=JSON.parse(await readFile(path.join(prefix,'transport.json'),'utf8'));
      const body=await readFile(path.join(prefix,'request.body.json'));
      const request=JSON.parse(body);
      let raw;try {raw=await readFile(path.join(prefix,'response.body.raw'));}catch {raw=Buffer.alloc(0);}
      const decoded=decodeCapturedSse(raw);
      const sdkThinking=output?.content.filter(block=>block.type==='thinking').map(block=>block.thinking).join('')??null;
      const sdkText=output?.content.filter(block=>block.type==='text').map(block=>block.text).join('')??null;
      const reply=decoded.toolCalls.map(call=>{try{return {...call,arguments:JSON.parse(call.arguments)};}catch{return call;}});
      const partialArguments=reply.some(call=>typeof call.arguments==='string');
      const sdkCalls=output?.content.filter(block=>block.type==='toolCall').map(block=>({id:block.id,name:block.name,arguments:block.arguments}))??null;
      reports.push({requestId:identity.requestId,folder,attempt,conversationId:identity.conversationId,
        complete:meta.complete,status:meta.status,requestHashMatches:createHash('sha256').update(body).digest('hex')===meta.requestSha256,
        responseHashMatches:meta.responseSha256?createHash('sha256').update(raw).digest('hex')===meta.responseSha256:null,
        userMessages:request.messages.filter(message=>message.role==='user').length,
        messages:request.messages.length,maxTokens:request.max_tokens,responseIds:decoded.ids,parseErrors:decoded.parseErrors,
        thinkingMatches:sdkThinking===decoded.thinking,textMatches:sdkText===decoded.text,
        toolCallsMatch:partialArguments?null:JSON.stringify(sdkCalls)===JSON.stringify(reply),
        ...(partialArguments?{toolCallsNote:'Incomplete raw JSON arguments; the SDK exposes a repaired partial object, so equality is not asserted.'}:{}),
        stopReason:output?.stopReason,usage:output?.usage,
        suspectThinking:/sensitivity|specificity|math\/statistics|three independent arguments|no previous thinking|user (?:keeps )?(?:repeating|resending)/i.test(decoded.thinking),
        thinking:decoded.thinking,text:decoded.text,toolCalls:reply});
    }
  }
  return reports;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const reports=await analyzeTraces(path.resolve(process.argv[2]));
  console.log(JSON.stringify(reports,null,2));
}
