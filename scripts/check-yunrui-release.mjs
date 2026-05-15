#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const checks = [];

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

const pkg = readJson('package.json');
check('package name', pkg.name === 'yunrui-openclaw', `expected yunrui-openclaw, got ${pkg.name}`);
check('build script', pkg.scripts?.build === 'tsc && vite build', 'expected tsc && vite build');

const tauri = readJson('src-tauri/tauri.conf.json');
check('tauri productName', tauri.productName === '云睿OpenClaw', `got ${tauri.productName}`);
check('tauri identifier', tauri.identifier === 'com.yunrui.openclaw', `got ${tauri.identifier}`);
check('tauri window title', tauri.app?.windows?.[0]?.title === '云睿OpenClaw', `got ${tauri.app?.windows?.[0]?.title}`);

const cargo = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8');
check('cargo package name', /name\s*=\s*"yunrui-openclaw"/.test(cargo));
check('cargo authors keep upstream', /OpenClaw contributors/.test(cargo));
check('cargo authors include yunrui', /云睿OpenClaw/.test(cargo));

const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
check('api entry state', app.includes('apiEntryMode'));
check('relay station state', app.includes('relayStationUrl'));
check('own api path label', app.includes('我已经有 API Key'));
check('relay path label', app.includes('去中转站获取 API Key'));
check('relay env default', app.includes('VITE_YUNRUI_RELAY_STATION_URL'));
check('relay save guard', app.includes('请先去中转站获取 API Key，拿到后切回“我已经有 API Key”再保存。'));
check('relay test guard', app.includes('请先去中转站获取 API Key，拿到后切回“我已经有 API Key”再验证。'));
check('chat session mode ref restored', app.includes('chatSessionModeRef.current = "synced"'));

const releaseScript = readFileSync(join(root, 'scripts/build-release.ps1'), 'utf8');
check('release zip name', releaseScript.includes('Yunrui-OpenClaw-v$ver-Windows.zip'));
check('release exe name', releaseScript.includes('Yunrui-OpenClaw.exe'));
check('release keeps license', releaseScript.includes('LICENSE'));
check('release copies compliance doc', releaseScript.includes('云睿OpenClaw发布说明.md'));
check('release copies checklist', releaseScript.includes('RELEASE_CHECKLIST.md'));
check('release copies github actions doc', releaseScript.includes('GITHUB_ACTIONS_WINDOWS.md'));
check('release copies commit summary', releaseScript.includes('YUNRUI_COMMIT_SUMMARY.md'));
check('release checks cargo', releaseScript.includes('Test-CommandExists \"cargo\"'));

check('license exists', existsSync(join(root, 'LICENSE')));
check('compliance doc exists', existsSync(join(root, '云睿OpenClaw发布说明.md')));
check('release checklist exists', existsSync(join(root, 'RELEASE_CHECKLIST.md')));
check('github actions doc exists', existsSync(join(root, 'GITHUB_ACTIONS_WINDOWS.md')));
check('commit summary exists', existsSync(join(root, 'YUNRUI_COMMIT_SUMMARY.md')));
check('windows workflow exists', existsSync(join(root, '.github/workflows/build-yunrui-windows.yml')));

for (const item of checks) {
  console.log(`${item.ok ? '✓' : '✗'} ${item.name}${item.detail && !item.ok ? ` — ${item.detail}` : ''}`);
}

if (failures.length) {
  console.error(`\n发布前检查失败：${failures.length} 项`);
  process.exit(1);
}

console.log('\n发布前检查通过。');
