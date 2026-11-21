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
  let generation=0,running=false,cleanup=null,lastReading=0,timeout=null,reference='magnetic';
  const now=()=>performance.now();
  const names={waiting:'센서 측정을 기다립니다. 휴대폰을 평평하게 잡아주세요.',unavailable:'북쪽을 읽을 센서가 없거나 사용할 수 없습니다. 브라우저라면 안드로이드 앱에서 확인하세요.',unstable:'자기장 또는 센서 정확도가 불안정합니다. 금속·자석에서 떨어져 다시 확인하세요.',tilted:'휴대폰을 화면이 위로 향하게 평평하게 잡아주세요.',stale:'새 방향 값이 오지 않습니다. 이전 방향은 숨겼습니다.',paused:'화면을 벗어나 측정을 중지했습니다. 다시 켜주세요.',stopped:'나침반을 껐습니다.',denied:'방향 센서 권한이 허용되지 않았습니다.',portrait:'브라우저에서는 휴대폰을 세로 화면으로 돌려 평평하게 잡아주세요.'};
  function statusText(text){if($('compassStatus').textContent!==text)$('compassStatus').textContent=text;}
  function clear(status){$('compassRose').hidden=true;$('compassValue').textContent='—';$('compassDial').setAttribute('aria-label','유효한 방향 측정 없음');statusText(names[status]||names.unavailable);}
  function stop(status='stopped'){
    generation++;running=false;clearTimeout(timeout);timeout=null;const fn=cleanup;cleanup=null;try{fn?.();}catch(_){}
    $('compassStart').disabled=false;$('compassStop').disabled=true;lastReading=0;clear(status);
  }
  function reading(sample,gen){
    if(gen!==generation||!running||document.hidden)return;
    const valid=sample?.status==='reading'&&typeof sample.heading==='number'&&Number.isFinite(sample.heading)&&sample.heading>=0&&sample.heading<360;
    if(!valid){lastReading=0;clear(sample?.status);if(['paused','unavailable','denied','stopped'].includes(sample?.status))stop(sample.status);return;}
    if(reference==='magnetic'&&(!Number.isInteger(sample.accuracy)||sample.accuracy<2)){clear('unstable');lastReading=0;return;}
    if(reference==='magnetic'&&window.DURU_MONOTONIC){const age=window.DURU_MONOTONIC()-sample.observedElapsedMs;if(!Number.isFinite(sample.observedElapsedMs)||!Number.isFinite(age)||age<0||age>2000){clear('stale');lastReading=0;return;}}
    lastReading=now();const angle=sample.heading;
    const dir=['북','북동','동','남동','남','남서','서','북서'][Math.round(angle/45)%8];
    $('compassRose').hidden=false;$('compassRose').style.transform=`rotate(${-angle}deg)`;
    $('compassValue').textContent=`${Math.round(angle)%360}° · ${dir}`;
    $('compassReference').textContent=reference==='magnetic'?'휴대폰 위쪽 · 자북 기준 (진북 보정 안 함)':'휴대폰 위쪽 · 브라우저 북 기준 (정확도·보정값 모름)';
    $('compassDial').setAttribute('aria-label',`센서 북쪽 기준 ${Math.round(angle)%360}도 ${dir}`);
    statusText(reference==='magnetic'?(sample.accuracy===2?'측정 중 · 센서 정확도 보통. 주변 표지와 대조하세요.':'측정 중 · 자기 간섭·현장 오차가 있을 수 있습니다.'):'측정 중 · 브라우저가 제공한 북쪽 기준. 정확도는 확인되지 않았습니다.');
  }
  async function start(){
    stop();running=true;const gen=generation;lastReading=0;clear('waiting');$('compassStart').disabled=true;$('compassStop').disabled=false;
    timeout=setTimeout(()=>{if(running&&gen===generation&&!lastReading)stop('unavailable');},10000);
    if(window.DURU_START_COMPASS){reference='magnetic';cleanup=window.DURU_START_COMPASS(sample=>reading(sample,gen));if(!running){cleanup?.();cleanup=null;}return;}
    reference='browser';
    if(!window.isSecureContext||!window.DeviceOrientationEvent){stop('unavailable');return;}
    try{
      if(typeof DeviceOrientationEvent.requestPermission==='function'&&await DeviceOrientationEvent.requestPermission()!=='granted'){if(gen===generation)stop('denied');return;}
    }catch(_){if(gen===generation)stop('denied');return;}
    if(gen!==generation||!running)return;
    const onOrientation=e=>{
      // Browsers without a sensor send events with no values; leave them to the 10-second "unavailable" timeout instead of reporting a tilt.
      if(e.alpha==null&&e.beta==null&&e.gamma==null&&e.webkitCompassHeading==null)return;
      const screenAngle=screen.orientation?.angle??window.orientation??0;
      if(screenAngle!==0){reading({status:'portrait'},gen);return;}
      if(!Number.isFinite(e.beta)||!Number.isFinite(e.gamma)||Math.abs(e.beta)>20||Math.abs(e.gamma)>20){reading({status:'tilted'},gen);return;}
      let heading=null;
      if(typeof e.webkitCompassHeading==='number'){
        if(!Number.isFinite(e.webkitCompassHeading)||e.webkitCompassHeading<0||e.webkitCompassHeading>=360||!Number.isFinite(e.webkitCompassAccuracy)||e.webkitCompassAccuracy<0||e.webkitCompassAccuracy>30){reading({status:'unstable'},gen);return;}
        heading=e.webkitCompassHeading;
      }
      else if(e.absolute===true&&typeof e.alpha==='number'&&Number.isFinite(e.alpha))heading=(360-e.alpha)%360;
      if(heading!==null)reading({status:'reading',heading},gen);
    };
    // Relative alpha is intentionally never treated as north.
    window.addEventListener('deviceorientationabsolute',onOrientation);window.addEventListener('deviceorientation',onOrientation);
    cleanup=()=>{window.removeEventListener('deviceorientationabsolute',onOrientation);window.removeEventListener('deviceorientation',onOrientation);};
  }
  $('compassOpen').onclick=()=>{if(!dialog.open)dialog.showModal();};
  $('compassClose').onclick=()=>dialog.close();dialog.addEventListener('close',()=>stop());
  dialog.addEventListener('click',e=>{if(e.target===dialog)dialog.close();});
  $('compassStart').onclick=start;$('compassStop').onclick=()=>stop();
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('paused');});
  window.addEventListener('pagehide',()=>stop('paused'));
  setInterval(()=>{if(running&&lastReading&&now()-lastReading>2000){lastReading=0;clear('stale');}},500);
})();
