(() => {
  'use strict';
  const api=window.DURU;if(!api)return;
  const $=id=>document.getElementById(id),esc=api.escapeHtml;
  const KEY='duru-received-v1',MAX_BYTES=8192,MAX_RECEIVED=50;
  const kinds={gps:'GPS 수신 위치',manual:'직접 지정한 위치',goal:'목표·합류 지점'};
  const clock=()=>window.DURU_MONOTONIC?window.DURU_MONOTONIC():performance.now();
  const bytes=s=>new TextEncoder().encode(s).length;
  const validTime=t=>Number.isSafeInteger(t)&&t>=0&&t<=4102444800000;
  function cleanCard(c){
    if(!c||typeof c!=='object'||Array.isArray(c)||c.app!=='두루지도 위치카드'||c.version!==1||
      typeof c.id!=='string'||!/^[a-f0-9]{32}$/.test(c.id)||!Object.hasOwn(kinds,c.kind)||
      !Number.isFinite(c.lat)||Math.abs(c.lat)>85||!Number.isFinite(c.lon)||Math.abs(c.lon)>180||
      !validTime(c.createdAt)||typeof c.label!=='string'||!c.label.trim()||c.label.length>80||
      typeof c.sender!=='string'||c.sender.length>40||typeof c.note!=='string'||c.note.length>200||
      (c.kind==='gps'?!validTime(c.observedAt)||!Number.isFinite(c.accuracy)||c.accuracy<0||c.accuracy>100000:
        c.observedAt!==null||c.accuracy!==null||c.ageAtCreationMs!==null)||
      (c.ageAtCreationMs!==null&&(!Number.isSafeInteger(c.ageAtCreationMs)||c.ageAtCreationMs<0||c.ageAtCreationMs>31536000000)))
      throw Error('올바른 생존나침반 위치 카드가 아닙니다. 원본 글이나 JSON 파일을 확인하세요.');
    return {app:c.app,version:1,id:c.id,kind:c.kind,label:c.label.trim(),sender:c.sender,note:c.note,
      lat:c.lat,lon:c.lon,createdAt:c.createdAt,observedAt:c.observedAt,accuracy:c.accuracy,ageAtCreationMs:c.ageAtCreationMs};
  }
  function parse(text){
    if(typeof text!=='string'||bytes(text)>MAX_BYTES)throw Error('위치 카드는 8KB 이하여야 합니다.');
    const raw=text.trim();let doc;
    try{if(raw.startsWith('{'))doc=JSON.parse(raw);
    else{
      const matches=[...raw.matchAll(/DURU1:([A-Za-z0-9_-]+)/g)];
      if(matches.length!==1)throw Error('DURU1:로 시작하는 카드 자료를 포함한 글 한 개를 붙여 넣으세요.');
      const encoded=matches[0][1];
      const binary=atob(encoded.replace(/-/g,'+').replace(/_/g,'/'));
      doc=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0))));
    }}catch(_){throw Error('카드 자료를 해석하지 못했습니다. 잘리지 않은 원본 글 또는 JSON 파일을 확인하세요.');}
    return cleanCard(doc);
  }
  const stamp=t=>new Date(t).toLocaleString('ko-KR')+' (해당 기기 시계)';
  const duration=ms=>ms<60000?'1분 미만':`${Math.floor(ms/60000).toLocaleString()}분`;
  function encode(c){
    const u=new TextEncoder().encode(JSON.stringify(c));let binary='';for(const b of u)binary+=String.fromCharCode(b);
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function describe(c){
    const age=c.ageAtCreationMs===null?'측정 경과 모름':`생성 때 이미 ${duration(c.ageAtCreationMs)} 지난 위치 (송신자 제공)`;
    return c.kind==='gps'?`${age} · 추정 오차 ${Math.round(c.accuracy)}m · 현재 위치 아님`:
      c.kind==='goal'?'가려고 정한 지점 · 사람의 현재 위치/안전한 대피소를 뜻하지 않음':'수동 지정 · GPS 측정 아님 · 사람의 현재 위치 보장 안 됨';
  }
  function cardText(c){return `[생존나침반 위치카드] ${kinds[c.kind]}: ${c.label}\n위도 ${c.lat.toFixed(5)}, 경도 ${c.lon.toFixed(5)} (WGS84)\n${describe(c)}\n작성 ${stamp(c.createdAt)}\n${c.sender?'보낸 사람(확인 안 됨): '+c.sender+'\n':''}${c.note?'메모: '+c.note+'\n':''}전달 지연 모름 · 아래 DURU1 자료를 앱의 ‘위치 공유 → 받기’에 붙여 넣으세요.\nDURU1:${encode(c)}`;}
  let received=[],storageLocked=false,rawReceived=null;const receivedClocks=new Map();
  try{rawReceived=localStorage.getItem(KEY);const saved=JSON.parse(rawReceived===null?'[]':rawReceived);if(!Array.isArray(saved))throw Error();
    if(saved.length>MAX_RECEIVED)storageLocked=true;
    for(const r of saved.slice(0,MAX_RECEIVED)){try{
      if(!r||!validTime(r.receivedAt)||typeof r.alias!=='string'||r.alias.length>40)throw Error();
      const card=cleanCard(r.card);if(received.some(x=>x.card.id===card.id))throw Error();
      received.push({card,receivedAt:r.receivedAt,alias:r.alias});
    }catch(_){storageLocked=true;}}
  }catch(_){storageLocked=true;}
  function persist(next){if(storageLocked){api.toast('받은 위치 원문을 보존하기 위해 추가·삭제를 잠갔습니다. 원문 백업을 보관하세요.');return false;}
    try{localStorage.setItem(KEY,JSON.stringify(next));received=next;return true;}catch(_){api.toast('저장 공간에 기록하지 못했습니다. 기존 받은 위치는 유지합니다.');return false;}}
  let draft=null,generated=null,pending=null,waitingGps=false,tab='send';
  const el=document.createElement('dialog');el.id='shareDialog';el.className='modal sharing-modal';
  el.innerHTML=`<div class="modal-card"><div class="modal-header"><div><span class="eyebrow">선택한 상대에게 한 번씩</span><h2>위치 공유</h2></div><button id="closeShare" class="icon-button" aria-label="위치 공유 닫기">×</button></div>
    <p class="sharing-caution">카드 만들기·읽기는 오프라인으로 됩니다. 실제 전달에는 선택한 문자·메신저·파일 이동 수단이 필요합니다. 블루투스 직접 연결·실시간 추적 기능은 없습니다.</p>
    <div class="emergency-tabs" role="tablist" aria-label="위치 공유 기능"><button role="tab" data-share-tab="send">보내기</button><button role="tab" data-share-tab="receive">받기</button><button role="tab" data-share-tab="received">받은 위치 <span id="receivedCount"></span></button></div>
    <section id="share-send" role="tabpanel"><label class="stacked-label">보낼 카드 종류<select id="shareKind"><option value="gps">GPS 수신 위치</option><option value="manual">직접 지정한 위치</option><option value="goal">목표·합류 지점</option></select></label>
      <div id="shareGpsActions" class="action-row"><button id="shareRefreshGps" class="secondary-button">GPS 새로 확인</button><button id="shareUseGps" class="secondary-button">최근 GPS 사용</button></div>
      <div id="shareManualActions" class="action-row" hidden><button id="shareUseSelected" class="secondary-button">선택한 장소 사용</button><button id="shareUseCenter" class="secondary-button">지도 중심 사용</button></div>
      <p id="shareSourceInfo" class="position-status" role="status">보낼 위치를 먼저 고르세요.</p>
      <label class="stacked-label">장소 이름<input id="shareLabel" maxlength="80" placeholder="예: 가족 합류 장소"></label><label class="stacked-label">내 별명 (선택)<input id="shareSender" maxlength="40" placeholder="실명 대신 알아볼 수 있는 별명"></label><label class="stacked-label">함께 보낼 메모 (선택)<textarea id="shareNote" maxlength="200" placeholder="입구·기다릴 장소 등"></textarea></label>
      <button id="makeShareCard" class="primary-button wide">내용 확인용 카드 만들기</button><div id="shareGenerated" hidden><p id="shareGeneratedInfo" class="sharing-caution"></p><label class="stacked-label">상대에게 보낼 글<textarea id="shareOutput" class="location-card" readonly></textarea></label><p class="small-note">아래 동작은 좌표와 메모를 복사하거나 다른 앱에 넘깁니다. 받을 사람과 내용을 확인하세요. 한 번 전달한 사본은 원격으로 회수할 수 없습니다.</p><div class="action-row"><button id="copyShareCard" class="secondary-button">글 복사</button><button id="sendShareCard" class="primary-button">공유 화면 열기</button></div><button id="saveShareCard" class="secondary-button wide">카드 JSON 파일 저장</button></div></section>
    <section id="share-receive" role="tabpanel" hidden><label class="stacked-label">받은 카드 글 또는 JSON<textarea id="receiveShareText" maxlength="8192" placeholder="DURU1: 자료가 들어 있는 글 전체를 붙여 넣으세요."></textarea></label><div class="action-row"><button id="previewShareCard" class="primary-button">카드 내용 확인</button><label class="secondary-button file-label" for="importShareCard">JSON 파일 열기</label><input type="file" id="importShareCard" accept="application/json,.json,text/plain" hidden></div><p id="shareReceiveStatus" class="small-note" role="status"></p><div id="shareIncoming" hidden><div id="shareIncomingInfo" class="sharing-card"></div><label class="stacked-label">내가 알아볼 상대 이름 (선택)<input id="receiveAlias" maxlength="40" placeholder="이름은 상대 인증이 아닙니다."></label><button id="acceptShareCard" class="primary-button wide">확인한 카드 지도에 추가</button></div></section>
    <section id="share-received" role="tabpanel" hidden><label class="sharing-toggle"><input id="showReceived" type="checkbox" checked>지도에 받은 위치 표시</label><p class="small-note">내 GPS·내 장소·가족 계획과 별도로 보관합니다. 보낸 사람과 위치의 사실 여부는 확인되지 않았습니다. 받은 사람 위치는 전달 지연을 알 수 없으므로 항상 회색 ‘시점 확인 필요’로 표시합니다.</p><div id="receivedList"></div></section>
    <p id="shareActionStatus" class="position-status" role="status"></p></div>`;
  document.body.append(el);
  const storageWarning=document.createElement('p');storageWarning.id='receivedStorageWarning';storageWarning.className='sharing-caution';storageWarning.hidden=!storageLocked;storageWarning.textContent='저장된 받은 위치 일부를 읽지 못했거나 저장소에 접근할 수 없습니다. 읽을 수 있는 카드는 표시하고, 원문을 덮어쓰지 않도록 추가·삭제를 잠갔습니다. 복구를 위해 원문을 먼저 백업하세요.';
  const rawBackup=document.createElement('button');rawBackup.id='backupReceivedRaw';rawBackup.className='secondary-button wide';rawBackup.hidden=!storageLocked||rawReceived===null;rawBackup.textContent='보존한 받은 위치 원문 백업';$('share-received').prepend(storageWarning,rawBackup);
  const recovery=document.createElement('div');recovery.id='receivedRecovery';recovery.hidden=true;
  recovery.innerHTML='<label class="sharing-toggle"><input type="checkbox" id="confirmReceivedBackup">원문 파일을 따로 보관했고, 읽을 수 없는 기록을 목록에서 제외하는 데 동의합니다.</label><button id="recoverReceived" class="secondary-button wide" disabled>정상 카드만 유지하고 변경 잠금 풀기</button>';
  rawBackup.after(recovery);$('confirmReceivedBackup').onchange=()=>{$('recoverReceived').disabled=!$('confirmReceivedBackup').checked;};
  $('recoverReceived').onclick=()=>{
    if(!storageLocked||recovery.hidden||!$('confirmReceivedBackup').checked)return;
    if(!confirm(`원문 파일을 보관했는지 확인하세요. 읽을 수 있는 카드 ${received.length}개만 목록에 다시 저장하고, 읽지 못한 기록은 제외하여 변경 잠금을 풀까요? 제외된 기록은 원문 백업에서만 보관됩니다.`))return;
    try{localStorage.setItem(KEY,JSON.stringify(received));storageLocked=false;storageWarning.hidden=true;rawBackup.hidden=true;recovery.hidden=true;$('acceptShareCard').disabled=false;renderReceived();$('shareActionStatus').textContent='정상 카드만 유지하고 잠금을 풀었습니다. 제외한 기록의 원문 백업 파일을 계속 보관하세요.';api.redraw();}
    catch(_){api.toast('복구 목록을 저장하지 못했습니다. 원문과 기존 목록은 그대로 보존합니다.');}
  };
  $('acceptShareCard').disabled=storageLocked;
  const privacy=document.createElement('p');privacy.textContent='위치 공유에서 글 복사·파일 저장·공유 화면을 직접 선택하면 카드에 담긴 좌표와 메모를 외부로 전달할 수 있습니다. 선택한 문자·메신저 앱의 전송망과 개인정보 처리 방식이 적용됩니다. 자동 공유·직접 블루투스 연결·수신 확인 기능은 없습니다.';$('dataInfo').append(privacy);
  const retention=document.createElement('p');retention.className='small-note';retention.textContent='앱·브라우저 데이터 삭제 시 받은 카드도 지워집니다. 내 장소·계획 백업에는 받은 카드가 포함되지 않으므로 필요한 원본 글이나 파일을 따로 보관하세요.';$('share-received').append(retention);
  function setTab(next){tab=next;for(const name of ['send','receive','received'])$('share-'+name).hidden=name!==next;
    for(const b of el.querySelectorAll('[data-share-tab]')){b.classList.toggle('active',b.dataset.shareTab===next);b.setAttribute('aria-selected',String(b.dataset.shareTab===next));}
    if(next==='received')renderReceived();}
  function open(next='send'){if(!el.open)el.showModal();setTab(next);}
  $('navShare').onclick=()=>open();$('closeShare').onclick=()=>el.close();el.onclick=e=>{if(e.target===el)el.close();};
  for(const b of el.querySelectorAll('[data-share-tab]'))b.onclick=()=>setTab(b.dataset.shareTab);
  function invalidate(){generated=null;$('shareGenerated').hidden=true;$('shareActionStatus').textContent='';}
  function sourceInfo(){const c=draft;$('shareSourceInfo').textContent=c?`${kinds[$('shareKind').value]} · ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}${c.observedAt?' · 수신 '+stamp(c.observedAt):' · 직접 고른 좌표'}`:'보낼 위치를 먼저 고르세요.';}
  function pick(p,gps=false){if(!p){api.toast(gps?'먼저 GPS를 확인하세요.':'지도에서 장소를 선택한 뒤 다시 여세요.');return;}
    draft={lat:p.lat,lon:p.lon,observedAt:gps?p.timestamp:null,accuracy:gps?p.accuracy:null,fixElapsedMs:gps?p.fixElapsedMs:null};
    if(!gps)$('shareLabel').value=(p.n||($('shareKind').value==='goal'?'목표·합류 지점':'직접 지정한 위치')).slice(0,80);
    else if(!$('shareLabel').value)$('shareLabel').value='내 GPS 수신 위치';invalidate();sourceInfo();}
  $('shareKind').onchange=()=>{draft=null;waitingGps=false;$('shareGpsActions').hidden=$('shareKind').value!=='gps';$('shareManualActions').hidden=$('shareKind').value==='gps';invalidate();sourceInfo();};
  $('shareUseGps').onclick=()=>pick(api.state.gps,true);
  $('shareRefreshGps').onclick=()=>{waitingGps=true;$('shareSourceInfo').textContent='GPS 확인 중입니다. 권한과 기기의 위치 설정을 확인하세요.';$('locate').click();};
  window.addEventListener('duru-position',()=>{if(waitingGps&&$('shareKind').value==='gps'){waitingGps=false;pick(api.state.gps,true);}});
  window.addEventListener('duru-position-error',e=>{if(waitingGps){waitingGps=false;$('shareSourceInfo').textContent=e.detail;}});
  $('shareUseSelected').onclick=()=>pick(api.state.selected);$('shareUseCenter').onclick=()=>pick(api.state.center);
  for(const id of ['shareLabel','shareSender','shareNote'])$(id).oninput=invalidate;
  $('makeShareCard').onclick=()=>{invalidate();try{
    if(!draft)throw Error('보낼 위치를 먼저 고르세요.');
    const kind=$('shareKind').value;let age=null;
    if(kind==='gps'&&window.DURU_MONOTONIC&&Number.isFinite(draft.fixElapsedMs)){
      const n=clock()-draft.fixElapsedMs;if(n>=0&&n<=31536000000)age=Math.floor(n);
    }
    const warningAge=age===null?Date.now()-draft.observedAt:age;
    if(kind==='gps'&&warningAge>=300000&&!confirm('수신 후 5분 이상 지난 것으로 표시된 GPS입니다. 먼저 새로 확인하는 것이 좋습니다. 이전 수신 위치 카드로 만들까요? 단조 시계를 사용할 수 없는 환경의 시각 비교에는 기기 시계 오차가 있을 수 있습니다.'))return;
    const random=new Uint8Array(16);crypto.getRandomValues(random);
    generated=cleanCard({app:'두루지도 위치카드',version:1,id:Array.from(random,n=>n.toString(16).padStart(2,'0')).join(''),kind,
      label:$('shareLabel').value.trim(),sender:$('shareSender').value.trim(),note:$('shareNote').value.trim(),
      lat:+draft.lat.toFixed(5),lon:+draft.lon.toFixed(5),createdAt:Date.now(),observedAt:kind==='gps'?Math.round(draft.observedAt):null,
      accuracy:kind==='gps'?draft.accuracy:null,ageAtCreationMs:kind==='gps'?age:null});
    $('shareOutput').value=cardText(generated);$('shareGeneratedInfo').textContent=describe(generated)+' · 카드에 고정된 위치이며 자동 갱신되지 않습니다.';
    $('shareGenerated').hidden=false;$('shareActionStatus').textContent='카드를 만들었습니다. 아직 아무에게도 보내지 않았습니다.';
  }catch(e){invalidate();api.toast(e.message);}};
  $('copyShareCard').onclick=async()=>{if(!generated)return;try{await navigator.clipboard.writeText($('shareOutput').value);$('shareActionStatus').textContent='글을 복사했습니다. 상대에게 전달하거나 수신을 확인한 것은 아닙니다.';}catch(_){$('shareOutput').focus();$('shareOutput').select();$('shareActionStatus').textContent='글을 선택했습니다. 길게 눌러 복사하세요.';}};
  $('sendShareCard').onclick=async()=>{if(!generated)return;const text=$('shareOutput').value;try{
    if(window.DURU_SHARE_TEXT)await window.DURU_SHARE_TEXT(text);
    else if(navigator.share)await navigator.share({title:'생존나침반 위치 카드',text});
    else throw Error('이 환경은 공유 화면을 지원하지 않습니다. 글 복사나 JSON 파일 저장을 이용하세요.');
    $('shareActionStatus').textContent='공유 화면에 글을 넘겼습니다. 전달 성공·상대 수신 여부는 이 앱에서 확인하지 못합니다.';
  }catch(e){$('shareActionStatus').textContent=e.name==='AbortError'?'공유를 취소했습니다.':e.message;}};
  $('saveShareCard').onclick=async()=>{if(!generated)return;const text=JSON.stringify(generated,null,2);try{
    if(window.DURU_SAVE_BACKUP){if(!await window.DURU_SAVE_BACKUP('생존나침반-위치카드.json',text))return;}
    else{const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='생존나침반-위치카드.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}
    $('shareActionStatus').textContent='카드 파일 저장을 요청했습니다. 파일을 받을 사람에게 직접 전달하세요. 상대 수신 여부는 확인되지 않았습니다.';
  }catch(e){api.toast(e.message);}};
  rawBackup.onclick=async()=>{if(rawReceived===null)return;try{
    const text=JSON.stringify({app:'두루지도 받은위치 원문',version:1,raw:rawReceived},null,2),name='생존나침반-받은위치-원문.json';
    if(window.DURU_SAVE_BACKUP){if(!await window.DURU_SAVE_BACKUP(name,text))return;}
    else{const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),15000);}
    recovery.hidden=false;$('shareActionStatus').textContent='원문 파일 저장을 요청했습니다. 파일을 실제로 보관했는지 확인한 뒤 복구 동의를 선택할 수 있습니다. 이 파일에는 받은 좌표와 메모가 들어 있습니다.';
  }catch(e){api.toast(e.message);}};
  function cardInfo(c){return `<strong>${esc(c.label)}</strong><p>${esc(kinds[c.kind])} · ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}</p><p>${esc(describe(c))}</p><p>작성 ${esc(stamp(c.createdAt))}${c.observedAt?'<br>측정 '+esc(stamp(c.observedAt)):''}</p><p>보낸 사람 확인 안 됨${c.sender?' · 카드에 적힌 별명: '+esc(c.sender):''}</p>${c.note?'<p class="sharing-note">'+esc(c.note)+'</p>':''}<p>전달 지연 모름 · 공식 대피소·안전 경로·시설 개방 확인 정보가 아닙니다.${c.lat<32||c.lat>39.5||c.lon<124||c.lon>132.5?' 대한민국 지도 범위 밖의 좌표입니다.':''}</p>`;}
  function preview(text){pending=null;$('shareIncoming').hidden=true;try{pending=parse(text);$('shareIncomingInfo').innerHTML=cardInfo(pending);$('shareIncoming').hidden=false;$('shareReceiveStatus').textContent='내용을 확인한 뒤 추가하세요. 아직 지도에 저장하지 않았습니다.';}
    catch(e){$('shareReceiveStatus').textContent=e instanceof SyntaxError?'카드 자료를 해석하지 못했습니다. 원본 전체를 확인하세요.':e.message;}}
  $('previewShareCard').onclick=()=>preview($('receiveShareText').value);
  $('receiveShareText').oninput=()=>{pending=null;$('shareIncoming').hidden=true;$('shareReceiveStatus').textContent='';};
  $('importShareCard').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>MAX_BYTES)throw Error('위치 카드 파일은 8KB 이하여야 합니다.');const text=await file.text();$('receiveShareText').value=text;preview(text);}catch(err){pending=null;$('shareIncoming').hidden=true;$('shareReceiveStatus').textContent=err.message;}finally{e.target.value='';}};
  $('acceptShareCard').onclick=()=>{if(!pending)return;
    if(received.some(r=>r.card.id===pending.id)){api.toast('이미 받은 카드입니다. 기존 위치를 바꾸지 않았습니다.');return;}
    if(received.length>=MAX_RECEIVED){api.toast('받은 위치는 50개까지 보관합니다. 필요 없는 카드를 삭제한 뒤 다시 받으세요.');return;}
    const record={card:pending,receivedAt:Date.now(),alias:$('receiveAlias').value.trim()};
    if(!persist([...received,record]))return;receivedClocks.set(record.card.id,clock());pending=null;$('shareIncoming').hidden=true;
    $('shareReceiveStatus').textContent='이 기기에 카드를 추가했습니다. 보낸 사람에게 수신 알림을 전송하지는 않았습니다.';
    api.redraw();renderReceived();setTab('received');};
  function receiptAge(r){const start=receivedClocks.get(r.card.id);if(start===undefined)return null;const n=clock()-start;return n>=0?n:null;}
  // Offline cards have unknown delivery delay. Never color a person's report as a fresh live fix.
  function stale(r){return r.card.kind!=='goal';}
  function renderReceived(){
    $('receivedCount').textContent=received.length?'('+received.length+')':'';
    $('receivedList').innerHTML=received.length?received.map(r=>{const age=receiptAge(r);return `<article class="sharing-card ${stale(r)?'sharing-stale':''}" data-received="${r.card.id}">${r.alias?'<h3>'+esc(r.alias)+' (내가 붙인 이름)</h3>':''}${cardInfo(r.card)}<p>수신 ${esc(stamp(r.receivedAt))}<br>${age===null?'수신 후 경과 모름 · 앱을 다시 연 뒤 신선도를 확인할 수 없습니다.':'수신 후 '+duration(age)+' · 이 실행 중 경과'}${stale(r)?'<br>전달 지연·현재 시점 확인 안 됨 · 현재 위치로 쓰지 마세요.':''}</p><div class="action-row"><button class="secondary-button" data-received-map="${r.card.id}">지도에서 보기</button><button class="link-button" data-received-delete="${r.card.id}">이 카드 삭제</button></div></article>`;}).join(''):'<p class="small-note">아직 받은 위치가 없습니다. ‘받기’에서 카드 글이나 JSON 파일을 여세요.</p>';
    for(const b of el.querySelectorAll('[data-received-map]'))b.onclick=()=>{const r=received.find(r=>r.card.id===b.dataset.receivedMap);if(r){el.close();api.focusPoint(r.card);}};
    for(const b of el.querySelectorAll('[data-received-delete]')){b.disabled=storageLocked;b.onclick=()=>{if(!confirm('이 기기의 받은 카드를 삭제할까요? 다른 사람이 가진 사본은 지워지지 않습니다.'))return;if(persist(received.filter(r=>r.card.id!==b.dataset.receivedDelete))){receivedClocks.delete(b.dataset.receivedDelete);renderReceived();api.redraw();}};}
  }
  $('showReceived').onchange=()=>api.redraw();
  api.addOverlay({draw({ctx,screen,project}){if(!$('showReceived').checked)return;for(const r of received){const p=screen(project(r.card.lon,r.card.lat));if(p[0]<-20||p[0]>innerWidth+20||p[1]<-20||p[1]>innerHeight+20)continue;
    ctx.save();ctx.translate(...p);ctx.fillStyle=r.card.kind==='goal'?'#a16d22':'#818886';ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.beginPath();
    if(r.card.kind==='goal'){ctx.moveTo(0,-12);ctx.lineTo(12,0);ctx.lineTo(0,12);ctx.lineTo(-12,0);ctx.closePath();}else ctx.arc(0,0,11,0,Math.PI*2);
    ctx.fill();ctx.stroke();ctx.fillStyle='#fff';ctx.font='700 10px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(r.card.kind==='goal'?'목':'받',0,0);ctx.restore();}},
    hit(x,y){if(!$('showReceived').checked)return null;const camera=api.state.camera,s=256*2**camera.z,rect=$('map').getBoundingClientRect();for(const r of [...received].reverse()){const p=api.project(r.card.lon,r.card.lat),sx=(p[0]-camera.x)*s+rect.width/2,sy=(p[1]-camera.y)*s+rect.height/2;if(Math.hypot(sx-x,sy-y)<18)return()=>{open('received');el.querySelector(`[data-received="${r.card.id}"]`)?.scrollIntoView({block:'center'});};}return null;}});
  setInterval(()=>{if(document.hidden)return;if(el.open&&tab==='received')renderReceived();if(received.length)api.redraw();},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(el.open&&tab==='received')renderReceived();if(received.length)api.redraw();}});
  renderReceived();setTab('send');
  window.DURU_SHARING={parse,cleanCard,cardText,open,get received(){return received.map(r=>({...r,card:{...r.card}}));}};
})();
