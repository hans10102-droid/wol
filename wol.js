// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-brown; icon-glyph: magic;
const HOST = "hans10102.dns.army:88"
const BASE = "http://" + HOST
const START = BASE + "/start.asp"
const PASSWORD = "imhs514!"
const CODE_LEN = 6

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

// start.asp를 직접 받아온다
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
  '}' +
  'return "OK";' +
  '})();'

for (let i = 0; i < 10; i++) {
  const r = await wv.evaluateJavaScript(fill, false)
  if (r === "OK") break
  await wait(200)
}

// ── 캡차(Code) 자동 인식 ─────────────────────────────────────────
// 캡차 특성: (1) 영어 소문자만 (2) 글자 중앙을 선이 관통 (3) 구불구불
// 페이지 안에서 Tesseract.js로 인식한다. 심자마자 즉시 반환하고
// 실제 작업은 페이지 백그라운드로 진행된다(present와 겹치면 화면이 깨짐).
const ocr = `
(function(){
  if (window.__wolOcrLoaded) return "DUP";
  window.__wolOcrLoaded = true;

  var SC = 4;                  // 확대 배율
  var CODE_LEN = ` + CODE_LEN + `;
  var ALPHA = "abcdefghijklmnopqrstuvwxyz";
  var worker = null, busy = false;

  function status(msg, ok){
    var d = document.getElementById("__ocr_status");
    if(!d){
      d = document.createElement("div");
      d.id = "__ocr_status";
      d.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;padding:10px;" +
        "text-align:center;font-size:16px;font-weight:bold;color:#fff;background:#666;" +
        "font-family:-apple-system,BlinkMacSystemFont,sans-serif;";
      document.body.appendChild(d);
    }
    d.textContent = msg;
    d.style.background = ok === true ? "#2e7d32" : (ok === false ? "#c62828" : "#555");
  }

  function grabImg(){
    var fr = document.getElementById("mcr_captcha");
    var doc = fr && (fr.contentDocument || (fr.contentWindow && fr.contentWindow.document));
    if(!doc) return null;
    var im = doc.querySelector("img");
    if(im && im.complete && im.naturalWidth > 0) return im;
    return null;
  }

  async function waitImg(){
    for(var i=0;i<30;i++){
      var im = grabImg();
      if(im) return im;
      await new Promise(function(r){setTimeout(r,200);});
    }
    return null;
  }

  // ── 1) 확대 + 그레이스케일 ──────────────────────────────
  function toGray(img){
    var W = img.naturalWidth*SC, H = img.naturalHeight*SC;
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var cx = cv.getContext("2d");
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = "high";
    cx.drawImage(img, 0, 0, W, H);
    var d = cx.getImageData(0,0,W,H).data;
    var g = new Float32Array(W*H);
    for(var i=0,k=0;k<W*H;k++,i+=4) g[k] = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
    return {g:g, W:W, H:H};
  }

  // ── 2) Sauvola 적응형 이진화 ────────────────────────────
  // 전역 임계값(Otsu)은 연한 글자를 통째로 날려버린다(axovpm -> pm).
  // 국소 평균/표준편차로 픽셀마다 기준을 정해 연한 획도 살린다.
  function binarize(gr){
    var W=gr.W, H=gr.H, g=gr.g, S=W+1;
    var I=new Float64Array(S*(H+1)), I2=new Float64Array(S*(H+1));
    for(var y=0;y<H;y++){
      var rs=0, rs2=0;
      for(var x=0;x<W;x++){
        var v=g[y*W+x]; rs+=v; rs2+=v*v;
        I[(y+1)*S+(x+1)]  = I[y*S+(x+1)]  + rs;
        I2[(y+1)*S+(x+1)] = I2[y*S+(x+1)] + rs2;
      }
    }
    var r = Math.max(6, Math.round(H*0.35)), k = 0.22, R = 128;
    var bin = new Uint8Array(W*H);   // 1 = 글자(잉크), 0 = 배경
    for(var y2=0;y2<H;y2++){
      var y0=Math.max(0,y2-r), y1=Math.min(H-1,y2+r);
      for(var x2=0;x2<W;x2++){
        var x0=Math.max(0,x2-r), x1=Math.min(W-1,x2+r);
        var n=(x1-x0+1)*(y1-y0+1);
        var s  = I[(y1+1)*S+(x1+1)]  - I[y0*S+(x1+1)]  - I[(y1+1)*S+x0]  + I[y0*S+x0];
        var s2 = I2[(y1+1)*S+(x1+1)] - I2[y0*S+(x1+1)] - I2[(y1+1)*S+x0] + I2[y0*S+x0];
        var m = s/n, vr = Math.max(0, s2/n - m*m), sd = Math.sqrt(vr);
        var T = m * (1 + k*(sd/R - 1));
        bin[y2*W+x2] = g[y2*W+x2] < T ? 1 : 0;
      }
    }
    return bin;
  }

  // ── 3) 구불구불한 관통선 추적(동적계획법) ────────────────
  // 열마다 "얇은 잉크 조각"을 후보로 두고, 열을 건너가며 가장 매끄럽게
  // 이어지는 경로를 고른다. 글자획과 겹쳐 두꺼워진 구간은 후보에서 빠지고
  // 이전 위치를 물려받아(gap) 선을 놓치지 않는다.
  function traceLine(bin, W, H, ltMul){
    var LT = Math.max(2, Math.round(SC*ltMul));   // 선으로 볼 최대 두께
    var JUMP = Math.max(3, SC*2), GAP = JUMP*1.5;
    var back = new Array(W), prev = null;
    for(var x=0;x<W;x++){
      var runs=[], y0=-1, y;
      for(y=0;y<=H;y++){
        var ink = (y<H) && bin[y*W+x]===1;
        if(ink && y0<0) y0=y;
        else if(!ink && y0>=0){
          var th=y-y0;
          if(th<=LT) runs.push({a:y0,b:y-1,c:(y0+y-1)/2,t:th});
          y0=-1;
        }
      }
      var cur=[], i, j;
      var minPrev = Infinity;
      if(prev) for(j=0;j<prev.length;j++) if(prev[j].cost<minPrev) minPrev=prev[j].cost;
      for(i=0;i<runs.length;i++){
        var rr=runs[i], best=Infinity, bi=-1;
        if(prev){
          for(j=0;j<prev.length;j++){
            var d=Math.abs(rr.c-prev[j].y);
            if(d>JUMP*3) continue;
            var cst=prev[j].cost + d + rr.t*0.3;
            if(cst<best){best=cst;bi=j;}
          }
          if(bi<0) best = minPrev + GAP*2 + rr.t*0.3;
        } else {
          best = rr.t*0.3 + Math.abs(rr.c-H/2)*0.1;
        }
        cur.push({y:rr.c, cost:best, run:rr, from:bi});
      }
      if(prev){
        for(j=0;j<prev.length;j++) cur.push({y:prev[j].y, cost:prev[j].cost+GAP, run:null, from:j});
      }
      if(cur.length===0) cur.push({y:H/2, cost:0, run:null, from:-1});
      cur.sort(function(a,b){return a.cost-b.cost;});
      if(cur.length>8) cur = cur.slice(0,8);
      back[x]=cur; prev=cur;
    }
    var path=new Array(W), idx=0;
    for(var x3=W-1;x3>=0;x3--){
      var st = back[x3][idx] || back[x3][0];
      path[x3]=st;
      idx = st.from>=0 ? st.from : 0;
    }
    return path;
  }

  // ── 4) 선 제거(세로획은 보존) ───────────────────────────
  // 지우려는 조각의 위/아래로 잉크가 길게 이어지면 글자의 세로획이
  // 지나는 것이므로 남긴다 -> 글자가 두 동강 나서 사라지는 일을 막는다.
  // 반대로 c의 트인 부분처럼 위아래가 비어 있으면 지운다 -> c가 e로 안 읽힌다.
  function removeLine(bin, W, H, path, tol){
    var out = new Uint8Array(bin), x, y;
    var MARGIN = Math.max(2, Math.round(SC*2.5));

    // 선은 이미지 왼쪽 끝에서 오른쪽 끝까지 이어지므로 글자 사이 빈 곳을 반드시 지난다.
    // 그 구간(위아래가 비어 있는 곳)에서 선의 진짜 두께를 재둔다.
    var iso=[];
    for(x=0;x<W;x++){
      var r = path[x] && path[x].run;
      if(!r) continue;
      var up=0, dn=0;
      for(y=r.a-1; y>=0 && up<MARGIN; y--){ if(bin[y*W+x]===1) break; up++; }
      for(y=r.b+1; y<H  && dn<MARGIN; y++){ if(bin[y*W+x]===1) break; dn++; }
      if(up>=MARGIN && dn>=MARGIN) iso.push(r.t);
    }
    var t0;
    if(iso.length >= 8){
      iso.sort(function(a,b){ return a-b; });
      t0 = iso[(iso.length/2)|0];
    } else {
      t0 = Math.max(2, Math.round(SC*2));
    }

    // 선이 지나는 높이를 부드럽게 다듬는다(열마다 튀는 값을 평균내어 실제 곡선에 맞춘다)
    var ys=new Array(W), sm=new Array(W);
    for(x=0;x<W;x++) ys[x] = path[x] ? path[x].y : H/2;
    var R = Math.max(2, Math.round(W/40));
    for(x=0;x<W;x++){
      var s=0, n=0;
      for(var k=x-R;k<=x+R;k++){ if(k<0||k>=W) continue; s+=ys[k]; n++; }
      sm[x]=s/n;
    }

    // 획 전체를 지우지 않고 "선의 두께만큼"만 띠로 지운다.
    // 글자와 겹친 곳에서도 선 굵기 이상은 절대 사라지지 않는다.
    var half = (t0*tol)/2;
    for(x=0;x<W;x++){
      var a=Math.round(sm[x]-half), b=Math.round(sm[x]+half);
      if(a<0) a=0;
      if(b>=H) b=H-1;
      if(a>b) continue;
      // 띠 바로 위아래로 획이 이어지면 글자를 가로지른 것이므로 되살린다
      var above = (a-1>=0) && bin[(a-1)*W+x]===1;
      var below = (b+1<H)  && bin[(b+1)*W+x]===1;
      if(above && below) continue;
      for(y=a;y<=b;y++) out[y*W+x]=0;
    }
    return out;
  }

  // ── 5) 연결 성분 찾기 ───────────────────────────────────
  function comps(bin, W, H){
    var lab=new Uint8Array(W*H), st=new Int32Array(W*H), list=[];
    for(var s=0;s<W*H;s++){
      if(bin[s]!==1 || lab[s]) continue;
      var sp=0, px=[]; st[sp++]=s; lab[s]=1;
      var minx=1e9,maxx=-1,miny=1e9,maxy=-1;
      while(sp>0){
        var cur=st[--sp]; px.push(cur);
        var cx=cur%W, cy=(cur/W)|0;
        if(cx<minx)minx=cx; if(cx>maxx)maxx=cx;
        if(cy<miny)miny=cy; if(cy>maxy)maxy=cy;
        for(var dy=-1;dy<=1;dy++){
          for(var dx=-1;dx<=1;dx++){
            if(!dx && !dy) continue;
            var nx=cx+dx, ny=cy+dy;
            if(nx<0||nx>=W||ny<0||ny>=H) continue;
            var ni=ny*W+nx;
            if(bin[ni]===1 && !lab[ni]){ lab[ni]=1; st[sp++]=ni; }
          }
        }
      }
      list.push({px:px, x0:minx, x1:maxx, y0:miny, y1:maxy});
    }
    return list;
  }

  // 잔여 얼룩 제거(얇은 글자는 보존)
  // 미디언 필터는 l, x 같은 얇은 글자를 갉아먹으므로 쓰지 않고,
  // 연결된 덩어리의 크기를 재서 작은 것/납작한 조각만 지운다.
  function despeckle(bin, W, H){
    var out=new Uint8Array(bin), cs=comps(bin,W,H);
    var MINA=Math.round(SC*SC*3), MIND=Math.round(SC*3);
    var FLATH=Math.max(1,Math.round(SC*1.2)), FLATW=SC*8;
    for(var i=0;i<cs.length;i++){
      var c=cs[i], bw=c.x1-c.x0+1, bh=c.y1-c.y0+1;
      var tiny = (c.px.length<MINA && bw<MIND && bh<MIND);
      var flat = (bh<=FLATH && bw<=FLATW);
      if(tiny || flat){ for(var p=0;p<c.px.length;p++) out[c.px[p]]=0; }
    }
    return out;
  }

  // ── 5-2) 글자 단위로 자르기 ─────────────────────────────
  // 6글자인 것을 알고 있으므로 덩어리를 묶고 쪼개 정확히 6칸을 만든다.
  function segBoxes(bin, W, H){
    var cs = comps(bin, W, H);
    if(!cs.length) return [];
    var gs = cs.map(function(c){ return {x0:c.x0, x1:c.x1, y0:c.y0, y1:c.y1}; });
    gs.sort(function(a,b){ return a.x0-b.x0; });

    // x구간이 겹치는 조각끼리 합친다 (i의 점, 끊어진 획 등)
    var g=[], i;
    for(i=0;i<gs.length;i++){
      var cur=gs[i], last=g.length?g[g.length-1]:null;
      if(last){
        var ov = Math.min(last.x1,cur.x1) - Math.max(last.x0,cur.x0);
        var minw = Math.min(last.x1-last.x0, cur.x1-cur.x0) + 1;
        if(ov > minw*0.35){
          last.x0=Math.min(last.x0,cur.x0); last.x1=Math.max(last.x1,cur.x1);
          last.y0=Math.min(last.y0,cur.y0); last.y1=Math.max(last.y1,cur.y1);
          continue;
        }
      }
      g.push({x0:cur.x0,x1:cur.x1,y0:cur.y0,y1:cur.y1});
    }

    // 6개보다 많으면 가장 가까운 이웃끼리 합친다
    while(g.length > CODE_LEN){
      var bi=-1, bg=1e9;
      for(i=0;i+1<g.length;i++){
        var gap=g[i+1].x0-g[i].x1;
        if(gap<bg){ bg=gap; bi=i; }
      }
      if(bi<0) break;
      g[bi].x1=Math.max(g[bi].x1,g[bi+1].x1);
      g[bi].y0=Math.min(g[bi].y0,g[bi+1].y0);
      g[bi].y1=Math.max(g[bi].y1,g[bi+1].y1);
      g.splice(bi+1,1);
    }

    // 6개보다 적으면 가장 넓은 칸을 세로 잉크가 가장 적은 곳에서 쪼갠다
    while(g.length > 0 && g.length < CODE_LEN){
      var wi=0;
      for(i=1;i<g.length;i++) if((g[i].x1-g[i].x0)>(g[wi].x1-g[wi].x0)) wi=i;
      var b=g[wi], bw=b.x1-b.x0+1;
      if(bw < SC*6) break;
      var lo=b.x0+Math.round(bw*0.25), hi=b.x0+Math.round(bw*0.75), cut=-1, best=1e9;
      for(var x=lo;x<=hi;x++){
        var n=0;
        for(var y=b.y0;y<=b.y1;y++) if(bin[y*W+x]===1) n++;
        if(n<best){ best=n; cut=x; }
      }
      if(cut<0) break;
      g.splice(wi+1, 0, {x0:cut+1, x1:b.x1, y0:b.y0, y1:b.y1});
      b.x1=cut;
    }
    return g;
  }

  function cropCanvas(bin, W, H, b){
    var PAD=SC*5, bw=b.x1-b.x0+1, bh=b.y1-b.y0+1;
    var cv=document.createElement("canvas");
    cv.width=bw+PAD*2; cv.height=bh+PAD*2;
    var cx=cv.getContext("2d");
    cx.fillStyle="#fff"; cx.fillRect(0,0,cv.width,cv.height);
    var im=cx.createImageData(bw,bh), d=im.data;
    for(var y=0;y<bh;y++){
      for(var x=0;x<bw;x++){
        var v = bin[(b.y0+y)*W + (b.x0+x)]===1 ? 0 : 255;
        var o=(y*bw+x)*4; d[o]=d[o+1]=d[o+2]=v; d[o+3]=255;
      }
    }
    cx.putImageData(im,PAD,PAD);
    return cv;
  }

  // ── 6) 선 제거 강도별 정리본 만들기 ─────────────────────
  // 선 두께 기준을 하나로 정하면 어떤 캡차에서는 선이 남고 어떤 캡차에서는
  // 글자가 깎인다. 세 가지 강도로 만들어 뒤에서 서로 대조시킨다.
  function cleanAt(bin, W, H, tol){
    return despeckle(removeLine(bin, W, H, traceLine(bin, W, H, 4.5), tol), W, H);
  }

  function toCanvas(bin, W, H){
    var PAD=SC*5;
    var cv=document.createElement("canvas");
    cv.width=W+PAD*2; cv.height=H+PAD*2;
    var cx=cv.getContext("2d");
    cx.fillStyle="#fff"; cx.fillRect(0,0,cv.width,cv.height);
    var im=cx.createImageData(W,H), d=im.data;
    for(var i=0,k=0;k<W*H;k++,i+=4){
      var v = bin[k]===1 ? 0 : 255;
      d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
    }
    cx.putImageData(im,PAD,PAD);
    return cv;
  }

  // ── 7) 한 변형본 인식 + i/j 보정 ────────────────────────
  async function runOne(cv, psm){
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      tessedit_char_whitelist: ALPHA
    });
    var r = await worker.recognize(cv, {}, {blocks:true, text:true});
    var syms=[];
    try{
      (r.data.blocks||[]).forEach(function(b){
        (b.paragraphs||[]).forEach(function(pg){
          (pg.lines||[]).forEach(function(ln){
            (ln.words||[]).forEach(function(wd){
              (wd.symbols||[]).forEach(function(sy){ syms.push(sy); });
            });
          });
        });
      });
    }catch(e){}
    var chars=[], confs=[];
    if(syms.length){
      // i와 j는 윗부분이 같아 혼동된다. j만 기준선 아래로 꼬리가 내려가므로
      // 글자 바닥 위치의 중앙값을 기준선으로 삼아 강제로 구분한다.
      var bots=syms.map(function(s){return s.bbox.y1;}).sort(function(a,b){return a-b;});
      var base=bots[((bots.length-1)/2)|0], DESC=SC*2;
      syms.forEach(function(s){
        var ch=(s.text||"").toLowerCase().replace(/[^a-z]/g,"");
        if(!ch) return;
        if(ch==="i" && s.bbox.y1 > base+DESC) ch="j";
        else if(ch==="j" && s.bbox.y1 <= base+DESC) ch="i";
        chars.push(ch);
        confs.push(s.confidence||0);
      });
    } else {
      var t=(r.data.text||"").toLowerCase().replace(/[^a-z]/g,"");
      for(var i=0;i<t.length;i++){ chars.push(t.charAt(i)); confs.push(r.data.confidence||0); }
    }
    var avg = confs.length ? confs.reduce(function(a,b){return a+b;},0)/confs.length : 0;
    return {chars:chars, confs:confs, conf:avg, text:chars.join("")};
  }

  // ── 7-2) 글자 하나씩 잘라서 읽기 ────────────────────────
  // 통짜로 읽으면 글자 경계를 잘못 잡아 통째로 밀리는 실수가 나온다.
  // 6칸으로 잘라 한 글자씩 읽으면 그 실수가 사라진다.
  async function runSeg(bin, W, H){
    var boxes = segBoxes(bin, W, H);
    if(boxes.length !== CODE_LEN) return null;
    await worker.setParameters({
      tessedit_pageseg_mode: "10",
      tessedit_char_whitelist: ALPHA
    });
    var bots = boxes.map(function(b){ return b.y1; }).sort(function(a,b){ return a-b; });
    var base = bots[((bots.length-1)/2)|0], DESC = SC*2;
    var chars=[], confs=[];
    for(var i=0;i<boxes.length;i++){
      var r = await worker.recognize(cropCanvas(bin, W, H, boxes[i]), {}, {text:true});
      var t = (r.data.text||"").toLowerCase().replace(/[^a-z]/g,"");
      var ch = t.charAt(0);
      // 한 글자를 못 읽어도 그 자리만 기권시키고 나머지 자리는 투표에 참여시킨다
      if(!ch){ chars.push(""); confs.push(0); continue; }
      if(ch==="i" && boxes[i].y1 > base+DESC) ch="j";
      else if(ch==="j" && boxes[i].y1 <= base+DESC) ch="i";
      chars.push(ch);
      confs.push(r.data.confidence||0);
    }
    if(!chars.join("")) return null;
    var avg = confs.reduce(function(a,b){return a+b;},0)/confs.length;
    return {chars:chars, confs:confs, conf:avg, text:chars.join("")};
  }

  // ── 8) 여러 변형본의 결과를 자리별로 투표 ────────────────
  // 캡차는 항상 6글자이므로 6글자 후보만 모아 자리마다 신뢰도 가중 다수결.
  function vote(cands){
    var good = cands.filter(function(c){ return c.chars.length===CODE_LEN; });
    if(!good.length){
      cands.sort(function(a,b){
        var da=Math.abs(a.chars.length-CODE_LEN), db=Math.abs(b.chars.length-CODE_LEN);
        if(da!==db) return da-db;
        return b.conf-a.conf;
      });
      return cands.length ? cands[0].text : "";
    }
    var out="";
    for(var i=0;i<CODE_LEN;i++){
      var score={}, bestc="", bs=-1, j, ch, w;
      for(j=0;j<good.length;j++){
        ch=good[j].chars[i];
        if(!ch) continue;                 // 기권한 자리는 건너뛴다
        w=(good[j].confs[i]||1) + good[j].conf*0.5;
        score[ch]=(score[ch]||0)+w;
      }
      for(var k in score) if(score[k]>bs){ bs=score[k]; bestc=k; }
      out+=bestc;
    }
    return out;
  }

  function setCode(t){
    var cap=document.getElementById("captchatext");
    if(!cap) return;
    cap.value=t;
    cap.dispatchEvent(new Event("input",{bubbles:true}));
    cap.dispatchEvent(new Event("change",{bubbles:true}));
  }

  async function recognize(){
    if(busy) return;
    busy = true;
    try{
      status("캡차 준비중...");
      var img = await waitImg();
      if(!img){ status("캡차 이미지를 찾지 못함 — 직접 입력하세요", false); return; }

      if(!window.Tesseract){
        status("인식 엔진 내려받는 중 (최초 1회만 느림)...");
        await new Promise(function(res,rej){
          var s=document.createElement("script");
          s.src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
          s.onload=res;
          s.onerror=function(){ rej(new Error("엔진 다운로드 실패(인터넷 확인)")); };
          document.head.appendChild(s);
        });
      }
      if(!worker){
        status("인식 엔진 준비중...");
        worker = await Tesseract.createWorker("eng");
      }

      status("이미지 정리중...");
      var gr = toGray(img);
      var bin = binarize(gr);
      // 지우는 띠의 폭을 달리한 네 가지 정리본. 얇게 지우면 선이 남고 두껍게
      // 지우면 글자가 상하는데, 어느 쪽이 유리한지는 캡차마다 달라서 함께 읽힌다.
      var thin = cleanAt(bin, gr.W, gr.H, 0.8);
      var mid  = cleanAt(bin, gr.W, gr.H, 1.4);
      var jobs = [
        [toCanvas(thin, gr.W, gr.H), "7"],
        [toCanvas(cleanAt(bin, gr.W, gr.H, 1.1), gr.W, gr.H), "8"],
        [toCanvas(mid, gr.W, gr.H), "7"],
        [toCanvas(cleanAt(bin, gr.W, gr.H, 2.4), gr.W, gr.H), "7"]
      ];
      var cands=[], total=jobs.length+1;
      for(var i=0;i<jobs.length;i++){
        status("인식중... (" + (i+1) + "/" + total + ")");
        try{
          var c = await runOne(jobs[i][0], jobs[i][1]);
          if(c.chars.length) cands.push(c);
        }catch(e){}
      }
      // 6칸으로 잘라 한 글자씩 읽은 결과도 후보에 넣는다
      status("인식중... (" + total + "/" + total + ")");
      try{
        var sc = await runSeg(mid, gr.W, gr.H);
        if(sc) cands.push(sc);
      }catch(e){}

      var t = vote(cands);
      if(t){
        setCode(t);
        var sure = cands.filter(function(c){return c.text===t;}).length;
        status("인식 결과: " + t + (sure>=2 ? " (일치 " + sure + "회)" : " (확인 권장)"), true);
      } else {
        status("인식 실패 — Code를 직접 입력하세요", false);
      }
    }catch(e){
      status("인식 오류: " + ((e && e.message) || e) + " — 직접 입력하세요", false);
    }finally{
      busy = false;
    }
  }

  // 새로고침으로 캡차를 바꾸면 자동으로 다시 인식한다
  var fr = document.getElementById("mcr_captcha");
  if(fr) fr.addEventListener("load", function(){ setTimeout(recognize, 400); });

  recognize();
  return "STARTED";
})();
`

try {
  await wv.evaluateJavaScript(ocr, false)
} catch (e) {
  // OCR을 못 심어도 로그인 화면은 그대로 사용 가능 — Code만 직접 입력하면 됨
}

// 화면 표시 — OCR 진행 상황은 상단 상태줄로 보인다.
await wv.present(true)
Script.complete()
