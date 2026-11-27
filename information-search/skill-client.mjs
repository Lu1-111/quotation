// 知乎搜索官方 Skill 执行客户端：严格按照知乎数据开放平台《知乎搜索 Skill》(zhihu_search_skill) 官方规范调用
// `{baseDir}/scripts/zhihu-search.py '{"query":"...","count":10}'`
// 认证与环境配置遵循 SKILL.md：
// - ZHIHU_ACCESS_SECRET：必填 Bearer 凭证
// - ZHIHU_OPENAPI_BASE_URL：可选，默认 https://developer.zhihu.com
// - ZHIHU_ZHIHU_SEARCH_URL：可选完整 endpoint，优先级高于 ZHIHU_OPENAPI_BASE_URL
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SearchError, normalizeItem, parseLossless, plainText } from './official-client.mjs';

export const DEFAULT_SKILL_DIR = fileURLToPath(new URL('./skills/zhihu-search', import.meta.url));
const MAX_STDOUT_BYTES = 4_000_000;

let cachedPythonBin = null;

// 按官方 SKILL.md 要求定位可用的 Python 3 解释器，并解析出底层真实可执行文件绝对路径，
// 绕开 Windows Microsoft Store 应用执行别名（WindowsApps\python3.exe 每次约 600ms 的额外转发损耗）。
export function resolvePythonBin(explicitBin = process.env.ZHIHU_SKILL_PYTHON) {
  const custom = typeof explicitBin === 'string' ? explicitBin.trim() : '';
  if (custom) return custom;
  if (cachedPythonBin) return cachedPythonBin;

  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(
        candidate,
        ['-c', 'import sys; sys.exit(1) if sys.version_info[0] < 3 else sys.stdout.write(sys.executable)'],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        },
      );
      if (probe.status === 0) {
        const realExe = typeof probe.stdout === 'string' ? probe.stdout.trim() : '';
        cachedPythonBin = realExe && existsSync(realExe) ? realExe : candidate;
        return cachedPythonBin;
      }
    } catch {
      // 继续尝试下一个候选解释器
    }
  }
  throw new SearchError('未找到可用的 Python 3 运行环境，无法运行知乎搜索 Skill 脚本。', 503, 'SKILL_RUNTIME_MISSING');
}

// 只向 Skill 子进程透传必要的系统运行环境与官方 SKILL.md 规定的环境变量。
export function buildSkillEnv({
  accessSecret,
  openApiBaseUrl,
  searchUrl,
  parentEnv = process.env,
} = {}) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'SystemDrive', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA']) {
    const found = Object.keys(parentEnv).find((k) => k.toUpperCase() === key.toUpperCase());
    if (found && typeof parentEnv[found] === 'string' && parentEnv[found]) {
      env[found] = parentEnv[found];
    }
  }
  // 强制 Python 标准输出走 UTF-8，防止 Windows 默认 cp936/gbk 编码在含 emoji 或生僻字摘要时报错。
  env.PYTHONUTF8 = '1';
  env.PYTHONIOENCODING = 'utf-8';

  if (typeof accessSecret === 'string' && accessSecret.trim()) {
    env.ZHIHU_ACCESS_SECRET = accessSecret.trim();
  }
  if (typeof openApiBaseUrl === 'string' && openApiBaseUrl.trim()) {
    env.ZHIHU_OPENAPI_BASE_URL = openApiBaseUrl.trim();
  }
  if (typeof searchUrl === 'string' && searchUrl.trim()) {
    env.ZHIHU_ZHIHU_SEARCH_URL = searchUrl.trim();
  }
  return env;
}

function defaultRunProcess({ command, args, env, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }

    let child;
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let settled = false;

    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 忽略清理异常 */ }
      reject(combinedSignal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    combinedSignal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!settled) {
          settled = true;
          combinedSignal.removeEventListener('abort', onAbort);
          try { child.kill(); } catch { /* 忽略 */ }
          reject(new SearchError('知乎搜索响应超过大小限制。', 502, 'INVALID_RESPONSE'));
        }
        return;
      }
      stdoutChunks.push(chunk);
    });

    // stderr 仅消费排空防阻塞，不拼入业务返回也不回显任何内部信息。
    child.stderr.on('data', () => {});

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      combinedSignal.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      combinedSignal.removeEventListener('abort', onAbort);
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      });
    });
  });
}

