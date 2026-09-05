// Generates a VAPID key pair for Web Push. No dependencies.
//   node tools/gen-vapid.mjs
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });

const x = Buffer.from(jwk.x, "base64url");
const y = Buffer.from(jwk.y, "base64url");
const pub = Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");

console.log("");
console.log("VAPID_PUBLIC_KEY   =", pub);
console.log("VAPID_PRIVATE_KEY  =", jwk.d);
console.log("");
console.log("Put the PUBLIC key in config.js (VAPID_PUBLIC_KEY)");
console.log("Put BOTH in Supabase -> Edge Functions -> Secrets");
console.log("Also add VAPID_SUBJECT = mailto:your@email.com");
console.log("");
