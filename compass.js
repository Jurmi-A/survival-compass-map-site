(() => {
  'use strict';
  const api=window.DURU;if(!api)return;
  const $=id=>document.getElementById(id);
  const dialog=document.createElement('dialog');dialog.id='compassDialog';dialog.className='modal compass-modal';
  dialog.innerHTML=`<div class="modal-card"><div class="modal-header"><div><span class="eyebrow">인터넷 없이 · 휴대폰 방향 센서</span><h2>나침반</h2></div><button id="compassClose" class="icon-button" aria-label="나침반 닫기">×</button></div><p class="compass-hint">휴대폰을 화면이 위로 향하게 평평하게 잡으세요. 위쪽 모서리가 향하는 방향을 표시합니다.</p>
    <div class="compass-dial" role="img" aria-label="측정 전 나침반" id="compassDial"><span class="compass-phone">▲ 휴대폰 위쪽</span><div id="compassRose" class="compass-rose" hidden><b class="compass-n">N 북</b><b class="compass-e">E 동</b><b class="compass-s">S 남</b><b class="compass-w">W 서</b><div class="compass-needle"></div></div><span class="compass-center"></span></div>
    <div class="compass-value" id="compassValue">—</div><p class="compass-reference" id="compassReference">방향 측정을 시작하세요</p><p id="compassStatus" class="position-status" role="status" aria-live="polite">측정 전입니다.</p>
    <div class="action-row"><button id="compassStart" class="primary-button">나침반 켜기</button><button id="compassStop" class="secondary-button" disabled>끄기</button></div>
    <p class="small-note">빨간 바늘은 센서가 가리키는 북쪽입니다. 앱에서는 자북을 사용하며 진북 보정은 하지 않습니다. 지도 위쪽(진북)과 차이가 날 수 있습니다. GPS와 이동 방향은 사용하지 않습니다.</p>
    <details><summary>측정이 흔들리거나 안 될 때</summary><ul class="compass-notes"><li>자석 케이스·스피커·차량·철제 구조물에서 떨어져 다시 확인하세요.</li><li>휴대폰을 평평하게 두고 잠시 기다리세요. 보정 방법은 기기 제조사 안내를 따르세요.</li><li>센서의 정상 표시도 자기 간섭이나 오차가 없다는 보장은 아닙니다. 주변 표지와 대조하세요.</li><li>브라우저에서는 북쪽 기준 방향 센서가 제공돼야 합니다. 지원하지 않으면 안드로이드 앱을 이용하세요.</li><li>화면을 닫거나 앱을 벗어나면 측정을 멈춥니다. 다시 켜서 새 값을 받으세요.</li></ul></details></div>`;
  document.body.append(dialog);
  const now=()=>performance.now();
  const names={waiting:'센서 측정을 기다립니다. 휴대폰을 평평하게 잡아주세요.',unavailable:'북쪽을 읽을 센서가 없거나 사용할 수 없습니다. 브라우저라면 안드로이드 앱에서 확인하세요.',unstable:'자기장 또는 센서 정확도가 불안정합니다. 금속·자석에서 떨어져 다시 확인하세요.',tilted:'휴대폰을 화면이 위로 향하게 평평하게 잡아주세요.',stale:'새 방향 값이 오지 않습니다. 이전 방향은 숨겼습니다.',paused:'화면을 벗어나 측정을 중지했습니다. 다시 켜주세요.',stopped:'나침반을 껐습니다.',denied:'방향 센서 권한이 허용되지 않았습니다.',portrait:'브라우저에서는 휴대폰을 세로 화면으로 돌려 평평하게 잡아주세요.'};
  const terminalStatus=new Set(['paused','unavailable','denied','stopped']);
  const northReference=ref=>ref==='magnetic'?'자북 기준':'브라우저 북 기준';

  // ---- Shared sensor: one session serves every user (compass dialog, map direction cone). ----
  // The Android bridge supports a single compass session, so screens must never start their own.
  const subscribers=new Set();let sensorCleanup=null,sensorStarting=false,sensorReference='magnetic';
  function emit(sample){for(const fn of [...subscribers])fn(sample,sensorReference);}
  function stopSensor(){const fn=sensorCleanup;sensorCleanup=null;try{fn?.();}catch(_){}}
  function startSensor(){
    if(sensorCleanup||sensorStarting)return;
    if(window.DURU_START_COMPASS){
      sensorReference='magnetic';
      // A bridge failure can call back before the subscription has returned its cleanup function.
      let active=true;
      const release=window.DURU_START_COMPASS(sample=>queueMicrotask(()=>{if(active)emit(sample);}));
      sensorCleanup=()=>{active=false;release();};
      return;
    }
    sensorReference='browser';
    if(!window.isSecureContext||!window.DeviceOrientationEvent){setTimeout(()=>emit({status:'unavailable'}),0);return;}
    const listen=()=>{
      const onOrientation=e=>{
        // Browsers without a sensor send events with no values; leave them to the "unavailable" timeout instead of reporting a tilt.
        if(e.alpha==null&&e.beta==null&&e.gamma==null&&e.webkitCompassHeading==null)return;
        const screenAngle=screen.orientation?.angle??window.orientation??0;
        if(screenAngle!==0){emit({status:'portrait'});return;}
        if(!Number.isFinite(e.beta)||!Number.isFinite(e.gamma)||Math.abs(e.beta)>20||Math.abs(e.gamma)>20){emit({status:'tilted'});return;}
        let heading=null;
        if(typeof e.webkitCompassHeading==='number'){
          if(!Number.isFinite(e.webkitCompassHeading)||e.webkitCompassHeading<0||e.webkitCompassHeading>=360||!Number.isFinite(e.webkitCompassAccuracy)||e.webkitCompassAccuracy<0||e.webkitCompassAccuracy>30){emit({status:'unstable'});return;}
          heading=e.webkitCompassHeading;
        }
        else if(e.absolute===true&&typeof e.alpha==='number'&&Number.isFinite(e.alpha))heading=(360-e.alpha)%360;
        if(heading!==null)emit({status:'reading',heading});
      };
      // Relative alpha is intentionally never treated as north.
      window.addEventListener('deviceorientationabsolute',onOrientation);window.addEventListener('deviceorientation',onOrientation);
      sensorCleanup=()=>{window.removeEventListener('deviceorientationabsolute',onOrientation);window.removeEventListener('deviceorientation',onOrientation);};
    };
    if(typeof DeviceOrientationEvent.requestPermission!=='function'){listen();return;}
    sensorStarting=true;
    DeviceOrientationEvent.requestPermission().then(r=>{sensorStarting=false;if(!subscribers.size)return;if(r!=='granted'){emit({status:'denied'});return;}listen();},()=>{sensorStarting=false;emit({status:'denied'});});
  }
  function subscribe(fn){subscribers.add(fn);startSensor();return ()=>{subscribers.delete(fn);if(!subscribers.size)stopSensor();};}
  // Same acceptance rules everywhere: magnetic readings need medium accuracy and must be under 2 s old.
  function check(sample,reference){
    const valid=sample?.status==='reading'&&typeof sample.heading==='number'&&Number.isFinite(sample.heading)&&sample.heading>=0&&sample.heading<360;
    if(!valid)return {ok:false,status:sample?.status||'unavailable'};
    if(reference==='magnetic'&&(!Number.isInteger(sample.accuracy)||sample.accuracy<2))return {ok:false,status:'unstable'};
    if(reference==='magnetic'&&window.DURU_MONOTONIC){const age=window.DURU_MONOTONIC()-sample.observedElapsedMs;if(!Number.isFinite(sample.observedElapsedMs)||!Number.isFinite(age)||age<0||age>2000)return {ok:false,status:'stale'};}
    return {ok:true,heading:sample.heading,accuracy:sample.accuracy,status:'reading'};
  }

  // ---- Compass dialog (unchanged behaviour) ----
  let generation=0,running=false,cleanup=null,lastReading=0,timeout=null,reference='magnetic';
  function statusText(text){if($('compassStatus').textContent!==text)$('compassStatus').textContent=text;}
  function clear(status){$('compassRose').hidden=true;$('compassValue').textContent='—';$('compassDial').setAttribute('aria-label','유효한 방향 측정 없음');statusText(names[status]||names.unavailable);}
  function stop(status='stopped'){
    generation++;running=false;clearTimeout(timeout);timeout=null;const fn=cleanup;cleanup=null;try{fn?.();}catch(_){}
    $('compassStart').disabled=false;$('compassStop').disabled=true;lastReading=0;clear(status);
  }
  function reading(sample,gen,ref){
    if(gen!==generation||!running||document.hidden)return;
    reference=ref;const r=check(sample,ref);
    if(!r.ok){lastReading=0;clear(r.status);if(terminalStatus.has(sample?.status))stop(sample.status);return;}
    lastReading=now();const angle=r.heading;
    const dir=['북','북동','동','남동','남','남서','서','북서'][Math.round(angle/45)%8];
    $('compassRose').hidden=false;$('compassRose').style.transform=`rotate(${-angle}deg)`;
    $('compassValue').textContent=`${Math.round(angle)%360}° · ${dir}`;
    $('compassReference').textContent=ref==='magnetic'?'휴대폰 위쪽 · 자북 기준 (진북 보정 안 함)':'휴대폰 위쪽 · 브라우저 북 기준 (정확도·보정값 모름)';
    $('compassDial').setAttribute('aria-label',`센서 북쪽 기준 ${Math.round(angle)%360}도 ${dir}`);
    statusText(ref==='magnetic'?(r.accuracy===2?'측정 중 · 센서 정확도 보통. 주변 표지와 대조하세요.':'측정 중 · 자기 간섭·현장 오차가 있을 수 있습니다.'):'측정 중 · 브라우저가 제공한 북쪽 기준. 정확도는 확인되지 않았습니다.');
  }
  function start(){
    stop();running=true;const gen=generation;lastReading=0;clear('waiting');$('compassStart').disabled=true;$('compassStop').disabled=false;
    timeout=setTimeout(()=>{if(running&&gen===generation&&!lastReading)stop('unavailable');},10000);
    cleanup=subscribe((sample,ref)=>reading(sample,gen,ref));
  }
  $('compassOpen').onclick=()=>{if(!dialog.open)dialog.showModal();};
  $('compassClose').onclick=()=>dialog.close();dialog.addEventListener('close',()=>stop());
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  $('compassStart').onclick=start;$('compassStop').onclick=()=>stop();

  // ---- Map direction: a cone on the position dot showing where the top of the phone points. ----
  // The map stays north-up. The sensor runs only while this is switched on and the page is visible.
  let headingOn=false,headingUnsub=null,headingTimer=0,lastDraw=0;
  let heading={value:null,status:'off',at:0,reference:'magnetic'};
  const hbtn=document.createElement('button');hbtn.id='headingToggle';hbtn.className='icon-button heading-toggle';hbtn.type='button';
  hbtn.setAttribute('aria-pressed','false');hbtn.setAttribute('aria-label','내가 보는 방향 표시');hbtn.title='보는 방향 표시';
  hbtn.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l5.5 15.5L12 15.8 6.5 19z"/></svg>';
  $('locate').after(hbtn);
  function publish(){window.dispatchEvent(new CustomEvent('duru-heading',{detail:{...heading,on:headingOn}}));const t=now();if(t-lastDraw>90){lastDraw=t;api.redraw();}}
  function paintButton(){
    hbtn.classList.toggle('active',headingOn&&heading.value!==null);hbtn.classList.toggle('heading-waiting',headingOn&&heading.value===null);
    hbtn.setAttribute('aria-pressed',String(headingOn));
    const svg=hbtn.querySelector('svg');svg.style.transform=headingOn&&heading.value!==null?`rotate(${heading.value}deg)`:'';
    hbtn.title=!headingOn?'보는 방향 표시':heading.value!==null?`보는 방향 ${Math.round(heading.value)%360}° (${northReference(heading.reference)}) · 누르면 끔`:`방향 확인 중: ${names[heading.status]||'센서를 기다립니다.'}`;
  }
  function onSample(sample,ref){
    const r=check(sample,ref);
    if(r.ok){clearTimeout(headingTimer);heading={value:r.heading,status:'reading',at:now(),reference:ref};}
    else{
      if(terminalStatus.has(sample?.status)){
        setHeading(false);
        if(sample.status==='unavailable'||sample.status==='denied')api.toast(names[sample.status]);
        return;
      }
      heading={value:null,status:r.status,at:now(),reference:ref};
    }
    paintButton();publish();
  }
  function setHeading(on){
    if(on===headingOn)return;headingOn=on;clearTimeout(headingTimer);
    if(on){
      const ref=window.DURU_START_COMPASS?'magnetic':'browser';
      heading={value:null,status:'waiting',at:now(),reference:ref};headingUnsub=subscribe(onSample);
      headingTimer=setTimeout(()=>{if(headingOn&&heading.value===null){const message=names[heading.status]||names.unavailable;setHeading(false);api.toast(message);}},10000);
      api.toast(api.state.gps?`보는 방향을 위치 점에 표시합니다 · ${northReference(ref)}, 현장과 대조하세요`:'버튼 화살표가 보는 방향입니다 · 위치 버튼으로 내 위치를 확인하면 지도에도 표시됩니다');}
    else{const fn=headingUnsub;headingUnsub=null;try{fn?.();}catch(_){}heading={value:null,status:'off',at:0,reference:'magnetic'};}
    paintButton();publish();api.redraw();
  }
  hbtn.onclick=()=>setHeading(!headingOn);
  api.addOverlay({draw({ctx,screen,project}){
    const g=api.state.gps;if(!headingOn||heading.value===null||!g)return;
    const age=window.DURU_MONOTONIC&&Number.isFinite(g.fixElapsedMs)?window.DURU_MONOTONIC()-g.fixElapsedMs:Date.now()-g.timestamp;
    const p=screen(project(g.lon,g.lat)),old=!Number.isFinite(age)||age<0||age>120000,a=(heading.value-90)*Math.PI/180,spread=32*Math.PI/180,r=78;
    const grad=ctx.createRadialGradient(p[0],p[1],6,p[0],p[1],r);grad.addColorStop(0,old?'rgba(124,133,135,.45)':'rgba(40,107,156,.5)');grad.addColorStop(1,'rgba(40,107,156,0)');
    ctx.save();ctx.beginPath();ctx.moveTo(p[0],p[1]);ctx.arc(p[0],p[1],r,a-spread,a+spread);ctx.closePath();ctx.fillStyle=grad;ctx.fill();ctx.restore();
  }});
  window.DURU_HEADING={subscribe,check,get state(){return {on:headingOn,...heading};},set:setHeading};

  // Stop everything when the page is hidden; nothing measures in the background.
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stop('paused');setHeading(false);}});
  window.addEventListener('pagehide',()=>{stop('paused');setHeading(false);});
  setInterval(()=>{
    if(running&&lastReading&&now()-lastReading>2000){lastReading=0;clear('stale');}
    if(headingOn&&heading.value!==null&&now()-heading.at>2000){heading={...heading,value:null,status:'stale'};paintButton();publish();}
  },500);
})();
