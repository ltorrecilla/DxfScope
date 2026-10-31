// Parse every inline script in DXF_Viewer.html; skip importmap/JSON; strip
// import statements from module scripts before compiling.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/DXF_Viewer.html', 'utf8');
const m = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
let fail = 0;
for (let i = 0; i < m.length; i++) {
    const attrs = m[i][1];
    if (/src=/.test(attrs) || /importmap|json/.test(attrs)) continue;
    let body = m[i][2];
    if (!body.trim()) continue;
    if (/type=.module/.test(attrs)) {
        body = body
            .replace(/^\s*import\s[^;]*?from\s*['"][^'"]+['"];?/gm, '')
            .replace(/^\s*import\s*['"][^'"]+['"];?/gm, '');
        try {
            new Function('"use strict"; return (async () => {' + body + '\n})');
            console.log('script', i, 'module OK');
        } catch (e) { console.log('script', i, 'module ERR:', e.message); fail = 1; }
    } else {
        try {
            new Function(body);
            console.log('script', i, 'classic OK');
        } catch (e) { console.log('script', i, 'classic ERR:', e.message); fail = 1; }
    }
}
process.exit(fail);
