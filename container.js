import { Sandbox } from "tensorlake";
const sandbox = await Sandbox.create({
  name: "boxy-computer", 
  cpus: 2.0,
  memoryMb: 2048,
});

async function runCommandInBoxyContainer(command) {
  