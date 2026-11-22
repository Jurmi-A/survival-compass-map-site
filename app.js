(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.MAP_DATA;
  if (!data) { document.body.textContent = '지도 자료를 불러오지 못했습니다. 지도 파일을 다시 받아주세요.'; return; }
  const canvas = $('map'), mainCtx = canvas.getContext('2d');
  // The detailed map is rendered into baseCanvas; while a finger moves, only that image is moved or scaled.
  const baseCanvas = document.createElement('canvas'), baseCtx = baseCanvas.getContext('2d');
  let labelScale = 1, ctx = mainCtx, baseView = null, interacting = false, settleTimer = 0;
  const standalone = !!window.IS_STANDALONE || location.protocol === 'file:' || location.protocol === 'content:';
  const nativeApp = !!window.DURU_ANDROID;
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const project = (lon,lat) => [(lon+180)/360,(1-Math.log(Math.tan(Math.PI/4+clamp(lat,-85,85)*Math.PI/360))/Math.PI)/2];
  const unproject = (x,y) => [x*360-180,Math.atan(Math.sinh(Math.PI*(1-2*y)))*180/Math.PI];
  const camera = {x:project(127.8,36)[0],y:project(127.8,36)[1],z:6.2};
  let w=0,h=0,dpr=1,raf=0,selected=null,gps=null,offlineReady=false,installPrompt=null;
  const overlays=[];let gpsPending=false;let offlineError='',workerSetup=null;const offlineFailures=new Set();
  const MAX_ZOOM=17,appRoot=document.querySelector('.app');
  let headerClosed=innerWidth<=720;
  try{const pref=localStorage.getItem('survival-map-header');if(pref==='open'||pref==='closed')headerClosed=pref==='closed';}catch(_){}
  function headerLayout(){const mobile=innerWidth<=720;appRoot.style.setProperty('--map-top',mobile?(headerClosed?'76px':`${Math.ceil($('mapHeader').getBoundingClientRect().bottom+12)}px`):'40px');requestDraw();}
  function setHeader(closed,remember=true){headerClosed=closed;$('mapHeader').classList.toggle('hidden',closed);$('mapHeader').inert=closed;$('headerExpand').classList.toggle('hidden',!closed);$('headerExpand').setAttribute('aria-expanded',String(!closed));if(closed){$('search').blur();$('searchResults').classList.add('hidden');$('search').setAttribute('aria-expanded','false');}if(remember)try{localStorage.setItem('survival-map-header',closed?'closed':'open');}catch(_){}headerLayout();}
  $('headerExpand').onclick=()=>{setHeader(false);$('search').focus();};
  $('headerCollapse').onclick=()=>{setHeader(true);$('headerExpand').focus();};
  const headerObserver=new ResizeObserver(()=>headerLayout());headerObserver.observe($('mapHeader'));window.addEventListener('resize',headerLayout);
  new MutationObserver(()=>{$('compactStatus').textContent=offlineReady?'오프라인 준비됨':'저장 미확인';}).observe($('statusPill'),{childList:true,subtree:true});
  $('routeOpen').onclick=()=>toast('도보 자료를 불러오지 못했습니다. 최신 지도 파일이나 앱을 다시 받아주세요.');
  $('compassOpen').onclick=()=>toast('나침반을 불러오지 못했습니다. 최신 지도 파일이나 앱을 다시 받아주세요.');
  const shareNav=document.createElement('button');shareNav.id='navShare';shareNav.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/></svg>위치 공유';$('navOffline').before(shareNav);
  shareNav.onclick=()=>{showHelp();$('offlineState').textContent='위치 공유 기능을 불러오지 못했습니다. 최신 지도 앱이나 지도 파일을 다시 받아주세요.';};
  function showOfflineFailure(message){offlineError=String(message).slice(0,700);updateOffline();for(const fail of offlineFailures)fail(Error(offlineError));}
  function waitForActive(reg){if(reg?.active)return Promise.resolve(reg);return new Promise((resolve,reject)=>{let worker;const done=(error)=>{clearTimeout(timer);offlineFailures.delete(fail);worker?.removeEventListener('statechange',inspect);reg?.removeEventListener('updatefound',inspect);error?reject(error):resolve(reg);};const fail=e=>done(e);const inspect=()=>{if(reg.active){done();return;}const next=reg.installing||reg.waiting;if(next&&next!==worker){worker?.removeEventListener('statechange',inspect);worker=next;worker.addEventListener('statechange',inspect);}if(worker?.state==='redundant')done(Error(offlineError||'지도 설치가 완료되지 않았습니다. 크롬에서 다시 열거나 HTML 파일을 저장하세요.'));};const timer=setTimeout(()=>done(Error(offlineError||'지도 설치가 오래 걸립니다. 연결을 확인하거나 HTML 파일을 저장하세요.')),120000);offlineFailures.add(fail);reg.addEventListener('updatefound',inspect);inspect();});}

  const pinKinds={place:'일반 장소',meeting:'가족 합류',shelter:'직접 확인한 대피 장소',caution:'주의 지점',supply:'확인할 장소'};
  let pins=[];
  try { pins=JSON.parse(localStorage.getItem('duru-pins')||'[]').filter(validPin); } catch (_) {}
  function validPin(p) { return p && typeof p.n==='string' && p.n.length<=120 && Number.isFinite(p.lon) && p.lon>=-180 && p.lon<=180 && Number.isFinite(p.lat) && p.lat>=-85 && p.lat<=85 && (!p.note||(typeof p.note==='string'&&p.note.length<=300)) && (!p.kind||['place','meeting','shelter','caution','supply'].includes(p.kind)) && (!p.checkedAt||(typeof p.checkedAt==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(p.checkedAt))); }
  const regions = [
    ['경기도',127.15,37.55],['강원특별자치도',128.25,37.7],['충청북도',127.82,36.8],['충청남도',126.82,36.5],['전북특별자치도',127.12,35.74],['전라남도',126.9,34.8],['경상북도',128.9,36.3],['경상남도',128.15,35.36],['제주특별자치도',126.56,33.36]
  ];
  const anchors = [
    {n:'서울',lon:126.978,lat:37.5665,type:'도시',alt:'서울특별시 Seoul'},
    {n:'부산',lon:129.0756,lat:35.1796,type:'도시',alt:'부산광역시 Busan'},
    {n:'인천',lon:126.7052,lat:37.4563,type:'도시',alt:'인천광역시 Incheon'},
    {n:'대구',lon:128.6014,lat:35.8714,type:'도시',alt:'대구광역시 Daegu'},
    {n:'대전',lon:127.3845,lat:36.3504,type:'도시',alt:'대전광역시 Daejeon'},
    {n:'광주',lon:126.8526,lat:35.1595,type:'도시',alt:'광주광역시 Gwangju'},
    {n:'울산',lon:129.3114,lat:35.5396,type:'도시',alt:'울산광역시 Ulsan'},
    {n:'세종',lon:127.289,lat:36.48,type:'도시',alt:'세종특별자치시 Sejong'},
    {n:'제주',lon:126.5312,lat:33.4996,type:'도시',alt:'제주시 Jeju'},
    {n:'독도',lon:131.869,lat:37.241,type:'섬',alt:'Dokdo'},
    {n:'울릉도',lon:130.9,lat:37.5,type:'섬',alt:'울릉군 Ulleung'}
  ];
  const norm = s => String(s||'').toLocaleLowerCase().replace(/\s/g,'');
  // Place rank drives both label priority and the zoom at which a place appears.
  const placeTypes={city:['도시',1,7],town:['읍·마을',2,8],suburb:['동·지역',3,10],quarter:['동·지역',3,10.5],village:['마을·리',4,11]};
  for(const a of anchors){a.rank=0;a.minZ=0;}
  const places = [...anchors, ...(data.places||[]).map(p=>{const t=placeTypes[p.type]||[p.type,4,11];return {...p,alt:Array.isArray(p.alt)?p.alt.join(' '):p.alt,type:t[0],rank:t[1],minZ:t[2]};}).filter(p => !anchors.some(a => norm(p.n)===norm(a.n) || (Math.abs(p.lon-a.lon)<.035 && Math.abs(p.lat-a.lat)<.035)))].sort((a,b)=>a.rank-b.rank);
  const facilityKinds={hospital:['병원','#c0392b','병',11.5],fire:['소방서','#d35400','소',11.5],police:['경찰','#2c5aa0','경',12.5],townhall:['관공서','#2f7d5b','관',13],school:['학교','#7b5ea7','학',13],station:['역','#3f4a59','역',10.5],entrance:['지하철 출입구','#5a6fa0','출',13.5]};
  const legend=document.createElement('dialog');legend.id='legendDialog';legend.className='modal legend-modal';
  const pinSymbol=color=>`<svg class="legend-pin" viewBox="0 0 24 32" aria-hidden="true"><path fill="${color}" d="M12 31C10 24 1 19 1 11a11 11 0 0 1 22 0c0 8-9 13-11 20Z"/><circle cx="12" cy="11" r="3" fill="#fff"/></svg>`;
  legend.innerHTML=`<div class="modal-card"><div class="modal-header"><div><span class="eyebrow">지도 범례</span><h2>점·기호 안내</h2></div><button id="legendClose" class="icon-button" aria-label="점·기호 안내 닫기">×</button></div><p class="legend-intro">색 점은 지도에 등록된 시설입니다. 점을 누르면 종류와 이름을 볼 수 있고, 확대하면 ‘병·소·역’ 같은 글자가 나타납니다.</p><h3>시설 위치</h3><dl class="legend-list">${Object.entries(facilityKinds).map(([key,[label,color,letter]])=>`<div><dt><span class="legend-dot ${key==='entrance'?'legend-square':''}" style="--mark-color:${color}" aria-hidden="true">${key==='entrance'?'3':letter}</span>${label}</dt><dd>${key==='hospital'?'빨간 점 · 병원 위치':key==='fire'?'주황 점 · 소방서 위치':key==='station'?'짙은 회색 점 · 철도·지하철역':key==='entrance'?'파란 네모 · 숫자는 출구 번호':key==='police'?'파란 점 · 경찰 시설':key==='townhall'?'초록 점 · 관공서': '보라 점 · 학교'}</dd></div>`).join('')}</dl><p class="legend-note">점이 있다고 현재 운영·출입·진료가 가능하다는 뜻은 아닙니다. 학교·역·지하철 출구를 공식 대피소로 표시한 것이 아닙니다.</p><h3>선택·저장·수신한 위치</h3><dl class="legend-list"><div><dt>${pinSymbol('#214f47')}선택한 위치</dt><dd>짙은 초록 핀 · 지금 눌러 확인 중인 지점</dd></div><div><dt>${pinSymbol('#db804c')}저장한 장소</dt><dd>주황 핀 · 직접 저장한 장소. 합류는 청회색, 주의는 적갈색입니다.</dd></div><div><dt><span class="legend-gps" aria-hidden="true"></span>GPS 수신 위치</dt><dd>파란 점과 오차 범위 · 오래되면 회색으로 표시. 수신 시각·오차를 확인하세요.</dd></div><div><dt><span class="legend-dot" style="--mark-color:#818886" aria-hidden="true">받</span>받은 위치</dt><dd>상대가 보낸 위치 카드 · 현재 위치나 신원은 확인되지 않았습니다.</dd></div><div><dt><span class="legend-goal" aria-hidden="true">목</span>받은 목표 지점</dt><dd>황토색 마름모 · 위치 카드에서 정한 목적지</dd></div><div><dt><span class="legend-place" aria-hidden="true"></span>작은 지명 점</dt><dd>작은 녹색 점 · 도시·읍·동·마을의 이름 위치</dd></div></dl><h3>길과 회피 표시</h3><dl class="legend-list"><div><dt><span class="legend-line legend-road" aria-hidden="true"></span>주요 도로</dt><dd>황토색 선 · 전국 개요 도로</dd></div><div><dt><span class="legend-line legend-rail" aria-hidden="true"></span>철도</dt><dd>회색 선과 흰 점선 · 지하·터널 구간은 옅은 점선</dd></div><div><dt><span class="legend-cross" aria-hidden="true">×</span>철도 건널목</dt><dd>확대했을 때 보이는 X 표시</dd></div><div><dt><span class="legend-line legend-walk" aria-hidden="true"></span>시범 도보 도로</dt><dd>가는 회색 선 · 서울역 주변 도보 기능 사용 시 표시</dd></div><div><dt><span class="legend-line legend-route" aria-hidden="true"></span>계산한 도보 경로</dt><dd>파란 선 · ‘출’은 출발점, ‘도’는 도착점. 현장 통행·안전 미확인</dd></div><div><dt><span class="legend-zone" aria-hidden="true"></span>직접 지정한 회피 구역</dt><dd>주황 원 · 사용자가 지정한 범위이며 공식 통제 정보가 아닙니다.</dd></div><div><dt><span class="legend-line legend-boundary" aria-hidden="true"></span>도보 시범 지역 경계</dt><dd>파란 점선 사각형 · 이 안의 자료만 길찾기에 사용</dd></div></dl><p class="legend-note">표시가 없다고 시설이나 길이 없는 것은 아닙니다. 확대 수준과 지도 표시 설정에 따라 일부 기호를 생략합니다.</p></div>`;
  document.body.append(legend);$('legendOpen').onclick=()=>legend.showModal();$('legendClose').onclick=()=>legend.close();legend.addEventListener('click',e=>{if(e.target===legend)legend.close();});
  const railPoints=[...(data.stations||[]).map(s=>({k:'station',n:s.n,lon:s.lon,lat:s.lat})),...(data.subwayEntrances||[]).map(e=>({k:'entrance',n:e.n,lon:e.lon,lat:e.lat}))];
  const facilities=[...(data.facilities||[]),...railPoints].filter(f=>facilityKinds[f.k]).map(f=>({n:f.n,lon:f.lon,lat:f.lat,kind:f.k,type:facilityKinds[f.k][0],label:/[가-힣]/.test(f.n)?f.n:facilityKinds[f.k][0],facility:true,group:f.k==='station'||f.k==='entrance'?'rail':'facility',rank:f.k==='station'?5:6,minZ:facilityKinds[f.k][3],exit:f.k==='entrance'?((f.n.match(/(\d+(?:-\d+)?)번 출구/)||[])[1]||''):''}));
  // Stations and subway entrances follow the rail layer switch; other facilities follow the facility switch.
  const facilityOn=f=>$(f.group==='rail'?'showRail':'showFacilities').checked;
  const searchPlaces = [...places,...regions.map(r=>({n:r[0],lon:r[1],lat:r[2],type:'시·도',alt:r[0],rank:0})),...facilities];
  for(const p of searchPlaces)p.key=norm(p.n+' '+(p.alt||''));
  const projectedFeature = fc => (fc?.features||[]).map(f=>{
    const g=f.geometry;
    if (!g) return null;
    const polygons=g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];
    return {p:f.properties,polys:polygons.map(poly=>poly.map(ring=>ring.map(c=>project(c[0],c[1]))))};
  }).filter(Boolean);
  const land=projectedFeature(data.land), boundaries=projectedFeature(data.regions);
  // Lines arrive as 1e-5 polylines (lat, lon); decode once into projected x,y pairs.
  function decodeLine(str){const out=[];let i=0,lat=0,lon=0;while(i<str.length){for(let k=0;k<2;k++){let b,shift=0,res=0;do{b=str.charCodeAt(i++)-63;res|=(b&31)<<shift;shift+=5;}while(b>=32);const d=res&1?~(res>>1):res>>1;if(k)lon+=d;else lat+=d;}const p=project(lon/1e5,lat/1e5);out.push(p[0],p[1]);}return Float64Array.from(out);}
  function bounds(xy){let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(let i=0;i<xy.length;i+=2){if(xy[i]<minX)minX=xy[i];if(xy[i]>maxX)maxX=xy[i];if(xy[i+1]<minY)minY=xy[i+1];if(xy[i+1]>maxY)maxY=xy[i+1];}return [minX,minY,maxX,maxY];}
  // Long lines are cut into short overlapping pieces so off-screen parts are skipped cheaply.
  function prepLine(r){const all=r.p?decodeLine(r.p):Float64Array.from((r.c||[]).flatMap(c=>project(c[0],c[1]))),k=r.k??['motorway','trunk','primary','secondary','tertiary'].indexOf(r.type),n=r.n||'',out=[],step=128;for(let i=0;i<all.length-2;i+=step){const xy=all.subarray(i,Math.min(all.length,i+step+2));out.push({k,n,xy,b:bounds(xy)});}return out;}
  const roads=(data.roads||[]).flatMap(prepLine).filter(r=>r.xy.length>=4),roadCount=(data.roads||[]).length;
  const roadClasses=[[],[],[],[],[]];for(const r of roads)roadClasses[clamp(r.k,0,4)].push(r);
  const rivers=(data.rivers||[]).flatMap(prepLine).filter(r=>r.xy.length>=4);
  // Railways keep tunnel/bridge flags; tunnels are drawn faintly because they cannot be crossed or seen on the surface.
  const railways=(data.railways||[]).flatMap(r=>prepLine(r).map(part=>({...part,tunnel:r.t===1,bridge:r.b===1}))).filter(r=>r.xy.length>=4),railCount=(data.railways||[]).length;
  const railCrossings=(data.railCrossings||[]).map(c=>({xy:project(c[1],c[0]),pedestrian:c[2]===1}));
  for (const p of [...places,...facilities]) p.xy=project(p.lon,p.lat);
  function screen(xy) { const s=256*2**camera.z; return [(xy[0]-camera.x)*s+w/2,(xy[1]-camera.y)*s+h/2]; }
  function at(x,y) { const s=256*2**camera.z; return unproject(camera.x+(x-w/2)/s,camera.y+(y-h/2)/s); }
  function constrainCamera(){
    if(!w||!h)return;
    const s=256*2**camera.z,mobile=innerWidth<=720;
    const pad={left:mobile?24:Math.min(headerClosed?24:380,w*.35),right:24,top:Math.min(mobile?(headerClosed?80:190):80,h*.3),bottom:Math.min(110,h*.22)};
    const nw=project(124.6,38.8),se=project(132.2,32.8);
    for(const [axis,size,start,end,lo,hi] of [['x',w,pad.left,pad.right,nw[0],se[0]],['y',h,pad.top,pad.bottom,nw[1],se[1]]]){
      const span=Math.max(80,size-start-end)/s,offset=(start-end)/2/s,extent=hi-lo;
      // At overview scale allow a little movement; zoomed views stay inside Korea and nearby waters.
      const slack=Math.min(extent*.12,span*.08);
      const min=span>=extent?(lo+hi)/2-slack:lo+span/2;
      const max=span>=extent?(lo+hi)/2+slack:hi-span/2;
      camera[axis]=clamp(camera[axis],min-offset,max-offset);
    }
  }
  function requestDraw() { constrainCamera();const note=document.querySelector('.map-caution');if(note){const text=camera.z>=15?'확대 보기 · 전국 도로 약 20m 단순화 · 상세는 서울역 주변':'전국 개요 · 현장 위험·통행 미확인';if(note.textContent!==text)note.textContent=text;}if(!raf) raf=requestAnimationFrame(()=>{raf=0;draw();}); }
  function shape(features,fill,stroke,lineWidth=1) {
    ctx.fillStyle=fill;ctx.strokeStyle=stroke;ctx.lineWidth=lineWidth;
    for(const f of features){ctx.beginPath();for(const poly of f.polys)for(const ring of poly){ring.forEach((xy,i)=>{const p=screen(xy); i?ctx.lineTo(...p):ctx.moveTo(...p);});ctx.closePath();}if(fill)ctx.fill('evenodd');if(stroke)ctx.stroke();}
  }
  // Skips vertices closer than ~1px on screen so country-wide views stay fast.
  function linePath(xy){const s=256*2**camera.z,ox=w/2-camera.x*s,oy=h/2-camera.y*s,n=xy.length;let lx=xy[0]*s+ox,ly=xy[1]*s+oy;ctx.moveTo(lx,ly);for(let i=2;i<n;i+=2){const x=xy[i]*s+ox,y=xy[i+1]*s+oy;if(i===n-2||Math.abs(x-lx)+Math.abs(y-ly)>=1.2){ctx.lineTo(x,y);lx=x;ly=y;}}}
  function inView(xy,margin=70){const p=screen(xy);return p[0]>-margin&&p[0]<w+margin&&p[1]>-margin&&p[1]<h+margin;}
  function roadVisible(r){const s=256*2**camera.z,dx=(w/2+100)/s,dy=(h/2+100)/s;return r.b[2]>camera.x-dx&&r.b[0]<camera.x+dx&&r.b[3]>camera.y-dy&&r.b[1]<camera.y+dy;}
  function textLabel(text,x,y,size,color,weight='500') {ctx.font=`${weight} ${size}px system-ui, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineJoin='round';ctx.lineWidth=3.8;ctx.strokeStyle='#f8f7ed';ctx.strokeText(text,x,y);ctx.fillStyle=color;ctx.fillText(text,x,y);}
  function drawBase(){
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle='#deebe7';ctx.fillRect(0,0,w,h);
    // Geographic grid is decorative; all map features use geographic coordinates.
    ctx.strokeStyle='rgba(86,128,118,.07)';ctx.lineWidth=1;
    const step=camera.z<7?2:camera.z<9?1:.25;
    const bl=at(0,h),tr=at(w,0);
    for(let lon=Math.floor(bl[0]/step)*step;lon<tr[0];lon+=step){const x=screen(project(lon,36))[0];ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
    for(let lat=Math.floor(bl[1]/step)*step;lat<tr[1];lat+=step){const y=screen(project(127,lat))[1];ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
    shape(land,'#f6f4e9','#95b2a6',1.05);
    if($('showRegions').checked){ctx.setLineDash([3,4]);shape(boundaries,null,'#bdc4b3',.8);ctx.setLineDash([]);}
    if(camera.z>=7.5){ctx.lineJoin='round';ctx.lineCap='round';ctx.strokeStyle='#9ec5c0';ctx.lineWidth=camera.z<10?1:1.6;ctx.beginPath();for(const r of rivers)if(roadVisible(r))linePath(r.xy);ctx.stroke();}
    const zf=clamp((camera.z-4)/3,.7,1.8);
    const roadLabels=[];
    if($('showRoads').checked){
      // [class, color, width, minimum zoom]; minor classes first so major roads paint on top.
      const styles=[[4,'#e6dcc0',.8,10],[3,'#e0d3a6',1,8],[2,'#ddd1aa',camera.z<7?.55:1.2,0],[1,'#c1b783',camera.z<7?.7:1.5,0],[0,'#d2a061',camera.z<7?.95:2.1,0]];
      ctx.lineJoin='round';ctx.lineCap='round';
      for(const [k,color,width,minZ] of styles){if(camera.z<minZ)continue;ctx.lineWidth=width*zf*(k>=3&&camera.z>=11?1.4:1);ctx.strokeStyle=color;ctx.beginPath();for(const r of roadClasses[k])if(roadVisible(r))linePath(r.xy);ctx.stroke();}
      if(camera.z>=9){const maxK=camera.z>=11?4:camera.z>=10?3:2,s=256*2**camera.z;let count=0;const used=[];for(let k=0;k<=maxK&&count<=35*labelScale;k++)for(const r of roadClasses[k]){if(count>35*labelScale)break;if(!r.n||r.xy.length<8||!roadVisible(r))continue;const m=Math.floor(r.xy.length/4)*2,p=[(r.xy[m]-camera.x)*s+w/2,(r.xy[m+1]-camera.y)*s+h/2];if(p[0]<50||p[0]>w-50||p[1]<140||p[1]>h-160||used.some(a=>Math.hypot(a[0]-p[0],a[1]-p[1])<90))continue;roadLabels.push([r.n,p]);used.push(p);count++;}}
    }
    if($('showRail').checked&&camera.z>=7){
      ctx.lineJoin='round';ctx.lineCap='butt';const visible=railways.filter(roadVisible),detail=camera.z>=9;
      if(camera.z>=10.5){ctx.setLineDash([3,4]);ctx.strokeStyle='rgba(110,116,124,.55)';ctx.lineWidth=1.2;ctx.beginPath();for(const r of visible)if(r.tunnel&&(r.k!==1||camera.z>=11))linePath(r.xy);ctx.stroke();ctx.setLineDash([]);}
      const surface=visible.filter(r=>!r.tunnel&&(r.k!==1||camera.z>=10));
      ctx.strokeStyle='#6c7177';ctx.lineWidth=detail?2.4:1;ctx.beginPath();for(const r of surface)linePath(r.xy);ctx.stroke();
      if(detail){ctx.setLineDash([7,7]);ctx.strokeStyle='#f6f4e9';ctx.lineWidth=1.2;ctx.beginPath();for(const r of surface)linePath(r.xy);ctx.stroke();ctx.setLineDash([]);}
      if(camera.z>=13){ctx.strokeStyle='#3b4047';ctx.lineWidth=1.6;ctx.beginPath();for(const c of railCrossings){if(!inView(c.xy,10))continue;const p=screen(c.xy),r=c.pedestrian?3:4;ctx.moveTo(p[0]-r,p[1]-r);ctx.lineTo(p[0]+r,p[1]+r);ctx.moveTo(p[0]+r,p[1]-r);ctx.lineTo(p[0]-r,p[1]+r);}ctx.stroke();}
    }
    // Labels reserve measured boxes so place and facility names never overlap each other.
    const boxes=[];
    const fits=(text,x,y,size,weight)=>{ctx.font=`${weight} ${size}px system-ui, sans-serif`;const bw=ctx.measureText(text).width/2+4,bh=size/2+3;if(boxes.some(q=>Math.abs(q[0]-x)<bw+q[2]&&Math.abs(q[1]-y)<bh+q[3]))return false;boxes.push([x,y,bw,bh]);return true;};
    const big=camera.z>=12.5,visibleFac=camera.z>=10.5?facilities.filter(f=>camera.z>=f.minZ&&facilityOn(f)&&inView(f.xy,20)).sort((a,b)=>a.rank-b.rank):[],showFac=visibleFac.length>0;
    const exitSpots=[];
    for(const f of visibleFac){const pos=screen(f.xy),kind=facilityKinds[f.kind];
      // Subway exits are small numbered squares; exits drawn on top of each other are skipped to keep stations readable.
      if(f.kind==='entrance'){if(exitSpots.some(q=>Math.abs(q[0]-pos[0])<9&&Math.abs(q[1]-pos[1])<9))continue;exitSpots.push(pos);const r=6;ctx.fillStyle=kind[1];ctx.strokeStyle='#fff';ctx.lineWidth=1.2;ctx.beginPath();ctx.roundRect?ctx.roundRect(pos[0]-r,pos[1]-r,r*2,r*2,2):ctx.rect(pos[0]-r,pos[1]-r,r*2,r*2);ctx.fill();ctx.stroke();ctx.font=`700 ${f.exit.length>2?6:8}px system-ui, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#fff';ctx.fillText(f.exit||'출',pos[0],pos[1]+.5);continue;}
      ctx.beginPath();ctx.arc(pos[0],pos[1],big?7:4,0,Math.PI*2);ctx.fillStyle=kind[1];ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=big?1.5:1;ctx.stroke();if(big){ctx.font='700 8px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#fff';ctx.fillText(kind[2],pos[0],pos[1]+.5);boxes.push([pos[0],pos[1],8,8]);}}
    if($('showLabels').checked){
      let count=0;
      for(const p of places){if(camera.z<p.minZ||!inView(p.xy))continue;const a=p.rank===0,pos=screen(p.xy),size=a?13:p.rank>=3?10:11,weight=a?'650':'500';if(camera.z<8&&!a&&boxes.some(q=>Math.hypot(q[0]-pos[0],q[1]-pos[1]+13)<60))continue;if(!fits(p.n,pos[0],pos[1]-13,size,weight))continue;
        ctx.beginPath();ctx.arc(pos[0],pos[1],a?3:2,0,Math.PI*2);ctx.fillStyle=a?'#3c665b':'#849684';ctx.fill();textLabel(p.n,pos[0],pos[1]-13,size,a?'#2e5146':p.rank>=3?'#6b7f72':'#5b7466',weight);
        if(++count>140*labelScale)break;
      }
      if(camera.z<8.3) for(const r of regions){const p=screen(project(r[1],r[2])),text=r[0].replace('특별자치도',''),size=camera.z<6.2?11:13;if(fits(text,p[0],p[1],size,'600'))textLabel(text,p[0],p[1],size,'#879281','600');}
    }
    for(const [text,p] of roadLabels)if(fits(text,p[0],p[1],10,'500'))textLabel(text,p[0],p[1],10,'#887c58');
    if(showFac&&camera.z>=11){let count=0;for(const f of visibleFac){if(f.kind==='entrance'||(f.kind!=='station'&&camera.z<13))continue;const pos=screen(f.xy);if(!fits(f.label,pos[0],pos[1]+16,10,'600'))continue;textLabel(f.label,pos[0],pos[1]+16,10,'#4d5a52','600');if(++count>60*labelScale)break;}}
    for(const overlay of overlays)overlay.drawBase?.({ctx,screen,project,camera,w,h});
    // Sea names are geographic labels, kept away from the mainland.
    if(camera.z<8){for(const t of [['서해',124.9,35.7],['동해',130.7,37.1],['남해',128,33.8]]){const p=screen(project(t[1],t[2]));ctx.font='12px system-ui';ctx.fillStyle='#87aaa2';ctx.textAlign='center';ctx.fillText(t[0],p[0],p[1]);}}
  }
  function interact(){interacting=true;clearTimeout(settleTimer);settleTimer=setTimeout(()=>{interacting=false;requestDraw();},160);}
  function draw(){
    const key=[w,h,dpr,...['showRoads','showRegions','showLabels','showFacilities','showRail'].map(id=>$(id).checked)].join();
    // The cached map extends beyond the screen so dragging and pinching reveal real map, not blank edges.
    const margin=Math.max(.15,Math.min(.5,(Math.sqrt(8e6/Math.max(1,canvas.width*canvas.height))-1)/2)),mx=Math.round(w*margin),my=Math.round(h*margin);
    const s1=256*2**camera.z,stale=!baseView||baseView.key!==key||Math.abs((baseView.x-camera.x)*s1)>baseView.mx*.9||Math.abs((baseView.y-camera.y)*s1)>baseView.my*.9||Math.abs(camera.z-baseView.z)>1;
    if(!interacting||stale){const bw=w+2*mx,bh=h+2*my,pw=Math.round(bw*dpr),ph=Math.round(bh*dpr);if(baseCanvas.width!==pw||baseCanvas.height!==ph){baseCanvas.width=pw;baseCanvas.height=ph;}const vw=w,vh=h;labelScale=(bw*bh)/(vw*vh);w=bw;h=bh;ctx=baseCtx;try{drawBase();}finally{ctx=mainCtx;w=vw;h=vh;}baseView={x:camera.x,y:camera.y,z:camera.z,key,mx,my};}
    ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#deebe7';ctx.fillRect(0,0,canvas.width,canvas.height);
    const k=2**(camera.z-baseView.z);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.save();ctx.translate(w/2+(baseView.x-camera.x)*s1,h/2+(baseView.y-camera.y)*s1);ctx.scale(k,k);ctx.drawImage(baseCanvas,-w/2-baseView.mx,-h/2-baseView.my,w+2*baseView.mx,h+2*baseView.my);ctx.restore();
    for(const overlay of overlays)overlay.draw?.({ctx,screen,project,camera,w,h});
    for(const pin of pins) drawMarker(pin,pin.kind==='caution'?'#a64332':pin.kind==='meeting'?'#5066a0':'#db804c',false);
    if(selected)drawMarker(selected,'#214f47',true);
    if(gps){const p=screen(project(gps.lon,gps.lat));const metersPerPixel=156543.03392*Math.cos(gps.lat*Math.PI/180)/2**camera.z;ctx.beginPath();ctx.arc(...p,clamp(gps.accuracy/metersPerPixel,9,150),0,Math.PI*2);ctx.fillStyle='rgba(57,125,186,.12)';ctx.fill();ctx.beginPath();ctx.arc(...p,6,0,Math.PI*2);ctx.fillStyle=Date.now()-gps.timestamp>120000?'#7c8587':'#3984bd';ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();}
    updateScale();
  }
  function drawMarker(p,color,active){const xy=screen(project(p.lon,p.lat));ctx.save();ctx.translate(...xy);if(active){ctx.beginPath();ctx.arc(0,0,16,0,Math.PI*2);ctx.fillStyle='rgba(33,79,71,.13)';ctx.fill();}ctx.beginPath();ctx.moveTo(0,1);ctx.bezierCurveTo(-19,-17,-10,-30,0,-30);ctx.bezierCurveTo(10,-30,19,-17,0,1);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=1.8;ctx.stroke();ctx.beginPath();ctx.arc(0,-19,3,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.restore();}
  function updateScale(){const lonlat=at(w/2,h/2),mpp=156543.03392*Math.cos(lonlat[1]*Math.PI/180)/2**camera.z;const raw=mpp*75,base=10**Math.floor(Math.log10(raw)),n=[1,2,5,10].filter(v=>v*base<=raw).pop()*base;$('scaleLine').style.width=`${n/mpp}px`;$('scaleText').textContent=n>=1000?`${n/1000} km`:`${n} m`;}
  function resize(){const rect=canvas.getBoundingClientRect();w=rect.width;h=rect.height;dpr=document.body.classList.contains('low-power')?1:Math.min(devicePixelRatio||1,2);canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);requestDraw();}
  function fit(){const mobile=innerWidth<=720;const pad={left:mobile?32:headerClosed?32:400,right:mobile?45:100,top:mobile?(headerClosed?80:180):80,bottom:mobile?160:120};const a=project(124.75,32.95),b=project(132.05,38.65);const aw=Math.max(150,w-pad.left-pad.right),ah=Math.max(200,h-pad.top-pad.bottom);camera.z=clamp(Math.log2(Math.min(aw/Math.abs(a[0]-b[0]),ah/Math.abs(a[1]-b[1]))/256),5,9);const s=256*2**camera.z;camera.x=(a[0]+b[0])/2-(pad.left-pad.right)/2/s;camera.y=(a[1]+b[1])/2-(pad.top-pad.bottom)/2/s;requestDraw();}
  function zoom(delta,x=w/2,y=h/2){const before=at(x,y);camera.z=clamp(camera.z+delta,5,MAX_ZOOM);const after=at(x,y),bp=project(...before),ap=project(...after);camera.x+=bp[0]-ap[0];camera.y+=bp[1]-ap[1];requestDraw();}
  function fly(p,z=9){z=clamp(z,5,MAX_ZOOM);const xy=project(p.lon,p.lat);camera.x=xy[0];camera.y=xy[1];camera.z=z;const s=256*2**z;if(innerWidth>720&&!headerClosed)camera.x-=170/s;else camera.y+=40/s;requestDraw();}
  function toast(text){$('toast').textContent=text;$('toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').classList.add('hidden'),3500);}
  function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function isSaved(p){return pins.some(q=>Math.abs(q.lat-p.lat)<.0001&&Math.abs(q.lon-p.lon)<.0001);}
  function savePins(){try{localStorage.setItem('duru-pins',JSON.stringify(pins));return true;}catch(_){toast('이 브라우저에서는 장소를 보관할 수 없습니다. 내 장소 백업을 이용하세요.');return false;}}
  function updateCount(){$('savedCount').textContent=pins.length||'';}
  function selectPlace(p,move=true){const isFacility=p.facility===true||Object.values(facilityKinds).some(k=>k[0]===p.type);selected={n:p.n,lon:p.lon,lat:p.lat,type:p.type||'선택한 위치',facility:isFacility,kind:p.kind||'place',note:p.note||'',checkedAt:p.checkedAt||''};if(move)fly(p,p.type==='시·도'?8:isFacility?Math.max(13,Number.isFinite(p.minZ)?p.minZ:13):p.minZ>=10?Math.max(12,p.minZ+.5):10);$('bottomPanel').classList.remove('hidden');$('panelEyebrow').textContent=p.type==='시·도'?'지역':'선택한 장소';$('panelTitle').textContent=p.n;$('panelSubtitle').textContent=p.type==='선택한 위치'?'지도를 눌러 선택한 위치':isFacility?`${p.type} · OpenStreetMap 참고 자료. 운영·개방 여부는 확인되지 않았고 대피시설 지정이 아닙니다.`:'인터넷 없이 이 장소를 다시 찾아보세요';$('panelBody').innerHTML=`<p class="place-coordinates">${p.lat.toFixed(5)}° N &nbsp; ${p.lon.toFixed(5)}° E</p><label class="pin-name">장소 이름<input id="pinName" type="text" maxlength="120" aria-label="장소 이름" value="${escapeHtml(p.n)}"></label><label class="pin-name">분류<select id="pinKind">${Object.entries(pinKinds).map(([key,label])=>`<option value="${key}" ${key===selected.kind?'selected':''}>${label}</option>`).join('')}</select></label><label class="pin-name">메모<textarea id="pinNote" maxlength="300" placeholder="입구·계단·장애물 등 직접 확인한 내용">${escapeHtml(selected.note)}</textarea></label><label class="pin-name">확인일<input id="pinCheckedAt" type="date" value="${escapeHtml(selected.checkedAt)}"></label>${isSaved(p)?'<button id="updatePlace" class="secondary-button wide">저장한 정보 수정</button>':''}<div class="action-row"><button id="savePlace" class="primary-button">${isSaved(p)?'저장한 장소 삭제':'☆ 내 장소에 저장'}</button><button id="copyCoords" class="secondary-button">좌표 복사</button></div>`;
    $('savePlace').onclick=()=>{if(isSaved(selected)){if(!confirm('이 기기에 저장한 장소를 삭제할까요? 백업 파일은 변경하지 않습니다.'))return;pins=pins.filter(q=>!(Math.abs(q.lat-selected.lat)<.0001&&Math.abs(q.lon-selected.lon)<.0001));toast('저장한 장소를 삭제했습니다.');}else{readPinFields();pins.push({...selected});toast('내 장소에 저장했습니다.');}savePins();updateCount();selectPlace(selected,false);};
    function readPinFields(){selected.n=$('pinName').value.trim()||selected.n;selected.kind=$('pinKind').value;selected.note=$('pinNote').value.trim();selected.checkedAt=$('pinCheckedAt').value;}
    if($('updatePlace'))$('updatePlace').onclick=()=>{const found=pins.find(q=>Math.abs(q.lat-selected.lat)<.0001&&Math.abs(q.lon-selected.lon)<.0001);readPinFields();Object.assign(found,selected);if(savePins())toast('장소 정보를 수정했습니다.');selectPlace(selected,false);};
    $('copyCoords').onclick=async()=>{const text=`지도에서 선택한 장소: ${p.n}\n위도 ${p.lat.toFixed(5)}, 경도 ${p.lon.toFixed(5)} (WGS84)\n선택한 장소의 좌표이며 현재 GPS 위치가 아닙니다.`;try{await navigator.clipboard.writeText(text);toast('좌표를 복사했습니다.');}catch(_){toast(text);}};
    setNav('navMap');requestDraw();}
  // Only features drawn at the current zoom can be tapped.
  function nearest(x,y){let best=null;const consider=p=>{const q=screen(p.xy),d=Math.hypot(q[0]-x,q[1]-y);if(d<24&&(!best||d<best.d))best={p,d};};for(const p of pins)consider({...p,xy:project(p.lon,p.lat)});for(const f of facilities)if(camera.z>=f.minZ&&facilityOn(f))consider(f);if(!best)for(const p of places)if(camera.z>=p.minZ)consider(p);return best;}
  function closePanel(){selected=null;$('bottomPanel').classList.add('hidden');setNav('navMap');requestDraw();}
  function setNav(id){for(const el of document.querySelectorAll('.bottom-nav button'))el.classList.toggle('active',el.id===id);}
  function savedPanel(){setNav('navSaved');$('bottomPanel').classList.remove('hidden');$('panelEyebrow').textContent='나만의 지도';$('panelTitle').textContent='내 장소';$('panelSubtitle').textContent=`이 기기에 저장한 장소 ${pins.length}개`;$('panelBody').innerHTML=pins.length?pins.map((p,i)=>`<button class="saved-item" data-pin="${i}"><span class="saved-symbol">●</span><span><strong>${escapeHtml(p.n)}</strong><small>${escapeHtml(pinKinds[p.kind]||'일반 장소')} · ${escapeHtml(p.checkedAt||'확인일 미입력')}</small><small>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</small></span><span>↗</span></button>`).join(''):'<div class="empty-state"><span>☆</span><h3>기억하고 싶은 곳을 담으세요</h3><p>도시를 검색하거나 지도 위를 눌러<br>‘내 장소에 저장’을 선택하세요.</p></div>';for(const b of document.querySelectorAll('[data-pin]'))b.onclick=()=>selectPlace(pins[Number(b.dataset.pin)]);}
  function search(){const q=norm($('search').value);$('clearSearch').classList.toggle('hidden',!q);const box=$('searchResults');if(!q){box.classList.add('hidden');$('search').setAttribute('aria-expanded','false');return;}let hits=searchPlaces.filter(p=>p.key.includes(q)).sort((a,b)=>(norm(b.n)===q)-(norm(a.n)===q)||(norm(b.n).startsWith(q))-(norm(a.n).startsWith(q))||(a.rank||0)-(b.rank||0)).slice(0,20);box.classList.remove('hidden');$('search').setAttribute('aria-expanded','true');box.innerHTML=hits.length?hits.map((p,i)=>`<button role="option" class="result" data-result="${i}"><span class="result-icon">⌖</span><span><strong>${escapeHtml(p.n)}</strong><small>${escapeHtml(p.type||'도시·마을')} · ${p.lat.toFixed(2)}° N</small></span><span>↗</span></button>`).join(''):'<div class="no-results">저장된 도시·지역에서 찾지 못했습니다.<br><small>상세 주소와 상호명은 검색되지 않습니다.</small></div>';for(const b of box.querySelectorAll('[data-result]'))b.onclick=()=>{selectPlace(hits[+b.dataset.result]);box.classList.add('hidden');$('search').setAttribute('aria-expanded','false');$('search').blur();};search.hits=hits;}
  $('search').addEventListener('input',search);$('search').addEventListener('keydown',e=>{if(e.key==='Enter'&&search.hits?.length){selectPlace(search.hits[0]);$('searchResults').classList.add('hidden');$('search').setAttribute('aria-expanded','false');$('search').blur();}if(e.key==='Escape'){$('searchResults').classList.add('hidden');$('search').setAttribute('aria-expanded','false');$('search').blur();}});
  $('clearSearch').onclick=()=>{$('search').value='';search();$('search').focus();};
  for(const b of document.querySelectorAll('[data-city]'))b.onclick=()=>selectPlace(anchors.find(p=>p.n===b.dataset.city));
  $('zoomIn').onclick=()=>zoom(1);$('zoomOut').onclick=()=>zoom(-1);$('fit').onclick=fit;$('homeChip').onclick=()=>{closePanel();fit();};$('closePanel').onclick=closePanel;$('navMap').onclick=closePanel;$('navSaved').onclick=savedPanel;
  $('layers').onclick=()=>$('layerPanel').classList.toggle('hidden');for(const id of ['showRoads','showRegions','showLabels','showFacilities','showRail'])$(id).onchange=requestDraw;
  const pointers=new Map();let gesture=null,lastTap=0;
  canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,[e.offsetX,e.offsetY]);if(pointers.size===1)gesture={x:e.offsetX,y:e.offsetY,cx:camera.x,cy:camera.y,moved:false,time:performance.now()};else if(pointers.size===2){const a=[...pointers.values()];gesture={distance:Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]),z:camera.z,cx:camera.x,cy:camera.y,mx:(a[0][0]+a[1][0])/2,my:(a[0][1]+a[1][1])/2,moved:true};}canvas.style.cursor='grabbing';});
  canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId)||!gesture)return;pointers.set(e.pointerId,[e.offsetX,e.offsetY]);if(pointers.size===1&&!gesture.distance){const dx=e.offsetX-gesture.x,dy=e.offsetY-gesture.y;if(Math.hypot(dx,dy)>5)gesture.moved=true;const s=256*2**camera.z;camera.x=gesture.cx-dx/s;camera.y=gesture.cy-dy/s;}else if(pointers.size===2&&gesture.distance){const a=[...pointers.values()],d=Math.hypot(a[0][0]-a[1][0],a[0][1]-a[1][1]);camera.z=clamp(gesture.z+Math.log2(d/Math.max(gesture.distance,1)),5,MAX_ZOOM);const s0=256*2**gesture.z,s1=256*2**camera.z;camera.x=gesture.cx+(gesture.mx-w/2)/s0-((a[0][0]+a[1][0])/2-w/2)/s1;camera.y=gesture.cy+(gesture.my-h/2)/s0-((a[0][1]+a[1][1])/2-h/2)/s1;}interact();requestDraw();});
  function pointerUp(e){if(!pointers.has(e.pointerId))return;const g=gesture;if(pointers.size===1&&g&&!g.moved&&!g.distance){const p=at(e.offsetX,e.offsetY);if(performance.now()-lastTap<300){zoom(1,e.offsetX,e.offsetY);lastTap=0;}else{lastTap=performance.now();const overlayHit=overlays.map(o=>o.hit?.(e.offsetX,e.offsetY)).find(Boolean);if(overlayHit){overlayHit();pointers.delete(e.pointerId);gesture=null;return;}const near=nearest(e.offsetX,e.offsetY);if(near?.d<24)selectPlace(near.p,false);else selectPlace({n:'선택한 위치',lon:p[0],lat:p[1],type:'선택한 위치'},false);}}pointers.delete(e.pointerId);if(pointers.size===1){const point=[...pointers.values()][0];gesture={x:point[0],y:point[1],cx:camera.x,cy:camera.y,moved:true,time:performance.now()};}else gesture=null;canvas.style.cursor='grab';}
  canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',e=>{pointers.delete(e.pointerId);gesture=null;});
  canvas.addEventListener('wheel',e=>{e.preventDefault();interact();zoom(e.deltaY<0?.35:-.35,e.offsetX,e.offsetY);},{passive:false});
  canvas.addEventListener('keydown',e=>{const s=256*2**camera.z;if(e.key==='+'||e.key==='=')zoom(1);else if(e.key==='-')zoom(-1);else if(e.key.startsWith('Arrow')){e.preventDefault();if(e.key==='ArrowLeft')camera.x-=80/s;if(e.key==='ArrowRight')camera.x+=80/s;if(e.key==='ArrowUp')camera.y-=80/s;if(e.key==='ArrowDown')camera.y+=80/s;requestDraw();}});
  $('navEmergency').onclick=()=>{showHelp();$('offlineState').textContent='재난 기능을 불러오지 못했습니다. 지도 파일을 다시 받으세요. 재난문자·정부 방송·현장 통제를 우선 확인하고 재난 종류에 맞게 대피해야 합니다.';};
  $('locate').onclick=()=>{
    if(gpsPending){toast('GPS 확인 중입니다. 수신에 시간이 걸릴 수 있습니다.');return;}
    if(!navigator.geolocation){toast('이 기기는 위치 확인을 지원하지 않습니다.');return;}
    if(!isSecureContext&&!standalone){toast('위치 확인은 보안 연결(HTTPS)에서 사용할 수 있습니다.');return;}
    gpsPending=true;window.dispatchEvent(new Event('duru-position-start'));$('locate').classList.add('locating');toast('GPS 위치를 확인하고 있습니다…');
    navigator.geolocation.getCurrentPosition(pos=>{
      gpsPending=false;$('locate').classList.remove('locating');gps={lon:pos.coords.longitude,lat:pos.coords.latitude,accuracy:pos.coords.accuracy,timestamp:pos.timestamp,fixElapsedMs:pos.fixElapsedMs};
      window.dispatchEvent(new CustomEvent('duru-position',{detail:gps}));fly(gps,11);toast(`현재 위치 · 오차 약 ${Math.round(gps.accuracy)} m`);
    },err=>{
      gpsPending=false;$('locate').classList.remove('locating');
      const message=nativeApp&&err.message?err.message:err.code===1?'위치 권한이 필요합니다. 브라우저 설정에서 허용해주세요.':'GPS 수신에 실패했습니다. 야외에서 다시 시도하거나 수동 기준점을 이용하세요.';
      window.dispatchEvent(new CustomEvent('duru-position-error',{detail:message}));toast(message);
    },{enableHighAccuracy:true,timeout:60000,maximumAge:0});
  };
  function dataInfo(){const meta=data.meta||{};return `<p>지도 포함 범위: 대한민국 해안·시도 개요 경계, 고속도로부터 시·군 단위 도로까지 OSM 5개 도로 등급(motorway·trunk·primary·secondary·tertiary), 이름 있는 강, 도시·읍·동·마을 이름, 병원·소방서·경찰·관공서·학교 위치, 철도 노선(터널·교량 구분)·역·지하철 출입구·철도 건널목. 전국 골목길·건물은 없으며 서울역 주변에만 별도 도보 시범 자료가 있습니다.</p><p>도로·도시: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>, <a href="https://opendatacommons.org/licenses/odbl/1-0/" target="_blank" rel="noopener">ODbL 1.0</a>. 추출·단순화한 데이터도 ODbL로 제공합니다. 도로 ${roadCount.toLocaleString()}개 구간, 지명 ${places.length.toLocaleString()}개, 시설 ${facilities.length.toLocaleString()}개. 시설은 운영 여부·대피시설 지정 여부를 담고 있지 않습니다.</p><p>바탕·경계: Natural Earth / geoBoundaries. Natural Earth 원자료는 퍼블릭 도메인입니다. 일반화한 개요 경계로 최신 행정 경계를 보장하지 않습니다. 독도는 위치 표식으로 표시합니다.</p><p>데이터 준비: ${escapeHtml(meta.downloaded_at||meta.date||'2026-11-15')}. 도로 형태는 용량을 줄이기 위해 약 ${escapeHtml(meta.roadSimplificationMeters||20)}m 허용오차로 단순화했습니다. 지리 자료에는 누락·오차가 있을 수 있습니다.</p><p>앱은 검색어·GPS·내 장소를 서버로 전송하지 않습니다. 최초 지도 다운로드와 접속 시에는 호스팅 서버 연결이 필요합니다.</p>`;}
  $('dataInfo').innerHTML=dataInfo();
  $('dataInfo').lastElementChild.id='connectionInfo';
  if(!standalone){
    const apkLink=document.createElement('a');apkLink.id='downloadApk';apkLink.className='secondary-button wide';apkLink.href='./생존나침반-베타.apk';apkLink.download='생존나침반-1.5.0-베타.apk';apkLink.textContent='안드로이드 앱 1.5.0 베타 설치 파일 받기 · 약 4MB';
    const apkInfo=document.createElement('p');apkInfo.className='small-note';apkInfo.textContent='안드로이드 8 이상용 직접 설치 파일입니다. 지도 자료가 앱에 포함되어 설치 뒤에는 로그인과 인터넷 연결 없이 실행할 수 있습니다. 기존 내 장소·계획은 각각 백업 후 앱에서 가져오세요.';
    $('downloadMap').before(apkLink,apkInfo);
  }
  function updateOffline(){const el=$('statusPill');el.textContent=nativeApp?'오프라인 준비됨':standalone?'파일로 사용 중':offlineError?'저장 오류 확인':offlineReady?'오프라인 준비됨':navigator.onLine?'지도 저장하기':'저장 상태 확인';el.classList.toggle('ready',standalone||offlineReady);$('offlineState').textContent=offlineError|| (nativeApp?'✓ 지도와 앱 화면이 설치 파일에 포함되어 있습니다. 인터넷 연결과 로그인 없이 사용할 수 있습니다.':standalone?'이 파일에는 지도 자료가 모두 들어 있습니다. 파일을 보관하면 인터넷 없이 열 수 있습니다. 홈 화면 설치와 GPS는 브라우저에 따라 제한될 수 있습니다.':offlineReady?'✓ 이 기기에 지도와 앱 화면을 저장했습니다. 비행기 모드에서도 다시 열어 확인하세요.':'지도를 저장하면 인터넷이 끊겨도 이 주소에서 다시 열 수 있습니다.');$('cacheMap').disabled=standalone;$('cacheMap').textContent=standalone?'지도 자료가 파일에 포함되어 있습니다':offlineReady?'저장한 지도 다시 확인':'이 휴대폰에 지도 저장';}
  function showHelp(){updateOffline();$('helpDialog').showModal();updateStorageInfo();}
  async function updateStorageInfo(){let el=$('storageInfo');if(!el){el=document.createElement('p');el.id='storageInfo';el.className='info-note';$('offlineState').after(el);}let text=nativeApp?'지도는 앱에 포함되어 있습니다. 앱 삭제·데이터 삭제 시 내 장소와 계획은 지워집니다.':'저장 지속성: 브라우저 데이터 삭제나 기기 상태에 따라 지도가 사라질 수 있습니다.';try{if(!nativeApp&&navigator.storage?.persisted)text=(await navigator.storage.persisted())?'브라우저 지속 저장: 허용됨. 직접 데이터 삭제 시에는 지도가 지워집니다.':'브라우저 지속 저장: 보장되지 않음. 별도 지도 파일과 백업도 보관하세요.';const ts=localStorage.getItem('duru-pins-last-backup');text+=' 마지막 내 장소 백업 파일 생성: '+(ts?new Date(Number(ts)).toLocaleString('ko-KR'):'없음');}catch(_){}el.textContent=text;}
  $('navOffline').onclick=showHelp;$('statusPill').onclick=showHelp;$('sources').onclick=()=>{showHelp();document.querySelector('.data-details').open=true;};$('closeHelp').onclick=()=>$('helpDialog').close();$('helpDialog').onclick=e=>{if(e.target===$('helpDialog'))$('helpDialog').close();};
  async function checkCache(){if(standalone){offlineReady=true;updateOffline();return;}if(!('serviceWorker'in navigator)||!isSecureContext){updateOffline();return;}try{const r=await navigator.serviceWorker.ready;const channel=new MessageChannel();channel.port1.onmessage=e=>{if(e.data?.type==='CACHE_STATUS'){offlineReady=!!e.data.ready;updateOffline();if(offlineReady&&navigator.storage?.persist)navigator.storage.persist().catch(()=>{});}};r.active?.postMessage({type:'STATUS'},[channel.port2]);}catch(_){} }
  async function saveOffline(){if(standalone)return;$('cacheMap').disabled=true;$('cacheMap').textContent='전국 지도를 저장하고 있습니다…';try{if(!('serviceWorker'in navigator))throw Error('이 브라우저는 오프라인 저장을 지원하지 않습니다. HTML 파일을 저장해주세요.');const setup=await workerSetup;if(!setup)throw Error(offlineError||'이 브라우저에서 지도 설치를 시작하지 못했습니다. 안드로이드 크롬에서 열거나 지도 HTML 파일을 저장하세요.');const reg=await waitForActive(setup);const result=await new Promise((resolve,reject)=>{const mc=new MessageChannel();const timer=setTimeout(()=>reject(Error('저장 시간이 오래 걸립니다. 연결 상태를 확인하고 다시 시도하세요.')),90000);mc.port1.onmessage=e=>{clearTimeout(timer);e.data.ok?resolve(e.data):reject(Error(e.data.error||'지도 저장에 실패했습니다.'));};reg.active.postMessage({type:'CACHE_ALL'},[mc.port2]);});offlineReady=true;offlineError='';updateOffline();toast('지도 저장 완료. 비행기 모드로 확인해보세요.');if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});}catch(e){showOfflineFailure(e.message);toast(e.message);}finally{$('cacheMap').disabled=false;}}
  $('cacheMap').onclick=saveOffline;
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('installApp').classList.remove('hidden');});$('installApp').onclick=async()=>{if(!installPrompt)return;await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('installApp').classList.add('hidden');};
  async function downloadBlob(blob,name){if(window.DURU_SAVE_BACKUP)return window.DURU_SAVE_BACKUP(name,await blob.text());const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),15000);return true;}
  $('downloadMap').onclick=async()=>{if(standalone){toast('지금 열고 있는 HTML 파일이 오프라인 지도입니다. 이 파일을 보관하세요.');return;}try{const r=await fetch('./duru-offline.txt');if(!r.ok)throw Error();downloadBlob(await r.blob(),'생존나침반-한국-오프라인.html');toast('지도 파일을 저장합니다. 다운로드 폴더를 확인하세요.');}catch(_){toast('파일을 받지 못했습니다. 인터넷에 연결한 뒤 다시 시도하세요.');}};
  $('exportPins').onclick=async()=>{const saved=await downloadBlob(new Blob([JSON.stringify({app:'두루지도',version:1,pins},null,2)],{type:'application/json'}),'생존나침반-내장소.json');if(saved){try{localStorage.setItem('duru-pins-last-backup',String(Date.now()));}catch(_){}updateStorageInfo();}};
  $('importPins').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>2000000)throw Error('백업 파일이 너무 큽니다.');const doc=JSON.parse(await f.text());if(doc.app!=='두루지도'||!Array.isArray(doc.pins)||doc.pins.length>5000||!doc.pins.every(validPin))throw Error('올바른 생존나침반 백업 파일이 아닙니다.');for(const p of doc.pins)if(!isSaved(p))pins.push({n:p.n,lon:p.lon,lat:p.lat,type:typeof p.type==='string'?p.type.slice(0,64):'저장 장소',kind:p.kind||'place',note:p.note||'',checkedAt:p.checkedAt||'',facility:p.facility===true});const stored=savePins();updateCount();requestDraw();if(stored)toast('내 장소를 불러왔습니다.');}catch(err){toast(err.message||'백업 파일을 읽지 못했습니다.');}e.target.value='';};
  window.addEventListener('online',()=>{updateOffline();checkCache();});window.addEventListener('offline',updateOffline);window.addEventListener('resize',resize);
  setHeader(headerClosed,false);resize();fit();updateCount();updateOffline();
  if(!standalone&&'serviceWorker'in navigator&&isSecureContext){navigator.serviceWorker.addEventListener('message',e=>{if(e.origin&&e.origin!==location.origin)return;const d=e.data||{};if(d.type==='OFFLINE_INSTALL_PROGRESS'||d.type==='OFFLINE_INSTALL_READY')updateBanner(d);else if(d.type==='OFFLINE_INSTALL_ERROR'){updateBanner(d);if(d.reason!=='update')showOfflineFailure(d.error);}});workerSetup=navigator.serviceWorker.register('./sw.js').then(reg=>{const watch=()=>{const worker=reg.installing;if(worker)worker.addEventListener('statechange',()=>{if(worker.state==='redundant'&&!reg.active&&!offlineError)showOfflineFailure('지도 설치가 완료되지 않았습니다. 안드로이드 크롬에서 다시 열거나 지도 HTML 파일을 저장하세요.');});};reg.addEventListener('updatefound',watch);watch();checkCache();return reg;}).catch(e=>{showOfflineFailure('이 브라우저에서 오프라인 저장을 시작할 수 없습니다. 안드로이드 크롬에서 열거나 지도 HTML 파일을 저장하세요. ('+e.name+': '+e.message+')');return null;});navigator.serviceWorker.addEventListener('controllerchange',checkCache);}else checkCache();

  // Update/download progress never blocks the map: the saved version keeps working until the user reopens.
  const banner=document.createElement('div');banner.id='updateBanner';banner.className='update-banner hidden';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');
  banner.innerHTML='<div class="update-text"><strong id="updateTitle"></strong><span id="updateDetail"></span></div><progress id="updateProgress" max="100" value="0"></progress><div class="update-actions"><button id="updateReload" class="primary-button hidden">지금 다시 열기</button><button id="updateClose" class="icon-button" aria-label="업데이트 안내 닫기">×</button></div>';
  $('toast').before(banner);
  let bannerTimer=0,bannerDismissed='';
  function updateBanner(d){
    const key=d.version+':'+d.type;if(bannerDismissed&&bannerDismissed===key)return;
    clearTimeout(bannerTimer);banner.classList.remove('hidden');banner.classList.toggle('update-failed',d.type==='OFFLINE_INSTALL_ERROR');
    const what=d.reason==='update'?'새 버전':d.reason==='manual'?'저장한 지도 확인':'지도 저장';
    $('updateReload').classList.add('hidden');$('updateProgress').hidden=d.type!=='OFFLINE_INSTALL_PROGRESS';
    if(d.type==='OFFLINE_INSTALL_PROGRESS'){
      const pct=d.totalBytes?Math.min(100,Math.floor(d.doneBytes/d.totalBytes*100)):0;$('updateProgress').value=pct;
      $('updateTitle').textContent=d.reason==='update'?`새 버전 받는 중 · ${pct}%`:d.reason==='manual'?`저장한 지도 다시 확인 중 · ${pct}%`:`이 휴대폰에 지도 저장 중 · ${pct}%`;
      $('updateDetail').textContent=d.reason==='update'?`파일 ${d.doneFiles}/${d.totalFiles} · 지금 지도는 계속 쓸 수 있습니다.`:`파일 ${d.doneFiles}/${d.totalFiles} · 받는 동안에도 지도를 쓸 수 있습니다.`;
    }else if(d.type==='OFFLINE_INSTALL_READY'){
      if(d.reason==='update'){$('updateTitle').textContent='새 버전 준비됨';$('updateDetail').textContent='다시 열면 적용됩니다. 지금 화면은 이전 버전으로 계속 쓸 수 있습니다.';$('updateReload').classList.remove('hidden');}
      else{$('updateTitle').textContent=d.reason==='manual'?'저장한 지도 확인 완료':'지도 저장 완료';$('updateDetail').textContent='인터넷 없이도 이 주소에서 열 수 있습니다.';bannerTimer=setTimeout(()=>banner.classList.add('hidden'),6000);}
    }else{
      $('updateTitle').textContent=d.reason==='update'?'새 버전을 받지 못했습니다':`${what}에 실패했습니다`;
      $('updateDetail').textContent=d.reason==='update'?'저장된 지금 버전은 그대로 쓸 수 있습니다. 인터넷 연결 후 다시 열면 다시 시도합니다.':'오프라인 메뉴에서 다시 시도하거나 지도 HTML 파일을 저장하세요.';
    }
    banner.dataset.key=key;
  }
  $('updateReload').onclick=()=>location.reload();
  $('updateClose').onclick=()=>{bannerDismissed=banner.dataset.key||'';clearTimeout(bannerTimer);banner.classList.add('hidden');};
  window.DURU_UPDATE={show:updateBanner};
  // Read-only hooks support deterministic verification of geographic rendering and local state.
  window.DURU={get state(){return {camera:{...camera},selected,pins:pins.map(p=>({...p})),gps:gps?{...gps}:null,center:(()=>{const ll=at(w/2,h/2);return {lon:ll[0],lat:ll[1]};})(),offlineReady,roads:roadCount,places:searchPlaces.length,railways:railCount,stations:(data.stations||[]).length,subwayEntrances:(data.subwayEntrances||[]).length};},project,unproject,fit,selectPlace,focusPoint(p,z=11){closePanel();fly(p,z);},redraw:requestDraw,resize,toast,escapeHtml,invalidateBase(){baseView=null;requestDraw();},addOverlay(overlay){overlays.push(overlay);baseView=null;requestDraw();}};
})();
