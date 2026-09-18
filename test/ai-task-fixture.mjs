import http from 'node:http';
const html = `<!doctype html><title>Task test store</title><style>body{font:18px sans-serif;padding:30px}button,input,select{padding:12px;margin:10px}section{padding:12px;border:1px solid #ccc}h1{font-size:28px}</style><main></main><script>
window.events=[];window.sends=0;document.documentElement.dataset.events="[]";document.documentElement.dataset.sends="0";function recordEvent(name){events.push(name);document.documentElement.dataset.events=JSON.stringify(events)}
const main=document.querySelector('main');
function home(){main.innerHTML='<h1>Store</h1><button id="catalog">Open catalog</button><button>Account</button>';document.querySelector('#catalog').onclick=()=>{recordEvent('catalog');catalog()}}
function catalog(){main.innerHTML='<h1>Catalog</h1><section><h2>Notebook</h2><button id="notebook">Details</button></section><section><h2>Desk lamp</h2><button id="lamp">Details</button></section>';document.querySelector('#notebook').onclick=()=>{recordEvent('wrong-product');main.innerHTML='<h1>Notebook details</h1>'};document.querySelector('#lamp').onclick=()=>{recordEvent('lamp');details()}}
function details(){main.innerHTML='<h1>Desk lamp details</h1><label>Delivery <select id="delivery"><option>Standard</option><option>Express</option></select></label><label>Contact email <input id="email" value="old@example.invalid"></label><button id="submit">Submit request</button><p id="status">Complete the contact and delivery fields</p>';document.querySelector('#delivery').onchange=()=>recordEvent('delivery');document.querySelector('#email').oninput=()=>recordEvent('email');document.querySelector('#submit').onclick=()=>{sends++;document.documentElement.dataset.sends=String(sends);if(document.querySelector('#email').value==='buyer@example.invalid'&&document.querySelector('#delivery').value==='Express'){recordEvent('submit');main.innerHTML='<h1 id="confirmed">Request confirmed</h1><p>Desk lamp requested with Express delivery. Contact email saved.</p>'}else document.querySelector('#status').textContent='Missing correct email or Express delivery'}}
home();
</script>`;
let mode='ok',calls=[];
http.createServer(async(req,res)=>{
  const send=(n,data)=>{res.writeHead(n,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(req.url==='/'){res.end(html);return;}
  if(req.url==='/calls')return send(200,calls);
  if(req.url.startsWith('/mode/')){mode=req.url.slice(6);calls=[];return send(200,{mode});}
  if(req.method!=='POST'||req.url!=='/api'){res.writeHead(404).end();return;}
  let raw='';for await(const c of req)raw+=c;
  const body=JSON.parse(raw);calls.push(body);
  if(mode==='slow')await new Promise(r=>setTimeout(r,1500));
  if(mode==='error')return send(503,{error:'provider rejected'});
  if(body.questions.verify)return send(200,{answers:{verify:{type:'noul',noul:mode==='deny-verification'||(mode==='retry-choice'&&body.state.proposedAction.includes('Account'))?.1:.95}},usage:{input_tokens:100}});
  const state=body.state,controls=state.page.controls;
  const keys=Object.keys(body.questions.next.criteria);
  let selected='blocked',value='none',complete=.01;
  const id=(kind,c)=>`${kind}_${c.id}${kind==='fill'?'_v0':''}`;
  const find=(name)=>controls.find(c=>c.name===name);
  if(state.page.text.includes('Request confirmed')){selected='done';complete=.99;}
  else if(find('Open catalog'))selected=id('click',find('Open catalog'));
  else if(controls.some(c=>c.name==='Details'))selected=id('click',controls.find(c=>c.name==='Details'&&c.context.includes('Desk lamp')));
  else if(find('Delivery')?.options.some(o=>o.selected&&o.label==='Standard')&&find('Delivery').options.some(o=>o.label==='Express'))selected=`select_${find('Delivery').id}_1`;
  else if(find('Delivery')&&!find('Delivery').options.some(o=>o.label==='Express'))selected='blocked';
  else if(find('Contact email')&&!find('Contact email').filledWith.length){selected=id('fill',find('Contact email'));value='v0';}
  else if(find('Submit request'))selected=id('click',find('Submit request'));
  if(mode==='retry-choice'&&!state.rejectedActions?.length&&find('Account'))selected=id('click',find('Account'));
  if(!keys.includes(selected)&&mode==='deny-verification')selected='blocked';
  if(mode==='done'){selected='done';complete=.99;}
  if(mode==='false-done'){selected='done';complete=.1;}
  if(mode==='early-done'&&!state.history.length&&!state.rejectedActions?.length){selected='done';complete=.1;}
  if(mode==='loop')selected=keys.find(k=>k.startsWith('click_'))||'scroll_down';
  if(mode==='wait')selected='wait';
  if(mode==='blocked')selected='blocked';
  if(mode==='bad-value'&&selected.startsWith('fill_'))selected+='_unknown';
  const answer=(criteria,chosen)=>({type:'choice',choice:chosen,confidence:.99,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k===chosen? .99:.01/(Object.keys(criteria).length-1)]))});
  const next=answer(body.questions.next.criteria,selected);
  if(['verify','deny-verification'].includes(mode)||(mode==='retry-choice'&&!state.rejectedActions?.length))next.probabilities=Object.fromEntries(keys.map(k=>[k,k===selected? .6:.4/(keys.length-1)]));
  if(mode==='low')next.probabilities=Object.fromEntries(keys.map(k=>[k,1/keys.length]));
  if(mode==='invalid')next.choice='eval_arbitrary_javascript';
  send(200,{answers:{next,complete:{type:'noul',noul:complete},...(body.questions.value?{value:answer(body.questions.value.criteria,value)}:{})},usage:{input_tokens:700}});
}).listen(0,'0.0.0.0',function(){console.log(`PORT ${this.address().port}`)});
