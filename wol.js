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
    // 전처리: 4배 확대 → 그레이스케일 → Otsu 자동 이진화 → 미디언 필터로 가로줄 제거
    var SC=4, W=img.naturalWidth*SC, H=img.naturalHeight*SC;
    var c=document.createElement("canvas");
    c.width=W; c.height=H;
    var x=c.getContext("2d");
    x.imageSmoothingEnabled=true;
    x.drawImage(img,0,0,W,H);
    var id=x.getImageData(0,0,W,H), p=id.data;
    // 그레이스케일 + 히스토그램
    var gray=new Uint8ClampedArray(W*H), hist=new Array(256).fill(0);
    for(var j=0,q=0;j<p.length;j+=4,q++){
      var g=(p[j]*0.299+p[j+1]*0.587+p[j+2]*0.114)|0;
      gray[q]=g; hist[g]++;
    }
    // Otsu 임계값 자동 계산
    var total=W*H, sum=0;
    for(var t0=0;t0<256;t0++) sum+=t0*hist[t0];
    var sumB=0,wB=0,mx=0,thr=140;
    for(var t1=0;t1<256;t1++){
      wB+=hist[t1]; if(wB===0) continue;
      var wF=total-wB; if(wF===0) break;
      sumB+=t1*hist[t1];
      var mB=sumB/wB, mF=(sum-sumB)/wF, between=wB*wF*(mB-mF)*(mB-mF);
      if(between>mx){mx=between; thr=t1;}
    }
    // 이진화
    var bin=new Uint8ClampedArray(W*H);
    for(var q2=0;q2<total;q2++) bin[q2]=gray[q2]<thr?0:255;
    // 가로줄 추적 제거 — 선은 항상 중간을 가로지르므로 열마다 얇은 검은 조각 중
    // 이전 열의 선 위치와 이어지는 것만 지운다 (글자획과 겹친 두꺼운 부분은 유지).
    // c가 e로 읽히는 원인(선이 c의 트인 부분을 닫아버림)을 해결한다.
    var LT=SC*3, JUMP=SC*5, cy=-1;
    for(var cx=0;cx<W;cx++){
      var runs=[], y0=-1;
      for(var y=0;y<=H;y++){
        var b=(y<H)&&bin[y*W+cx]===0;
        if(b&&y0<0){y0=y;}
        else if(!b&&y0>=0){runs.push([y0,y-1]);y0=-1;}
      }
      var best=null,bd=1e9;
      for(var ri=0;ri<runs.length;ri++){
        var th=runs[ri][1]-runs[ri][0]+1;
        if(th>LT) continue;
        var ctr=(runs[ri][0]+runs[ri][1])/2;
        var d=(cy<0)?Math.abs(ctr-H/2):Math.abs(ctr-cy);
        if(d<bd){bd=d;best=runs[ri];}
      }
      if(best&&((cy<0&&bd<H/4)||(cy>=0&&bd<=JUMP))){
        for(var y2=best[0];y2<=best[1];y2++) bin[y2*W+cx]=255;
        cy=(best[0]+best[1])/2;
      }
    }
    // 3x3 미디언 필터 — 남은 잔여물 정리, 굵은 글자획 유지
    var out=new Uint8ClampedArray(W*H);
    for(var yy=0;yy<H;yy++){
      for(var xx=0;xx<W;xx++){
        var black=0,cnt=0;
        for(var dy=-1;dy<=1;dy++){
          var ny=yy+dy; if(ny<0||ny>=H) continue;
          for(var dx=-1;dx<=1;dx++){
            var nx=xx+dx; if(nx<0||nx>=W) continue;
            cnt++; if(bin[ny*W+nx]===0) black++;
          }
        }
        out[yy*W+xx]=(black*2>cnt)?0:255;
      }
    }
    for(var q3=0,o=0;q3<total;q3++,o+=4){
      var vv=out[q3]; p[o]=p[o+1]=p[o+2]=vv; p[o+3]=255;
    }
    x.putImageData(id,0,0);
    // 한 줄 단어 인식(PSM 7) + 글자 화이트리스트
    var worker=await Tesseract.createWorker("eng");
    await worker.setParameters({
      tessedit_pageseg_mode:"7",
      tessedit_char_whitelist:"abcdefghijklmnopqrstuvwxyz"
    });
    var r=await worker.recognize(c,{},{blocks:true,text:true});
    await worker.terminate();
    // i/j 보정: 위쪽 모양이 같아 혼동되지만 j만 기준선 아래로 꼬리가 내려간다.
    // 글자별 바운딩박스의 바닥(y1)을 기준선(중앙값)과 비교해 강제로 구분한다.
    var t="", syms=[];
    try{
      (r.data.blocks||[]).forEach(function(b){
        (b.paragraphs||[]).forEach(function(pg){
          (pg.lines||[]).forEach(function(ln){
            (ln.words||[]).forEach(function(wd){
              (wd.symbols||[]).forEach(function(sy){syms.push(sy);});
            });
          });
        });
      });
    }catch(_){}
    if(syms.length){
      var bots=syms.map(function(s){return s.bbox.y1;}).sort(function(a,b){return a-b;});
      var base=bots[Math.floor((bots.length-1)/2)];
      var DESC=SC*2;
      t=syms.map(function(s){
        var ch=(s.text||"").toLowerCase();
        if(ch==="i"&&s.bbox.y1>base+DESC) ch="j";
        else if(ch==="j"&&s.bbox.y1<=base+DESC) ch="i";
        return ch;
      }).join("");
    }else{
      t=r.data.text||"";
    }
    t=t.toLowerCase().replace(/[^a-z]/g,"");
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
