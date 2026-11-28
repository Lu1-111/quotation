// 统一数据采集服务：
// - 底层复用 Playwright 专用浏览器 + 知乎登录态复用（保持暖实例以加速增量同步）
// - 初次 50 条采集目标 <= 15s，后续增量同步目标 <= 10s
// - 同步完成后写入用户数据库（user-db.json），并触发绑定回调（如画像 Agent 与数据转换 Agent）
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { BrowserSetupError, loadBrowser } from './browser-runtime.mjs';
import { DATA_KINDS, POLICY_VERSION, hasSelectedKinds, policyAllows, reviewRecord } from './content-policy.mjs';
import { HistoryError, createDetailCache, parseHistoryJson } from './history-data.mjs';
import { DEFAULT_SETTINGS, rankRecords, trimToLimit, validateSettings } from './record-ranking.mjs';
import { collectSelectedData } from './zhihu-sources.mjs';

export const INITIAL_BUDGET_MS = 15_000;
export const INCREMENTAL_BUDGET_MS = 10_000;

export function createBrowserGateway(profileDirectory, channel = 'auto') {
  let context = null;
  let page = null;
  let selectedBrowser = null;
  let currentHeadless = null;

  return {
    get browserChannel() {
      return selectedBrowser;
    },
    get active() {
      return Boolean(context && page && !page.isClosed());
    },
    async open({ headless = false } = {}) {
      if (context && page && !page.isClosed()) {
        // 如果已有一个活跃的暖浏览器会话且无需切到可见窗口，直接复用（省去 3-5 秒冷启动！）
        if (headless || !currentHeadless) {
          if (!headless) await page.bringToFront();
          if (!page.url().startsWith('https://www.zhihu.com')) {
            await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 20_000 });
          }
          return;
        }
        await context.close().catch(() => {});
        context = null;
        page = null;
      }
      await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
      try {
        const { chromium, selected } = await loadBrowser(channel);
        selectedBrowser = selected.browser;
        currentHeadless = headless;
        const linuxDockerArgs =
          process.platform === 'linux'
            ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            : [];
        const windowArgs = headless ? [] : ['--new-window', '--window-size=1120,820'];
        context = await chromium.launchPersistentContext(profileDirectory, {
          ...selected.launchOptions,
          headless,
          acceptDownloads: false,
          viewport: headless ? { width: 1120, height: 820 } : null,
          args: [...linuxDockerArgs, ...windowArgs],
        });
        const opened = context;
        opened.on('close', () => {
          if (context === opened) {
            context = null;
            page = null;
            currentHeadless = null;
          }
        });
        page = context.pages()[0] || (await context.newPage());
        if (!page.url().startsWith('https://www.zhihu.com')) {
          await page.goto('https://www.zhihu.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 });
        }
      } catch (error) {
        await context?.close().catch(() => {});
        context = null;
        page = null;
        currentHeadless = null;
        if (error instanceof BrowserSetupError) throw error;
        throw new HistoryError('启动专用浏览器或访问知乎失败，请检查本机 Edge/Chrome 与网络环境。', 503);
      }
    },
    async gotoSignin() {
      if (!context || !page || page.isClosed()) {
        throw new HistoryError('浏览器会话未打开。', 409);
      }
      await page.goto('https://www.zhihu.com/signin', { waitUntil: 'domcontentloaded', timeout: 25_000 });
      // 等待登录面板或二维码元素渲染
      await page.waitForTimeout(1200);
      // 如果默认不是扫码登录标签，尝试切到扫码登录
      await page
        .evaluate(() => {
          const tabs = [...document.querySelectorAll('div, button, span')];
          const qrTab = tabs.find((el) => el.childElementCount === 0 && /扫码登录/.test((el.textContent || '').trim()));
          if (qrTab) qrTab.click();
        })
        .catch(() => {});
      await page.waitForTimeout(700);
    },
    async captureLoginQr() {
      if (!context || !page || page.isClosed()) return null;
      // 如果已经跳转出登录页，检查是否已登录
      if (!page.url().includes('/signin')) {
        return null;
      }
      // 优先精准截取知乎登录二维码区域，若 DOM 结构变化则截取登录卡片中心区
      const selectors = [
        '.Qrcode-img',
        'img[src*="qrcode"]',
        'img[alt*="二维码"]',
        '.Qrcode-content canvas',
        '.Qrcode-content img',
        '.SignFlow-qrcode',
        '.Qrcode-container',
        '.SignContainer-content',
      ];
      for (const sel of selectors) {
        const loc = page.locator(sel).first();
        if ((await loc.count().catch(() => 0)) > 0) {
          try {
            const box = await loc.boundingBox();
            if (box && box.width >= 90 && box.height >= 90) {
              const buf = await loc.screenshot({ type: 'png', timeout: 5000 });
              return `data:image/png;base64,${buf.toString('base64')}`;
            }
          } catch {
            // 继续尝试下一个选择器
          }
        }
      }
      try {
        const buf = await page.screenshot({ type: 'png', timeout: 5000 });
        return `data:image/png;base64,${buf.toString('base64')}`;
      } catch {
        return null;
      }
    },
    async request(requestPath, { optional = false, timeoutMs = 8000 } = {}) {
      if (!context || !page || page.isClosed()) {
        throw new HistoryError('请先打开专用浏览器并登录知乎。', 409);
      }
      const target = new URL(requestPath, 'https://www.zhihu.com');
      if (
        target.protocol !== 'https:' ||
        !['www.zhihu.com', 'api.zhihu.com', 'zhuanlan.zhihu.com'].includes(target.hostname)
      ) {
        throw new HistoryError('采集地址无效。', 400);
      }
      let result;
      try {
        if (target.hostname === 'www.zhihu.com') {
          result = await page.evaluate(
            async ({ urlPath, ms }) => {
              if (location.origin !== 'https://www.zhihu.com') return { status: 401 };
              const response = await fetch(urlPath, {
                credentials: 'same-origin',
                redirect: 'error',
                signal: AbortSignal.timeout(ms),
              });
              return { status: response.status, body: await response.text() };
            },
            { urlPath: `${target.pathname}${target.search}`, ms: timeoutMs },
          );
        } else {
          const response = await context.request.get(target.href, {
            timeout: timeoutMs,
            maxRedirects: 0,
            headers: { Referer: `${target.origin}/`, Accept: 'application/json' },
          });
          result = { status: response.status(), body: await response.text() };
          await response.dispose();
        }
      } catch {
        throw new HistoryError('知乎请求超时或失败，请检查专用窗口中的登录状态和网络。');
      }
      if (optional && [403, 404, 410].includes(result.status)) {
        throw new HistoryError('该条目详情暂时不可用。', result.status);
      }
      if ([401, 403].includes(result.status)) {
        throw new HistoryError('知乎要求重新登录或验证，请在专用窗口中完成登录后重试。', 401);
      }
      if (result.status === 429) {
        throw new HistoryError('知乎暂时限流，已保留上次同步结果。', 429);
      }
      if (result.status !== 200 || !result.body || result.body.length > 4_000_000) {
        throw new HistoryError('知乎返回了非预期响应。');
      }
      try {
        return parseHistoryJson(result.body);
      } catch {
        throw new HistoryError('知乎返回了验证页面，请在专用窗口中确认登录后重试。', 401);
      }
    },
    async close() {
      const closing = context;
      context = null;
      page = null;
      currentHeadless = null;
      await closing?.close().catch(() => {});
    },
  };
}

