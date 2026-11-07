// Candidate retrieval hints only. Nothing here marks a source verified or publishes explanations.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const args=Object.fromEntries(process.argv.slice(2).map(a=>a.replace(/^--/,'').split('=')));
const limit=Number(args.limit||10);
if(!Number.isInteger(limit)||limit<1||limit>1600)throw Error('Invalid limit');
const out=resolve(root,'work/evidence-proposals');await mkdir(out,{recursive:true});
const exists=async path=>access(path).then(()=>true,()=>false);
const questions=JSON.parse(await readFile(resolve(root,'app/public/questions.json'),'utf8'));
const line=(await readFile(resolve(root,'app/.dev.vars'),'utf8')).split('\n').find(l=>l.startsWith('ANTHROPIC_API_KEY='));
const key=line?.slice(line.indexOf('=')+1).trim().replace(/^["']|["']$/g,'');
if(!key)throw Error('API key not configured');
const todo=[];
for(const q of questions){
 const path=resolve(root,`data/explanations/${q.id}.json`);
 if(q.subject==='자연과학개론'||!await exists(path)||await exists(resolve(out,`${q.id}.json`)))continue;
 const ex=JSON.parse(await readFile(path,'utf8'));
 const missing=ex.basis.map((b,i)=>({basisIndex:i,choice:b.choice,kind:b.kind,reference:b.ref})).filter(b=>b.kind==='precedent'&&!ex.basis[b.basisIndex].evidenceId);
 if(missing.length)todo.push({question:q,explanation:ex,unmatched:missing});
}
const system=`법률 기출 해설의 판례 출처를 찾기 위한 검색 후보를 제안합니다. 도구가 없으므로 원문을 조회하거나 검증했다고 주장하지 마세요.
주어진 unmatched 항목 각각에 대해 실제로 알고 있는 사건번호 후보만 최대 2개 제안하세요. 모르면 빈 배열을 반환하고, 핵심 사실관계와 법리를 검색할 짧고 구체적인 한국어 검색어를 적으세요. 사건번호를 지어내거나 비슷한 번호로 채우지 마세요. 시험 이후 판례는 제외하세요.
JSON만 반환: {"id":"문제id","matches":[{"basisIndex":0,"caseNumbers":["92도3234"],"query":"구체적 사실관계 검색어","reason":"해당 선지와 연결되는 법리"}]}. 이 결과는 후보이며 실제 판결문 확인 전에는 근거로 사용하지 않습니다.`;
console.log(JSON.stringify({eligible:todo.length,requested:Math.min(todo.length,limit),mode:'unverified-candidates'}));
let failures=0;
for(const input of todo.slice(0,limit)){
 if(await exists(resolve(root,'work/evidence.stop')))break;
 try{
  const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',signal:AbortSignal.timeout(240000),headers:{'content-type':'application/json','anthropic-version':'2023-06-01','x-api-key':key},body:JSON.stringify({model:'claude-opus-5-5',max_tokens:5000,system,messages:[{role:'user',content:JSON.stringify(input)}]})});
  const result=await response.json();if(!response.ok)throw Error(`HTTP ${response.status}: ${result.error?.type}`);
  if(result.stop_reason!=='end_turn')throw Error(`Incomplete: ${result.stop_reason}`);
  const raw=result.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
  const data=JSON.parse(raw);
  if(data.id!==input.question.id||!Array.isArray(data.matches))throw Error('Invalid response');
  const expected=input.unmatched.map(x=>x.basisIndex).sort((a,b)=>a-b);
  const actual=data.matches.map(x=>x.basisIndex).sort((a,b)=>a-b);
  if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Missing or duplicate matches');
  if(data.matches.some(m=>!Array.isArray(m.caseNumbers)||typeof m.query!=='string'))throw Error('Invalid candidates');
  await writeFile(resolve(out,`${data.id}.json`),JSON.stringify({...data,status:'unverified',model:result.model,usage:result.usage},null,2)+'\n');
  console.log(JSON.stringify({id:data.id,matches:data.matches.length,candidates:data.matches.reduce((n,m)=>n+m.caseNumbers.length,0)}));
 }catch(e){console.log(JSON.stringify({id:input.question.id,error:e.message}));if(++failures>=3)break;}
}
if(failures)process.exitCode=1;
