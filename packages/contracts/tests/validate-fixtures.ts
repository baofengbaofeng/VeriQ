import { readFileSync } from "node:fs";
import { validateSchema } from "../src/index.js";
const fixtures = JSON.parse(readFileSync(new URL("../fixtures/compatibility.json", import.meta.url), "utf8"));
process.stdout.write(JSON.stringify(fixtures.map((x: {name:string; schema:string; value:unknown}) => ({name:x.name, valid:validateSchema(x.schema, x.value).length === 0}))));
