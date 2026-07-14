import { spawn, execSync } from 'child_process';
import fs from 'fs';

function startBoxy() {
  console.log("Starting Boxy..."); 
  const boxy = spawn('pnpm', ['start'], { stdio: 'inherit' }); 

  boxy.on('close', (code) => {
    if (code === 0) {
      console.log("downlodoing new code");
      try { 
        execSync('git fetch --all');
        execSync('git reset --hard origin/main');
      } catch (err) {
        console.error("Failed to pull latest code:", err.message);
      }
      startBoxy(); 
    } else {
      console.log(`boxy crashed`);
      try {
        const brokenSha = execSync('git rev-parse HEAD').toString().trim();
         
        execSync('git reset --hard HEAD~1');
        
        const safeSha = execSync('git rev-parse HEAD').toString().trim(); 
        fs.writeFileSync('./boxy_revert_pending.json', JSON.stringify({ brokenSha, safeSha }));
        console.log(`reverted to ${safeSha}`);
      } catch (err) {
        console.error("I AM A FAILURE", err.message);
      } 
    }
  });
}

startBoxy();