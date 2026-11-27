// Transpile tagged sources the way the unpacked shared/*.js look (tsc CommonJS) and compare to installed.
const ts = require(process.argv[2] + '/node_modules/typescript-api')
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const repo = process.argv[2], installed = '/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/shared'
const norm = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
for (const rel of process.argv.slice(3)) {
  const src = fs.readFileSync(path.join(repo, 'src/shared', rel + '.ts'), 'utf8')
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false } }).outputText
  const inst = fs.readFileSync(path.join(installed, rel + '.js'), 'utf8')
  const same = norm(out) === norm(inst)
  const sha = crypto.createHash('sha256').update(inst).digest('hex')
  console.log(JSON.stringify({ file: `out/shared/${rel}.js`, installedSha256: sha, matchesTaggedSourceAfterWhitespaceNormalization: same }))
}