// 演示数据集：包含多领域知识帖子 + 若干非知识噪音帖（网文、日常、情绪八卦），便于验证“过滤噪音 + 提炼知识点 + 跨分支星图构建”全链路
export function createDemoGateway({ round = 1 } = {}) {
  let active = false;
  const now = Math.floor(Date.now() / 1000);

  const basePosts = [
    {
      id: '201',
      type: 'answer',
      question: {
        title: '视觉语言模型（VLM）里的投影层 Projector 到底是如何把图像 Token 对齐到语言空间的？',
        topics: [{ id: 't1', name: '多模态学习' }, { id: 't2', name: '人工智能' }],
      },
      excerpt: '系统拆解了 LLaVA 的线性投影与 Q-Former 的交叉注意力瓶颈，说明为什么高分辨率切片（AnyRes）能缓解细粒度 OCR 信息丢失。',
      voteup_count: 1680,
      comment_count: 142,
      readOffsetDays: 0.2,
    },
    {
      id: '202',
      type: 'article',
      title: '从 PPO 到 GRPO：DeepSeek-R1 为什么能用组内相对优势替代 Critic 网络？',
      topics: [{ id: 't3', name: '强化学习' }, { id: 't2', name: 'AI' }],
      excerpt: '对比了经典 Actor-Critic 架构与 GRPO 组内归一化奖励估计，分析省去价值模型带来的显存收益以及 KL 散度约束防止策略坍缩的原理。',
      voteup_count: 2340,
      comment_count: 215,
      readOffsetDays: 0.4,
    },
    {
      id: '203',
      type: 'article',
      title: '大模型推理中的 KV Cache 为什么会成为显存瓶颈？PagedAttention 与 GQA 的联合优化机制',
      topics: [{ id: 't4', name: '大模型推理' }, { id: 't2', name: '人工智能' }],
      excerpt: '从自回归解码的内存带宽受限特性出发，推导 KV Cache 体积公式，解释分页显存管理和分组查询注意力如何将吞吐量提升 3-4 倍。',
      voteup_count: 1920,
      comment_count: 118,
      readOffsetDays: 0.6,
    },
    {
      id: '204',
      type: 'answer',
      question: {
        title: 'CLIP 的对比学习损失 InfoNCE 是怎样构造图文共享嵌入空间的？',
        topics: [{ id: 't1', name: '多模态' }, { id: 't2', name: '机器学习' }],
      },
      excerpt: '通过批内对称交叉熵把匹配的图文对拉近、把 N-1 个负样本推远，并分析了零样本分类泛化能力与模态间隙（Modality Gap）的成因。',
      voteup_count: 1210,
      comment_count: 74,
      readOffsetDays: 1.0,
    },
    {
      id: '205',
      type: 'answer',
      question: {
        title: '强化学习中的奖励黑客（Reward Hacking）在 RLHF 里是怎么发生的？',
        topics: [{ id: 't3', name: '强化学习' }, { id: 't5', name: 'AI 对齐' }],
      },
      excerpt: '当策略模型过度优化代理奖励模型（RM）而非真实人类偏好时，会出现冗长迎合与阿谀奉承现象，常通过参考模型 KL 惩罚和过程监督（PRM）缓解。',
      voteup_count: 980,
      comment_count: 89,
      readOffsetDays: 1.2,
    },
    {
      id: '206',
      type: 'article',
      title: '扩散模型（Diffusion）中的无分类器引导 CFG 为什么能让图文生成更贴合提示词？',
      topics: [{ id: 't1', name: '多模态生成' }, { id: 't2', name: '人工智能' }],
      excerpt: '解释条件去噪分数与无条件去噪分数的外推组合如何等价于隐式放大后验梯度，并讨论引导系数过大导致色彩过饱和的权衡。',
      voteup_count: 1150,
      comment_count: 66,
      readOffsetDays: 1.5,
    },
    {
      id: '207',
      type: 'answer',
      question: {
        title: '认知心理学中的「双系统理论（System 1 vs System 2）」如何解释人类的启发式偏差？',
        topics: [{ id: 't6', name: '认知心理学' }, { id: 't7', name: '决策科学' }],
      },
      excerpt: '丹尼尔·卡尼曼提出的直觉快思考与分析慢思考分工模型，阐述锚定效应、可得性启发式为何在高压或高认知负荷下主导判断。',
      voteup_count: 1540,
      comment_count: 132,
      readOffsetDays: 2.0,
    },
    {
      id: '208',
      type: 'article',
      title: '工作记忆容量受限与「组块化（Chunking）」如何决定专家与新手的思维效率？',
      topics: [{ id: 't6', name: '心理学' }, { id: 't8', name: '学习科学' }],
      excerpt: '结合米勒的 7±2 与考恩的 4 组块理论，说明将零散信息压缩为长期记忆中的图式结构，可以大幅降低工作记忆负荷。',
      voteup_count: 870,
      comment_count: 58,
      readOffsetDays: 2.4,
    },
    {
      id: '209',
      type: 'answer',
      question: {
        title: '行为经济学里的「前景理论（Prospect Theory）」怎样推翻了经典期望效用假说？',
        topics: [{ id: 't9', name: '行为经济学' }, { id: 't7', name: '决策' }],
      },
      excerpt: '人们以参照点而非绝对财富评估得失，呈现损失厌恶（损失痛苦约是等额收益快乐的 2 倍）与 S 型价值函数特征。',
      voteup_count: 1410,
      comment_count: 105,
      readOffsetDays: 2.8,
    },
    {
      id: '210',
      type: 'article',
      title: '信息熵（Shannon Entropy）与交叉熵损失之间到底是什么数学关系？',
      topics: [{ id: 't10', name: '信息论' }, { id: 't11', name: '数学' }],
      excerpt: '从编码平均最短长度出发，推导香农熵、相对熵（KL 散度）与交叉熵的恒等分解：H(P,Q) = H(P) + D_KL(P||Q)，连接统计学与神经网络训练。',
      voteup_count: 2050,
      comment_count: 149,
      readOffsetDays: 3.1,
    },
    {
      id: '211',
      type: 'answer',
      question: {
        title: '贝叶斯更新（Bayesian Inference）在现实不确定性判断中为什么常常反直觉？',
        topics: [{ id: 't11', name: '概率论' }, { id: 't7', name: '认知科学' }],
      },
      excerpt: '通过罕见病假阳性案例揭示忽略基础概率（Base Rate Fallacy）的后果，展示先验概率如何通过似然比平滑更新为后验概率。',
      voteup_count: 1320,
      comment_count: 93,
      readOffsetDays: 3.5,
    },
    {
      id: '212',
      type: 'article',
      title: '量子纠缠为什么不能用来超光速传递信息？无通信定理（No-Communication Theorem）通俗解析',
      topics: [{ id: 't12', name: '量子力学' }, { id: 't13', name: '物理学' }],
      excerpt: '虽然贝尔不等式实验证实了非定域关联，但对子系统取偏迹后得到的约化密度矩阵完全不受远端测量基选择的影响，因而因果律依然严格成立。',
      voteup_count: 1760,
      comment_count: 184,
      readOffsetDays: 4.0,
    },
    // 以下 4 条为刻意混入的非知识噪音记录，用于检验数据转换 Agent 的过滤能力
    {
      id: '291',
      type: 'answer',
      question: { title: '穿越回古代带着无限超市系统，第一天怎么震惊皇帝？', topics: [{ id: 'n1', name: '网文' }, { id: 'n2', name: '爽文' }] },
      excerpt: '我穿越过去刚绑定系统就掏出一瓶冰镇可乐，侍卫全部跪地惊呼仙人下凡，皇帝当场封我为镇国公。',
      voteup_count: 420,
      comment_count: 35,
      readOffsetDays: 0.3,
    },
    {
      id: '292',
      type: 'pin',
      title: '晒一下今天的午饭日常，楼下黄焖鸡真香',
      topics: [{ id: 'n3', name: '日常' }],
      excerpt: '今天心情不错，吃完午饭去喝了杯冰美式，大家下午加油！',
      like_count: 15,
      comment_count: 4,
      readOffsetDays: 0.5,
    },
    {
      id: '293',
      type: 'answer',
      question: { title: '某明星直播翻车这个事情大家怎么看？', topics: [{ id: 'n4', name: '娱乐八卦' }] },
      excerpt: '太离谱了气不气，真恶心，全网都在骂他团队公关翻车，吃瓜吃到撑。',
      voteup_count: 890,
      comment_count: 312,
      readOffsetDays: 0.8,
    },
    {
      id: '294',
      type: 'pin',
      title: '哈哈哈笑死我了',
      topics: [{ id: 'n5', name: '搞笑' }],
      excerpt: '哈哈哈笑死我了！',
      like_count: 9,
      comment_count: 1,
      readOffsetDays: 1.1,
    },
  ];

  // 第二轮增量演示新增 3 条（涵盖已有领域同义词 + 全新生物医学领域），用于验证增量同步与动态新开星系
  const incrementalPosts = [
    {
      id: '213',
      type: 'article',
      title: 'Transformer 中的旋转位置编码（RoPE）是如何让注意力机制获得相对位置感知与外推能力的？',
      topics: [{ id: 't2', name: 'AI' }, { id: 't4', name: '深度学习' }],
      excerpt: '通过在复数平面上对 Q/K 向量施加与位置成正比的旋转矩阵，使内积仅依赖相对距离 m-n，并配合 YaRN 频域缩放扩展长上下文窗口。',
      voteup_count: 1890,
      comment_count: 121,
      readOffsetDays: 0.05,
    },
    {
      id: '214',
      type: 'article',
      title: 'CRISPR-Cas9 基因编辑的引导 RNA 识别机制与脱靶效应控制原理',
      topics: [{ id: 't14', name: '分子生物学' }, { id: 't15', name: '生物医学' }],
      excerpt: '解析 sgRNA 与 PAM 序列（NGG）协同定位目标 DNA 双链切割位点的过程，以及高保真 Cas9 变体和碱基编辑器降低双链断裂风险的策略。',
      voteup_count: 1620,
      comment_count: 97,
      readOffsetDays: 0.08,
    },
    {
      id: '215',
      type: 'answer',
      question: {
        title: 'mRNA 疫苗如何利用脂质纳米颗粒（LNP）实现细胞内递送并触发适应性免疫应答？',
        topics: [{ id: 't15', name: '生物医学' }, { id: 't16', name: '免疫学' }],
      },
      excerpt: '说明可电离脂质在内体酸性环境下质子化促进内体逃逸的机制，以及假尿苷修饰如何抑制 Toll 样受体过度炎症反应并提升抗原翻译效率。',
      voteup_count: 1480,
      comment_count: 84,
      readOffsetDays: 0.1,
    },
  ];

  const posts = round > 1 ? [...incrementalPosts, ...basePosts] : basePosts;

  return {
    get active() {
      return active;
    },
    async open() {
      active = true;
    },
    async close() {
      active = false;
    },
    async request(requestPath) {
      if (!active) throw new HistoryError('请先连接演示数据。', 409);
      if (requestPath === '/api/v4/me') {
        return { id: 'demo-star-atlas', url_token: 'demo-explorer', name: '星图探索者（演示账号）' };
      }
      if (requestPath.includes('/unify-consumption/read_history')) {
        return {
          data: posts.map((post) => ({
            data: {
              header: { title: post.title || post.question?.title || '' },
              content: { ...post, summary: post.excerpt, author_name: '知乎专栏作者' },
              extra: {
                content_token: post.id,
                content_type: post.type,
                read_time: Math.floor(now - (post.readOffsetDays || 1) * 86400),
              },
            },
          })),
          paging: { is_end: true },
        };
      }
      if (requestPath.includes('/activities')) {
        return {
          data: [
            { verb: 'ANSWER_VOTE_UP', target: posts[0], created_time: now - 3600 },
            { verb: 'MEMBER_VOTEUP_ARTICLE', target: posts[1], created_time: now - 7200 },
          ],
          paging: { is_end: true },
        };
      }
      if (requestPath.includes('/people/') && requestPath.includes('/collections')) {
        return { data: [{ id: 'demo-fav', creator: { id: 'demo-star-atlas' } }], paging: { is_end: true } };
      }
      if (requestPath.includes('/collections/demo-fav/items')) {
        return {
          data: [{ content: posts[2], created: new Date().toISOString() }],
          paging: { is_end: true },
        };
      }
      const id = new URL(requestPath, 'https://www.zhihu.com').pathname.split('/').pop();
      const post = posts.find((p) => p.id === id);
      if (post) return post;
      throw new HistoryError('演示接口不存在。', 404);
    },
  };
}

