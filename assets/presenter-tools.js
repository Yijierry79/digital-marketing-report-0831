/* Streamax 演讲者视图：本地备注、自动保存与双屏同步。 */
(function(){
  'use strict';

  const NOTE_PREFIX='streamax-presenter-note-v1:';
  const SYNC_CHANNEL='streamax-presenter-sync-v1';
  const SYNC_EVENT_KEY='streamax-presenter-sync-event-v1';
  const IS_SPEAKER_MODE=new URLSearchParams(location.search).get('speaker')==='1';
  const SOURCE=`main-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mainChannel=!IS_SPEAKER_MODE&&'BroadcastChannel' in window?new BroadcastChannel(SYNC_CHANNEL):null;
  const seenMessages=new Set();
  let speakerWindow=null;
  let speakerChannel=null;
  let speakerSource='';

  window.__speakerMode=IS_SPEAKER_MODE;

  /* 使用页面的稳定语义标识，中间插页或重排时不会让旧备注错位。 */
  const usedNoteKeys=new Set();
  slides.forEach((slide,slideIndex)=>{
    const semanticKey=(slide.dataset.noteKey||slide.dataset.sequence||slide.id||`${slide.dataset.layout||'slide'}-${slideIndex+1}`).trim();
    let stableKey=semanticKey;
    let duplicate=2;
    while(usedNoteKeys.has(stableKey)) stableKey=`${semanticKey}-${duplicate++}`;
    usedNoteKeys.add(stableKey);
    slide.dataset.noteKey=stableKey;
  });

  function noteKey(slide){return NOTE_PREFIX+slide.dataset.noteKey;}
  function readNote(slide){
    try{return localStorage.getItem(noteKey(slide))||'';}catch(error){console.warn('无法读取本地演讲备注',error);return '';}
  }
  function writeNote(key,value){
    try{localStorage.setItem(key,value);return true;}catch(error){console.warn('无法保存本地演讲备注',error);return false;}
  }
  function message(source,type,payload={}){
    return {id:`${source}-${Date.now()}-${Math.random().toString(36).slice(2)}`,source,type,ts:Date.now(),...payload};
  }
  function remember(item,set=seenMessages){
    if(!item||!item.id||set.has(item.id)) return false;
    set.add(item.id);
    if(set.size>200) set.delete(set.values().next().value);
    return true;
  }
  function publish(type,payload={}){
    const item=message(SOURCE,type,payload);
    remember(item);
    mainChannel?.postMessage(item);
    try{localStorage.setItem(SYNC_EVENT_KEY,JSON.stringify(item));}catch{}
    if(speakerWindow&&!speakerWindow.closed) speakerWindow.postMessage(item,'*');
  }
  function publishState(){
    publish('slide-state',{index:idx,total,noteKey:noteKey(slides[idx])});
    if(speakerWindow&&!speakerWindow.closed) renderState(idx);
  }
  function receiveOnMain(item){
    if(!item||item.source===SOURCE||!remember(item)) return;
    if(item.type==='slide-request'&&Number.isFinite(Number(item.index))) go(Number(item.index),{force:true});
    else if(item.type==='speaker-ready') publishState();
  }

  mainChannel?.addEventListener('message',event=>receiveOnMain(event.data));
  if(!IS_SPEAKER_MODE){
    window.addEventListener('storage',event=>{
      if(event.key!==SYNC_EVENT_KEY||!event.newValue) return;
      try{receiveOnMain(JSON.parse(event.newValue));}catch{}
    });
    window.addEventListener('message',event=>{
      if(!speakerWindow||event.source!==speakerWindow) return;
      receiveOnMain(event.data);
    });
  }

  function heading(slide){
    return slide?.querySelector('h1,h2,h3,.page-title,.module-divider-title')?.textContent.replace(/\s+/g,' ').trim()||'未命名幻灯片';
  }
  function previewDocument(slide){
    const clone=slide.cloneNode(true);
    clone.querySelectorAll('canvas,script').forEach(element=>element.remove());
    clone.querySelectorAll('[contenteditable]').forEach(element=>element.removeAttribute('contenteditable'));
    clone.querySelectorAll('video').forEach(video=>{video.removeAttribute('autoplay');video.preload='metadata';video.muted=true;});
    const inherited=[...document.querySelectorAll('style')].map(style=>style.textContent).join('\n');
    const base=new URL('.',location.href).href.replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    const dark=slide.classList.contains('dark')||slide.classList.contains('accent');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${base}"><style>${inherited}</style><style>
      html,body{width:1600px!important;height:900px!important;overflow:hidden!important;margin:0!important;background:#fff!important}
      body.dark-bg{background:#102A4D!important}
      #hint,#nav,.editor-toolbar,#overview,#image-lightbox{display:none!important}
      .slide{display:flex!important;position:relative!important;width:1600px!important;height:900px!important;min-width:1600px!important;min-height:900px!important;transform:none!important}
      .slide [data-anim],.slide [style*="opacity: 0"]{opacity:1!important;transform:none!important;clip-path:none!important;visibility:visible!important}
      *{animation:none!important;transition:none!important}
    </style></head><body class="canvas-mode low-power${dark?' dark-bg':''}">${clone.outerHTML}</body></html>`;
  }
  function renderPreview(stage,slide){
    stage.replaceChildren();
    if(!slide){
      const end=speakerWindow.document.createElement('div');
      end.className='speaker-end-card';
      end.innerHTML='<strong>演示结束</strong><span>已经是最后一页</span>';
      stage.appendChild(end);
      return;
    }
    const frame=speakerWindow.document.createElement('iframe');
    frame.setAttribute('title',`幻灯片预览：${heading(slide)}`);
    frame.setAttribute('tabindex','-1');
    frame.style.cssText='position:absolute;width:1600px;height:900px;border:0;transform-origin:top left;pointer-events:none';
    frame.srcdoc=previewDocument(slide);
    stage.appendChild(frame);
    const fit=()=>{
      if(!speakerWindow||speakerWindow.closed||!frame.isConnected) return;
      const scale=Math.min(stage.clientWidth/1600,stage.clientHeight/900);
      frame.style.transform=`scale(${scale})`;
      frame.style.left=`${Math.max(0,(stage.clientWidth-1600*scale)/2)}px`;
      frame.style.top=`${Math.max(0,(stage.clientHeight-900*scale)/2)}px`;
    };
    fit();
    frame.addEventListener('load',fit,{once:true});
  }
  function renderState(requestedIndex=idx){
    if(!speakerWindow||speakerWindow.closed||!speakerWindow.document.getElementById('speaker-app')) return;
    const currentIndex=Math.max(0,Math.min(total-1,Number(requestedIndex)||0));
    idx=currentIndex;
    window.__currentSlideIndex=currentIndex;
    const current=slides[currentIndex];
    const next=slides[currentIndex+1]||null;
    const doc=speakerWindow.document;
    const textarea=doc.getElementById('speaker-notes');
    const currentKey=noteKey(current);
    renderPreview(doc.getElementById('speaker-current-stage'),current);
    renderPreview(doc.getElementById('speaker-next-stage'),next);
    doc.getElementById('speaker-counter').textContent=`${String(currentIndex+1).padStart(2,'0')} / ${String(total).padStart(2,'0')}`;
    doc.getElementById('speaker-current-title').textContent=heading(current);
    doc.getElementById('speaker-next-title').textContent=next?heading(next):'演示结束';
    doc.getElementById('speaker-prev').disabled=currentIndex===0;
    doc.getElementById('speaker-next').disabled=currentIndex===total-1;
    textarea.dataset.noteKey=currentKey;
    textarea.dataset.slideIndex=String(currentIndex);
    if(doc.activeElement!==textarea||textarea.dataset.loadedKey!==currentKey){
      textarea.value=readNote(current);
      textarea.dataset.loadedKey=currentKey;
    }
    doc.getElementById('speaker-save-status').textContent=textarea.value?'已从本机加载':'尚未添加备注';
    doc.getElementById('speaker-connection').textContent='已同步';
  }

  function mountSpeakerView(){
    speakerWindow=window;
    const doc=document;
    doc.title='演讲者视图 · 数字营销汇报';
    doc.body.className='';
    doc.body.replaceChildren();
    const style=doc.createElement('style');
    style.textContent=`
      :root{--navy:#102A4D;--green:#ABCD01;--paper:#F5F7F8;--muted:#6D7B87;--line:#D8E0E7;font-family:Helvetica,Arial,"Microsoft YaHei",sans-serif}
      *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:var(--paper);color:var(--navy)}
      button,textarea{font:inherit}.speaker-shell{height:100%;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:14px;padding:16px}
      .speaker-head,.speaker-foot{display:flex;align-items:center;justify-content:space-between;gap:16px}.speaker-brand{display:flex;align-items:center;gap:12px}.speaker-brand strong{font-size:18px}.speaker-counter{font:700 20px/1 monospace;letter-spacing:.06em}.speaker-connection{padding:5px 8px;background:var(--green);font-size:12px;font-weight:700}
      .speaker-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(360px,.8fr);gap:14px;min-height:0}.speaker-card{min-height:0;background:#fff;border:1px solid var(--line);display:flex;flex-direction:column}.speaker-label{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.speaker-label span:last-child{font-weight:400;letter-spacing:0;text-transform:none;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .speaker-current-stage,.speaker-next-stage{position:relative;min-height:0;overflow:hidden;background:#E9EDF0}.speaker-current-stage{flex:1}.speaker-side{display:grid;grid-template-rows:minmax(190px,.42fr) minmax(260px,.58fr);gap:14px;min-height:0}.speaker-next-stage{flex:1}
      .speaker-notes-card{min-height:0}.speaker-notes{width:100%;flex:1;min-height:0;resize:none;border:0;padding:16px;background:#fff;color:var(--navy);font-size:18px;line-height:1.55;outline:none}.speaker-notes:focus{box-shadow:inset 0 0 0 3px var(--green)}.speaker-save-row{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
      .speaker-controls{display:flex;gap:8px}.speaker-controls button{border:1px solid var(--navy);background:#fff;color:var(--navy);padding:10px 18px;cursor:pointer;font-weight:700}.speaker-controls button.primary{background:var(--navy);color:#fff}.speaker-controls button:hover:not(:disabled),.speaker-controls button:focus-visible{background:var(--green);color:var(--navy);outline:none}.speaker-controls button:disabled{opacity:.35;cursor:not-allowed}.speaker-help{max-width:620px;color:var(--muted);font-size:12px;line-height:1.4}.speaker-end-card{width:100%;height:100%;display:grid;place-content:center;text-align:center;gap:8px;color:var(--muted)}.speaker-end-card strong{font-size:22px;color:var(--navy)}
      @media(max-width:900px){.speaker-grid{grid-template-columns:1fr}.speaker-side{grid-template-columns:1fr 1fr;grid-template-rows:minmax(210px,1fr)}.speaker-help{display:none}}
    `;
    doc.head.appendChild(style);
    doc.body.innerHTML=`<main class="speaker-shell" id="speaker-app">
      <header class="speaker-head"><div class="speaker-brand"><strong>演讲者视图</strong><span class="speaker-connection" id="speaker-connection">正在连接…</span></div><div class="speaker-counter" id="speaker-counter">-- / --</div></header>
      <section class="speaker-grid"><article class="speaker-card"><div class="speaker-label"><span>当前页</span><span id="speaker-current-title"></span></div><div class="speaker-current-stage" id="speaker-current-stage"></div></article>
        <div class="speaker-side"><article class="speaker-card"><div class="speaker-label"><span>下一页</span><span id="speaker-next-title"></span></div><div class="speaker-next-stage" id="speaker-next-stage"></div></article>
          <article class="speaker-card speaker-notes-card"><div class="speaker-label"><span>本页备注</span><span>输入即保存</span></div><textarea id="speaker-notes" class="speaker-notes" aria-label="当前幻灯片的演讲备注" placeholder="在这里输入演讲备注……"></textarea><div class="speaker-save-row"><span id="speaker-save-status" role="status">尚未添加备注</span><span>仅保存在此浏览器</span></div></article></div></section>
      <footer class="speaker-foot"><div class="speaker-controls"><button type="button" id="speaker-prev">← 上一页</button><button type="button" id="speaker-next" class="primary">下一页 →</button></div><p class="speaker-help">备注保存在当前浏览器的站点数据中。只要链接域名不变，更新 HTML 不会覆盖备注；清除站点数据或使用无痕模式会使备注丢失。</p></footer>
    </main>`;

    speakerSource=`speaker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    speakerChannel='BroadcastChannel' in window?new BroadcastChannel(SYNC_CHANNEL):null;
    const speakerSeen=new Set();
    const accept=item=>{
      if(!item||item.source===speakerSource||!remember(item,speakerSeen)) return;
      if(item.type==='slide-state') renderState(item.index);
      if(item.type==='note-change'){
        const textarea=doc.getElementById('speaker-notes');
        if(textarea?.dataset.noteKey===item.noteKey&&doc.activeElement!==textarea) textarea.value=item.value||'';
      }
    };
    speakerChannel?.addEventListener('message',event=>accept(event.data));
    window.addEventListener('storage',event=>{
      if(event.key!==SYNC_EVENT_KEY||!event.newValue) return;
      try{accept(JSON.parse(event.newValue));}catch{}
    });
    window.addEventListener('message',event=>{if(event.source===window.opener) accept(event.data);});
    const emit=(type,payload={})=>{
      const item=message(speakerSource,type,payload);
      speakerSeen.add(item.id);
      speakerChannel?.postMessage(item);
      try{localStorage.setItem(SYNC_EVENT_KEY,JSON.stringify(item));}catch{}
      if(window.opener&&!window.opener.closed) window.opener.postMessage(item,'*');
    };
    const request=nextIndex=>emit('slide-request',{index:Math.max(0,Math.min(total-1,nextIndex))});
    doc.getElementById('speaker-prev').addEventListener('click',()=>request(Number(doc.getElementById('speaker-notes').dataset.slideIndex)-1));
    doc.getElementById('speaker-next').addEventListener('click',()=>request(Number(doc.getElementById('speaker-notes').dataset.slideIndex)+1));
    let statusTimer=null;
    doc.getElementById('speaker-notes').addEventListener('input',event=>{
      const textarea=event.currentTarget;
      const saved=writeNote(textarea.dataset.noteKey,textarea.value);
      const status=doc.getElementById('speaker-save-status');
      status.textContent=saved?`已自动保存 · ${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`:'保存失败：请检查浏览器站点数据权限';
      clearTimeout(statusTimer);
      statusTimer=setTimeout(()=>{if(status&&saved) status.textContent='已保存在本机';},1800);
      emit('note-change',{noteKey:textarea.dataset.noteKey,value:textarea.value});
    });
    window.addEventListener('keydown',event=>{
      if(event.target.matches('textarea,input,[contenteditable="true"]')) return;
      const currentIndex=Number(doc.getElementById('speaker-notes').dataset.slideIndex)||0;
      if(event.key==='ArrowRight'||event.key==='PageDown'||event.key===' '||event.key==='ArrowDown'){event.preventDefault();request(currentIndex+1);}
      if(event.key==='ArrowLeft'||event.key==='PageUp'||event.key==='ArrowUp'){event.preventDefault();request(currentIndex-1);}
      if(event.key==='Home'){event.preventDefault();request(0);}
      if(event.key==='End'){event.preventDefault();request(total-1);}
    });
    window.addEventListener('resize',()=>renderState(Number(doc.getElementById('speaker-notes').dataset.slideIndex)||idx));
    window.addEventListener('beforeunload',()=>speakerChannel?.close());
    renderState(idx);
    emit('speaker-ready',{index:idx});
    window.focus();
  }

  function openSpeakerView(){
    if(IS_SPEAKER_MODE){mountSpeakerView();return;}
    const url=new URL(location.href);
    url.searchParams.set('speaker','1');
    url.searchParams.set('slide',String(idx+1));
    speakerWindow=window.open(url.href,'streamax-speaker-view','popup=yes,width=1280,height=820,resizable=yes,scrollbars=no,toolbar=no,location=no,menubar=no,status=no');
    if(!speakerWindow) alert('浏览器阻止了演讲者窗口。请允许此站点弹出窗口后重试。');
    else speakerWindow.focus();
  }

  function installLaunchButton(){
    window.addEventListener('keydown',event=>{
      if(event.target.matches?.('textarea,input,select,[contenteditable="true"]')) return;
      if(event.key?.toLowerCase()==='s'&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();openSpeakerView();}
    });
  }

  document.addEventListener('presentation:slidechange',event=>{if(event.detail?.broadcast!==false) publishState();});
  window.__presenterAPI={open:openSpeakerView,getCurrentIndex:()=>idx,getNoteKey:index=>noteKey(slides[index]),getNote:index=>readNote(slides[index])};
  if(!IS_SPEAKER_MODE) installLaunchButton();
})();
