// Verify the actual NSIS payload manifest emitted by Tauri's default build.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(Object.keys(config.bundle?.resources ?? {}).length, 0, 'pure package must not bundle external resources');
assert.equal(config.bundle?.externalBin?.length ?? 0, 0, 'pure package must not bundle sidecars');
const manifest = 'src-tauri/target/release/nsis/x64/installer.nsi';
assert.ok(existsSync(manifest), 'build NSIS before checking its manifest');
const source = readFileSync(manifest, 'utf8');
assert.doesNotMatch(source, /ffmpeg|ffprobe/i, 'NSIS manifest must not carry FFmpeg tools');
const payloads = source.split(/\r?\n/).filter(line => /^\s*File\s/i.test(line));
assert.ok(payloads.some(line => line.includes('MAINBINARYSRCPATH')), 'main executable must be present');
for (const line of payloads) {
  assert.match(line, /MAINBINARYSRCPATH|WEBVIEW2|WebView2/i, `unexpected installer payload: ${line}`);
}
console.log(`Pure package manifest verified: ${payloads.length} application/WebView payload directives`);
