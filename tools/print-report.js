const { chromium } = require('playwright'); const fs=require('fs');
const C = Object.fromEntries(fs.readFileSync('private/creds.env','utf8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto('http://localhost:4300/');await p.fill('#email','admin@ffd.demo');await p.fill('#pw',C.ADMIN_PASSWORD);await p.click('form button');await p.waitForSelector('.tile');
await p.goto('http://localhost:4300/admin.html#/report');await p.waitForSelector('.rtiles');await p.waitForTimeout(1500);
await p.emulateMedia({media:'print'});await p.screenshot({path:'screens/33-admin-report-print.png',fullPage:true});
await p.pdf({path:'screens/33-admin-report.pdf',landscape:true});await b.close();})();
