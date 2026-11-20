// 文案黑名单扫描：源码与语言文件里出现禁词或破折号就报错，不过就不打包。
// 用法：node scripts/lint-copy.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

// 破折号全家：em dash、en dash、水平线、全角破折号、中文破折号成对出现的单字符
const DASHES = ['\u2014', '\u2013', '\u2012', '\u2015', '\u2010', '\u2011', '\u2500', '\uff0d'];

// 一眼机写的词。中英都收，界面与注释一并管。
const BANNED_WORDS = [
  '一键', '无缝', '极致', '赋能', '优雅', '轻松', '强大', '智能', '丝滑',
  '全方位', '匠心', '臻', '精致体验', '焕新', '来袭', '重磅',
  'seamless', 'effortless', 'powerful', 'blazing', 'supercharge', 'elevate',
  'revolutionize', 'game-changer', 'cutting-edge', 'state-of-the-art', 'robust',
];

// 允许出现禁词的文件：本脚本自身
const ALLOW = new Set([join(ROOT, 'scripts', 'lint-copy.mjs')]);

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.svg', '.html', '.css']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTENSIONS.has(extname(name))) yield p;
  }
}

let problems = 0;
for (const file of walk(ROOT)) {
  if (ALLOW.has(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const d of DASHES) {
      if (line.includes(d)) {
        console.log(`${file}:${i + 1}: 破折号 ${JSON.stringify(d)}`);
        problems += 1;
      }
    }
    for (const w of BANNED_WORDS) {
      const idx = line.toLowerCase().indexOf(w.toLowerCase());
      if (idx >= 0) {
        console.log(`${file}:${i + 1}: 禁词「${w}」`);
        problems += 1;
      }
    }
  });
}

if (problems > 0) {
  console.log(`\n共 ${problems} 处，先改完再打包`);
  process.exit(1);
}
console.log('文案检查通过');
