import { spawn, execSync } from 'child_process';
import fs from 'fs';


function startBoxy() {
  execSync('start https://www.youtube.com/watch?v=E4WlUXrJgy4');
  console.log("boxy start"); 
  const boxy = spawn('pnpm', ['start'], { stdio: 'inherit', shell: true }); 
  
  boxy.on('close', (code) => {
    if (code === 0) {
      console.log("new code got");
      try { 
        execSync('git fetch --all');
        execSync('git reset --hard origin/main'); 
        execSync('pnpm install'); // just in case but i hope pnpm doesnt' pull some garbage mess this up
      } catch (err) {
        console.error("Failed to pull latest code:", err.message);
      }
      startBoxy(); 
    } else {
      console.log(`Boxy crashed with code ${code}!`);
      try {
        const brokenSha = execSync('git rev-parse HEAD').toString().trim();
         
        execSync('git reset --hard HEAD~1');
        
        const safeSha = execSync('git rev-parse HEAD').toString().trim(); 
        fs.writeFileSync('./boxy_revert_pending.json', JSON.stringify({ brokenSha, safeSha }));
        console.log(`Reverted to ${safeSha}`);
      } catch (err) {
        console.error("I AM A FAILURE", err.message);
      } 
       
      startBoxy();
    }
  });
}

startBoxy();
