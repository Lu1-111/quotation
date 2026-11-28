// 「星球探索」功能模块总入口（支持后续平滑扩展多个子模块，当前包含首个子模块：跃迁 warp）
import { createInAppReaderService } from './reader-service.mjs';
import { createWarpAgent } from './warp-agent.mjs';
import { createZhihuSearchTool } from './zhihu-search.mjs';

export function createPlanetExplorationModule({
  starMapStore,
  planetsDb,
  userDb,
  collector,
  getModel,
  getAccessSecret,
  searchToolOverride = null,
  onWarpPipelineTrigger,
} = {}) {
  const searchTool =
    searchToolOverride ||
    createZhihuSearchTool({
      getAccessSecret,
      collector,
    });

  const warpAgent = createWarpAgent({
    starMapStore,
    planetsDb,
    searchTool,
    getModel,
  });

  const readerService = createInAppReaderService({ collector });

  async function proposeWarp({ planetId, signal } = {}) {
    return warpAgent.propose({ planetId, signal });
  }

  async function selectWarp({ warpId, targetKey, targetOverride = null, waitForPipeline = false } = {}) {
    let originPlanet = null;
    let target = targetOverride;

    if (warpId && targetKey) {
      const hit = warpAgent.getTarget(warpId, targetKey);
      if (hit) {
        originPlanet = hit.session.originPlanet;
        target = hit.target;
      }
    }
    if (!target || !target.title) {
      throw Object.assign(new Error('未找到对应的跃迁目标，请重新发起跃迁探索。'), { status: 404 });
    }

    // 1. 使用与采集模块一体化的知乎登录会话在站内拉取完整帖子内容
    const loaded = await readerService.loadPost(target);

    // 2. 立刻将该帖子写入用户数据库（user-db.json）
    await userDb.upsertRecords([loaded.userDbRecord], {
      accountNickname: loaded.viewer.nickname || null,
    });

    // 3. 立刻启动一次完整的星图生成流程（画像 + 数据转换 -> 星球库 -> 星图写入 Agent -> 3D 星图）
    let pipelineResult = null;
    if (onWarpPipelineTrigger) {
      const pipelinePromise = onWarpPipelineTrigger({
        originPlanet,
        article: loaded.article,
        record: loaded.userDbRecord,
      });
      if (waitForPipeline) {
        pipelineResult = await pipelinePromise;
      } else {
        pipelinePromise.catch(() => {});
      }
    }

    return {
      originPlanet,
      viewer: loaded.viewer,
      fullContentLoaded: loaded.fullContentLoaded,
      requiresLogin: loaded.requiresLogin,
      article: loaded.article,
      pipelineTriggered: Boolean(onWarpPipelineTrigger),
      ...(pipelineResult ? { pipelineResult } : {}),
    };
  }

  async function reloadPost(target) {
    if (!target || (!target.contentId && !target.url)) {
      throw Object.assign(new Error('缺少帖子标识，无法重新加载。'), { status: 400 });
    }
    const loaded = await readerService.loadPost(target);
    return {
      viewer: loaded.viewer,
      fullContentLoaded: loaded.fullContentLoaded,
      requiresLogin: loaded.requiresLogin,
      article: loaded.article,
    };
  }

  return {
    subModules: ['warp'],
    searchTool,
    proposeWarp,
    selectWarp,
    reloadPost,
  };
}