function mapSkillFailure(parsed, exitCode) {
  const code = parsed?.Code;
  const errText = typeof parsed?.error === 'string' ? parsed.error : '';

  if (code === 20001 || /HTTP\s*(401|403)/i.test(errText)) {
    return new SearchError('知乎凭证无效或权限不足。', 401, 'UPSTREAM_AUTH');
  }
  if ([30001, 30002].includes(code) || /HTTP\s*429/i.test(errText)) {
    return new SearchError('知乎搜索频率或额度受限，请稍后再试。', 429, 'RATE_LIMITED');
  }
  if (code === 10001 || /HTTP\s*400|Invalid JSON payload|query is required/i.test(errText)) {
    return new SearchError('知乎拒绝了搜索参数。', 400, 'UPSTREAM_PARAMETERS');
  }
  if (/Set ZHIHU_ACCESS_SECRET/i.test(errText)) {
    return new SearchError('尚未配置知乎 Access Secret，请在本机配置。', 503, 'NOT_CONFIGURED');
  }
  if (/timeout or network error/i.test(errText)) {
    return new SearchError('连接知乎官方搜索接口失败或超时。', 502, 'NETWORK_ERROR');
  }
  if (/Non-JSON response/i.test(errText)) {
    return new SearchError('知乎搜索响应无法解析。', 502, 'INVALID_RESPONSE');
  }
  return new SearchError(`知乎搜索 Skill 调用失败（退出码 ${exitCode}）。`, 502, 'UPSTREAM_ERROR');
}

export function createSkillClient({
  accessSecret = process.env.ZHIHU_ACCESS_SECRET,
  openApiBaseUrl = process.env.ZHIHU_OPENAPI_BASE_URL,
  searchUrl = process.env.ZHIHU_ZHIHU_SEARCH_URL,
  skillDir = process.env.ZHIHU_SEARCH_SKILL_DIR || DEFAULT_SKILL_DIR,
  pythonBin = process.env.ZHIHU_SKILL_PYTHON,
  runProcess = defaultRunProcess,
  timeoutMs = 20_000,
} = {}) {
  const trimmedSecret = typeof accessSecret === 'string' ? accessSecret.trim() : '';
  const scriptPath = path.resolve(skillDir, 'scripts', 'zhihu-search.py');

  return {
    provider: 'zhihu_search_skill',
    configured: Boolean(trimmedSecret),
    scriptPath,
    async search(query, limit = 10, { signal, sortBy } = {}) {
      if (!trimmedSecret) {
        throw new SearchError('尚未配置知乎 Access Secret，请在本机配置 ZHIHU_ACCESS_SECRET。', 503, 'NOT_CONFIGURED');
      }
      if (typeof query !== 'string' || !query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new SearchError('关键词不能为空，单查询数量必须为 1 到 10。', 400, 'INVALID_CRITERIA');
      }
      if (!existsSync(scriptPath)) {
        throw new SearchError('未找到知乎搜索 Skill 脚本文件（scripts/zhihu-search.py）。', 503, 'SKILL_MISSING');
      }

      const command = runProcess === defaultRunProcess ? resolvePythonBin(pythonBin) : (pythonBin || 'python3');
      const payloadArg = JSON.stringify({ query: query.trim(), count: limit, ...(sortBy ? { sortBy } : {}) });
      const env = buildSkillEnv({
        accessSecret: trimmedSecret,
        openApiBaseUrl,
        searchUrl,
      });

      let execution;
      try {
        execution = await runProcess({
          command,
          args: [scriptPath, payloadArg],
          env,
          signal,
          timeoutMs,
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof SearchError) throw error;
        if (error?.name === 'TimeoutError') {
          throw new SearchError('连接知乎官方搜索接口失败或超时。', 502, 'NETWORK_ERROR');
        }
        throw new SearchError('调用知乎搜索 Skill 进程失败。', 502, 'UPSTREAM_ERROR');
      }

      let body = null;
      const rawOut = String(execution?.stdout ?? '').trim();
      if (rawOut) {
        try {
          body = parseLossless(rawOut);
        } catch {
          if (execution.exitCode === 0) {
            throw new SearchError('知乎搜索响应无法解析或超过大小限制。', 502, 'INVALID_RESPONSE');
          }
        }
      }

      if (execution.exitCode !== 0) {
        throw mapSkillFailure(body, execution.exitCode);
      }

      if (body?.Code && body.Code !== 0) {
        throw mapSkillFailure(body, 0);
      }

      if (body?.Code !== 0 || !Array.isArray(body?.Data?.Items)) {
        throw new SearchError('知乎返回非预期搜索结果。', 502, 'INVALID_RESPONSE');
      }

      return {
        query,
        searchHashId: body.Data.SearchHashId == null ? null : String(body.Data.SearchHashId),
        hasMore: Boolean(body.Data.HasMore),
        emptyReason: plainText(body.Data.EmptyReason),
        items: body.Data.Items.map(normalizeItem),
      };
    },
  };
}