export function createCollectorService({
  userDb,
  dataDir,
  channel = 'auto',
  gatewayFactory,
  onSyncComplete,
  onProgress,
  onLoginState,
} = {}) {
  const browserProfileDir = path.join(dataDir, 'browser-profile');
  const detailCache = createDetailCache(path.join(dataDir, 'detail-cache.json'));
  const gateway = gatewayFactory ? gatewayFactory() : createBrowserGateway(browserProfileDir, channel);

  let settings = { ...DEFAULT_SETTINGS };
  let activeJob = null;
  let openingLogin = false;
  let waitingLogin = false;
  let loginPollTimer = null;
  let boundAccount = null;
  let stage = null;
  let fetched = 0;
  let lastError = null;
  let demoRound = 0;
  let cachedDatasets = { history: [], likes: [], collections: [] };

  function stopLoginPoller() {
    waitingLogin = false;
    if (loginPollTimer) {
      clearTimeout(loginPollTimer);
      loginPollTimer = null;
    }
  }

  function startLoginPoller(timeoutMs = 5 * 60_000) {
    stopLoginPoller();
    waitingLogin = true;
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      if (!waitingLogin || !gateway.active || activeJob) {
        stopLoginPoller();
        return;
      }
      if (Date.now() > deadline) {
        stopLoginPoller();
        onLoginState?.({ state: 'timeout' });
        return;
      }
      try {
        const account = await fetchAccount(gateway);
        boundAccount = account;
        stopLoginPoller();
        onLoginState?.({ state: 'logged_in', account });
        return;
      } catch {
        // 尚未完成登录，继续轮询
      }
      if (waitingLogin) {
        loginPollTimer = setTimeout(poll, 1800);
      }
    };
    loginPollTimer = setTimeout(poll, 1500);
  }

  async function fetchAccount(activeGateway) {
    const profile = await activeGateway.request('/api/v4/me');
    const id = profile?.id ?? profile?.url_token;
    if (typeof id !== 'string' || !id || profile.error) {
      throw new HistoryError('请先在专用窗口中登录知乎后再同步。', 401);
    }
    return { id, slug: profile.url_token || id, nickname: typeof profile.name === 'string' ? profile.name : '' };
  }

  function buildSnapshot({ account, items, source, syncedAt }) {
    const selected = settings;
    const nextDatasets = { ...cachedDatasets };
    for (const kind of DATA_KINDS.filter((k) => selected[k])) {
      const current = items
        .filter((item) => (item.kind || 'history') === kind)
        .map((item) => ({ ...item, kind, observedAt: item.observedAt ?? syncedAt }));
      nextDatasets[kind] = trimToLimit(current);
    }
    cachedDatasets = nextDatasets;

    const raw = DATA_KINDS.flatMap((k) => nextDatasets[k] || []);
    const ranked = rankRecords(raw, selected);
    const excluded = new Map();
    for (const record of raw.filter((r) => selected[r.kind || 'history'])) {
      const reviewed = reviewRecord(record, selected);
      if (!policyAllows(reviewed, selected)) excluded.set(`${record.contentType}:${record.contentId}`, reviewed);
    }

    const body = {
      policyVersion: POLICY_VERSION,
      settings: selected,
      records: ranked,
      excluded: [...excluded.values()],
    };
    const revision = createHash('sha256').update(JSON.stringify(body)).digest('hex');

    return {
      schemaVersion: 3,
      source,
      account: { nickname: account.nickname || '' },
      syncedAt,
      revision,
      ...body,
      counts: Object.fromEntries(
        DATA_KINDS.map((kind) => [kind, ranked.filter((r) => (r.kinds || ['history']).includes(kind)).length]),
      ),
    };
  }

  async function runSync({ useDemo = false, customGateway = null, keepWarm = true } = {}) {
    if (activeJob) return activeJob;
    if (!hasSelectedKinds(settings)) {
      throw new HistoryError('请至少勾选一种采集数据源（浏览记录/点赞/收藏）。', 400);
    }

    activeJob = (async () => {
      const startedAt = Date.now();
      lastError = null;
      fetched = 0;
      stage = 'connecting';
      onProgress?.({ stage, fetched });

      await detailCache.load();
      detailCache.prune();

      const existingDb = await userDb.read();
      const previousRecords = Array.isArray(existingDb.records) ? existingDb.records : [];
      if (previousRecords.length && cachedDatasets.history.length === 0) {
        cachedDatasets.history = previousRecords.filter((r) => (r.kinds || ['history']).includes('history'));
      }

      let activeGw = customGateway;
      let shouldCloseGw = false;
      if (!activeGw) {
        if (useDemo) {
          demoRound += 1;
          activeGw = createDemoGateway({ round: demoRound });
          shouldCloseGw = true;
        } else {
          activeGw = gateway;
          shouldCloseGw = !keepWarm;
        }
      }

      try {
        await activeGw.open({ headless: !useDemo });
        const owner = await fetchAccount(activeGw);

        const isIncremental = previousRecords.length > 0;
        const budgetMs = isIncremental ? INCREMENTAL_BUDGET_MS : INITIAL_BUDGET_MS;
        // 留出浏览器连接与落库余量，把详情补全严格限制在预算内
        const elapsedBeforeCollect = Date.now() - startedAt;
        const enrichBudgetMs = Math.max(1500, budgetMs - elapsedBeforeCollect - 2500);

        const { items, newRecordCount, mode } = await collectSelectedData(activeGw, owner, settings, {
          cache: detailCache,
          previous: settings.history && previousRecords.length > 0 ? { records: previousRecords } : undefined,
          concurrency: 6,
          batchPauseMs: useDemo ? 0 : 120,
          pagePauseMs: useDemo ? 0 : 120,
          enrichBudgetMs,
          progress(kind, count) {
            stage = kind;
            fetched = count;
            onProgress?.({ stage, fetched });
          },
        });

        await detailCache.flush();

        const syncedAt = new Date().toISOString();
        const snapshot = buildSnapshot({
          account: owner,
          items,
          source: useDemo ? 'demo_history' : 'zhihu_selected_data',
          syncedAt,
        });

        const durationMs = Date.now() - startedAt;
        const syncStats = {
          mode,
          source: snapshot.source,
          durationMs,
          budgetMs,
          withinBudget: durationMs <= budgetMs,
          fetchedCount: snapshot.records.length,
          newCount: newRecordCount,
          excludedCount: snapshot.excluded.length,
          completedAt: syncedAt,
        };

        const savedDb = await userDb.saveSnapshot(snapshot, { syncStats });
        stage = 'completed';
        onProgress?.({ stage, fetched: snapshot.records.length, syncStats });

        if (onSyncComplete) {
          // 采集完成后同步触发下游（画像 Agent 绑定更新 + 数据转换 Agent）
          await onSyncComplete({ userDbData: savedDb, syncStats });
        }

        return { userDbData: savedDb, syncStats };
      } catch (error) {
        lastError = error instanceof HistoryError ? error.message : error?.message || '采集同步失败。';
        throw error;
      } finally {
        if (shouldCloseGw) {
          await activeGw.close().catch(() => {});
        }
        activeJob = null;
        stage = null;
      }
    })();

    return activeJob;
  }

  async function openLoginWindow() {
    if (activeJob) throw new HistoryError('正在同步中，请稍后再打开登录窗口。', 409);
    openingLogin = true;
    lastError = null;
    try {
      await gateway.open({ headless: false });
      // 与原版 runtime.mjs 一致：后台自动轮询 /api/v4/me，用户完成登录后自动识别昵称并通知前端
      startLoginPoller();
      return { browserOpen: gateway.active, browserChannel: gateway.browserChannel, waitingLogin: true };
    } catch (error) {
      lastError = error?.message || '打开知乎登录窗口失败。';
      throw error;
    } finally {
      openingLogin = false;
    }
  }

  function updateSettings(next) {
    settings = validateSettings({ ...settings, ...next });
    return settings;
  }

  async function getState() {
    const db = await userDb.read();
    const account = boundAccount?.nickname ? { nickname: boundAccount.nickname } : db.account;
    return {
      browserOpen: gateway.active,
      browserChannel: gateway.browserChannel,
      openingLogin,
      waitingLogin,
      loggedIn: Boolean(boundAccount?.id),
      syncing: Boolean(activeJob),
      stage,
      fetched,
      settings,
      account,
      source: db.source,
      syncedAt: db.syncedAt,
      counts: db.counts,
      totalRecords: db.records.length,
      excludedCount: db.excluded.length,
      convertedCount: db.convertedKeys.length,
      syncStats: db.syncStats,
      error: lastError,
    };
  }

  async function close() {
    stopLoginPoller();
    await gateway.close().catch(() => {});
  }

  function resetDemoRound() {
    demoRound = 0;
    cachedDatasets = { history: [], likes: [], collections: [] };
  }

  async function startQrLogin() {
    if (activeJob) throw new HistoryError('正在同步中，请稍后再发起扫码登录。', 409);
    openingLogin = true;
    lastError = null;
    try {
      await gateway.open({ headless: true });
      // 先检查是否已登录
      try {
        const already = await fetchAccount(gateway);
        boundAccount = already;
        stopLoginPoller();
        onLoginState?.({ state: 'logged_in', account: already });
        return { loggedIn: true, account: already, qrDataUrl: null };
      } catch {
        // 未登录，前往知乎登录页提取二维码
      }
      await gateway.gotoSignin();
      const qrDataUrl = await gateway.captureLoginQr();
      startLoginPoller();
      return { loggedIn: false, waitingLogin: true, qrDataUrl };
    } catch (error) {
      lastError = error?.message || '加载知乎扫码二维码失败。';
      throw error;
    } finally {
      openingLogin = false;
    }
  }

  async function getQrSnapshot() {
    if (boundAccount?.id) {
      return { loggedIn: true, account: boundAccount, waitingLogin: false, qrDataUrl: null };
    }
    if (!gateway.active) {
      return { loggedIn: false, account: null, waitingLogin: false, qrDataUrl: null };
    }
    try {
      const acc = await fetchAccount(gateway);
      boundAccount = acc;
      stopLoginPoller();
      onLoginState?.({ state: 'logged_in', account: acc });
      return { loggedIn: true, account: acc, waitingLogin: false, qrDataUrl: null };
    } catch {
      // 尚未扫码确认，抓取最新二维码画面
    }
    const qrDataUrl = await gateway.captureLoginQr();
    return { loggedIn: false, account: null, waitingLogin, qrDataUrl };
  }

  // 直接从知乎官方 OAuth 数据接口同步创作与收藏到用户数据库（无需浏览历史会话也可独立完成全链路）
  async function syncFromOAuthRecords({ account, oauthRecords = [] }) {
    const startedAt = Date.now();
    const existingDb = await userDb.read();
    const isIncremental = existingDb.records.length > 0;
    const syncedAt = new Date().toISOString();
    const prevSettings = { ...settings };
    // 官方 OAuth 返回创作/收藏，临时确保这两类参与快照合并
    settings = { ...settings, likes: true, collections: true };
    let snapshot;
    try {
      snapshot = buildSnapshot({
        account: { nickname: account?.nickname || '知乎用户' },
        items: oauthRecords,
        source: 'zhihu_oauth_official',
        syncedAt,
      });
    } finally {
      settings = prevSettings;
    }

    const durationMs = Date.now() - startedAt;
    const budgetMs = isIncremental ? INCREMENTAL_BUDGET_MS : INITIAL_BUDGET_MS;
    const syncStats = {
      mode: isIncremental ? 'incremental' : 'initial',
      source: 'zhihu_oauth_official',
      durationMs,
      budgetMs,
      withinBudget: durationMs <= budgetMs,
      fetchedCount: snapshot.records.length,
      newCount: oauthRecords.length,
      excludedCount: snapshot.excluded.length,
      completedAt: syncedAt,
    };
    const savedDb = await userDb.saveSnapshot(snapshot, { syncStats });
    if (onSyncComplete) {
      await onSyncComplete({ userDbData: savedDb, syncStats });
    }
    return { userDbData: savedDb, syncStats };
  }

  return {
    openLoginWindow,
    startQrLogin,
    getQrSnapshot,
    syncFromOAuthRecords,
    sync: (opts = {}) => runSync({ useDemo: false, ...opts }),
    syncDemo: (opts = {}) => runSync({ useDemo: true, ...opts }),
    updateSettings,
    getState,
    close,
    resetDemoRound,
  };
}
