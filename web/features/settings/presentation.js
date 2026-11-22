'use strict';
// Appearance is local to this browser; no desktop or account settings are changed.
const ChatAppearance=(()=>{
  const defaults={theme:'system',accent:'#4664ed',fontSize:16,codeSize:13,density:'standard',showReasoning:true,showProcess:true,showToolImages:true,showActivity:true,showComputer:true,showPushplus:true,showAccounts:true,showFileThumbnails:true};
  function normalize(value={}){
    if(!value||typeof value!=='object')value={};
    return {theme:['system','light','dark'].includes(value.theme)?value.theme:defaults.theme,
      accent:/^#[0-9a-f]{6}$/i.test(value.accent)?value.accent:defaults.accent,
      fontSize:Number.isInteger(value.fontSize)&&value.fontSize>=10&&value.fontSize<=32?value.fontSize:defaults.fontSize,
      codeSize:Number.isInteger(value.codeSize)&&value.codeSize>=8&&value.codeSize<=28?value.codeSize:defaults.codeSize,
      density:['compact','standard','relaxed'].includes(value.density)?value.density:defaults.density,
      showReasoning:typeof value.showReasoning==='boolean'?value.showReasoning:defaults.showReasoning,
      showProcess:typeof value.showProcess==='boolean'?value.showProcess:defaults.showProcess,
      showToolImages:typeof value.showToolImages==='boolean'?value.showToolImages:defaults.showToolImages,
      showPushplus:typeof value.showPushplus==='boolean'?value.showPushplus:defaults.showPushplus,
      showAccounts:typeof value.showAccounts==='boolean'?value.showAccounts:defaults.showAccounts,
      showFileThumbnails:typeof value.showFileThumbnails==='boolean'?value.showFileThumbnails:defaults.showFileThumbnails,
      showComputer:typeof value.showComputer==='boolean'?value.showComputer:defaults.showComputer,
      showActivity:typeof value.showActivity==='boolean'?value.showActivity:defaults.showActivity};
  }
  function luminance(hex){
    const rgb=hex.match(/[0-9a-f]{2}/gi).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;
  }
  function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
  function colors(accent,dark){
    const background=dark?'#17181c':'#ffffff';
    let text=accent;
    const rgb=accent.match(/[0-9a-f]{2}/gi).map(v=>parseInt(v,16));
    for(let step=1;contrast(text,background)<4.5&&step<=20;step++){
      text='#'+rgb.map(v=>Math.round(v+((dark?255:0)-v)*step/20).toString(16).padStart(2,'0')).join('');
    }
    return {text,ink:contrast(accent,'#ffffff')>=contrast(accent,'#000000')?'#ffffff':'#000000'};
  }
  return {defaults,normalize,colors};
})();
if(typeof module!=='undefined')module.exports=ChatAppearance;

