// Generate data drafts through the app's existing API, without tools or agents.
// Drafts are never published by this script. Each requires evidence and independent review.
import {readFile, writeFile, mkdir, access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
const limit=Number(args.limit || 10);
if(!Number.isInteger(limit)||limit<1||limit>1000)throw Error('limit must be 1–1000');
const folder=resolve(root,'work/explanation-drafts');
await mkdir(folder,{recursive:true});
const exists=async p=>access(p).then(()=>true,()=>false);
const questions=JSON.parse(await readFile(resolve(root,'app/public/questions.json'),'utf8'));
const line=(await readFile(resolve(root,'app/.dev.vars'),'utf8')).split('\n').find(l=>l.startsWith('ANTHROPIC_API_KEY='));
const key=line?.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,'');
if(!key)throw Error('API key not configured');
const todo=[];
for(const q of questions)if(!await exists(resolve(root,`data/explanations/${q.id}.json`))&&!await exists(resolve(folder,`${q.id}.json`)))todo.push(q);
const system=`변리사 1차 자연과학 기출 해설을 작성하세요. 도구는 없으며 제공된 문제와 그림만 볼 수 있습니다.
공식 정답을 억지로 합리화하지 말고 먼저 독립적으로 계산·판단하세요. 모순이나 OCR 오류, 읽을 수 없는 그림은 issues에 기록하세요.
보기 순서가 바뀔 수 있으므로 해설에서는 '1번 보기' 대신 보기의 내용으로 가리키세요. 각 보기마다 왜 정답 또는 오답인지 구체적으로 설명하세요.
한국어 존댓말로 핵심 개념, 계산식, 단위, 필요한 가정과 결론을 적으세요. 설명은 마크다운 없이 일반 텍스트로 작성하세요.
출처를 조회하지 못하므로 검증했다고 주장하거나 인용문·URL·논문번호를 지어내지 마세요. 필요한 출처는 영문 개념 검색어로 제안만 하세요.
JSON 하나만 반환하세요: {"id":"문제id","summary":"풀이 요약","choices":["5개 선지 해설"],"lawNote":"","basis":[],"independentAnswer":[1부터5의 정답 번호],"derivation":"독립 풀이와 수치 검산","sourceQueries":["좁은 개념별 출처 검색어"],"issues":["검토사항; 없으면 빈 배열"]}`;
console.log(JSON.stringify({eligible:todo.length,requested:Math.min(limit,todo.length),mode:'draft-only'}));
let failures=0;
const concurrency=Number(args.concurrency||2);
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw Error('concurrency must be 1–3');
const queue=todo.slice(0,limit);
async function worker(){
while(queue.length && failures<3){
 const q=queue.shift();
 if(await exists(resolve(root,'work/draft.stop'))){console.log('stop requested');break;}
 try{
  const content=[{type:'text',text:JSON.stringify(q)}];
  for(const path of q.images??[]){const raw=await readFile(resolve(root,'app/public',path));content.push({type:'image',source:{type:'base64',media_type:'image/webp',data:raw.toString('base64')}});}
  const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal:AbortSignal.timeout(240000),headers:{'content-type':'application/json','anthropic-version':'2023-06-01','x-api-key':key},body:JSON.stringify({model:'claude-opus-5-5',max_tokens:6000,system,messages:[{role:'user',content}]})});
  const result=await response.json();
  if(!response.ok)throw Error(`HTTP ${response.status}: ${result.error?.type??'unknown'}`);
  if(result.stop_reason!=='end_turn')throw Error(`Incomplete response: ${result.stop_reason}`);
  const raw=result.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  const draft=JSON.parse(raw);
  if(draft.id!==q.id||draft.choices?.length!==5||!draft.summary||!draft.derivation||!Array.isArray(draft.issues)||!Array.isArray(draft.independentAnswer))throw Error('Invalid draft structure');
  const agrees=JSON.stringify([...draft.independentAnswer].sort())===JSON.stringify([...q.answer].sort());
  await writeFile(resolve(folder,`${q.id}.json`),JSON.stringify({...draft,_review:{status:'pending',answerAgrees:agrees,model:result.model,usage:result.usage,generatedAt:new Date().toISOString()}},null,2)+'\n');
  console.log(JSON.stringify({id:q.id,answerAgrees:agrees,issues:draft.issues.length,usage:result.usage}));
 }catch(error){failures++;console.log(JSON.stringify({id:q.id,error:error.message}));if(failures>=3)break;}
}
}
await Promise.all(Array.from({length:concurrency},worker));
if(failures)process.exitCode=1;
