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
// 이 스크립트는 페이지에 심자마자 즉시 반환하고, 인식 작업은 페이지 안에서
// 백그라운드로 진행된다 (present와 동시에 Scriptable API를 쓰면 화면이 깨짐)
const ocr = `
(async function(){
  // 화면 맨 위 상태 표시줄: 회색=진행중, 초록=성공, 빨강=실패
  function status(msg, ok){
    var d=document.getElementById("__ocr_status");
    if(!d){
      d=document.createElement("div");
      d.id="__ocr_status";
      d.style.cssText="position:fixed;top:0;left:0;right:0;z-index:9999;padding:8px;text-align:center;font-size:15px;color:#fff;background:#666;";
      document.body.appendChild(d);
    }
    d.textContent=msg;
    d.style.background = ok===true ? "#2e7d32" : (ok===false ? "#c62828" : "#666");
  }
  try{
    status("캡차 자동인식 준비중...");
    var img=null;
    for(var k=0;k<25;k++){
      var fr=document.getElementById("mcr_captcha");
      var doc=fr&&fr.contentDocument;
      var i=doc&&doc.querySelector("img");
      if(i&&i.complete&&i.naturalWidth>0){img=i;break;}
      await new Promise(function(r){setTimeout(r,200);});
    }
    if(!img){status("캡차 이미지를 못 찾음 — 직접 입력하세요",false);return;}
    if(!window.Tesseract){
      status("인식 엔진 내려받는 중 (최초 1회만 느림)...");
      await new Promise(function(res,rej){
        var s=document.createElement("script");
        s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
        s.onload=res;
        s.onerror=function(){rej(new Error("엔진 다운로드 실패(인터넷 확인)"));};
        document.head.appendChild(s);
      });
    }
    status("캡차 인식중...");
    // 전처리: 3배 확대 + 흑백 이진화 (줄무늬 캡차 인식률 향상)
    var c=document.createElement("canvas");
    var W=img.naturalWidth*3, H=img.naturalHeight*3;
    c.width=W; c.height=H;
    var x=c.getContext("2d");
    x.imageSmoothingEnabled=true;
    x.drawImage(img,0,0,W,H);
    var id=x.getImageData(0,0,W,H), p=id.data;
    for(var j=0;j<p.length;j+=4){
      var g=p[j]*0.299+p[j+1]*0.587+p[j+2]*0.114;
      var v=g<140?0:255;
      p[j]=p[j+1]=p[j+2]=v;
    }
    x.putImageData(id,0,0);
    var r=await Tesseract.recognize(c.toDataURL("image/png"),"eng");
    var t=(r.data.text||"").replace(/[^A-Za-z0-9]/g,"");
    var cap=document.getElementById("captchatext");
    if(t&&cap){
      cap.value=t;
      cap.dispatchEvent(new Event("input",{bubbles:true}));
      cap.dispatchEvent(new Event("change",{bubbles:true}));
      status("인식 결과: "+t+" — 맞는지 확인 후 로그인",true);
    }else{
      status("인식 실패 — Code를 직접 입력하세요",false);
    }
  }catch(e){
    status("인식 오류: "+((e&&e.message)||e)+" — 직접 입력하세요",false);
  }
})();
"STARTED"
`

try {
  await wv.evaluateJavaScript(ocr, false)
} catch (e) {
  // OCR 심기에 실패해도 로그인 화면은 그대로 사용 가능 — Code만 직접 입력하면 됨
}

// 화면 표시 — OCR은 페이지 안에서 진행되고 상태줄로 보인다.
// 창을 닫을 때까지 대기한 뒤 단축어에 즉시 완료를 알린다.
await wv.present(true)
Script.complete()
