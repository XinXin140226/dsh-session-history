// 空会话（刚开的新对话，没发消息）应被识别，不能显示成未命名
import { apply, Config } from '../index.js';
import { Context } from '@deepseek-ai/cordis';
import { apply as pJsonl } from '@deepseek-ai/dsh-session-persistence-jsonl';
import { rmSync } from 'node:fs';

rmSync('/tmp/blank-root', { recursive: true, force: true });
rmSync('/tmp/blank-data', { recursive: true, force: true });
const real = new Context();
await real.plugin(pJsonl, { root: '/tmp/blank-root', compression: 'zstd' });

const id = 'session-' + '0'.repeat(8) + '-0000-0000-0000-000000000000';
const h = await real.sessionPersistence.create({ version: 4, id, createdAt: 1795000000000, cwd: '/tmp', isSeeded: false });
await h.flush();
await h.close();

const fake = {
  get: k => k === 'connection' ? undefined
    : k === 'sessionPersistence' ? real.sessionPersistence
      : k === 'sessionQuery' ? { listSessions: async () => (await real.sessionPersistence.list()).map(s => ({ sessionId: s.header.id, updatedAt: s.header.createdAt })) }
        : undefined,
  provide: (n, v) => { fake[n] = v; },
  effect: fn => { fn(); return () => {}; },
  logger: { info() {}, warn() {} },
  fiber: { entry: {} },
};
await apply(fake, Config({ dataDir: '/tmp/blank-data' }));
const rows = await fake.sessionHistory.sessionRows();
const ok = rows.length === 1 && rows[0].blank === true && rows[0].title === '';
console.log('空会话识别:', JSON.stringify(rows.map(r => ({ blank: r.blank, title: r.title }))));
console.log(ok ? 'BLANK_TEST_OK' : 'BLANK_TEST_FAIL');
await real.fiber.dispose();
process.exit(ok ? 0 : 1);
