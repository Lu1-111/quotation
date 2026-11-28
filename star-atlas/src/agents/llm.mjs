// 大模型客户端配置与健壮 JSON 解析工具（供三大 Agent 共用）
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const tryParse = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch {
      // 尝试修复常见尾随逗号或未转义控制字符
      const repaired = candidate.replace(/,\s*([}\]])/g, '$1');
      try {
        return JSON.parse(repaired);
      } catch {
        return null;
      }
    }
  };

  const direct = tryParse(stripped);
  if (direct && typeof direct === 'object') return direct;

  // 提取最外层大括号包裹的 JSON 对象
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(stripped.slice(start, end + 1));
    if (sliced && typeof sliced === 'object') return sliced;
  }

  throw new Error('模型输出中未能解析出合法的 JSON 对象。');
}

export function createModelClient({ baseURL, modelName, apiKey }) {
  if (!baseURL || !modelName) return null;
  const provider = createOpenAICompatible({
    name: 'star-atlas-llm',
    baseURL,
    apiKey: apiKey || 'not-needed',
  });
  return provider.chatModel(modelName);
}

export async function generateStructuredJson({
  model,
  instructions,
  prompt,
  temperature = 0.2,
  timeoutMs = 90_000,
  signal,
  maxRetries = 1,
}) {
  if (!model) {
    throw new Error('未配置可用的大模型（AGENT_BASE_URL / AGENT_MODEL）。');
  }

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await generateText({
        model,
        system: instructions,
        prompt,
        temperature,
        // 对 DeepSeek 等支持思考模式的兼容端点关闭冗余推理以提升 JSON 响应速度
        providerOptions: {
          'star-atlas-llm': {
            thinking: { type: 'disabled' },
          },
        },
        abortSignal: signal ?? AbortSignal.timeout(timeoutMs),
      });
      return extractJsonObject(result.text);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        prompt = `${prompt}\n\n【格式纠正】上一次输出未能解析为 JSON，请严格只输出一个合法 JSON 对象，不要包含 Markdown 代码块或任何额外解释。`;
      }
    }
  }
  throw lastError;
}

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(tmp, filePath);
}

export function createLlmConfigStore(secretsDir) {
  const settingsPath = path.join(secretsDir, 'settings.json');
  const secretsPath = path.join(secretsDir, 'secrets.json');

  async function readJsonSafe(filePath) {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  async function getConfig() {
    const savedSettings = await readJsonSafe(settingsPath);
    const savedSecrets = await readJsonSafe(secretsPath);

    const baseURL = (savedSettings.baseURL || process.env.AGENT_BASE_URL || '').trim();
    const modelName = (savedSettings.modelName || process.env.AGENT_MODEL || '').trim();
    const apiKey = (savedSecrets.apiKey || process.env.AGENT_API_KEY || '').trim();

    return {
      baseURL,
      modelName,
      apiKey,
      ready: Boolean(baseURL && modelName),
    };
  }

  async function getPublicConfig() {
    const cfg = await getConfig();
    return {
      baseURL: cfg.baseURL,
      modelName: cfg.modelName,
      apiKeyConfigured: Boolean(cfg.apiKey),
      ready: cfg.ready,
    };
  }

  async function saveConfig({ baseURL, modelName, apiKey }) {
    const currentSettings = await readJsonSafe(settingsPath);
    const currentSecrets = await readJsonSafe(secretsPath);

    const nextSettings = {
      ...currentSettings,
      ...(typeof baseURL === 'string' ? { baseURL: baseURL.trim() } : {}),
      ...(typeof modelName === 'string' ? { modelName: modelName.trim() } : {}),
    };
    await atomicWriteJson(settingsPath, nextSettings);

    if (typeof apiKey === 'string' && apiKey.trim()) {
      await atomicWriteJson(secretsPath, { ...currentSecrets, apiKey: apiKey.trim() });
    }
    return getPublicConfig();
  }

  async function getModel() {
    const cfg = await getConfig();
    if (!cfg.ready) return { model: null, modelName: null, config: cfg };
    return {
      model: createModelClient(cfg),
      modelName: cfg.modelName,
      config: cfg,
    };
  }

  return {
    getConfig,
    getPublicConfig,
    saveConfig,
    getModel,
  };
}
