// Mock contacts + current user + seed content for the compose demo.
const INTERNAL_DOMAINS = ['omadanetworks.com', 'tp-link.com', 'tp-link.com.hk'];

const AV_COLORS = ['#4A78E5', '#2DB5A6', '#E5654B', '#DB5B7C', '#9C7AE0', '#5DBA8C', '#E59B4A', '#6FA8DC'];
function colorFor(str) {
  let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function isInternal(email) {
  const d = (email.split('@')[1] || '').toLowerCase();
  return INTERNAL_DOMAINS.some((x) => d === x);
}
function initials(name, email) {
  const src = (name || email || '').trim();
  if (/[一-鿿]/.test(src)) return src.slice(-2); // Chinese: last 2 chars
  const parts = src.split(/[\s.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

const CURRENT_USER = { name: 'Lucien Chen', email: 'lucien.chen@omadanetworks.com', title: 'Product Manager · Omada Cloud' };

const CONTACTS = [
  { name: '曾东彪', email: 'zengdongbiao@tp-link.com.hk', title: 'Regional Sales Director · APAC', team: 'TP-Link HK' },
  { name: 'Xavier Chen', email: 'xavier.chen@omadanetworks.com', title: 'Product Lead · Controller', team: 'Omada' },
  { name: '杜炜', email: 'duwei2@tp-link.com.hk', title: 'FAE Manager', team: 'TP-Link HK' },
  { name: '冯海林', email: 'fenghailin@tp-link.com.hk', title: 'Solutions Architect', team: 'TP-Link HK' },
  { name: 'Gary Wu', email: 'gary.w@omadanetworks.com', title: 'Cloud Backend Lead', team: 'Omada' },
  { name: 'Gabriel Zheng', email: 'gabriel.zheng@omadanetworks.com', title: 'PMM · Video', team: 'Omada' },
  { name: '张智嵩', email: 'zhangzhisong@tp-link.com', title: 'QA Lead · Controller', team: 'TP-Link' },
  { name: '徐自勇', email: 'xuziyong@tp-link.com', title: 'Field Engineer · HK', team: 'TP-Link' },
  { name: 'Echo Liu', email: 'echo.liu@tp-link.com', title: 'Program Manager', team: 'TP-Link' },
  { name: 'Kerry Ng', email: 'kerry.ng@chowtaifook.com', title: 'IT Infrastructure · Chow Tai Fook', team: 'Client', external: true },
  { name: 'Marta Nilsson', email: 'm.nilsson@elkjop.no', title: 'Head of IT · Elkjøp Nordic', team: 'Client', external: true },
  { name: 'David Park', email: 'david.park@gmail.com', title: '', team: 'Personal', external: true },
].map((c) => ({ ...c, internal: c.external ? false : isInternal(c.email), color: colorFor(c.email), initials: initials(c.name, c.email) }));

function makeContact(email) {
  const clean = email.trim().replace(/[<>]/g, '');
  const found = CONTACTS.find((c) => c.email.toLowerCase() === clean.toLowerCase());
  if (found) return found;
  return { name: '', email: clean, title: '', team: '', internal: isInternal(clean), external: !isInternal(clean), color: colorFor(clean), initials: initials('', clean) };
}

// @mention pool (internal teammates only)
const MENTION_POOL = CONTACTS.filter((c) => c.internal);

// Seed reply content (matches the screenshot thread)
const REPLY_SEED = `<p>曾总、Xavier：</p><p>关于免费云的功能差距问题，我这边可以组织产品侧系统性梳理一版<strong>免费云 vs Reyee Cloud</strong> 的功能对比清单，明确亚太场景下具体缺口点，再来对齐云侧投入优先级和方案。</p><p>关于 OC400 管理规模，600 台的评估结果出来后麻烦同步给我，我们再看是否需要在 PRD 层面跟进相应的功能优化或性能测试计划。</p><p>多形态 Controller 发挥优势这个思路认同，后续规划上我会一并考虑进去。</p><p></p><p>Best,<br>Lucien</p>`;

const REPLY_META = {
  to: ['zengdongbiao@tp-link.com.hk', 'xavier.chen@omadanetworks.com', 'duwei2@tp-link.com.hk'],
  cc: ['fenghailin@tp-link.com.hk', 'gary.w@omadanetworks.com'],
  subject: 'Re: 回复: 答复: OC400 limitations',
};

// Seed attachments for the reply mode
const SEED_ATTACHMENTS = [
  { id: 'a1', name: '免费云_vs_Reyee_功能对比_v3.xlsx', size: 284160, kind: 'sheet' },
  { id: 'a2', name: 'OC400_压测报告_600AP.pdf', size: 1863680, kind: 'pdf' },
];

Object.assign(window, { CONTACTS, CURRENT_USER, MENTION_POOL, makeContact, isInternal, colorFor, initials, REPLY_SEED, REPLY_META, SEED_ATTACHMENTS });