if(typeof document!=='undefined')(()=>{
  const get=id=>document.getElementById(id),root=document.documentElement;
  const key='bridge-appearance',system=window.matchMedia('(prefers-color-scheme: dark)');
  let saved;try{saved=JSON.parse(localStorage.getItem(key));}catch{}
  let settings=ChatAppearance.normalize(saved);
  const composer=get('composer');
  function preserveReading(change){
    const timeline=typeof chatTimeline==='undefined'?null:chatTimeline;
    const anchor=timeline?.capture(),bottom=timeline?.following;
    change();
    requestAnimationFrame(()=>{if(timeline&&timeline===chatTimeline)timeline.restore(anchor,bottom);});
  }
  function save(notify=true){try{localStorage.setItem(key,JSON.stringify(settings));}catch{}if(notify)document.dispatchEvent(new CustomEvent('bridge-appearance-change',{detail:{...settings}}));}
  function apply(){
    const dark=settings.theme==='dark'||settings.theme==='system'&&(window.BridgeNativeTheme?.dark??system.matches);
    const colors=ChatAppearance.colors(settings.accent,dark);
    root.dataset.theme=dark?'dark':'light';root.dataset.density=settings.density;
    root.dataset.showActivity=String(settings.showActivity);
    root.dataset.showComputer=String(settings.showComputer);get('appearance-computer').checked=settings.showComputer;
    root.dataset.showPushplus=String(settings.showPushplus);root.dataset.showAccounts=String(settings.showAccounts);
    root.dataset.showFileThumbnails=String(settings.showFileThumbnails);
    get('appearance-file-thumbnails').checked=settings.showFileThumbnails;
    window.BridgeWorkbench?.setThumbnails(settings.showFileThumbnails);
    get('appearance-pushplus').checked=settings.showPushplus;get('appearance-accounts').checked=settings.showAccounts;
    root.dataset.showReasoning=String(settings.showReasoning);root.dataset.showProcess=String(settings.showProcess);
    root.dataset.showToolImages=String(settings.showToolImages);
    get('appearance-tool-images').checked=settings.showToolImages;
    if(typeof chatTimeline!=='undefined')chatTimeline?.setVisibility(settings);
    root.style.setProperty('--accent',settings.accent);
    root.style.setProperty('--accent-ink',colors.ink);
    root.style.setProperty('--green',colors.text);
    root.style.setProperty('--soft',settings.accent+(dark?'29':'12'));
    root.style.setProperty('--message-size',settings.fontSize+'px');
    root.style.setProperty('--code-size',settings.codeSize+'px');
    document.querySelector('meta[name="theme-color"]').content=dark?'#17181c':'#ffffff';
    for(const [id,value] of Object.entries({theme:settings.theme,accent:settings.accent,font:settings.fontSize,code:settings.codeSize,density:settings.density}))get('appearance-'+id).value=value;
    get('appearance-font-value').textContent=settings.fontSize+' px';get('appearance-code-value').textContent=settings.codeSize+' px';
    get('appearance-activity').checked=settings.showActivity;get('appearance-reasoning').checked=settings.showReasoning;get('appearance-process').checked=settings.showProcess;
    document.querySelectorAll('[data-accent]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.accent===settings.accent.toLowerCase())));
  }
  function change(values){preserveReading(()=>{settings=ChatAppearance.normalize({...settings,...values});apply();save();if(Object.hasOwn(values,'theme'))document.dispatchEvent(new CustomEvent('bridge-theme-change',{detail:{theme:settings.theme}}));});}
  function nativeTheme(){
    const value=window.BridgeNativeTheme;
    if(!value||!['system','light','dark'].includes(value.theme)||typeof value.dark!=='boolean')return;
    preserveReading(()=>{settings=ChatAppearance.normalize({...settings,theme:value.theme});apply();save(false);});
  }
  document.addEventListener('bridge-native-theme',nativeTheme);
  document.addEventListener('bridge-appearance-restored',event=>{preserveReading(()=>{settings=ChatAppearance.normalize(event.detail);apply();});});
  const resizeMessage=()=>composerToolbar.resizeInput();
  const chatStyle=get('chat').style;
  const composerSize=new ResizeObserver(([entry])=>{
    const height=Math.ceil(entry.borderBoxSize?.[0]?.blockSize??composer.getBoundingClientRect().height);
    const value=height+'px';
    if(chatStyle.getPropertyValue('--composer-height')!==value)chatStyle.setProperty('--composer-height',value);
  });
  composerSize.observe(composer,{box:'border-box'});
  const pageState=new MutationObserver(()=>document.body.classList.toggle('chat-detail',!get('app').hidden&&get('app').classList.contains('chat-open')));
  pageState.observe(get('app'),{attributes:true,attributeFilter:['hidden','class']});
  document.querySelectorAll('[data-open-appearance]').forEach(button=>button.onclick=()=>{get('appearance-dialog').showModal();window.loadNotificationDefaults?.();});
  get('chat-details-button').onclick=()=>window.openCodexSessionMenu(get('chat-details-button'));
  // This script is loaded after app.js, which binds the existing close controls.
  get('appearance-language').onchange=()=>{get('phone-language').value=get('appearance-language').value;get('phone-language').onchange();get('appearance-language').value=BridgeI18n.language();};
  get('appearance-theme').onchange=()=>change({theme:get('appearance-theme').value});
  get('appearance-accent').oninput=()=>change({accent:get('appearance-accent').value});
  get('appearance-font').oninput=()=>change({fontSize:Number(get('appearance-font').value)});
  get('appearance-code').oninput=()=>change({codeSize:Number(get('appearance-code').value)});
  get('appearance-density').onchange=()=>change({density:get('appearance-density').value});
  get('appearance-reasoning').onchange=()=>change({showReasoning:get('appearance-reasoning').checked});
  get('appearance-computer').onchange=()=>change({showComputer:get('appearance-computer').checked});
  get('appearance-activity').onchange=()=>change({showActivity:get('appearance-activity').checked});
  get('appearance-file-thumbnails').onchange=()=>change({showFileThumbnails:get('appearance-file-thumbnails').checked});
  get('appearance-process').onchange=()=>change({showProcess:get('appearance-process').checked});
  get('appearance-tool-images').onchange=()=>change({showToolImages:get('appearance-tool-images').checked});
  document.querySelectorAll('[data-accent]').forEach(button=>button.onclick=()=>change({accent:button.dataset.accent}));
  get('appearance-pushplus').onchange=()=>change({showPushplus:get('appearance-pushplus').checked});
  get('appearance-accounts').onchange=()=>change({showAccounts:get('appearance-accounts').checked});
  get('appearance-reset').onclick=()=>change(ChatAppearance.defaults);
  system.addEventListener('change',()=>{if(settings.theme==='system')preserveReading(apply);});
  const revealMessage=()=>composerToolbar.setCollapsed(false);
  window.BridgePresentation={resizeMessage,openChat:()=>requestAnimationFrame(revealMessage),showError:revealMessage};
  apply();nativeTheme();resizeMessage();
  document.body.classList.toggle('chat-detail',!get('app').hidden&&get('app').classList.contains('chat-open'));
  const chat=get('chat'),timeline=get('timeline'),newer=get('newer'),search=get('search'),app=get('app');
  const reduceMotion=()=>typeof window.matchMedia==='function'&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const jumpLabel=()=>typeof BridgeI18n!=='undefined'&&BridgeI18n.language?.()==='en'?'Jump to bottom':'回到底部';
  let jumpButton=null;
  const syncJumpBottom=()=>{
    if(!jumpButton||!chat||!timeline)return;
    const distance=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight;
    const newerVisible=Boolean(newer&&!newer.hidden);
    jumpButton.hidden=chat.hidden||newerVisible||distance<=360;
  };
  if(chat&&timeline&&composer){
    jumpButton=document.createElement('button');
    jumpButton.id='jump-bottom';jumpButton.className='jump-bottom';jumpButton.type='button';jumpButton.hidden=true;
    const updateJumpLabel=()=>{const label=jumpLabel();jumpButton.setAttribute('aria-label',label);jumpButton.title=label;};
    updateJumpLabel();
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');
    svg.setAttribute('stroke-width','2');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');
    svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m6 9 6 6 6-6');
    svg.append(path);jumpButton.append(svg);
    composer.before(jumpButton);
    jumpButton.onclick=()=>{
      if(typeof timeline.scrollTo==='function')timeline.scrollTo({top:timeline.scrollHeight,behavior:reduceMotion()?'auto':'smooth'});
      else timeline.scrollTop=timeline.scrollHeight;
    };
    timeline.addEventListener('scroll',syncJumpBottom,{passive:true});
    if(typeof ResizeObserver!=='undefined')new ResizeObserver(syncJumpBottom).observe(timeline);
    if(typeof MutationObserver!=='undefined'){
      new MutationObserver(syncJumpBottom).observe(chat,{attributes:true,attributeFilter:['hidden']});
      if(newer)new MutationObserver(syncJumpBottom).observe(newer,{attributes:true,attributeFilter:['hidden']});
    }
    document.addEventListener('bridge-language',updateJumpLabel);
    syncJumpBottom();
  }
  if(search){
    try{search.type='search';}catch{}
    search.addEventListener('keydown',event=>{
      if(event.key!=='Escape')return;
      if(search.value){search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));event.preventDefault();}
      else search.blur();
    });
  }
  const welcome=get('welcome');
  if(welcome&&!get('welcome-new-chat')&&typeof welcome.append==='function'&&typeof document.createElement==='function'&&typeof document.createElementNS==='function'){
    const actions=document.createElement('div');actions.className='welcome-actions';
    const isApple=typeof navigator!=='undefined'&&/Mac|iPhone|iPad|iPod/i.test(navigator.platform||'');
    const createBtn=document.createElement('button');createBtn.id='welcome-new-chat';createBtn.className='welcome-primary';createBtn.type='button';
    const plusIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    plusIcon.setAttribute('viewBox','0 0 24 24');plusIcon.setAttribute('fill','none');plusIcon.setAttribute('stroke','currentColor');
    plusIcon.setAttribute('stroke-width','2.2');plusIcon.setAttribute('stroke-linecap','round');plusIcon.setAttribute('stroke-linejoin','round');plusIcon.setAttribute('aria-hidden','true');
    const plusPath=document.createElementNS('http://www.w3.org/2000/svg','path');plusPath.setAttribute('d','M12 5v14M5 12h14');
    plusIcon.append(plusPath);
    const createText=document.createElement('span');
    createBtn.append(plusIcon,createText);
    createBtn.onclick=()=>get('new-chat')?.click();
    const searchBtn=document.createElement('button');searchBtn.id='welcome-search';searchBtn.className='welcome-secondary';searchBtn.type='button';
    const searchIcon=document.createElementNS('http://www.w3.org/2000/svg','svg');
    searchIcon.setAttribute('viewBox','0 0 24 24');searchIcon.setAttribute('fill','none');searchIcon.setAttribute('stroke','currentColor');
    searchIcon.setAttribute('stroke-width','1.9');searchIcon.setAttribute('stroke-linecap','round');searchIcon.setAttribute('stroke-linejoin','round');searchIcon.setAttribute('aria-hidden','true');
    const searchCircle=document.createElementNS('http://www.w3.org/2000/svg','circle');searchCircle.setAttribute('cx','11');searchCircle.setAttribute('cy','11');searchCircle.setAttribute('r','7');
    const searchPath=document.createElementNS('http://www.w3.org/2000/svg','path');searchPath.setAttribute('d','m20 20-3.5-3.5');
    searchIcon.append(searchCircle,searchPath);
    const searchText=document.createElement('span');
    const kbd=document.createElement('kbd');kbd.className='welcome-kbd';kbd.textContent=isApple?'⌘K':'Ctrl K';
    searchBtn.append(searchIcon,searchText,kbd);
    searchBtn.onclick=()=>{
      if(!search)return;
      if(app?.classList?.contains('chat-list-collapsed')){
        const toggle=document.querySelector('.chat-list-toggle');
        if(toggle)toggle.click();else app.classList.remove('chat-list-collapsed');
      }
      search.focus();search.select();
    };
    const syncWelcomeLabels=()=>{
      const en=typeof BridgeI18n!=='undefined'&&BridgeI18n.language?.()==='en';
      createText.textContent=en?'New chat':'新建聊天';
      searchText.textContent=en?'Search chats':'搜索聊天';
    };
    syncWelcomeLabels();
    document.addEventListener('bridge-language',syncWelcomeLabels);
    actions.append(createBtn,searchBtn);welcome.append(actions);
  }
  document.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey)||event.altKey||event.shiftKey||event.key.toLowerCase()!=='k')return;
    if(!search||!app||app.hidden||document.querySelector('dialog[open]'))return;
    if(window.innerWidth<=720&&app.classList.contains('chat-open'))return;
    if(app.classList.contains('chat-list-collapsed')){
      const toggle=document.querySelector('.chat-list-toggle');
      if(toggle)toggle.click();else app.classList.remove('chat-list-collapsed');
    }
    event.preventDefault();search.focus();search.select();
  });
})();
