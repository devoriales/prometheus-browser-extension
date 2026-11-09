// Sends one framed native-messaging message to bridge/host.mjs and prints the reply.
import { spawn } from "node:child_process";
export function callHost(msg) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL("../bridge/host.mjs", import.meta.url).pathname]);
    const body = Buffer.from(JSON.stringify(msg));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    let out = Buffer.alloc(0), err = "";
    child.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      if (out.length < 4) return reject(new Error("no reply: " + err));
      resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()));
    });
    child.stdin.end(Buffer.concat([header, body]));
  });
}
if (process.argv[2]) console.log(JSON.stringify(await callHost(JSON.parse(process.argv[2])), null, 1));
