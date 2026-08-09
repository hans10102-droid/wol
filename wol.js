// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-brown; icon-glyph: magic;
const HOST = "hans10102.dns.army:88"
const BASE = "http://" + HOST
const START = BASE + "/start.asp"
const PASSWORD = "imhs514!"

// 단축어(백그라운드 확장)에서는 WebView.present()가 금지되어 있으므로
// Scriptable 앱으로 점프해서 이 스크립트를 다시 실행한다
if (!config.runsInApp) {
  const cb = new CallbackURL("scriptable:///run")
  cb.addParameter("scriptName", Script.name())
  cb.open()
  Script.complete()
  return
}

const wait = ms => new Promise(r => Timer.schedule(ms, false, r))

// start.asp를 직접 받아온다 (기존의 사전 loadURL + 1.5초 대기는 불필요해서 제거)
const req = new Request(START)
req.timeoutInterval = 15
let html
try {
  html = await req.loadString()
} catch (e) {
  const a = new Alert()
  a.title = "접속 실패"
  a.message = "공유기(" + HOST + ")에 연결할 수 없습니다.\n" + e
  a.addAction("확인")
  await a.present()
  Script.complete()
  return
}

// 팝업 전용 페이지를 단일 창에서 동작하도록 패치
html = html.split("redirectTopWindow();").join("/*disabled*/")
html = html.split("if(!opener)").join("if(false)")
html = html.split("top.location.replace").join("void")
html = html.split("top.location.href").join("void(0);var _x")
html = html.split("opener.document.Intro").join("document.Intro")
html = html.split("self.close();").join("/*noclose*/;")

// 원래 부모창(main.asp)에 있던 Intro 폼을 같은 페이지에 심는다
const introForm =
  '<form method="post" name="Intro" action="/goform/mcr_verifyLoginPasswd">' +
  '<input type="hidden" name="Password">' +
  '<input type="hidden" name="captchatext">' +
  '<input type="hidden" name="introPassword"></form>'
if (html.includes("</BODY>")) {
  html = html.replace("</BODY>", introForm + "</BODY>")
} else {
  html = html.replace("</body>", introForm + "</body>")
}

const wv = new WebView()
await wv.loadHTML(html, START)

const fill =
  '(function(){' +
  'var p=document.getElementById("Password");' +
  'if(!p) return "NO";' +
  'if(!p.value){' +
  'p.value=' + JSON.stringify(PASSWORD) + ';' +
  'p.dispatchEvent(new Event("input",{bubbles:true}));' +
  'p.dispatchEvent(new Event("change",{bubbles:true}));' +
  'var c=document.getElementById("captchatext");if(c)c.focus();' +
  '}' +
  'return "OK";' +
  '})();'

// loadHTML이 로드 완료까지 기다려주므로 보통 1회에 성공.
// 실패할 때만 짧게 재시도하고, 성공하면 즉시 종료 (기존: 무조건 15회 x 400ms = 6초)
for (let i = 0; i < 10; i++) {
  const r = await wv.evaluateJavaScript(fill, false)
  if (r === "OK") break
  await wait(200)
}

// ── 캡차(Code) 이미지 자동 인식(OCR) ─────────────────────────────
// Scriptable 자체엔 OCR이 없어서, 로그인 화면 WebView 안에서
// Tesseract.js(OCR 라이브러리)를 불러와 캡차 이미지를 읽어 Code 칸을 채운다.
// 페이지가 http라서 https CDN 로드는 mixed-content 차단 대상이 아니다.
// 인식 결과가 틀릴 수 있으므로 자동 로그인은 하지 않는다 — 눈으로 확인 후 로그인.
const ocr =
  'var completion = completion;' +
  '(async function(){' +
  'try{' +
  // 캡차 iframe(같은 오리진) 안의 이미지를 찾는다. 없으면 잠깐 기다렸다 재시도.
  'function findImg(){' +
  'var fr=document.getElementById("mcr_captcha");' +
  'if(!fr||!fr.contentDocument) return null;' +
  'return fr.contentDocument.querySelector("img");' +
  '}' +
  'var img=null;' +
  'for(var k=0;k<25;k++){img=findImg();' +
  'if(img&&(img.complete)&&(img.naturalWidth>0))break;' +
  'await new Promise(function(r){setTimeout(r,200);});img=null;}' +
  'if(!img){completion("NOIMG");return;}' +
  // OCR 엔진 로드(최초 1회, CDN)
  'if(!window.Tesseract){' +
  'await new Promise(function(res,rej){' +
  'var s=document.createElement("script");' +
  's.src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";' +
  's.onload=res;s.onerror=function(){rej(new Error("cdn"));};' +
  'document.head.appendChild(s);});}' +
  // 이미지를 캔버스로 옮겨 데이터URL 추출(같은 오리진이라 taint 없음)
  'var c=document.createElement("canvas");' +
  'c.width=img.naturalWidth;c.height=img.naturalHeight;' +
  'c.getContext("2d").drawImage(img,0,0);' +
  'var url=c.toDataURL("image/png");' +
  'var r=await Tesseract.recognize(url,"eng",' +
  '{tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"});' +
  'var t=(r.data.text||"").replace(/[^A-Za-z0-9]/g,"");' +
  'var cap=document.getElementById("captchatext");' +
  'if(cap&&t){cap.value=t;' +
  'cap.dispatchEvent(new Event("input",{bubbles:true}));' +
  'cap.dispatchEvent(new Event("change",{bubbles:true}));}' +
  'completion(t||"EMPTY");' +
  '}catch(e){completion("ERR:"+e);}' +
  '})();'

try {
  await wv.evaluateJavaScript(ocr, true)
} catch (e) {
  // OCR 실패해도 로그인 화면은 정상 표시 — Code만 직접 입력하면 됨
}

// 화면에 표시 — 채워진 Code를 확인/수정 후 로그인하면 됨.
// 창을 닫을 때까지 대기한 뒤 단축어에 즉시 완료를 알린다.
await wv.present(true)
Script.complete()
