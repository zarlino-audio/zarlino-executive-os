import { writeFileSync } from "node:fs";
const [ , , p, b ] = process.argv;
writeFileSync(p, Buffer.from(b, "base64"));
