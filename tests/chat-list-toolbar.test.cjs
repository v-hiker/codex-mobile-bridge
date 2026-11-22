'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

test('list filters follow the selected label and language',()=>{
  const documentEvents={},bodyChildren=[];
  const makeEl=tag=>{
    const listeners={},el={tagName:tag.toUpperCase(),children:[],dataset:{},attributes:{},style:{},className:'',textContent:'',hidden:false,disabled:false,focused:false,
      classList:{set:new Set(),add(...names){names.forEach(n=>this.set.add(n));},contains(n){return this.set.has(n);}},
      append(...items){items.forEach(item=>{item.parentElement=this;this.children.push(item);if(this===body)bodyChildren.push(item);});},
      replaceChildren(...items){this.children=[];if(this===body)bodyChildren.length=0;this.append(...items);},
      after(...items){if(!this.parentElement)return;const i=this.parentElement.children.indexOf(this);items.forEach((it,off)=>{it.parentElement=this.parentElement;this.parentElement.children.splice(i+1+off,0,it);});},
      remove(){if(this.parentElement===body){const i=bodyChildren.indexOf(this);if(i>=0)bodyChildren.splice(i,1);}if(this.parentElement){const i=this.parentElement.children.indexOf(this);if(i>=0)this.parentElement.children.splice(i,1);this.parentElement=null;}},
      contains(target){return target===this||this.children.some(c=>c.contains?.(target));},
      setAttribute(k,v){this.attributes[k]=v;},
      getAttribute(k){return this.attributes[k];},
      addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
      removeEventListener(type,fn){if(listeners[type])listeners[type]=listeners[type].filter(f=>f!==fn);},
      dispatchEvent(evt){for(const fn of listeners[evt.type]||[])fn(evt);},
      querySelectorAll(sel){return sel.includes('.filter-dropdown-item')?this.children.filter(c=>!c.disabled):[];},
      querySelector(sel){return sel==='[aria-selected="true"]:not(:disabled)'?this.children.find(c=>c.attributes['aria-selected']==='true'&&!c.disabled):this.children.find(c=>c.className.includes('filter-dropdown-item'));},
      getBoundingClientRect(){return {left:14,top:92,bottom:120,width:72,height:28};},
      focus(){this.focused=true;},
    };
    return el;
  };
  const body=makeEl('body');
  const select=(id,options,initial)=>{
    const s=makeEl('select');s.id=id;s.options=options.map(([value,textContent])=>{const o=makeEl('option');o.value=value;o.textContent=textContent;return o;});
    s.value=initial;s.selectedOptions=[s.options.find(o=>o.value===initial)];return s;
  };
  const surface=select('source-filter',[['all','All'],['cli','CLI']],'all');
  const mode=select('list-mode',[['recent','Recent'],['project','Project']],'recent');
  const toolbar=makeEl('div');toolbar.append(surface,mode);toolbar.querySelectorAll=()=>[surface,mode];
  const context=vm.createContext({
    document:{createElement:makeEl,body,activeElement:null,addEventListener(name,fn){(documentEvents[name]??=[]).push(fn);},removeEventListener(name,fn){if(documentEvents[name])documentEvents[name]=documentEvents[name].filter(f=>f!==fn);}},
    window:{addEventListener(){},removeEventListener(){}},
    innerWidth:390,innerHeight:844,Event:class{constructor(type){this.type=type;}},requestAnimationFrame:fn=>fn(),cancelAnimationFrame(){},Node:class{},
  });
  context.ClientIdentity=require('../web/features/clients/client-lifecycle.js').ClientIdentity;
  vm.runInContext(fs.readFileSync('web/features/clients/client-navigation.js','utf8'),context);
  vm.runInContext('bindChatListToolbar(toolbar)',Object.assign(context,{toolbar}));
  assert.equal(mode.style.width,'');assert.equal(surface.style.width,'');
  assert.equal(mode.classList.contains('filter-select-native'),true);
  const triggers=toolbar.children.filter(c=>c.className==='filter-dropdown-trigger');
  assert.equal(triggers[0].children[0].textContent,'All');
  assert.equal(triggers[1].children[0].textContent,'Recent');
  mode.value='project';mode.selectedOptions=[mode.options[1]];mode.dispatchEvent({type:'change'});
  assert.equal(triggers[1].children[0].textContent,'Project');
  mode.options[1].textContent='按项目';
  for(const fn of documentEvents['bridge-language']||[])fn();
  assert.equal(triggers[1].children[0].textContent,'按项目');
  triggers[1].onclick({preventDefault(){},stopPropagation(){}});
  assert.equal(bodyChildren.at(-1).className,'filter-dropdown-menu');
  assert.deepEqual(bodyChildren.at(-1).children.map(item=>item.children[0].textContent),['Recent','按项目']);
});
