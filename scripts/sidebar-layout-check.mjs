// 无账号、无真实助手、无桌面操作的界面验收；原生播放另有真实验收报告。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root=path.resolve('.output/chrome-mv3');
fs.mkdirSync('artifacts',{recursive:true});
const server=http.createServer((request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  if(pathname==='/qwebchannel.js'){response.setHeader('Content-Type','text/javascript');response.end('window.QWebChannel=function(transport,callback){callback({objects:{native:window.qaNative}})}');return;}
  const file=path.resolve(root,'.'+decodeURIComponent(pathname));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end();return;}
  response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');fs.createReadStream(file).pipe(response);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.E2E_BROWSER??'msedge',headless:true,args:['--disable-gpu']}),page=await browser.newPage({viewport:{width:380,height:950},locale:'zh-CN'});
const report={scope:'headless-ui-fixtures-only',nativePlaybackClaim:false};
try{
  await page.route('http://127.0.0.1:8131/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(route.request().url().includes('/health')?{backends:{'opencode-go':{available:true}}}:{models:[{id:'deepseek-v4.1-flash',label:'DeepSeek V4.1 Flash'},{id:'qwen-chat',label:'Qwen Chat'}]})}));
  await page.addInitScript(()=>{
    const state={attached:true,docked:true,collapsed:false,fullscreen:false};
    const source={id:'layout-fixture-video',title:'127.0.0.1',kind:'window',platform:'YouTube',url:'vma-web://lesson/layout-fixture-video'};
    const reply=(callback,value)=>setTimeout(()=>callback(JSON.stringify(value)),0);
    const changed=()=>window.dispatchEvent(new CustomEvent('desktop:presentation',{detail:{...state}}));
    window.qt={webChannelTransport:{}};
    window.qaNative={
      bootstrap:callback=>reply(callback,{token:'ui-fixture-only'}),
      presentationState:callback=>reply(callback,state),currentSource:callback=>reply(callback,source),
      windows:callback=>reply(callback,[]),browsers:callback=>reply(callback,[{id:'in-app',title:'应用内播放'}]),
      stopCapture:callback=>reply(callback,{ok:true}),frame:callback=>reply(callback,{time:2,duration:20,playing:false,sourceId:source.id}),
      openVideo:callback=>reply(callback,{canceled:true}),
      collapseSidebar:(collapsed,callback)=>{state.collapsed=collapsed;changed();reply(callback,state);},
      restoreWindow:callback=>{state.attached=false;changed();reply(callback,state);},
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/desktop.html?debug=1`);
  await page.locator('.desktop-source-page.is-attached').waitFor();
  const sidebar=page.locator('.study-sidebar');await sidebar.waitFor();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('desktop:source-title',{detail:{id:'layout-fixture-video',title:'原始课程标题',platform:'YouTube',previousTitle:'127.0.0.1'}})));
  await sidebar.locator('.study-heading h2').filter({hasText:'原始课程标题'}).waitFor();report.actualTitleAndPlatform=true;
  await page.evaluate(()=>new Promise(resolve=>window.qaNative.collapseSidebar(true,resolve)));
  await page.locator('.study-sidebar.is-collapsed').waitFor();
  await page.evaluate(()=>new Promise(resolve=>window.qaNative.collapseSidebar(false,resolve)));
  await page.locator('.study-sidebar:not(.is-collapsed)').waitFor();report.presentationEvents=true;
  const question=page.getByRole('textbox',{name:'向当前视频提问'});await question.fill('当前视频的草稿');
  await page.getByRole('button',{name:'更换视频源'}).click();
  const sources=page.getByRole('region',{name:'选择视频来源'});await sources.waitFor();
  const rect=await sources.boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=380);
  assert.equal(await page.locator('.source-layout > aside:not(.study-sidebar)').count(),0,'来源不再占据左侧独立面板');
  for(const name of ['网课窗口','本地视频'])await sources.getByRole('button',{name,exact:true}).click();
  await sources.getByRole('button',{name:'选择视频文件'}).click();
  assert.equal(await sidebar.getAttribute('data-video-id'),'layout-fixture-video');assert.equal(await question.inputValue(),'当前视频的草稿');
  await page.screenshot({path:'artifacts/sidebar-right-source.png'});report.rightExpandableSources=true;report.tabAndCancelPreserveVideo=true;
  await sources.getByLabel('这节课的名称',{exact:true}).fill('设置');
  await sources.getByRole('button',{name:'收起来源选择'}).click();
  await page.waitForFunction(()=>new Promise(resolve=>{const open=indexedDB.open('video-memory-assistant');open.onsuccess=()=>{const db=open.result,read=db.transaction('videos').objectStore('videos').get('layout-fixture-video');read.onsuccess=()=>{db.close();resolve(read.result?.customTitle&&read.result.title==='设置');};};}));
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('desktop:source-title',{detail:{id:'layout-fixture-video',title:'新的网页标题',platform:'YouTube',previousTitle:'原始课程标题'}})));
  assert.equal(await sidebar.locator('.study-heading h2').innerText(),'设置');report.manualTitlePreserved=true;
  await page.getByRole('button',{name:'切换智能体',exact:true}).click();
  const models=page.getByRole('region',{name:'侧栏助手与模型'});await models.locator('.model-option').first().waitFor();
  assert.equal(await page.getByRole('dialog').count(),0);const bounds=await models.boundingBox();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=380);
  await models.getByRole('searchbox',{name:'搜索模型'}).fill('DeepSeek');assert.equal(await models.locator('.model-option').count(),1);
  await page.screenshot({path:'artifacts/sidebar-right-models.png'});report.inlineModels=true;
  await models.locator('.model-option').click();assert.equal(await question.inputValue(),'当前视频的草稿');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'打开视频库',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'学习偏好',exact:true}).click();
  const answerLanguage=await page.getByLabel('回答与摘要的语言',{exact:true}).inputValue();
  await page.getByLabel('界面语言',{exact:true}).selectOption('en');
  await page.getByRole('button',{name:'Learning preferences',exact:true}).waitFor();
  assert.equal(await page.getByLabel('Answer and summary language',{exact:true}).inputValue(),answerLanguage);
  await page.getByRole('button',{name:'AI assistant',exact:true}).click();
  assert.equal(await page.locator('.api-services button').first().innerText(),'OpenAI');
  await page.getByRole('button',{name:'Add video',exact:true}).click();
  assert.equal(await page.locator('.study-heading h2').innerText(),'设置','用户视频标题不随界面语言翻译');
  assert.equal(await page.getByRole('textbox',{name:'Ask about this video'}).inputValue(),'当前视频的草稿');
  await page.getByRole('button',{name:'Change video source'}).click();
  const sourceEn=page.getByRole('region',{name:'Choose video source'});await sourceEn.getByRole('button',{name:'Online course',exact:true}).click();
  const platform=sourceEn.getByLabel('Course platform',{exact:true});
  assert.equal(await platform.locator('option').first().innerText(),'YouTube');
  await sourceEn.getByRole('button',{name:'Close source selector'}).click();
  await page.getByRole('button',{name:'Switch assistant',exact:true}).click();
  const modelEn=page.getByRole('region',{name:'Sidebar assistant and model'});
  assert.ok((await modelEn.locator('.assistant-options button').first().innerText()).includes('Codex'));
  await modelEn.getByRole('button',{name:'Close assistant selector'}).click();
  await page.screenshot({path:'artifacts/ui-language-english.png'});
  await page.getByRole('button',{name:'Open library',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Learning preferences',exact:true}).click();
  await page.getByLabel('Interface language',{exact:true}).selectOption('zh-TW');
  await page.getByRole('button',{name:'學習偏好',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'zh-TW');
  assert.equal(await page.getByLabel('回答與摘要的語言',{exact:true}).inputValue(),answerLanguage);
  await page.screenshot({path:'artifacts/ui-language-traditional.png'});
  report.interfaceLanguages=['zh-CN','en','zh-TW'];report.languageReordersToolsServicesPlatforms=true;report.contentAndDraftPreserved=true;
  report.passed=true;console.log('SIDEBAR_LAYOUT_PASS',JSON.stringify(report));
}catch(error){report.error=error.message;throw error;}
finally{fs.writeFileSync('artifacts/sidebar-layout-check.json',JSON.stringify(report,null,2));await browser.close();await new Promise(resolve=>server.close(resolve));}
