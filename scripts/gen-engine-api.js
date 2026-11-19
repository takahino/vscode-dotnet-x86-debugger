// Writes docs/engine-api.json and docs/engine-api.html from src/engineProtocol.ts (run `npm run compile` first).
//   node scripts/gen-engine-api.js                 write the files
//   node scripts/gen-engine-api.js --check         fail when the files are not up to date
//   node scripts/gen-engine-api.js --engine <dir>  also compare with the requests dotnet-x86dbg dispatches (src/debugger/engine.rs)
const fs = require('fs');
const path = require('path');
const { buildEngineApi, renderJson, renderHtml, engineDispatchedRequests, documentedEngineRequests } = require('../out/tools/engineApiDoc');

const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const check = args.includes('--check');
const engineIndex = args.indexOf('--engine');
const api = buildEngineApi(repo);
const outputs = [
    [path.join(repo, 'docs', 'engine-api.json'), renderJson(api)],
    [path.join(repo, 'docs', 'engine-api.html'), renderHtml(api)],
];

let failed = false;
for (const [file, text] of outputs) {
    if (check) {
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
        if (current !== text) {
            console.error(`${path.relative(repo, file)} is not up to date: run npm run docs:api`);
            failed = true;
        }
    } else {
        fs.writeFileSync(file, text);
        console.log(`wrote ${path.relative(repo, file)}`);
    }
}

if (engineIndex >= 0) {
    const engineRepo = path.resolve(args[engineIndex + 1] ?? '');
    const dispatched = engineDispatchedRequests(engineRepo);
    const documented = documentedEngineRequests(api);
    const missing = dispatched.filter((c) => !documented.includes(c));
    const extra = documented.filter((c) => !dispatched.includes(c));
    if (missing.length || extra.length) {
        if (missing.length) console.error(`the engine handles requests the document does not list: ${missing.join(', ')}`);
        if (extra.length) console.error(`the document lists engine requests the engine does not handle: ${extra.join(', ')}`);
        failed = true;
    } else {
        console.log(`the ${dispatched.length} requests the engine handles match the document`);
    }
}
process.exit(failed ? 1 : 0);