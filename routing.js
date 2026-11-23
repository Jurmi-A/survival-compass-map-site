(() => {
  'use strict';
  const api=window.DURU, core=window.DURU_WALK_CORE, index=window.DURU_WALK_INDEX;
  if(!api||!core||!index)return;
  const $=id=>document.getElementById(id), esc=api.escapeHtml, KEY='survival-avoid-zones-v1', WALK_CACHE='walk-data-v2';
  const native=!!window.DURU_ANDROID, standalone=window.IS_STANDALONE&&!native;
  const availableTile=key=>standalone?index.tileRegion[key]==='seoul':!!index.tileRegion[key];
  const supported=typeof DecompressionStream==='function'&&!!crypto.subtle;
  const MAX_ROUTE=40000; // straight-line limit; longer trips are split into legs by the user
  let start=null,goal=null,result=null,zones=[],storageError='',rawZones=null,backupRequested=false,sessionOnly=false,busy=false,routeRun=0;
  // ---- Nationwide walking data: one script per province, loaded on demand and verified against walk-index.js ----
  const regionById=new Map(index.regions.map(r=>[r.id,r])),packs=new Map(),pending=new Map(),tiles=new Map();
  const fileUrl=r=>new URL(r.file,location.href).href;
  window.DURU_WALK_PACK=(id,b64)=>{const p=pending.get(id);if(p)p.resolve(b64);};
  function loadScript(file){return new Promise((ok,no)=>{const el=document.createElement('script');el.src='./'+file;el.async=true;el.onload=()=>{el.remove();ok();};el.onerror=()=>{el.remove();no(Error('load'));};document.head.append(el);});}
  async function sha(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');}
  async function verifyPack(r,b64){
    const bin=atob(b64),bytes=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
    if(await sha(bytes)!==r.sha256)throw Error(`${r.label} 도보 자료가 배포본과 다릅니다.`);
    const data=core.readPack(bytes);
    if(data.region!==r.id)throw Error('다른 지역 자료입니다.');
    return data;
  }
  async function parsePackResponse(r,response){
    if(!response.ok)throw Error(`${r.label} 도보 자료를 불러오지 못했습니다.`);
    const prefix=`DURU_WALK_PACK("${r.id}","`,suffix='");',text=(await response.text()).trimEnd();
    if(!text.startsWith(prefix)||!text.endsWith(suffix))throw Error(`${r.label} 도보 자료 형식이 올바르지 않습니다.`);
    return verifyPack(r,text.slice(prefix.length,-suffix.length));
  }
  async function webPack(r,requireSave){
    const url=fileUrl(r);
    const cache=await window.caches?.open(WALK_CACHE).catch(()=>null);
    if(requireSave&&!cache)throw Error('이 브라우저에 자료를 저장할 수 없습니다.');
    const saved=await cache?.match(url).catch(()=>null);
    if(saved){
      try{return await parsePackResponse(r,saved);}
      catch(_){await cache.delete(url).catch(()=>{});}
    }
    let response;
    try{response=await fetch(url,{cache:'no-store',redirect:'error'});}
    catch(_){throw Error(`${r.label} 도보 자료를 아직 쓸 수 없습니다. 인터넷에 연결한 뒤 받아 주세요.`);}
    const data=await parsePackResponse(r,response.clone());
    try{await cache?.put(url,response);}
    catch(_){if(requireSave)throw Error('저장 공간을 확인한 뒤 다시 받아 주세요.');}
    return data;
  }
  function pack(id){
    if(packs.has(id))return packs.get(id);
    const r=regionById.get(id);
    const job=(async()=>{
      if(standalone){
        if(id!=='seoul'||!window.DURU_EMBEDDED_WALK)throw Error('이 HTML 파일에는 서울 자료만 있습니다.');
        return verifyPack(r,window.DURU_EMBEDDED_WALK);
      }
      if(!native)return webPack(r,false);
      const got=new Promise(resolve=>pending.set(id,{resolve}));
      try{await loadScript(r.file);}catch(_){pending.delete(id);throw Error(`${r.label} 도보 자료를 불러오지 못했습니다.`);}
      const b64=await Promise.race([got,new Promise((_,no)=>setTimeout(()=>no(Error(`${r.label} 도보 자료 형식이 올바르지 않습니다.`)),1000))]).finally(()=>pending.delete(id));
      return verifyPack(r,b64);
    })();
    packs.set(id,job);job.catch(()=>packs.delete(id));return job;
  }
  async function inflate(bytes){const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));return new Uint8Array(await new Response(stream).arrayBuffer());}
  function tile(key){
    if(tiles.has(key))return tiles.get(key);
    const id=index.tileRegion[key];if(!id)return Promise.resolve(null);
    const job=(async()=>{const p=await pack(id),[off,len]=p.tiles[key],[x,y]=key.split(',').map(Number);return core.decodeTile(await inflate(p.body.subarray(off,off+len)),x,y);})();
    tiles.set(key,job);job.catch(()=>tiles.delete(key));
    if(tiles.size>400)tiles.delete(tiles.keys().next().value);
    return job;
  }
  function regionsFor(keys){return [...new Set(keys.map(k=>index.tileRegion[k]).filter(Boolean))].map(id=>regionById.get(id));}
  let lastGraph=null;
  async function graphFor(keys){
    const directRegions=regionsFor(keys);
    keys=core.withEndpoints(keys,index.tileDependencies).filter(availableTile);
    if(lastGraph?.sig===keys.join(';'))return {graph:lastGraph.graph,missing:[]};
    const need=regionsFor(keys).filter(r=>!packs.has(r.id));
    if(need.length)status(`도보 자료 불러오는 중: ${need.map(r=>`${r.label} ${(r.bytes/1e6).toFixed(1)}MB`).join(', ')}…`);
    const loaded=[],loadedKeys=[],failures=new Map();
    const settlements=await Promise.allSettled(keys.map(tile));
    settlements.forEach((entry,i)=>{
      const key=keys[i];
      if(entry.status==='fulfilled'){
        loaded.push(entry.value);loadedKeys.push(key);
      }else{
        failures.set(index.tileRegion[key],entry.reason);
      }
    });
    const sig=loadedKeys.join(';');
    const graph=lastGraph?.sig===sig?lastGraph.graph:core.buildGraph(loaded);
    lastGraph={sig,graph};
    const missingRegions=new Set([...directRegions.map(r=>r.id),...failures.keys()]);
    const missing=[...missingRegions].filter(id=>failures.has(id)).map(id=>({label:regionById.get(id).label,message:failures.get(id).message}));
    return {graph,missing};
  }
  function missingMessage(missing){
    const labels=missing.map(r=>r.label).join('·');
    return `${missing[0].message} 오프라인 메뉴에서 ${labels} 자료를 확인하세요.`;
  }
  const dialog=document.createElement('dialog');dialog.id='routeDialog';dialog.className='modal routing-modal';
  dialog.innerHTML=`<div class="modal-card"><div class="modal-header"><div><span class="eyebrow">${standalone?'파일에 포함된 서울 자료':'전국 · 인터넷 없이도 계산'}</span><h2>도보 길찾기</h2></div><button id="routeClose" class="icon-button" aria-label="길찾기 닫기">×</button></div>
    <p class="routing-caution">거리 기준 참고 경로입니다. 현장 통행·안전 여부는 확인되지 않았습니다. 공식 대피 지시와 현장 통제를 우선하세요. 차량·휠체어 길찾기는 지원하지 않습니다.</p>
    <p class="small-note">자료: © OpenStreetMap contributors · ${esc(index.osmTimestamp||'시각 모름')} · ODbL. ${native?'앱에 전국 도보 자료가 들어 있습니다.':standalone?'이 HTML에는 서울 자료만 들어 있습니다.':'지역 자료를 오프라인 메뉴에서 미리 받을 수 있습니다.'} 직선 ${MAX_ROUTE/1000}km까지 계산합니다.</p>
    <p class="small-note">지도에서 도로 지점을 누른 뒤 장소 정보의 ‘도보 출발점’ 또는 ‘도보 목적지’를 선택하세요. 아래 버튼은 현재 선택한 위치를 사용합니다.</p>
    <div class="route-endpoints"><p id="routeStart"></p><p id="routeGoal"></p></div>
    <div class="action-row"><button id="routeSetStart" class="secondary-button">선택 위치 → 출발점</button><button id="routeSetGoal" class="secondary-button">선택 위치 → 목적지</button></div>
    <button id="routeGps" class="secondary-button wide">수신한 GPS로 출발점 후보 찾기</button>
    <section id="routeCandidate" hidden><p id="routeCandidateText"></p><button id="routeAccept" class="primary-button wide">이 도로 지점 사용</button></section>
    <button id="routeCalculate" class="primary-button wide">도보 경로 계산</button>
    <p id="routeStatus" role="status" aria-live="polite">출발점과 목적지를 지정하세요.</p>
    <div class="action-row"><button id="routeView" class="secondary-button">경로 지도에서 보기</button><button id="routeClear" class="link-button">경로 지우기</button></div>
    <details><summary>직접 지정한 회피 구역 <span id="routeZoneCount"></span></summary><p class="small-note">공식 통제 정보가 아닙니다. 직접 지정한 원 안을 통과하지 않도록 계산하며, 시간이 지나도 자동 해제하지 않습니다.</p>
    <label class="stacked-label">회피 반경<select id="routeRadius"><option value="50">50m</option><option value="100" selected>100m</option><option value="250">250m</option><option value="500">500m</option><option value="1000">1km</option></select></label>
    <button id="routeAddZone" class="secondary-button wide">선택 위치에 회피 구역 추가</button><div id="routeZones"></div></details>
    <p id="routeStorage" class="small-note"></p><section id="routeRecovery" hidden><button id="routeRawBackup" class="secondary-button wide">회피 구역 원문 백업</button><label class="sharing-toggle"><input id="routeRecoveryAgree" type="checkbox">원문을 보관했거나 읽을 수 없음을 확인했고, 기존 구역 없이 시작하는 데 동의합니다.</label><button id="routeRecover" class="secondary-button wide">이번 실행에서만 새로 시작</button></section></div>`;
  document.body.append(dialog);
  const button=$('routeOpen');
  const status=text=>{const el=$('routeStatus');el.textContent=text;if(dialog?.open)requestAnimationFrame(()=>el.scrollIntoView({block:'nearest'}));};
  function gpsAge(p){return window.DURU_MONOTONIC&&Number.isFinite(p.fixElapsedMs)?window.DURU_MONOTONIC()-p.fixElapsedMs:Date.now()-p.timestamp;}
  function freshGps(p){const age=gpsAge(p);return Number.isFinite(age)&&age>=0&&age<=300000&&Number.isFinite(p.accuracy)&&p.accuracy>=0&&p.accuracy<=40;}
  function inside(p){
    return !!p&&Number.isFinite(p.lat)&&Number.isFinite(p.lon)&&p.lat>=32&&p.lat<=40&&p.lon>=123&&p.lon<=133&&
      core.withEndpoints(core.tilesFor(p,p,90),index.tileDependencies).some(availableTile);
  }
  // Display-only walking guidance: steps derived from the computed route, and progress recalculated only
  // when the user presses the location button. No continuous tracking, sound, or vibration.
  let guide=null,progress=null,progressFix=null,guideDismissed=false;
  const guideCard=document.createElement('section');guideCard.id='routeGuide';guideCard.className='route-guide';guideCard.hidden=true;guideCard.setAttribute('aria-label','도보 경로 안내');
  guideCard.innerHTML=`<div class="route-guide-top"><div class="route-guide-main"><strong id="routeGuideNext" role="status"></strong><span id="routeGuideSub"></span><span id="routeGuideFacing" class="route-guide-facing" hidden></span></div>
    <div class="route-guide-actions"><button id="routeGuideLocate" class="icon-button" aria-label="내 위치로 진행 상황 확인">${$('locate').innerHTML}</button><button id="routeGuideList" class="icon-button" aria-label="단계별 안내 목록" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg></button><button id="routeGuideClose" class="icon-button" aria-label="안내 닫기">×</button></div></div>
    <ol id="routeGuideSteps" class="route-guide-steps" hidden></ol><p class="route-guide-note">참고 경로 · 현장 통행·안전 미확인 · 위치 버튼을 누를 때만 갱신</p>`;
  document.querySelector('.app').append(guideCard);
  function bearing(a,b){const r=Math.PI/180,y=Math.sin((b.lon-a.lon)*r)*Math.cos(b.lat*r),x=Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos((b.lon-a.lon)*r);return (Math.atan2(y,x)/r+360)%360;}
  function kindOf(k){return k==='steps'?'계단':k==='crossing'?'횡단보도':k==='walk'?'보행로':k==='main'?'큰길':'길';}
  function meters(m){return m<1000?`${Math.max(5,Math.round(m/5)*5)}m`:`${(m/1000).toFixed(1)}km`;}
  function turnWord(d){if(d===null)return '출발';const a=Math.abs(d);if(a<35)return '직진';if(a>150)return '되돌아가기';return d>0?(a>110?'오른쪽으로 크게':'오른쪽으로'):(a>110?'왼쪽으로 크게':'왼쪽으로');}
  function whereOf(l){return l.key==='계단'?'계단':l.key==='횡단보도'?'횡단보도 건너기':l.name||(l.kind==='보행로'?'보행로':l.kind==='큰길'?'큰길(차도 옆 주의)':'길');}
  // Legs break at a turn of 35° or more, a street-name change, stairs, or a crossing; tiny wiggles (<6 m) never count as turns.
  function buildGuide(r){
    const pts=r.points,segs=[];let total=0;
    for(let i=1;i<pts.length;i++){const len=core.distance(pts[i-1],pts[i]);if(len<=0)continue;const t=r.seg[i-1]||{};segs.push({a:pts[i-1],b:pts[i],len,from:total,bear:bearing(pts[i-1],pts[i]),name:t.name||'',kind:kindOf(t.kind)});total+=len;}
    const legs=[];
    for(const s of segs){const leg=legs.at(-1),key=s.kind==='계단'||s.kind==='횡단보도'?s.kind:'길';
      const turn=leg?((s.bear-leg.endBear+540)%360)-180:null;
      if(!leg||key!==leg.key||(s.len>=6&&(s.name!==leg.name||Math.abs(turn)>=35)))legs.push({key,name:s.name,kind:s.kind,from:s.from,len:s.len,turn,startBear:s.bear,endBear:s.bear});
      else{leg.len+=s.len;if(s.len>=6)leg.endBear=s.bear;}}
    // Clean-up: short jogs (<20 m, e.g. crossing a side road) fold into the next leg, keeping that leg's main
    // direction; turns are then recomputed, and consecutive legs on the same street in the same direction merge.
    const L=legs.map(l=>({...l}));const diff=(a,b)=>((a-b+540)%360)-180,where=l=>whereOf(l);
    for(let i=0;i<L.length;){const l=L[i];if(L.length>1&&l.len<20&&l.key==='길'){
      if(i+1<L.length&&L[i+1].key==='길'){L[i+1].from=l.from;L[i+1].len+=l.len;L.splice(i,1);continue;}
      if(i>0&&L[i-1].key==='길'){L[i-1].len+=l.len;L[i-1].endBear=l.endBear;L.splice(i,1);continue;}}i++;}
    for(let i=0;i<L.length;i++)L[i].turn=i?diff(L[i].startBear,L[i-1].endBear):null;
    const merged=[];for(const l of L){const p=merged.at(-1);if(p&&where(p)===where(l)&&Math.abs(l.turn)<35){p.len+=l.len;p.endBear=l.endBear;}else merged.push(l);}
    return segs.length?{total,segs,legs:merged.map(l=>({...l,word:turnWord(l.turn),where:whereOf(l)}))}:null;
  }
  function projectOnRoute(p){let best=null;const kx=Math.cos(p.lat*Math.PI/180)*111320,ky=110540;
    for(const s of guide.segs){const ax=(s.a.lon-p.lon)*kx,ay=(s.a.lat-p.lat)*ky,dx=(s.b.lon-s.a.lon)*kx,dy=(s.b.lat-s.a.lat)*ky,L=dx*dx+dy*dy,t=L?Math.max(0,Math.min(1,-(ax*dx+ay*dy)/L)):0,d=Math.hypot(ax+t*dx,ay+t*dy);
      if(!best||d<best.d)best={d,along:s.from+t*s.len,point:{lat:s.a.lat+(s.b.lat-s.a.lat)*t,lon:s.a.lon+(s.b.lon-s.a.lon)*t}};}
    return best;}
  function updateProgress(){
    if(!guide)return;const g=api.state.gps;if(!g)return;
    progressFix=g;
    const age=gpsAge(g);
    if(!freshGps(g)){progress={stale:true,age,accuracy:g.accuracy};renderGuide();api.redraw();return;}
    // The regular locate button zooms out to a city view; while guiding, stay zoomed in on the walker instead.
    if(!guideCard.hidden){const z=Math.max(15,api.state.camera.z);setTimeout(()=>api.focusPoint({lat:g.lat,lon:g.lon},z),0);}
    const p=projectOnRoute(g),off=p.d>Math.max(30,g.accuracy+10);let idx=0;for(let i=0;i<guide.legs.length;i++)if(guide.legs[i].from<=p.along+1)idx=i;
    progress={...p,off,idx,age,accuracy:g.accuracy};renderGuide();api.redraw();
  }
  function renderProgressText(){
    const L=guide.legs,next=$('routeGuideNext'),sub=$('routeGuideSub'),gpsText=p=>`GPS ${Math.max(0,Math.round(p.age/1000))}초 전 ±${Math.round(p.accuracy)}m`;
    let primary,detail;
    guideCard.classList.toggle('route-guide-off',!!progress?.off);
    if(!progress){primary=`${L[0].word} · ${L[0].where} ${meters(L[0].len)}`;detail=`총 ${meters(guide.total)} · ${L.length}단계 · 위치 버튼으로 진행 확인`;}
    else if(progress.stale){primary='진행 상황을 계산하지 않았습니다';detail='GPS가 오래됐거나 오차가 큽니다. 위치 버튼으로 다시 확인하세요.';}
    else if(progress.off){primary=`경로에서 약 ${meters(progress.d)} 벗어남`;detail=`통행 가능한 길을 현장에서 확인하세요 · ${gpsText(progress)}`;}
    else{const left=guide.total-progress.along,n=L[progress.idx+1];
      primary=left<15?'목적지 부근입니다 · 주변을 직접 확인하세요':n?`${meters(n.from-progress.along)} 뒤 ${n.word} · ${n.where}`:`목적지까지 ${meters(left)} · ${L[progress.idx].where}`;
      detail=`남은 거리 약 ${meters(left)} · ${gpsText(progress)}`;}
    if(next.textContent!==primary)next.textContent=primary;
    if(sub.textContent!==detail)sub.textContent=detail;
  }
  function renderGuide(){
    const show=!!guide&&result?.status==='found'&&!guideDismissed&&!dialog.open;guideCard.hidden=!show;if(!show)return;
    renderProgressText();
    renderFacing();
    $('routeGuideSteps').innerHTML=guide.legs.map((l,i)=>{const cls=progress&&!progress.stale&&!progress.off?(i<progress.idx?'done':i===progress.idx?'current':''):'';return `<li class="${cls}"><b>${esc(l.word)}</b> ${esc(l.where)} <span>${meters(l.len)}</span></li>`;}).join('')+'<li><b>도착</b> 선택한 목적지 쪽 도로 지점</li>';
  }
  function refreshProgressAge(){
    if(!progressFix||progress?.stale)return;
    const age=gpsAge(progressFix);
    if(!Number.isFinite(age)||age<0||age>300000){
      progress={stale:true,age,accuracy:progressFix.accuracy};
      renderGuide();api.redraw();
    }else{
      progress.age=age;
      if(!guideCard.hidden)renderProgressText();
    }
  }
  // With the direction cone on, compare where the phone points with where the route goes from the last on-route fix.
  function routeBearingAt(along){const S=guide.segs;let i=S.findIndex(s=>along<s.from+s.len);if(i<0)i=S.length-1;if(S[i].from+S[i].len-along<8&&i+1<S.length)i++;return S[i].bear;}
  function renderFacing(){
    const el=$('routeGuideFacing'),h=window.DURU_HEADING?.state;
    const usable=!guideCard.hidden&&guide&&progressFix&&freshGps(progressFix)&&progress&&!progress.stale&&!progress.off&&guide.total-progress.along>=15&&h?.on;
    if(!usable){el.hidden=true;return;}
    el.hidden=false;
    if(h.value===null){el.textContent='보는 방향 확인 중 · 폰을 평평하게 잡아주세요';return;}
    const rel=((routeBearingAt(progress.along)-h.value+540)%360)-180,a=Math.abs(rel),side=rel>0?'오른쪽':'왼쪽';
    const where=a<=25?'정면':a<=70?`${side} 앞`:a<=115?side:a<=160?`${side} 뒤`:'뒤쪽';
    const reference=h.reference==='magnetic'?'자북, 진북 보정 없음':'브라우저 센서';
    const text=`경로 방향: ${where} · ${reference}`;
    if(el.textContent!==text)el.textContent=text;
    el.dataset.rel=String(Math.round(rel));
  }
  window.addEventListener('duru-heading',renderFacing);
  $('routeGuideLocate').onclick=()=>$('locate').click();
  $('routeGuideList').onclick=()=>{const list=$('routeGuideSteps'),open=list.hidden;list.hidden=!open;$('routeGuideList').setAttribute('aria-expanded',String(open));};
  $('routeGuideClose').onclick=()=>{guideDismissed=true;renderGuide();api.redraw();};
  window.addEventListener('duru-position',updateProgress);
  setInterval(refreshProgressAge,1000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshProgressAge();});
  dialog.addEventListener('close',()=>{refreshProgressAge();renderGuide();});
  function resetGuide(){guide=result?.status==='found'&&result.points?.length>1?buildGuide(result):null;progress=null;progressFix=null;guideDismissed=false;$('routeGuideSteps').hidden=true;$('routeGuideList').setAttribute('aria-expanded','false');renderGuide();}
  function validZones(value){
    if(!Array.isArray(value)||value.length>30)throw Error('회피 구역 자료를 읽을 수 없습니다. 기존 자료 보호를 위해 길찾기를 잠갔습니다.');
    for(const z of value){if(!z||z.source!=='manual'||typeof z.id!=='string'||!Number.isFinite(z.observedAt)||!Number.isFinite(z.lat)||!Number.isFinite(z.lon)||!(z.radiusMeters>0&&z.radiusMeters<=1000))throw Error('회피 구역 자료 형식 오류');}
    return value;
  }
  try{rawZones=localStorage.getItem(KEY);zones=validZones(JSON.parse(rawZones||'[]'));}catch(e){storageError=e.message;}
  function invalidateRoute(){routeRun++;busy=false;result=null;resetGuide();}
  function persist(next){try{if(!sessionOnly)localStorage.setItem(KEY,JSON.stringify(next));zones=next;invalidateRoute();render();api.redraw();return true;}catch(_){status('회피 구역을 저장하지 못했습니다. 기존 구역을 유지합니다.');return false;}}
  let candidate=null;
  function render(){
    const label=p=>p?`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · 선택점에서 도로까지 ${Math.round(p.offsetMeters)}m (연결 미확인)`:'미지정';
    $('routeStart').textContent='출발점: '+label(start);$('routeGoal').textContent='목적지: '+label(goal);
    $('routeZoneCount').textContent=`(${zones.length})`;
    $('routeStorage').textContent=storageError||(sessionOnly?'이번 실행에만 적용합니다. 원래 저장소는 보존했으며 재실행하면 다시 확인해야 합니다.':'회피 구역은 이 기기에 저장됩니다. 브라우저 자료 삭제·앱 삭제 시 사라질 수 있습니다.');
    $('routeRecovery').hidden=!storageError;$('routeRawBackup').disabled=rawZones===null;
    $('routeCalculate').disabled=!!storageError||!start||!goal||busy;
    $('routeView').disabled=result?.status!=='found';
    $('routeZones').innerHTML=zones.map((z,i)=>`<p class="route-zone">직접 지정 · ${z.radiusMeters}m · ${esc(new Date(z.observedAt).toLocaleDateString('ko-KR'))}<button class="link-button" data-zone-remove="${i}">삭제</button></p>`).join('');
    for(const b of dialog.querySelectorAll('[data-zone-remove]'))b.onclick=()=>{if(storageError)return;persist(zones.filter((_,i)=>i!==Number(b.dataset.zoneRemove)));status('회피 구역이 바뀌었습니다. 경로를 다시 계산하세요.');};
  }
  function open(){
    if(!supported){api.toast('도보 길찾기를 사용하려면 브라우저 또는 Android System WebView를 업데이트하세요.');return false;}
    render();if(!dialog.open)dialog.showModal();
    return true;
  }
  button.onclick=open;$('routeClose').onclick=()=>dialog.close();
  let chooseSeq=0;
  async function choose(which,p=api.state.selected){
    if(!open())return;
    candidate=null;$('routeCandidate').hidden=true;const seq=++chooseSeq;
    if(!p){status('지도를 눌러 위치를 먼저 선택하세요.');return;}
    if(!inside(p)){status(standalone?'이 HTML 파일에는 서울 도보 자료만 있습니다. 전국 도보 길찾기는 앱이나 저장한 웹 지도에서 사용하세요.':'이 위치 주변에는 도보 길 자료가 없습니다(바다·국외 등). 육지의 길 가까이를 선택하세요.');return;}
    let nearest,missing;
    try{
      const data=await graphFor(core.tilesFor(p,p,300));
      missing=data.missing;
      nearest=core.snapPoint(data.graph,p,40);
    }
    catch(e){if(seq===chooseSeq)status(`${e.message} 인터넷에 연결된 상태에서 다시 시도하거나 오프라인 메뉴에서 미리 받아 두세요.`);return;}
    if(seq!==chooseSeq)return;
    const meters=nearest?.offsetMeters;
    if(!nearest){status(missing.length?missingMessage(missing):'40m 안에 계산 가능한 도로 후보를 찾지 못했습니다. 입구나 도로를 더 가까이 선택하세요.');return;}
    candidate={which,node:{lat:nearest.lat,lon:nearest.lon,offsetMeters:nearest.offsetMeters,selected:nearest.selected}};
    $('routeCandidateText').textContent=`${which==='start'?'출발':'도착'} 도로 후보: 선택 위치에서 ${Math.round(meters)}m, ${nearest.lat.toFixed(5)}, ${nearest.lon.toFixed(5)}. 이 사이를 건널 수 있는지 직접 확인하세요. 건물·강·담장을 가로지르는 연결은 제공하지 않습니다.`;
    $('routeCandidate').hidden=false;status('후보 도로 지점을 확인한 뒤 사용을 눌러주세요.');return candidate;
  }
  $('routeSetStart').onclick=()=>choose('start');$('routeSetGoal').onclick=()=>choose('goal');
  $('routeAccept').onclick=()=>{if(!candidate)return;if(candidate.node.gps&&!freshGps(candidate.node.gps)){status('GPS 후보가 오래됐습니다. 새로 수신하거나 직접 지정하세요.');return;}if(candidate.which==='start')start=candidate.node;else goal=candidate.node;candidate=null;invalidateRoute();$('routeCandidate').hidden=true;render();api.redraw();status('도로 지점을 지정했습니다. 출발점과 목적지를 지정한 뒤 계산하세요.');};
  $('routeGps').onclick=()=>{const gps=api.state.gps;if(!gps){status('GPS 수신 위치가 없습니다. 지도 화면의 위치 버튼으로 먼저 수신하세요.');return;}
    const age=gpsAge(gps);
    if(!freshGps(gps)){status('GPS가 5분보다 오래됐거나 오차가 40m를 넘습니다. 새로 수신하거나 지도에서 직접 선택하세요.');return;}
    choose('start',gps).then(picked=>{if(picked&&picked===candidate){picked.node.gps={...gps};$('routeCandidateText').textContent+=` GPS ${Math.floor(age/1000)}초 전 · 추정 오차 ${Math.round(gps.accuracy)}m. 현재 위치를 보장하지 않습니다.`;}});
  };
  $('routeCalculate').onclick=()=>{
    if(storageError||!start||!goal||busy)return;
    if(start.gps&&!freshGps(start.gps)){result=null;resetGuide();api.redraw();status('GPS 출발점이 오래됐습니다. 새로 수신하거나 지도에서 직접 지정하세요.');render();return;}
    const straight=core.distance(start,goal);
    if(straight>MAX_ROUTE){result=null;resetGuide();render();status(`직선거리 ${(straight/1000).toFixed(1)}km는 한 번에 계산하지 않습니다(${MAX_ROUTE/1000}km까지). 중간 지점을 목적지로 나누어 계산하세요.`);return;}
    const run=++routeRun,from=start,to=goal;
    result=null;resetGuide();busy=true;render();status('경로 계산 중…');api.redraw();
    const messages={no_path:'조건을 만족하는 경로를 찾지 못했습니다. 통행 가능한 다른 길이 없다는 뜻은 아닙니다.',blocked_selected_location:'선택한 원래 위치가 회피 구역 안에 있습니다.',limit_exceeded:'계산 한도를 초과했습니다. 더 가까운 지점으로 나누어 선택하세요.'};
    (async()=>{try{
      const {graph,missing}=await graphFor(core.tilesFor(from,to,Math.max(1500,Math.min(6000,straight*0.3))));
      if(run!==routeRun)return;
      const s=core.snapPoint(graph,from,5),t=core.snapPoint(graph,to,5);
      if(!s||!t)throw Error(missing.length?missingMessage(missing):'출발점이나 목적지의 도로 지점을 다시 선택해 주세요.');
      s.selected=from.selected;t.selected=to.selected;
      await new Promise(r=>setTimeout(r,20));
      if(run!==routeRun)return;
      if(from.gps&&!freshGps(from.gps))throw Error('gps');
      result=core.route(graph,s,t,{zones,maxMs:2500});
      const km=m=>m<1000?Math.round(m)+'m':(m/1000).toFixed(1)+'km';
      const scope=missing.length?'저장된 자료 범위에서 계산했습니다. ':'';
      status(result.status==='found'?`${scope}도로 구간 약 ${km(result.meters)} · ${result.hasSteps?'계단 포함 · ':''}현장 통행·안전 미확인. 선택점과 도로 사이 ${Math.round(start.offsetMeters)}m / ${Math.round(goal.offsetMeters)}m는 경로에 포함되지 않으며 접근 확인이 필요합니다.`:(result.status==='no_path'&&missing.length?missingMessage(missing):messages[result.status]||'경로를 계산하지 못했습니다.'));
    }catch(e){
      if(run!==routeRun)return;
      result=null;
      if(e.message==='gps')status('GPS 출발점이 오래됐습니다. 새로 수신하거나 직접 지정하세요.');
      else status(e.message||'경로 자료를 처리하지 못했습니다.');
    }
    busy=false;resetGuide();render();api.redraw();})();
  };
  $('routeView').onclick=()=>{if(result?.status!=='found')return;dialog.close();renderGuide();api.focusPoint(start,14);api.toast('파란 선은 참고 경로입니다. 위쪽 안내 카드의 위치 버튼으로 진행 상황을 확인하세요.');};
  $('routeClear').onclick=()=>{start=null;goal=null;chooseSeq++;invalidateRoute();candidate=null;$('routeCandidate').hidden=true;status('경로를 지웠습니다.');render();api.redraw();};
  $('routeAddZone').onclick=()=>{if(storageError)return;const p=api.state.selected;if(!p){status('지도를 눌러 회피할 위치를 먼저 선택하세요.');return;}if(zones.length>=30){status('회피 구역은 30개까지 저장할 수 있습니다.');return;}
    const z={id:crypto.randomUUID(),lat:p.lat,lon:p.lon,radiusMeters:Number($('routeRadius').value),source:'manual',observedAt:Date.now()};
    if(persist([...zones,z]))status('직접 지정한 회피 구역을 저장했습니다. 경로를 다시 계산하세요.');
  };
  $('routeRawBackup').onclick=async()=>{if(rawZones===null)return;const text=JSON.stringify({app:'생존나침반 회피구역 원문',raw:rawZones},null,2);try{
    if(window.DURU_SAVE_BACKUP){if(!await window.DURU_SAVE_BACKUP('회피구역-원문.json',text))return;}
    else{const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='회피구역-원문.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
    backupRequested=true;status('원문 저장을 요청했습니다. 파일을 보관했는지 확인한 뒤 복구 동의를 선택하세요.');
  }catch(_){status('원문 백업을 요청하지 못했습니다. 기존 자료를 유지합니다.');}};
  $('routeRecover').onclick=()=>{if(!$('routeRecoveryAgree').checked||rawZones!==null&&!backupRequested){status('원문 백업과 복구 동의를 먼저 확인하세요.');return;}storageError='';sessionOnly=true;zones=[];invalidateRoute();render();api.redraw();status('기존 저장소를 보존하고 이번 실행에서만 시작했습니다. 기존 회피 구역은 적용되지 않습니다.');};
  // Extend place actions without replacing existing saving/sharing controls.
  const placeObserver=new MutationObserver(()=>{if(!$('pinName')||$('routePlaceActions'))return;const row=document.createElement('div');row.id='routePlaceActions';row.className='action-row';if(!inside(api.state.selected)){
      // No walking data here (sea or outside Korea): say why instead of offering buttons that can only fail.
      row.classList.add('route-place-outside');row.innerHTML='<p class="route-place-note">이 위치 주변에는 도보 길 자료가 없습니다. 육지의 길 가까이를 선택하세요.</p>';
      $('panelBody').append(row);return;}
    row.innerHTML='<button id="routePlaceStart" class="secondary-button">도보 출발점</button><button id="routePlaceGoal" class="secondary-button">도보 목적지</button>';$('panelBody').append(row);$('routePlaceStart').onclick=()=>choose('start');$('routePlaceGoal').onclick=()=>choose('goal');});
  placeObserver.observe($('panelBody'),{childList:true});
  api.addOverlay({draw({ctx,screen,project}){
    const xy=p=>screen(project(p.lon,p.lat));ctx.save();
    for(const z of zones){const p=xy(z),east=xy({...z,lon:z.lon+z.radiusMeters/(111320*Math.cos(z.lat*Math.PI/180))});ctx.beginPath();ctx.arc(...p,Math.abs(east[0]-p[0]),0,Math.PI*2);ctx.fillStyle='#b45b3833';ctx.strokeStyle='#a34e32';ctx.lineWidth=2;ctx.fill();ctx.stroke();}
    if(result?.status==='found'){ctx.beginPath();for(const [i,point] of result.points.entries()){const p=xy(point);i?ctx.lineTo(...p):ctx.moveTo(...p);}ctx.strokeStyle='#fff';ctx.lineWidth=8;ctx.stroke();ctx.strokeStyle='#286b9c';ctx.lineWidth=4;ctx.stroke();if(guide&&progress&&!progress.stale&&!progress.off){ctx.beginPath();ctx.moveTo(...xy(guide.segs[0].a));for(const sg of guide.segs){if(sg.from+sg.len<=progress.along)ctx.lineTo(...xy(sg.b));else{ctx.lineTo(...xy(progress.point));break;}}ctx.strokeStyle='#9aa8a4';ctx.lineWidth=4;ctx.stroke();}}
    for(const [p,label] of [[start,'출'],[goal,'도']])if(p){const s=xy(p);ctx.beginPath();ctx.arc(...s,11,0,Math.PI*2);ctx.fillStyle='#286b9c';ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 11px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,...s);}ctx.restore();
  }});
  // ---- Offline menu: walking data by province (web keeps them in its own cache; the Android app already bundles them) ----
  const walkBox=document.createElement('section');walkBox.id='walkData';walkBox.className='walk-data';
  walkBox.innerHTML=`<h3>도보 길찾기 자료 (시·도별)</h3><p class="small-note" id="walkDataNote"></p><div id="walkDataList" class="walk-data-list"></div>`;
  const walkAnchor=$('installApp')||$('cacheMap');if(walkAnchor)walkAnchor.after(walkBox);else $('helpDialog')?.querySelector('.modal-card')?.append(walkBox);
  async function savedSet(){if(native)return new Set(index.regions.map(r=>r.id));try{const c=await caches.open(WALK_CACHE),out=new Set();for(const r of index.regions)if(await c.match(fileUrl(r)))out.add(r.id);return out;}catch(_){return new Set();}}
  async function renderWalkData(){
    const saved=await savedSet(),total=index.regions.reduce((n,r)=>n+r.bytes,0),have=index.regions.filter(r=>saved.has(r.id)).reduce((n,r)=>n+r.bytes,0);
    $('walkDataNote').textContent=native?`앱에 전국 도보 자료가 들어 있습니다(${(total/1e6).toFixed(0)}MB). 따로 받을 필요가 없습니다.`:
      `길찾기를 처음 쓰면 그 지역 자료를 자동으로 받아 저장합니다. 인터넷이 끊길 때를 대비해 사는 곳·다니는 곳을 미리 받아 두세요. 저장됨 ${(have/1e6).toFixed(1)}MB / 전국 ${(total/1e6).toFixed(0)}MB`;
    if(native){$('walkDataList').innerHTML='';return;}
    $('walkDataList').innerHTML=index.regions.map(r=>`<div class="walk-data-row"><span>${esc(r.label)} <small>${(r.bytes/1e6).toFixed(1)}MB</small></span>${saved.has(r.id)?`<span class="walk-data-saved">저장됨</span><button class="link-button" data-walk-remove="${r.id}">삭제</button>`:`<button class="secondary-button" data-walk-save="${r.id}">받기</button>`}</div>`).join('');
    for(const b of walkBox.querySelectorAll('[data-walk-save]'))b.onclick=async()=>{const r=regionById.get(b.dataset.walkSave);b.disabled=true;b.textContent='받는 중…';
      try{await webPack(r,true);api.toast(`${r.label} 도보 자료를 저장했습니다.`);}
      catch(e){api.toast(e.message||`${r.label} 도보 자료를 받지 못했습니다.`);}renderWalkData();};
    for(const b of walkBox.querySelectorAll('[data-walk-remove]'))b.onclick=async()=>{const r=regionById.get(b.dataset.walkRemove);try{await (await caches.open(WALK_CACHE)).delete(fileUrl(r));}catch(_){}packs.delete(r.id);for(const k of [...tiles.keys()])if(index.tileRegion[k]===r.id)tiles.delete(k);lastGraph=null;renderWalkData();};
  }
  if(standalone){
    $('walkDataNote').textContent='이 HTML 파일에는 전국 바탕 지도와 서울 도보 자료가 들어 있습니다. 다른 지역의 도보 길찾기는 앱이나 저장한 웹 지도에서 사용하세요.';
  }else{
    renderWalkData();
    $('helpDialog')?.addEventListener('toggle',()=>{if($('helpDialog').open)renderWalkData();});
    $('navOffline')?.addEventListener('click',()=>setTimeout(renderWalkData,0));
  }
  render();
  window.DURU_ROUTING={open,choose,get state(){return {start,goal,result,guide:guide&&{total:guide.total,legs:guide.legs.map(l=>({word:l.word,where:l.where,from:l.from,len:l.len}))},progress,zones:zones.map(z=>({...z})),busy,loadedRegions:[...packs.keys()],tilesLoaded:tiles.size};},regions:index.regions,WALK_CACHE};
})();
