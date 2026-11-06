import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as logic from "./logic.js";
import * as radar from "./radar.js";

// Exercise the actual screen handlers with browser storage and DOM boundaries stubbed.
const storage = new Map();
const listeners = {};
const app = { innerHTML: "" };
let explanationLoads = 0;
let dialogClosed = 0;
const ctx = vm.createContext({
  ...logic, ...radar, console, Date, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
  document: {
    getElementById: (id) => id === "app" ? app : id === "confirm" ? { close: () => dialogClosed++ } : null,
    addEventListener: (type, fn) => { listeners[type] = fn; },
  },
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
  location: { hash: "#exam" }, history: { pushState() {}, replaceState() {} },
  innerHeight: 768, innerWidth: 1024, scrollY: 0, scrollTo() {}, requestAnimationFrame() {}, addEventListener() {}, visualViewport: null,
  explanationLoaded: () => explanationLoads++,
});
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8")
  .replace(/^import\s*\{[\s\S]*?from "\.\/logic\.js";/, "")
  .replace(/import \{ RADAR_PARTS, radarViews, radarFace \} from "\.\/radar\.js";/, "")
  .replaceAll("import.meta.env.PROD", "false")
  .replace(/boot\(\)\.catch\(bootFailure\);\s*$/, "");
vm.runInContext(source, ctx);
const run = (code) => vm.runInContext(code, ctx);
run("const originalShell = shell;");
run(`
  questions = [
    {id: 'b', year: 2025, round: 62, subject: '민법개론', number: 2, stem: 'B', choices: ['a','b','c','d','e'], answer: [2]},
    {id: 'a', year: 2025, round: 62, subject: '민법개론', number: 1, stem: 'A', choices: ['a','b','c','d','e'], answer: [1]},
    {id: 'other', year: 2024, round: 61, subject: '민법개론', number: 1, choices: [], answer: [1]}
  ];
  byId = new Map(questions.map(q => [q.id, q]));
  save = () => {};
  loadExplain = () => explanationLoaded();
  shell = (tab, body) => { app.innerHTML = body; };
  exam();
`);
assert.match(app.innerHTML, /기출 모의고사/);
assert.doesNotMatch(app.innerHTML, /실전 모의고사|연도 회차별 풀기|data-act="mock"/);
assert.match(app.innerHTML, /aria-haspopup="dialog"/);
assert.doesNotMatch(app.innerHTML, /<select/);
await run("ACTIONS['round-select']({year: '2024'});");
assert.match(app.innerHTML, /data-act="round" data-year="2024"/);
assert.doesNotMatch(app.innerHTML, /data-act="round" data-year="2025"/);
run("exam();");
assert.match(app.innerHTML, /data-act="round" data-year="2024"/);
run(`ACTIONS['round-start']({year: '2025', subject: '민법개론'});`);
assert.equal(run("session.mode"), "mock");
assert.equal(run("session.ids.join(',')"), "a,b");
assert.equal(run("session.orders.get('a').join(',')"), "0,1,2,3,4");
assert.doesNotMatch(app.innerHTML, /정답 확인|해설|class="mark"/);
listeners.change({ target: { name: "c", value: "1", closest: () => ({ classList: { add() {} } }) } });
listeners.change({ target: { name: "c", value: "0", closest: () => ({ classList: { add() {} } }) } });
assert.equal(run("session.picks.a"), 0);
assert.equal(run("state.log.length"), 0);
run("submitMock(); submitMock();");
assert.equal(run("state.log.length"), 2, "submission must only grade once");
assert.equal(run("session.score"), 1);
assert.equal(run("state.log[1].ok"), false, "unanswered questions count as wrong");
assert.match(app.innerHTML, /50점/);
assert.match(app.innerHTML, /미응답/);
assert.match(app.innerHTML, /data-act="mock-review"/);
run("openMockReview(1);");
assert.equal(explanationLoads, 1);
assert.match(app.innerHTML, /aria-label="해설"/);
assert.match(app.innerHTML, /disabled/);
listeners.change({ target: { name: "c", value: "1", closest: () => ({ classList: { add() {} } }) } });
assert.equal(run("session.picks.b"), undefined, "review cannot change submitted answers");
run("commit(); ACTIONS['mock-review-move']({delta: '-1'}); commit();");
assert.equal(run("state.log.length"), 2, "review must not record more attempts");
run("session = null; resume();");
assert.equal(run("session.mode"), "mock-review");
assert.equal(run("session.revealed"), true);
run("ACTIONS['mock-result'](); commit(); session = null; resume(); commit();");
assert.equal(run("state.log.length"), 2, "leaving restored results must not record attempts");
assert.equal(run("session.mode"), "mock-result");
assert.match(app.innerHTML, /50점/);
run(`ACTIONS['round-start']({year: '2025', subject: '민법개론'}); session.deadline = 0; mockClock(); mockClock();`);
assert.equal(run("session.mode"), "mock-result");
assert.equal(run("state.log.length"), 4, "timeout grades all questions once");
assert.ok(dialogClosed >= 2, "timeout closes submission/abandon confirmation");
// Direct selection and cycling share immediate rendering without skeleton delays.
const attributes = new Map();
const radarCard = { innerHTML: "", setAttribute: (k, v) => attributes.set(k, v) };
const radarStatus = { textContent: "" };
ctx.document.getElementById = (id) => id === "radar-card" ? radarCard : id === "radar-status" ? radarStatus : null;
ctx.document.querySelectorAll = () => [];
for (const title of ["산업재산권법", "민법개론", "자연과학개론", "전체"]) {
  run("ACTIONS['radar-next']()");
  assert.ok(radarStatus.textContent.startsWith(title));
  assert.match(radarCard.innerHTML, /content-enter/);
  assert.doesNotMatch(radarCard.innerHTML, /skeleton/);
}
run("ACTIONS['radar-select']({index: '2'})");
assert.equal(run("radarIndex"), 2);
const unchanged = radarCard.innerHTML;
run("ACTIONS['radar-select']({index: '2'})");
assert.equal(radarCard.innerHTML, unchanged);
console.log("mock flow and radar interaction ok");

// The initial route marks Home in the markup, without a separately positioned highlight.
run("location.hash = ''; countUp = () => {}; originalShell('home', '');");
assert.match(app.innerHTML, /data-tab="home" aria-current="page"/);
assert.doesNotMatch(app.innerHTML, /class="pill"/);
run("location.hash = '#stats'; originalShell('stats', '');");
assert.match(app.innerHTML, /data-tab="stats" aria-current="page"/);
assert.equal((app.innerHTML.match(/aria-current="page"/g) ?? []).length, 1);
console.log("navigation selection ok");

// Initial and repeat tab visits share one animation; same-page updates stay still.
run("lastTab = null; location.hash = '#home'; originalShell('home', '');");
assert.match(app.innerHTML, /shell page-enter/);
run("location.hash = '#exam'; originalShell('exam', '');");
assert.match(app.innerHTML, /shell page-enter/);
run("location.hash = '#home'; originalShell('home', '');");
assert.match(app.innerHTML, /shell page-enter/);
run("originalShell('home', '');");
assert.doesNotMatch(app.innerHTML, /page-enter/);
ctx.document.startViewTransition = () => { throw new Error('Tab navigation must not stack view transitions'); };
let reloads = 0;
ctx.location.reload = () => reloads++;
run("updatePending = true; session = { mode: 'mock' }; render();");
assert.equal(reloads, 0, "updates do not interrupt solving");
run("session = null; render();");
assert.equal(reloads, 1, "pending update applies after leaving the session");
run("updatePending = false;");
run("session = null; solveClosed = false; render = () => {}; paint();");
console.log("consistent tab motion ok");

// Empty notebooks still expose every standard subject and topic, with safe zero counts.
run("state = emptyState(); notes();");
for (const [subject, parts] of Object.entries(radar.RADAR_PARTS)) {
  run(`notesSubject = ${JSON.stringify(subject)}; notes();`);
  assert.ok(app.innerHTML.includes(subject));
  for (const part of parts) assert.ok(app.innerHTML.includes(part));
}
assert.doesNotMatch(app.innerHTML, /NaN|Infinity|data-act="review-all"/);
assert.match(app.innerHTML, /0문제/);
run("notes(['민법개론', '물권법']);");
assert.match(app.innerHTML, /복습 문항 없음/);
assert.doesNotMatch(app.innerHTML, /data-act="topic-review"/);
console.log("empty notebook topics ok");

assert.equal(run("notesSubject"), "민법개론", "detail preserves selected subject");
const toastNode = { textContent: "", classList: { add() {}, remove() {} } };
ctx.document.getElementById = (id) => id === "toast" ? toastNode : null;
ctx.clearTimeout = () => {};
ctx.setTimeout = () => 1;
const htmlBeforeToast = app.innerHTML;
run("ACTIONS['notes-empty']();");
assert.equal(toastNode.textContent, "등록된 오답이 없어요");
assert.equal(app.innerHTML, htmlBeforeToast, "empty topic leaves the screen intact");
run(`questions[0].topic = '물권법'; state.log = [{ id: 'b', ok: false, t: Date.now() }]; notes();`);
assert.match(app.innerHTML, /오늘 <strong>1<\/strong>/);
assert.match(app.innerHTML, /전체 1/);
assert.match(app.innerHTML, /a href="#notes\//);
assert.match(app.innerHTML, /data-act="notes-empty"/);
assert.doesNotMatch(app.innerHTML, /class="meter"/);
console.log("notebook counts and empty toast ok");

// Calendar changes update only the calendar; summaries count attempts and distinct days.
const calendarBody = { innerHTML: "" };
const detailBody = { innerHTML: "" };
ctx.document.getElementById = (id) => id === "calendar-body" ? calendarBody : id === "record-detail" ? detailBody : null;
ctx.document.querySelector = () => null;
run("calendarMonth = '2026-01'; selectedRecordDay = '2026-01-31'; ACTIONS.month({delta: '-1'});");
assert.equal(run("calendarMonth"), '2025-12');
assert.equal(run("selectedRecordDay"), '2025-12-01');
assert.equal(radarCard.innerHTML, unchanged, 'month changes leave radar untouched');
assert.match(calendarBody.innerHTML, /data-act="record-day"/);
assert.match(calendarBody.innerHTML, /풀이 횟수/);
run("ACTIONS['record-day']({day: '2025-12-02'});");
assert.match(detailBody.innerHTML, /이날은 학습 기록이 없어요/);
assert.equal(run("recordSummary([{t: Date.now(), ok:true}, {t:Date.now(),ok:false}]).rate"), '50%');
assert.equal(run("recordSummary([{t: Date.now(), ok:true}, {t:Date.now(),ok:false}]).days"), 1);
assert.equal(run("recordSummary([]).rate"), '기록 없음');
run("stats();");
assert.match(app.innerHTML, /최근 7일/);
assert.match(app.innerHTML, /학습한 날/);
assert.match(app.innerHTML, /stats-layout/);
console.log("learning records summary and calendar ok");

const scrollCalls = [];
ctx.scrollTo = (...args) => scrollCalls.push(args);
ctx.scrollY = 700;
run("lastTab = '#stats'; location.hash = '#notes'; originalShell('notes', '');");
assert.deepEqual(scrollCalls, [[0, 0]], 'switching tabs always starts at the top');
run("location.hash = '#stats'; originalShell('stats', '');");
assert.deepEqual(scrollCalls.at(-1), [0, 0], 'returning to a tab never restores old offset');
const callsBeforeRefresh = scrollCalls.length;
run("originalShell('stats', '');");
assert.equal(scrollCalls.length, callsBeforeRefresh, 'same-page updates preserve scroll');
assert.equal(ctx.history.scrollRestoration, 'manual');
console.log("tab scroll reset ok");

const statsPanelNode = { innerHTML: "" };
ctx.document.getElementById = (id) => id === "stats-panel" ? statsPanelNode : null;
run("statsView = 'accuracy'; stats();");
assert.match(app.innerHTML, /id="radar-card"/);
assert.doesNotMatch(app.innerHTML, /id="calendar-body"/);
run("ACTIONS['stats-view']({view: 'calendar'});");
assert.match(statsPanelNode.innerHTML, /id="calendar-body"/);
assert.doesNotMatch(statsPanelNode.innerHTML, /id="radar-card"|stats-summary/);
assert.match(statsPanelNode.innerHTML, /content-enter/);
run("ACTIONS['stats-view']({view: 'accuracy'});");
assert.match(statsPanelNode.innerHTML, /id="radar-card"/);
assert.doesNotMatch(statsPanelNode.innerHTML, /id="calendar-body"/);
assert.deepEqual(scrollCalls.at(-1), [0, 0]);
console.log("single records view at a time ok");

// Feedback follows the displayed shuffled order, including multiple accepted answers.
run(`session = { picks: { test: 0 }, orders: new Map([['test', [2, 0, 4, 1, 3]]]), amb: false };`);
assert.match(run("answerFeedback({id:'test',answer:[1]},session).message"), /정답이에요/);
run("session.picks.test = 1;");
const wrongFeedback = run("answerFeedback({id:'test',answer:[1,5]},session)");
assert.match(wrongFeedback.message, /정답은 ②·③번이에요/);
assert.equal(wrongFeedback.ok, false);

run("session.picks.test = 0; session.amb = true;");
assert.equal(run("answerFeedback({id:'test',answer:[1]},session).ok"), true);
console.log("answer feedback mapping ok");

// Dedicated chat keeps the composer outside explanations and streams into the sheet.
const streamedText = { textContent: "" };
const chatMessages = { querySelector: () => streamedText, addEventListener() {}, innerHTML: '', scrollHeight: 100, scrollTop: 0, clientHeight: 100 };
const chatInput = { value: '왜 정답인가요?', disabled: false };
const chatSend = { disabled: false };
const chatDialog = { style: { setProperty() {} }, classList: { toggle() {} }, open: false, innerHTML: '', show() { this.open = true; this.modal = false; }, showModal() { this.open = true; this.modal = true; },
 querySelector(selector) { return selector === '.chat-messages' ? chatMessages : selector === 'textarea' ? chatInput : chatSend; } };
ctx.document.getElementById = (id) => id === 'ai-chat' ? chatDialog : null;
ctx.document.documentElement = { style: { setProperty() {} } };
ctx.TextDecoderStream = TextDecoderStream;
ctx.Response = Response;
run(`questions = [{id:'chat-q',year:2026,number:1,subject:'민법개론',choices:['a','b','c','d','e'],answer:[1]}]; byId = new Map(questions.map(q=>[q.id,q])); session={...blank(),mode:'daily',ids:['chat-q'],i:0,revealed:true,orders:new Map([['chat-q',[0,1,2,3,4]]]),picks:{'chat-q':0},explain:{summary:'요약',choices:['a','b','c','d','e']}};`);
assert.match(run('explainHtml(current())'), /AI 질문/);
assert.doesNotMatch(run('explainHtml(current())'), /data-form="ask"/);
run('openChat();');
assert.equal(chatDialog.open, true);
assert.equal(chatDialog.modal, false, "wide screens allow problem interaction");
assert.match(chatDialog.innerHTML, /data-form="ask"/);
assert.match(chatDialog.innerHTML, /2026년/);
run(`let askCalls=0; post=async()=>{askCalls++;return new Response('설명 답변');};`);
const submitEvent = { preventDefault() {}, target: { dataset: {form:'ask'}, querySelector: () => chatInput } };
const responsePending = listeners.submit(submitEvent);
assert.equal(run('session.asking'), true);
await listeners.submit(submitEvent);
await responsePending;
assert.equal(run('askCalls'), 1);
assert.equal(run('session.asking'), false);
assert.equal(run('session.chat[1].content'), '설명 답변');
assert.match(chatMessages.innerHTML, /설명 답변/);
assert.equal(chatSend.disabled, false);
assert.ok(storage.has('chat:chat-q'));
console.log('AI chat sheet and streaming ok');

// Multiple response chunks update the same text node without rebuilding message bubbles.
let messageRebuilds = 0;
let renderedMessages = chatMessages.innerHTML;
Object.defineProperty(chatMessages, 'innerHTML', { get: () => renderedMessages, set: (value) => { messageRebuilds++; renderedMessages = value; }, configurable: true });
ctx.ReadableStream = ReadableStream;
ctx.TextEncoder = TextEncoder;
run(`post = async () => new Response(new ReadableStream({start(controller) { for (const chunk of ['첫째 ', '둘째 ', '셋째 ', '넷째']) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); }}));`);
chatInput.value = '다시 설명해줘';
await listeners.submit(submitEvent);
assert.equal(streamedText.textContent, '첫째 둘째 셋째 넷째');
assert.equal(messageRebuilds, 3, 'only submission, reply creation and completion rebuild; chunks do not');
run('chatFollowBottom = false;');
chatMessages.scrollTop = 17;
run("paintChatReply({content:'이어지는 답변'}, 3);");
assert.equal(chatMessages.scrollTop, 17, 'reading earlier messages does not force a scroll');
console.log('stable streaming message updates ok');

chatDialog.close = function () { this.open = false; };
chatDialog.contains = () => false;
ctx.innerWidth = 768;
run('updateChatViewport()');
assert.equal(chatDialog.modal, true, 'portrait drawer makes background inert');
ctx.innerWidth = 1024;
run('updateChatViewport()');
assert.equal(chatDialog.modal, false, 'landscape restores interactive supporting pane');
assert.match(chatDialog.innerHTML, /data-form="ask"/, 'rotation preserves conversation DOM');
console.log('adaptive chat orientation ok');

// A short review session must not pull future-scheduled questions into today's queue.
chatDialog.open = false;
ctx.document.getElementById = () => null;
run(`
questions = [
 { id:'due',year:2025,round:62,number:1,subject:'민법개론',topic:'물권법',stem:'오늘 복습',choices:['a','b','c','d','e'],answer:[1]},
 { id:'future',year:2025,round:62,number:2,subject:'민법개론',topic:'물권법',stem:'다음 복습',choices:['a','b','c','d','e'],answer:[1]}
];
byId = new Map(questions.map(q=>[q.id,q]));
state = emptyState();
state.log = [
 {id:'due',ok:false,t:Date.now()-86400000*2},
 {id:'future',ok:false,t:Date.now()-86400000*2},
 {id:'future',ok:true,t:Date.now()-86400000}
];
ACTIONS['topic-review']({subject:'민법개론',topic:'물권법',due:'true'});
`);
assert.equal(run('session.ids.join(",")'),'due');
run(`ACTIONS['topic-review']({subject:'민법개론',topic:'물권법'});`);
assert.equal(run('session.ids.length'),2);
assert.match(app.innerHTML, /id="reveal-answer"[^>]*disabled/);
const answerButton = {disabled:true,textContent:''};
ctx.document.getElementById = id => id==='reveal-answer'?answerButton:null;
listeners.change({target:{name:'c',value:'0',closest:()=>({classList:{add(){}}})}});
assert.equal(answerButton.disabled,false);
// A response attached to the prior problem must not mutate a new problem's asking state.
run('const priorQuestionSession = session; session.asking = true; next();');
assert.equal(run('session === priorQuestionSession'),false);
assert.equal(run('session.asking'),false);
run('priorQuestionSession.asking = false; session.asking = true; priorQuestionSession.askError = true;');
assert.equal(run('session.asking'),true);
assert.equal(run('session.askError'),false);
console.log('persona review priority and question isolation ok');

run('notesFlagged([]);');
assert.match(app.innerHTML, /개정 의심으로 표시한 문제가 없어요/);
assert.match(app.innerHTML, /href="#notes"/);
