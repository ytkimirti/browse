import {spawnSync} from 'node:child_process';
import {mkdtempSync,symlinkSync,readdirSync,readFileSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {recordingSource} from '../scripts/video.mjs';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url)));
const dir=mkdtempSync(join(tmpdir(),'browse-cadence-'));
symlinkSync(join(homedir(),'.browse/camoufox-pw'),join(dir,'camoufox-pw'));
const env={...process.env,BROWSE_HOME:dir,BROWSE_OUT:join(dir,'out'),BROWSE_PW_BASE:join(homedir(),'.browse/package.json'),BROWSE_SESSION:'cadence',BROWSE_ENGINE:process.env.BROWSE_ENGINE||'chromium',BROWSE_REMOTE:'',BROWSE_PROFILE:'',BROWSE_HEADFUL:'0',BROWSE_VIDEO:'1',BROWSE_REALTIME:'1',BROWSE_KEEP_WEBM:'1',BROWSE_FPS:'30',BROWSE_IDLE_MODE:'cut'};
let failed=0,checks=0;
function check(name,ok,detail=''){checks++;failed+=!ok;console.log(`${ok?'PASS':'FAIL'} ${name}${ok?'':': '+detail}`)}
function b(...args){const r=spawnSync(process.execPath,[join(ROOT,'browse.mjs'),...args],{env,cwd:dir,encoding:'utf8',timeout:60000});return {code:r.status,out:r.stdout||'',err:r.stderr||''}}
const probe=p=>JSON.parse(spawnSync('ffprobe',['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=r_frame_rate,avg_frame_rate,nb_read_frames,duration','-show_entries','format=duration','-of','json',p],{encoding:'utf8'}).stdout);
try{
  let rejected=false;try{recordingSource('unknown recorder',30)}catch{rejected=true}check('unknown recorder fails explicitly',rejected);
  const html='<body style="margin:0;background:navy"><canvas id="c" width="640" height="480"></canvas><button id="target" style="position:fixed;right:0;bottom:0">Target</button><script>let n=0;function frame(){const x=c.getContext("2d");x.fillStyle="navy";x.fillRect(0,0,640,480);x.fillStyle="white";x.font="80px monospace";x.fillText(String(n++),50,100);window.animation=requestAnimationFrame(frame)}frame()</script>';
  let r=b('--viewport','640x480','open','data:text/html,'+encodeURIComponent(html));check('recorded browser starts',r.code===0,r.err);if(r.code)throw Error(r.err);
  r=b('eval','new Promise(resolve => setTimeout(resolve, 2200))');check('animation advances in real time',r.code===0,r.err);
  r=b('eval','window.__realMove=window.__browseCursor.moveTo;window.__browseCursor.moveTo=(x,y,ms)=>{window.__moveMs=ms;return window.__realMove(x,y,ms)}');
  r=b('click','#target');check('cursor action succeeds',r.code===0,r.err);
  check('cursor glide uses faster 120ms default',b('eval','window.__moveMs').out.trim()==='120');
  r=b('speed','10');check('real-time recording rejects speed edits',r.code===1&&r.err.includes('real-time'),r.err);
  r=b('eval','cancelAnimationFrame(window.animation);new Promise(resolve=>setTimeout(resolve,3100))');check('static interval completes',r.code===0,r.err);
  r=b('eval','document.body.innerHTML="";document.body.style.background="white";new Promise(resolve=>setTimeout(resolve,3100))');check('blank tail completes',r.code===0,r.err);
  r=b('close','--keep-raw');check('video finalizes',r.code===0,r.err);
  const raw=join(dir,'out/video',readdirSync(join(dir,'out/video')).find(f=>f.endsWith('.webm'))),mp4=join(dir,'out/recording.mp4');
  const a=probe(raw),z=probe(mp4);
  check('raw source captures at 30 fps',a.streams[0].r_frame_rate==='30/1',JSON.stringify(a));
  check('MP4 is constant 30 fps',z.streams[0].r_frame_rate==='30/1'&&z.streams[0].avg_frame_rate==='30/1',JSON.stringify(z));
  check('export preserves every source frame',a.streams[0].nb_read_frames===z.streams[0].nb_read_frames,JSON.stringify({a,z}));
  check('no cuts, speedup or blank-tail trimming',+a.streams[0].nb_read_frames>=8.4*30&&Math.abs(+a.streams[0].nb_read_frames/30-+z.streams[0].duration)<.04,JSON.stringify({raw:a.format.duration,mp4:z.format.duration}));
  const hashes=spawnSync('ffmpeg',['-v','error','-ss','0.6','-t','1.5','-i',raw,'-f','framemd5','-'],{encoding:'utf8'}).stdout.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1));
  check(env.BROWSE_ENGINE==='chromium'?'motion is fresh capture, not 25fps upconversion':'Camoufox retains its upstream motion cadence',new Set(hashes).size>=(env.BROWSE_ENGINE==='chromium'?41:34),`${new Set(hashes).size} unique frames / ${hashes.length}`);
  console.log('Artifacts: '+join(dir,'out'));
}finally{b('close')}
console.log(`${checks-failed}/${checks} passed`);process.exitCode=failed?1:0;
