(() => {
  'use strict';
  const api=window.DURU, core=window.DURU_ROUTING_CORE, pack=window.ROUTING_DATA;
  if(!api||!core||!pack)return;
  const $=id=>document.getElementById(id), esc=api.escapeHtml, KEY='survival-avoid-zones-v1';
  let graph=null,start=null,goal=null,result=null,zones=[],storageError='',rawZones=null,backupRequested=false,sessionOnly=false,routeMode=false;
  const dialog=document.createElement('dialog');dialog.id='routeDialog';dialog.className='modal routing-modal';
  dialog.innerHTML=`<div class="modal-card"><div class="modal-header"><div><span class="eyebrow">서울역 주변 · 오프라인 시범 기능</span><h2>도보 길찾기</h2></div><button id="routeClose" class="icon-button" aria-label="길찾기 닫기">×</button></div>
    <p class="routing-caution">거리 기준 참고 경로입니다. 현장 통행·안전 여부는 확인되지 않았습니다. 공식 대피 지시와 현장 통제를 우선하세요. 차량·휠체어 길찾기는 지원하지 않습니다.</p>
    <p class="small-note">자료: © OpenStreetMap contributors · ${esc(pack.metadata.osmTimestamp||'시각 모름')} · ODbL. 서울역 주변 약 3 × 3.7km만 제공합니다.</p>
    <button id="routeRegion" class="secondary-button wide">시범 지역 지도에서 보기</button>
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
  function ensureGraph(){if(!graph)graph=core.buildGraph(pack);return graph;}
  function inside(p){const b=pack.bounds;return p&&p.lon>=b[0]&&p.lon<=b[2]&&p.lat>=b[1]&&p.lat<=b[3];}
  // Display-only walking guidance: steps derived from the computed route, and progress recalculated only
  // when the user presses the location button. No continuous tracking, sound, or vibration.
  const wayTags=new Map();for(const w of pack.ways||[])wayTags.set(w.id,w.tags||{});
  let guide=null,progress=null,progressFix=null,guideDismissed=false;
  const guideCard=document.createElement('section');guideCard.id='routeGuide';guideCard.className='route-guide';guideCard.hidden=true;guideCard.setAttribute('aria-label','도보 경로 안내');
  guideCard.innerHTML=`<div class="route-guide-top"><div class="route-guide-main"><strong id="routeGuideNext" role="status"></strong><span id="routeGuideSub"></span><span id="routeGuideFacing" class="route-guide-facing" hidden></span></div>
    <div class="route-guide-actions"><button id="routeGuideLocate" class="icon-button" aria-label="내 위치로 진행 상황 확인">${$('locate').innerHTML}</button><button id="routeGuideList" class="icon-button" aria-label="단계별 안내 목록" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg></button><button id="routeGuideClose" class="icon-button" aria-label="안내 닫기">×</button></div></div>
    <ol id="routeGuideSteps" class="route-guide-steps" hidden></ol><p class="route-guide-note">참고 경로 · 현장 통행·안전 미확인 · 위치 버튼을 누를 때만 갱신</p>`;
  document.querySelector('.app').append(guideCard);
  function bearing(a,b){const r=Math.PI/180,y=Math.sin((b.lon-a.lon)*r)*Math.cos(b.lat*r),x=Math.cos(a.lat*r)*Math.sin(b.lat*r)-Math.sin(a.lat*r)*Math.cos(b.lat*r)*Math.cos((b.lon-a.lon)*r);return (Math.atan2(y,x)/r+360)%360;}
  function kindOf(t){if(t.highway==='steps')return '계단';if(t.footway==='crossing'||t.highway==='crossing')return '횡단보도';if(['footway','pedestrian','path'].includes(t.highway))return '보행로';return '길';}
  function meters(m){return m<1000?`${Math.max(5,Math.round(m/5)*5)}m`:`${(m/1000).toFixed(1)}km`;}
  function turnWord(d){if(d===null)return '출발';const a=Math.abs(d);if(a<35)return '직진';if(a>150)return '되돌아가기';return d>0?(a>110?'오른쪽으로 크게':'오른쪽으로'):(a>110?'왼쪽으로 크게':'왼쪽으로');}
  function whereOf(l){return l.key==='계단'?'계단':l.key==='횡단보도'?'횡단보도 건너기':l.name||(l.kind==='보행로'?'보행로':'길');}
  // Legs break at a turn of 35° or more, a street-name change, stairs, or a crossing; tiny wiggles (<6 m) never count as turns.
  function buildGuide(r){
    const pts=r.points,segs=[];let total=0;
    for(let i=1;i<pts.length;i++){const len=core.distance(pts[i-1],pts[i]);if(len<=0)continue;const t=wayTags.get(r.wayIds[i-1])||{};segs.push({a:pts[i-1],b:pts[i],len,from:total,bear:bearing(pts[i-1],pts[i]),name:t['name:ko']||t.name||'',kind:kindOf(t)});total+=len;}
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
    for(const z of value){if(!z||z.source!=='manual'||typeof z.id!=='string'||!Number.isFinite(z.observedAt))throw Error('회피 구역 자료 형식 오류');core.intersectsZone(z,z,z);}
    return value;
  }
  try{rawZones=localStorage.getItem(KEY);zones=validZones(JSON.parse(rawZones||'[]'));}catch(e){storageError=e.message;}
  function persist(next){try{if(!sessionOnly)localStorage.setItem(KEY,JSON.stringify(next));zones=next;result=null;resetGuide();render();api.redraw();return true;}catch(_){status('회피 구역을 저장하지 못했습니다. 기존 구역을 유지합니다.');return false;}}
  let candidate=null;
  function render(){
    const label=p=>p?`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · 선택점에서 도로까지 ${Math.round(p.offsetMeters)}m (연결 미확인)`:'미지정';
    $('routeStart').textContent='출발점: '+label(start);$('routeGoal').textContent='목적지: '+label(goal);
    $('routeZoneCount').textContent=`(${zones.length})`;
    $('routeStorage').textContent=storageError||(sessionOnly?'이번 실행에만 적용합니다. 원래 저장소는 보존했으며 재실행하면 다시 확인해야 합니다.':'회피 구역은 이 기기에 저장됩니다. 브라우저 자료 삭제·앱 삭제 시 사라질 수 있습니다.');
    $('routeRecovery').hidden=!storageError;$('routeRawBackup').disabled=rawZones===null;
    $('routeCalculate').disabled=!!storageError||!start||!goal;
    $('routeView').disabled=result?.status!=='found';
    $('routeZones').innerHTML=zones.map((z,i)=>`<p class="route-zone">직접 지정 · ${z.radiusMeters}m · ${esc(new Date(z.observedAt).toLocaleDateString('ko-KR'))}${inside(z)?'':' · 지역 밖 중심(반경이 겹치면 회피)'}<button class="link-button" data-zone-remove="${i}">삭제</button></p>`).join('');
    for(const b of dialog.querySelectorAll('[data-zone-remove]'))b.onclick=()=>{if(storageError)return;persist(zones.filter((_,i)=>i!==Number(b.dataset.zoneRemove)));status('회피 구역이 바뀌었습니다. 경로를 다시 계산하세요.');};
  }
  function open(){ensureGraph();if(!routeMode){routeMode=true;api.invalidateBase();}render();if(!dialog.open)dialog.showModal();}
  button.onclick=open;$('routeClose').onclick=()=>dialog.close();
  $('routeRegion').onclick=()=>{dialog.close();api.focusPoint({lon:126.975,lat:37.5615},14);};
  function choose(which,p=api.state.selected){
    open();candidate=null;$('routeCandidate').hidden=true;
    if(!inside(p)){status('시범 지역 밖이거나 위치를 선택하지 않았습니다. ‘시범 지역 지도에서 보기’를 누른 뒤 도로를 선택하세요.');return;}
    const g=ensureGraph();if(g.issues.length){status('도로 자료가 불완전해 경로를 계산할 수 없습니다.');return;}
    const nearest=core.snapPoint(g,p,40),meters=nearest?.offsetMeters;
    if(!nearest){status('40m 안에 계산 가능한 도로 후보를 찾지 못했습니다. 길이 없다는 뜻은 아닙니다. 입구나 도로를 더 가까이 선택하세요.');return;}
    candidate={which,node:nearest};
    $('routeCandidateText').textContent=`${which==='start'?'출발':'도착'} 도로 후보: 선택 위치에서 ${Math.round(meters)}m, ${nearest.lat.toFixed(5)}, ${nearest.lon.toFixed(5)}. 이 사이를 건널 수 있는지 직접 확인하세요. 건물·강·담장을 가로지르는 연결은 제공하지 않습니다.`;
    $('routeCandidate').hidden=false;status('후보 도로 지점을 확인한 뒤 사용을 눌러주세요.');
  }
  $('routeSetStart').onclick=()=>choose('start');$('routeSetGoal').onclick=()=>choose('goal');
  $('routeAccept').onclick=()=>{if(!candidate)return;if(candidate.node.gps&&!freshGps(candidate.node.gps)){status('GPS 후보가 오래됐습니다. 새로 수신하거나 직접 지정하세요.');return;}if(candidate.which==='start')start=candidate.node;else goal=candidate.node;candidate=null;result=null;resetGuide();$('routeCandidate').hidden=true;render();api.redraw();status('도로 지점을 지정했습니다. 출발점과 목적지를 지정한 뒤 계산하세요.');};
  $('routeGps').onclick=()=>{const gps=api.state.gps;if(!gps){status('GPS 수신 위치가 없습니다. 지도 화면의 위치 버튼으로 먼저 수신하세요.');return;}
    const age=gpsAge(gps);
    if(!freshGps(gps)){status('GPS가 5분보다 오래됐거나 오차가 40m를 넘습니다. 새로 수신하거나 지도에서 직접 선택하세요.');return;}
    choose('start',gps);if(candidate){candidate.node.gps={...gps};$('routeCandidateText').textContent+=` GPS ${Math.floor(age/1000)}초 전 · 추정 오차 ${Math.round(gps.accuracy)}m. 현재 위치를 보장하지 않습니다.`;}
  };
  $('routeCalculate').onclick=()=>{
    if(storageError||!start||!goal)return;
    if(start.gps&&!freshGps(start.gps)){result=null;resetGuide();api.redraw();status('GPS 출발점이 오래됐습니다. 새로 수신하거나 지도에서 직접 지정하세요.');render();return;}
    result=null;resetGuide();status('경로 계산 중…');api.redraw();
    setTimeout(()=>{try{result=core.routeFromSnaps(ensureGraph(),start,goal,{zones,maxMs:1200,maxVisited:50000});
      const messages={no_path:'조건을 만족하는 경로를 찾지 못했습니다. 통행 가능한 다른 길이 없다는 뜻은 아닙니다.',outside_data:'시범 지역 자료 밖입니다.',blocked_selected_location:'선택한 원래 위치가 회피 구역 안에 있습니다.',blocked_endpoint:'출발점 또는 목적지가 회피 구역 안에 있습니다.',unsupported_data:'미지원 제한 또는 불완전한 도로 자료로 경로를 제공할 수 없습니다.',limit_exceeded:'계산 한도를 초과했습니다. 더 가까운 지점으로 나누어 선택하세요.'};
      status(result.status==='found'?`도로 구간 약 ${Math.round(result.meters)}m · ${result.hasSteps?'계단 포함 · ':''}현장 통행·안전 미확인. 선택점과 도로 사이 ${Math.round(start.offsetMeters)}m / ${Math.round(goal.offsetMeters)}m는 경로에 포함되지 않으며 접근 확인이 필요합니다.`:messages[result.status]||'경로를 계산하지 못했습니다.');
    }catch(_){result=null;status('경로 자료를 처리하지 못했습니다.');}resetGuide();render();api.redraw();},30);
  };
  $('routeView').onclick=()=>{if(result?.status!=='found')return;dialog.close();renderGuide();api.focusPoint(start,14);api.toast('파란 선은 참고 경로입니다. 위쪽 안내 카드의 위치 버튼으로 진행 상황을 확인하세요.');};
  $('routeClear').onclick=()=>{start=null;goal=null;result=null;resetGuide();candidate=null;$('routeCandidate').hidden=true;status('경로를 지웠습니다.');render();api.redraw();};
  $('routeAddZone').onclick=()=>{if(storageError)return;const p=api.state.selected;if(!inside(p)){status('시범 지역 안에서 지도를 눌러 회피할 위치를 선택하세요.');return;}if(zones.length>=30){status('회피 구역은 30개까지 저장할 수 있습니다.');return;}
    const z={id:crypto.randomUUID(),lat:p.lat,lon:p.lon,radiusMeters:Number($('routeRadius').value),source:'manual',observedAt:Date.now()};
    if(persist([...zones,z]))status('직접 지정한 회피 구역을 저장했습니다. 경로를 다시 계산하세요.');
  };
  $('routeRawBackup').onclick=async()=>{if(rawZones===null)return;const text=JSON.stringify({app:'생존나침반 회피구역 원문',raw:rawZones},null,2);try{
    if(window.DURU_SAVE_BACKUP){if(!await window.DURU_SAVE_BACKUP('회피구역-원문.json',text))return;}
    else{const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='회피구역-원문.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
    backupRequested=true;status('원문 저장을 요청했습니다. 파일을 보관했는지 확인한 뒤 복구 동의를 선택하세요.');
  }catch(_){status('원문 백업을 요청하지 못했습니다. 기존 자료를 유지합니다.');}};
  $('routeRecover').onclick=()=>{if(!$('routeRecoveryAgree').checked||rawZones!==null&&!backupRequested){status('원문 백업과 복구 동의를 먼저 확인하세요.');return;}storageError='';sessionOnly=true;zones=[];result=null;resetGuide();render();api.redraw();status('기존 저장소를 보존하고 이번 실행에서만 시작했습니다. 기존 회피 구역은 적용되지 않습니다.');};
  // Extend place actions without replacing existing saving/sharing controls.
  const placeObserver=new MutationObserver(()=>{if(!$('pinName')||$('routePlaceActions'))return;const row=document.createElement('div');row.id='routePlaceActions';row.className='action-row';if(!inside(api.state.selected)){
      // Outside the pilot area the buttons could only fail, so say why instead of offering them.
      row.classList.add('route-place-outside');row.innerHTML='<p class="route-place-note">도보 길찾기는 서울역 주변 시범 지역(약 3×3.7km)에서만 됩니다. 이 위치는 지역 밖입니다.</p><button id="routePlaceRegion" class="secondary-button">시범 지역 보기</button>';
      $('panelBody').append(row);$('routePlaceRegion').onclick=()=>api.focusPoint({lon:126.975,lat:37.5615},14);return;}
    row.innerHTML='<button id="routePlaceStart" class="secondary-button">도보 출발점</button><button id="routePlaceGoal" class="secondary-button">도보 목적지</button>';$('panelBody').append(row);$('routePlaceStart').onclick=()=>choose('start');$('routePlaceGoal').onclick=()=>choose('goal');});
  placeObserver.observe($('panelBody'),{childList:true});
  api.addOverlay({drawBase({ctx,screen,project,camera}){
    if(!routeMode||!graph||camera.z<13)return;
    const xy=p=>screen(project(p.lon,p.lat));ctx.save();ctx.strokeStyle='#b0bab0';ctx.lineWidth=1;ctx.beginPath();
    for(const [id,edges] of graph.adjacency){const a=xy(graph.nodes.get(id));for(const e of edges){if(id>e.to)continue;const b=xy(graph.nodes.get(e.to));ctx.moveTo(...a);ctx.lineTo(...b);}}ctx.stroke();ctx.restore();
  },draw({ctx,screen,project,camera}){
    const xy=p=>screen(project(p.lon,p.lat));ctx.save();
    const b=pack.bounds, nw=xy({lon:b[0],lat:b[3]}),se=xy({lon:b[2],lat:b[1]});
    if(camera.z>=11){ctx.strokeStyle='#587d91';ctx.lineWidth=1;ctx.setLineDash([5,5]);ctx.strokeRect(nw[0],nw[1],se[0]-nw[0],se[1]-nw[1]);ctx.setLineDash([]);}
    for(const z of zones){const p=xy(z),east=xy({...z,lon:z.lon+z.radiusMeters/(111320*Math.cos(z.lat*Math.PI/180))});ctx.beginPath();ctx.arc(...p,Math.abs(east[0]-p[0]),0,Math.PI*2);ctx.fillStyle='#b45b3833';ctx.strokeStyle='#a34e32';ctx.lineWidth=2;ctx.fill();ctx.stroke();}
    if(result?.status==='found'){ctx.beginPath();for(const [i,point] of result.points.entries()){const p=xy(point);i?ctx.lineTo(...p):ctx.moveTo(...p);}ctx.strokeStyle='#fff';ctx.lineWidth=8;ctx.stroke();ctx.strokeStyle='#286b9c';ctx.lineWidth=4;ctx.stroke();if(guide&&progress&&!progress.stale&&!progress.off){ctx.beginPath();ctx.moveTo(...xy(guide.segs[0].a));for(const sg of guide.segs){if(sg.from+sg.len<=progress.along)ctx.lineTo(...xy(sg.b));else{ctx.lineTo(...xy(progress.point));break;}}ctx.strokeStyle='#9aa8a4';ctx.lineWidth=4;ctx.stroke();}}
    for(const [p,label] of [[start,'출'],[goal,'도']])if(p){const s=xy(p);ctx.beginPath();ctx.arc(...s,11,0,Math.PI*2);ctx.fillStyle='#286b9c';ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 11px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,...s);}ctx.restore();
  }});
  render();
  window.DURU_ROUTING={open,choose,get state(){return {start,goal,result,guide:guide&&{total:guide.total,legs:guide.legs.map(l=>({word:l.word,where:l.where,from:l.from,len:l.len}))},progress,zones:zones.map(z=>({...z})),issues:graph?.issues??[],graphLoaded:!!graph};}};
})();
