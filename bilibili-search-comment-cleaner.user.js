// ==UserScript==
// @name         B站搜索与评论净化
// @namespace    https://github.com/coe0721/Bilibili-Search-Comment-Cleaner
// @version      0.18.0
// @description  快速净化 B 站搜索与评论；支持分别自定义评论和搜索淡化程度，并提供稳定分批排序。
// @author       coe0721
// @match        https://www.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @noframes
// @updateURL    https://raw.githubusercontent.com/coe0721/Bilibili-Search-Comment-Cleaner/main/bilibili-search-comment-cleaner.user.js
// @downloadURL  https://raw.githubusercontent.com/coe0721/Bilibili-Search-Comment-Cleaner/main/bilibili-search-comment-cleaner.user.js
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  /**
   * 安全设计：
   * 1. 除用户主动开启“点赞播放比”或“视频标签复核”外不发网络请求；只匿名访问 B站公开接口。
   * 2. 只读取已经渲染在当前页面中的公开评论数据。
   * 3. 所有设置只保存在油猴的脚本专用存储中；不会被 B 站刷新覆盖。
   * 4. 过滤只改变显示样式，不删除评论节点；可随时恢复。
   *
   * 兼容思路参考：
   * - Bilibili-Evolved 关于新版开放 Shadow DOM 评论区的社区记录
   * - bilibili-cleaner 的本地黑白名单与保守过滤思路
   * 本脚本为独立实现，未复制上述项目源码。
   */

  const SCRIPT_ID = 'codex-bili-comment-cleaner';
  const STORAGE_KEY = `${SCRIPT_ID}:settings:v1`;
  const THREAD_SELECTOR = 'bili-comment-thread-renderer';
  const COMMENT_SELECTOR = 'bili-comment-renderer';
  const SEARCH_CARD_SELECTOR = [
    '.video-list-item',
    '.bili-video-card',
    '.video-item',
    '.search-video-card',
    '.bili-video-card-v2',
  ].join(',');
  const RATIO_MAX_CONCURRENCY = 2;
  const RATIO_START_GAP_MS = 900;
  const RATIO_SUCCESS_TTL_MS = 10 * 60 * 1000;
  const RATIO_ERROR_TTL_MS = 3 * 60 * 1000;
  const RATIO_CIRCUIT_FAILURES = 3;
  const RATIO_CIRCUIT_PAUSE_MS = 3 * 60 * 1000;
  const TAG_MAX_CONCURRENCY = 4;
  const TAG_START_GAP_MS = 200;
  const TAG_SUCCESS_TTL_MS = 30 * 60 * 1000;
  const TAG_ERROR_TTL_MS = 3 * 60 * 1000;
  const TAG_CIRCUIT_FAILURES = 3;
  const TAG_CIRCUIT_PAUSE_MS = 3 * 60 * 1000;
  const SORT_HYDRATION_WINDOW_MS = 8000;
  const APPEND_SORT_BATCH_WINDOW_MS = 900;

  const DEFAULTS = Object.freeze({
    filterEnabled: true,
    showFiltered: false,
    commentDimOpacity: 7,
    minMeaningfulChars: 6,
    lowLikeThreshold: 1,
    lowLikesDirect: true,
    ordinaryRuleThreshold: 2,
    minUserLevel: 0,
    customKeywords: '',
    sortEnabled: true,
    sortBy: 'likes',
    sortAutoVersion: 1,
    sortUpdateMode: 'batch',
    sortFlowVersion: 1,
    searchEnabled: true,
    searchHideAds: true,
    searchDimOpacity: 7,
    searchMinViews: 1000,
    searchLowViewMode: 'dim',
    searchLikeViewMode: 'off',
    searchMinLikeViewPercent: 1,
    searchRatioMinViews: 1000,
    searchRelevanceMode: 'dim',
    searchRelevanceSensitivity: 'balanced',
    searchTagReviewEnabled: true,
    tagAutoVersion: 1,
    searchTuningVersion: 1,
    searchKeepWords: '',
    stabilityVersion: 2,
    launcherRight: 24,
    launcherBottom: 96,
    panelOpen: true,
  });

  // 只收录较明确的广告/导流组合，不按观点或立场过滤。
  const BUILTIN_SPAM_PATTERNS = Object.freeze([
    /(?:加|进).{0,3}(?:qq群|群聊|群).{0,6}(?:领取|获取|免费|资源)/iu,
    /(?:私信|主页).{0,6}(?:领取|获取|免费|资源|教程|安装包)/iu,
    /(?:戳我|点我|点击|置顶评论).{0,8}(?:领取|获取|自取).{0,14}(?:资料|资源|课件|安装包|电子书)/iu,
    /(?:代写|代做|包过|代充|刷赞|刷粉|接单).{0,8}(?:联系|私信|主页|加我)?/iu,
    /(?:微信|v信|vx).{0,8}(?:联系|咨询|加我|同号)/iu,
  ]);

  // 这些不是“一票否决”，只作为一条普通低信息信号与低赞、零回复等叠加。
  const LOW_INFORMATION_PATTERNS = Object.freeze([
    /^(?:前排|第一|沙发|来了|打卡|蹲|插眼|留名|好耶|支持|确实|笑死|绷|典|急|孝|乐|草|顶|牛|牛逼|666+)[!！。,.，~～…\s]*$/iu,
    /^(?:求|跪求|蹲)(?:资料|资源|链接|安装包|课件|电子书)(?:666+)?[!！。,.，~～…\s]*$/iu,
    /^(?:哈|呵|嘿|呜|啊|哦|噢|额|嗯|嘻){3,}[!！。,.，~～…\s]*$/iu,
  ]);

  const FANWORK_PATTERN = /(?:二创|同人|手书|mmd|mad|amv|混剪|剪辑|配音|翻唱|角色曲|生贺|绘画|临摹|漫画|同人文|同人曲|cosplay|cos|仿妆|还原|建模|自制动画|手办)/iu;
  const GENERIC_SEARCH_WORDS = new Set([
    '教程', '教学', '攻略', '入门', '基础', '零基础', '新手', '课程', '自学', '全套', '实战',
    '讲解', '学习', '详解', '快速', '系列', '推荐', '视频', '合集', '全集', '完整版', '最新',
    '二创', '同人',
  ]);

  const originalOrder = new WeakMap();
  const parentSequence = new WeakMap();
  const originalSortStyle = new WeakMap();
  const originalParentLayout = new WeakMap();
  const visuallySortedElements = new Set();
  const visuallySortedParents = new Set();
  let sortGroupSnapshots = new WeakMap();
  let sortBatchStates = new WeakMap();
  let commentSortBatch = new WeakMap();
  const touchedComments = new Set();
  const touchedSearchCards = new Set();
  const searchCardIdentity = new WeakMap();
  let commentDataCache = new WeakMap();
  let commentQualityCache = new WeakMap();
  const dirtyCommentThreads = new Set();
  let searchCardDataCache = new WeakMap();
  let searchRelevanceCache = new WeakMap();
  const dirtySearchCards = new Set();
  let customKeywordCache = { source: '', values: [] };
  const videoStatsCache = new Map();
  const videoTagsCache = new Map();
  let ratioObservedCards = new Set();
  let tagObservedCards = new Set();
  let observedCommentThreads = new WeakSet();
  const observedShadowRoots = new Set();
  const nestedObservers = new Map();
  const reasonTooltipRoots = new WeakSet();

  const runtime = {
    settings: loadSettings(),
    applying: false,
    rerunRequested: false,
    orderDirty: false,
    lastUrl: location.href,
    ui: null,
    timer: 0,
    observerTimer: 0,
    searchTimer: 0,
    keywordTimer: 0,
    searchKeywordTimer: 0,
    dragMoved: false,
    tooltipTarget: null,
    tooltipTimer: 0,
    sortRequested: false,
    commentObservers: new Map(),
    commentHostObserver: null,
    commentHostRetryTimer: 0,
    searchContainer: null,
    searchObserver: null,
    ratioObserver: null,
    ratioQueue: [],
    ratioQueued: new Set(),
    ratioActive: 0,
    ratioNextStartAt: 0,
    ratioPumpTimer: 0,
    ratioGeneration: 0,
    ratioFailureStreak: 0,
    ratioPausedUntil: 0,
    ratioLastError: '',
    tagObserver: null,
    tagQueue: [],
    tagQueued: new Set(),
    tagActive: 0,
    tagNextStartAt: 0,
    tagPumpTimer: 0,
    tagGeneration: 0,
    tagFailureStreak: 0,
    tagPausedUntil: 0,
    tagLastError: '',
    lastSummary: {
      loaded: 0,
      filtered: 0,
      readable: 0,
      likeUnknown: 0,
      reasons: '',
      reason: '等待评论区加载',
    },
    lastSearchSummary: {
      query: '',
      loaded: 0,
      ads: 0,
      lowViews: 0,
      viewUnknown: 0,
      unrelated: 0,
      uncertain: 0,
      tagPending: 0,
      tagUnavailable: 0,
      tagRescued: 0,
      ratioLow: 0,
      ratioPending: 0,
      ratioUnavailable: 0,
      ratioSkipped: 0,
      ratioPaused: 0,
      protected: 0,
      reason: '等待搜索页',
    },
  };

  function loadSettings() {
    try {
      let saved = typeof GM_getValue === 'function' ? GM_getValue(STORAGE_KEY, null) : null;
      if (typeof saved === 'string') saved = JSON.parse(saved);
      if (!saved || typeof saved !== 'object') {
        // 从 v0.1 的站点 localStorage 迁移一次，之后改用油猴专用存储。
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      }
      const merged = { ...DEFAULTS, ...saved };
      // 稳定性架构升级时关闭旧排序，避免沿用可能扰动布局的状态。
      if (saved.stabilityVersion !== DEFAULTS.stabilityVersion) {
        merged.sortEnabled = false;
        merged.stabilityVersion = DEFAULTS.stabilityVersion;
      }
      // v0.11 按用户要求将标签复核自动开启一次；之后手动关闭会被正常记住。
      if (saved.tagAutoVersion !== DEFAULTS.tagAutoVersion) {
        merged.searchTagReviewEnabled = true;
        merged.tagAutoVersion = DEFAULTS.tagAutoVersion;
      }
      // v0.12 的排序已改为仅在成员变化或数据首次就绪时重排，按用户核心需求自动开启一次。
      if (saved.sortAutoVersion !== DEFAULTS.sortAutoVersion) {
        merged.sortEnabled = true;
        merged.sortBy = 'likes';
        merged.sortAutoVersion = DEFAULTS.sortAutoVersion;
      }
      // v0.15 默认改为分批排序：后加载的高赞评论只在新批次中靠前，不会跳到已读区域。
      if (saved.sortFlowVersion !== DEFAULTS.sortFlowVersion) {
        merged.sortUpdateMode = 'batch';
        merged.sortFlowVersion = DEFAULTS.sortFlowVersion;
      }
      // v0.12 用均衡本地筛选配合标签救回，兼顾“能过滤”与角色/二创标题的误杀控制。
      if (saved.searchTuningVersion !== DEFAULTS.searchTuningVersion) {
        merged.searchRelevanceSensitivity = 'balanced';
        merged.searchTagReviewEnabled = true;
        merged.searchTuningVersion = DEFAULTS.searchTuningVersion;
      }
      return sanitizeSettings(merged);
    } catch (error) {
      console.warn(`[${SCRIPT_ID}] 设置读取失败，使用默认值。`, error);
      return { ...DEFAULTS };
    }
  }

  function sanitizeSettings(value) {
    const sortValues = new Set(['likes', 'replies', 'balanced']);
    const sortUpdateModes = new Set(['batch', 'global', 'initial']);
    return {
      filterEnabled: Boolean(value.filterEnabled),
      showFiltered: Boolean(value.showFiltered),
      commentDimOpacity: clampInteger(
        value.commentDimOpacity,
        1,
        100,
        DEFAULTS.commentDimOpacity,
      ),
      minMeaningfulChars: clampInteger(value.minMeaningfulChars, 1, 50, DEFAULTS.minMeaningfulChars),
      lowLikeThreshold: clampInteger(value.lowLikeThreshold, 0, 1000000, DEFAULTS.lowLikeThreshold),
      lowLikesDirect: Boolean(value.lowLikesDirect),
      ordinaryRuleThreshold: clampInteger(
        value.ordinaryRuleThreshold,
        1,
        4,
        DEFAULTS.ordinaryRuleThreshold,
      ),
      minUserLevel: clampInteger(value.minUserLevel, 0, 6, DEFAULTS.minUserLevel),
      customKeywords: String(value.customKeywords || '').slice(0, 4000),
      sortEnabled: Boolean(value.sortEnabled),
      sortBy: sortValues.has(value.sortBy) ? value.sortBy : DEFAULTS.sortBy,
      sortAutoVersion: DEFAULTS.sortAutoVersion,
      sortUpdateMode: sortUpdateModes.has(value.sortUpdateMode)
        ? value.sortUpdateMode
        : DEFAULTS.sortUpdateMode,
      sortFlowVersion: DEFAULTS.sortFlowVersion,
      searchEnabled: Boolean(value.searchEnabled),
      searchHideAds: Boolean(value.searchHideAds),
      searchDimOpacity: clampInteger(
        value.searchDimOpacity,
        1,
        100,
        DEFAULTS.searchDimOpacity,
      ),
      searchMinViews: clampInteger(value.searchMinViews, 0, 100000000000, DEFAULTS.searchMinViews),
      searchLowViewMode: new Set(['off', 'dim', 'hide']).has(value.searchLowViewMode)
        ? value.searchLowViewMode
        : DEFAULTS.searchLowViewMode,
      searchLikeViewMode: new Set(['off', 'dim', 'hide']).has(value.searchLikeViewMode)
        ? value.searchLikeViewMode
        : DEFAULTS.searchLikeViewMode,
      searchMinLikeViewPercent: clampNumber(
        value.searchMinLikeViewPercent,
        0,
        100,
        DEFAULTS.searchMinLikeViewPercent,
      ),
      searchRatioMinViews: clampInteger(
        value.searchRatioMinViews,
        0,
        100000000000,
        DEFAULTS.searchRatioMinViews,
      ),
      searchRelevanceMode: new Set(['off', 'dim', 'hide']).has(value.searchRelevanceMode)
        ? value.searchRelevanceMode
        : DEFAULTS.searchRelevanceMode,
      searchRelevanceSensitivity: new Set(['conservative', 'balanced', 'strict']).has(
        value.searchRelevanceSensitivity,
      ) ? value.searchRelevanceSensitivity : DEFAULTS.searchRelevanceSensitivity,
      searchTagReviewEnabled: Boolean(value.searchTagReviewEnabled),
      tagAutoVersion: DEFAULTS.tagAutoVersion,
      searchTuningVersion: DEFAULTS.searchTuningVersion,
      searchKeepWords: String(value.searchKeepWords || '').slice(0, 2000),
      stabilityVersion: DEFAULTS.stabilityVersion,
      launcherRight: clampInteger(value.launcherRight, 8, 10000, DEFAULTS.launcherRight),
      launcherBottom: clampInteger(value.launcherBottom, 8, 10000, DEFAULTS.launcherBottom),
      panelOpen: Boolean(value.panelOpen),
    };
  }

  function clampInteger(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  function saveSettings() {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(STORAGE_KEY, runtime.settings);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(runtime.settings));
    } catch (error) {
      console.warn(`[${SCRIPT_ID}] 设置保存失败。`, error);
    }
  }

  function parseCompactCount(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value ?? '').trim().replaceAll(',', '');
    if (!text) return 0;

    const match = text.match(/(-?[\d.]+)\s*(千|万|亿|k|m)?/iu);
    if (!match) return 0;

    const base = Number.parseFloat(match[1]);
    if (!Number.isFinite(base)) return 0;
    if (/^(?:千|k)$/iu.test(match[2] || '')) return Math.round(base * 1000);
    if (match[2] === '万') return Math.round(base * 10000);
    if (match[2] === '亿') return Math.round(base * 100000000);
    if (/^m$/iu.test(match[2] || '')) return Math.round(base * 1000000);
    return Math.max(0, Math.round(base));
  }

  function safelyRead(object, key) {
    try {
      return object?.[key];
    } catch {
      return undefined;
    }
  }

  function looksLikeReply(value) {
    if (!value || typeof value !== 'object') return false;
    const content = safelyRead(value, 'content');
    return Boolean(
      typeof safelyRead(content, 'message') === 'string' ||
      safelyRead(value, 'like') !== undefined ||
      safelyRead(value, 'rcount') !== undefined ||
      safelyRead(value, 'member')
    );
  }

  function unwrapReplyData(...sources) {
    const queue = sources.filter(Boolean);
    const seen = new Set();
    const childKeys = ['reply', 'data', 'item', 'comment', 'rootReply', 'replyInfo', 'value'];
    let inspected = 0;

    while (queue.length && inspected < 40) {
      const value = queue.shift();
      inspected += 1;
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (looksLikeReply(value)) return value;

      for (const key of childKeys) {
        const child = safelyRead(value, key);
        if (child && typeof child === 'object' && !seen.has(child)) queue.push(child);
      }
    }
    return null;
  }

  function findMainRenderer(thread) {
    const root = thread.shadowRoot;
    if (!root) return null;
    return root.querySelector(COMMENT_SELECTOR);
  }

  function deepTextContent(node, depth = 0) {
    if (!node || depth > 10) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType === Node.ELEMENT_NODE && /^(?:STYLE|SCRIPT|NOSCRIPT|TEMPLATE)$/u.test(node.tagName)) {
      return '';
    }

    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'SLOT') {
      const assigned = node.assignedNodes?.({ flatten: true }) || [];
      if (assigned.length) return assigned.map((child) => deepTextContent(child, depth + 1)).join('');
    }

    // 新版评论正文还会继续嵌套开放 Shadow DOM，普通 textContent 读不到里面的字。
    const source = node.shadowRoot || node;
    let text = '';
    for (const child of source.childNodes || []) text += deepTextContent(child, depth + 1);
    return text;
  }

  function extractLevelFromDom(root) {
    const userHost = root?.querySelector('bili-comment-user-info');
    const userRoot = userHost?.shadowRoot;
    const levelNode = userRoot?.querySelector('#user-level img, #user-level [src], [class*="level"] img');
    const source = `${levelNode?.getAttribute?.('src') || ''} ${levelNode?.getAttribute?.('alt') || ''} ${levelNode?.getAttribute?.('title') || ''}`;
    const match = source.match(/(?:level[_-]?|lv\s*)([0-6])/iu);
    return match ? Number(match[1]) : null;
  }

  function extractDomDetails(renderer) {
    const root = renderer?.shadowRoot;
    if (!root) {
      return {
        text: '', textReady: false, likes: 0, replies: 0,
        likesKnown: false, repliesKnown: false, level: null, pinned: false, labelText: '',
      };
    }

    const content = root.querySelector('#content');
    const richText = content?.querySelector('bili-rich-text') || content;
    // 只读取真正的正文，避免把“置顶”徽标误当成评论内容。
    const text = deepTextContent(richText).trim();
    const actionHost = root.querySelector('bili-comment-action-buttons-renderer');
    const actionRoot = actionHost?.shadowRoot;
    // B 站零赞时 #count 往往是空文本；此时 #like 容器本身仍能证明“已识别且为 0”。
    // 同时保留少量语义化选择器，兼容网页对内部 id 的小幅调整。
    const likeContainer = actionRoot?.querySelector('#like, [data-action="like"], [part~="like"]');
    const likeNode = likeContainer?.querySelector('#count, [class~="count"], [part~="count"]')
      || actionRoot?.querySelector('#like-count');
    const likeAccessibleText = likeContainer
      ? `${likeContainer.getAttribute?.('aria-label') || ''} ${likeContainer.getAttribute?.('title') || ''}`
      : '';
    const accessibleMatch = likeAccessibleText.match(/(?:点赞|赞)[^\d]*([\d.]+\s*(?:千|万|亿|k|m)?)/iu);
    const likes = parseCompactCount(
      deepTextContent(likeNode) || accessibleMatch?.[1] || 0,
    );
    const labelText = deepTextContent(root);
    const replyMatch = labelText.match(/(?:展开|共)?\s*([\d.]+\s*(?:千|万|亿|k|m)?)\s*条回复/iu);
    const replies = parseCompactCount(replyMatch?.[1] || 0);
    return {
      text,
      textReady: Boolean(content && richText),
      likes,
      replies,
      likesKnown: Boolean(likeContainer || likeNode || accessibleMatch),
      repliesKnown: Boolean(replyMatch),
      level: extractLevelFromDom(root),
      pinned: Boolean(root.querySelector('#content #top, #top')),
      labelText,
    };
  }

  function extractThreadReplies(thread) {
    const host = thread?.shadowRoot?.querySelector('bili-comment-replies-renderer');
    const root = host?.shadowRoot;
    if (!root) return { replies: 0, known: false };
    const label = deepTextContent(root).trim();
    const match = label.match(/(?:展开|共)?\s*([\d.]+\s*(?:千|万|亿|k|m)?)\s*条回复/iu);
    if (match) return { replies: parseCompactCount(match[1]), known: true };
    const loadedReplies = root.querySelectorAll('bili-comment-reply-renderer').length;
    if (loadedReplies > 0) return { replies: loadedReplies, known: true };
    return { replies: 0, known: false };
  }

  function extractComment(thread) {
    const renderer = findMainRenderer(thread);
    const reply = unwrapReplyData(
      safelyRead(renderer, '__data'),
      safelyRead(renderer, 'data'),
      safelyRead(thread, '__data'),
      safelyRead(thread, 'data'),
    );
    const dom = extractDomDetails(renderer);
    const threadReplies = extractThreadReplies(thread);

    const replyContent = safelyRead(reply, 'content') || {};
    const text = String(safelyRead(replyContent, 'message') || dom.text || '').trim();
    const replyLikes = safelyRead(reply, 'like');
    const replyCount = safelyRead(reply, 'rcount') ?? safelyRead(reply, 'count');
    const likes = parseCompactCount(replyLikes ?? dom.likes);
    const replies = parseCompactCount(
      replyCount ?? (threadReplies.known ? threadReplies.replies : dom.replies),
    );
    const dataLevel = Number(safelyRead(safelyRead(safelyRead(reply, 'member'), 'level_info'), 'current_level'));
    const replyControl = safelyRead(reply, 'reply_control') || {};
    const upAction = safelyRead(reply, 'up_action') || {};
    const combinedLabels = dom.labelText.replace(text, '');

    const pinned = Boolean(
      safelyRead(replyControl, 'is_up_top') ||
      safelyRead(replyControl, 'is_admin_top') ||
      dom.pinned ||
      /(?:UP主|管理员)?置顶/u.test(combinedLabels),
    );
    const upInteracted = Boolean(
      safelyRead(upAction, 'like') ||
      safelyRead(upAction, 'reply') ||
      safelyRead(replyControl, 'is_up_reply') ||
      /UP主(?:觉得很赞|回复过)/u.test(combinedLabels),
    );

    return {
      thread,
      text,
      likes,
      replies,
      likesKnown: replyLikes !== undefined || dom.likesKnown,
      // “回复”按钮不代表零回复；只有数据字段或明确的“X条回复”文本才算已识别。
      repliesKnown: replyCount !== undefined || threadReplies.known || dom.repliesKnown,
      level: Number.isFinite(dataLevel) ? dataLevel : dom.level,
      pinned,
      upInteracted,
      textReady: dom.textReady || Boolean(reply),
      hasReadableData: Boolean(text || reply || dom.likesKnown),
    };
  }

  function getCommentData(thread) {
    const cached = commentDataCache.get(thread);
    // 正文和点赞都就绪后可直接复用；对应 Shadow DOM 有变化时观察器只让这一条失效。
    // 尚未就绪的节点继续读取，避免把加载占位永久缓存。
    if (
      cached &&
      !dirtyCommentThreads.has(thread) &&
      cached.textReady &&
      cached.likesKnown
    ) {
      observeCommentInternals(thread);
      return cached;
    }

    const comment = extractComment(thread);
    commentDataCache.set(thread, comment);
    dirtyCommentThreads.delete(thread);
    observeCommentInternals(thread);
    return comment;
  }

  function collectThreadElements() {
    const result = new Set(document.querySelectorAll(THREAD_SELECTOR));

    for (const commentsHost of document.querySelectorAll('bili-comments')) {
      const root = commentsHost.shadowRoot;
      if (!root) continue;
      root.querySelectorAll(THREAD_SELECTOR).forEach((element) => result.add(element));
    }

    return [...result].filter((element) => element.isConnected);
  }

  function meaningfulText(text) {
    return String(text || '')
      .replace(/https?:\/\/\S+/giu, '')
      .replace(/\[[^\]\n]{1,30}\]/gu, '')
      .replace(/[\p{P}\p{S}\p{Z}\s_]/gu, '');
  }

  function looksRepetitive(text) {
    const compact = meaningfulText(text);
    if (compact.length < 8) return false;
    if (/(.{1,3})\1{3,}/u.test(compact)) return true;
    const uniqueRatio = new Set([...compact]).size / [...compact].length;
    return uniqueRatio <= 0.22;
  }

  function getCustomKeywords() {
    const source = runtime.settings.customKeywords;
    if (customKeywordCache.source === source) return customKeywordCache.values;
    const values = source
      .split(/\r?\n|,/u)
      .map((word) => word.trim().toLocaleLowerCase())
      .filter((word) => word.length >= 2)
      .slice(0, 200);
    customKeywordCache = { source, values };
    return values;
  }

  function getLowQualityReason(comment, customKeywords) {
    if (!comment.text) return null;
    const lowerText = comment.text.toLocaleLowerCase();
    const hardReasons = [];
    const ordinaryReasons = [];

    const matchedKeyword = customKeywords.find((keyword) => lowerText.includes(keyword));
    if (matchedKeyword) hardReasons.push(`自定义关键词：${matchedKeyword.slice(0, 20)}`);

    if (BUILTIN_SPAM_PATTERNS.some((pattern) => pattern.test(comment.text))) {
      hardReasons.push('疑似广告或导流');
    }

    if (hardReasons.length) return [...new Set(hardReasons)].join('；');

    // 点赞已经证明有一定群体价值时，不再因短文本、表情占位、零回复或梗式重复被规则误杀。
    const engagementProtected = comment.likesKnown
      && comment.likes > runtime.settings.lowLikeThreshold;

    const meaningfulLength = [...meaningfulText(comment.text)].length;
    if (!engagementProtected && meaningfulLength === 0) hardReasons.push('仅表情或符号');
    if (!engagementProtected && looksRepetitive(comment.text)) hardReasons.push('重复字符较多');

    if (hardReasons.length) return [...new Set(hardReasons)].join('；');

    // 置顶或 UP 主互动只保护普通信号，不保护自定义关键词、广告等强规则。
    if (comment.pinned || comment.upInteracted) return null;

    if (
      runtime.settings.lowLikesDirect &&
      comment.likesKnown &&
      comment.likes <= runtime.settings.lowLikeThreshold
    ) {
      return `低赞直接过滤：${comment.likes}赞≤${runtime.settings.lowLikeThreshold}`;
    }

    if (comment.likesKnown && comment.likes <= runtime.settings.lowLikeThreshold) {
      ordinaryReasons.push(`低赞≤${runtime.settings.lowLikeThreshold}`);
    }
    if (!engagementProtected && comment.repliesKnown && comment.replies === 0) ordinaryReasons.push('零回复');
    if (!engagementProtected && meaningfulLength < runtime.settings.minMeaningfulChars) {
      ordinaryReasons.push(`有效内容少于${runtime.settings.minMeaningfulChars}字`);
    }
    if (
      runtime.settings.minUserLevel > 0 &&
      comment.level !== null &&
      comment.level < runtime.settings.minUserLevel
    ) {
      ordinaryReasons.push(`用户等级L${comment.level}`);
    }
    if (!engagementProtected && LOW_INFORMATION_PATTERNS.some((pattern) => pattern.test(comment.text.trim()))) {
      ordinaryReasons.push('低信息套话');
    }

    if (ordinaryReasons.length < runtime.settings.ordinaryRuleThreshold) return null;
    return `命中${ordinaryReasons.length}条：${ordinaryReasons.join('＋')}`;
  }

  function getCachedLowQualityReason(comment, customKeywords, ruleKey) {
    const cached = commentQualityCache.get(comment.thread);
    if (
      cached?.ruleKey === ruleKey &&
      cached.text === comment.text &&
      cached.likes === comment.likes &&
      cached.replies === comment.replies &&
      cached.likesKnown === comment.likesKnown &&
      cached.repliesKnown === comment.repliesKnown &&
      cached.level === comment.level &&
      cached.pinned === comment.pinned &&
      cached.upInteracted === comment.upInteracted
    ) return cached.reason;
    const reason = getLowQualityReason(comment, customKeywords);
    commentQualityCache.set(comment.thread, {
      ruleKey,
      text: comment.text,
      likes: comment.likes,
      replies: comment.replies,
      likesKnown: comment.likesKnown,
      repliesKnown: comment.repliesKnown,
      level: comment.level,
      pinned: comment.pinned,
      upInteracted: comment.upInteracted,
      reason,
    });
    return reason;
  }

  function restoreStyleProperty(element, property, value, priority = '') {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
  }

  function restoreAppearance(element) {
    if (!element) return;
    if (element.getAttribute('data-codex-bili-mode') !== null) {
      element.removeAttribute('data-codex-bili-mode');
    }
    if (element.getAttribute('data-codex-bili-filtered') !== null) {
      element.removeAttribute('data-codex-bili-filtered');
    }
  }

  function setFilterState(element, reason) {
    if (!reason) {
      restoreAppearance(element);
      return;
    }

    const mode = runtime.settings.showFiltered ? 'dim' : 'hide';
    if (mode !== 'dim' && runtime.tooltipTarget === element) hideReasonTooltip();
    touchedComments.add(element);
    if (
      element.getAttribute('data-codex-bili-mode') === mode &&
      element.getAttribute('data-codex-bili-filtered') === reason
    ) return;

    element.setAttribute('data-codex-bili-filtered', reason);
    element.setAttribute('data-codex-bili-mode', mode);
  }

  function restoreAllComments() {
    for (const element of touchedComments) restoreAppearance(element);
    touchedComments.clear();
  }

  function ensureCommentStyles(root) {
    if (!root) return;
    bindReasonTooltip(root);
    if (root.querySelector(`#${SCRIPT_ID}-comment-style`)) return;
    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-comment-style`;
    style.textContent = `
      bili-comment-thread-renderer[data-codex-bili-mode="hide"] {
        display: block !important;
        visibility: hidden !important;
        opacity: 0 !important;
        height: 12px !important;
        min-height: 12px !important;
        max-height: 12px !important;
        margin: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        overflow: hidden !important;
        pointer-events: none !important;
      }
      bili-comment-thread-renderer[data-codex-bili-mode="dim"] {
        opacity: var(--codex-bili-comment-dim-opacity, 0.07) !important;
        filter: grayscale(1) !important;
      }
      bili-comment-thread-renderer[data-codex-bili-mode="dim"]:hover {
        opacity: var(--codex-bili-comment-hover-opacity, 0.18) !important;
      }
    `;
    root.appendChild(style);
  }

  function ensureSearchStyles() {
    if (document.getElementById(`${SCRIPT_ID}-search-style`)) return;
    const style = document.createElement('style');
    style.id = `${SCRIPT_ID}-search-style`;
    style.textContent = `
      [data-codex-search-mode="hide"] { display: none !important; }
      [data-codex-search-mode="dim"] {
        opacity: var(--codex-bili-search-dim-opacity, 0.07) !important;
        filter: grayscale(1) !important;
      }
      [data-codex-search-mode="dim"]:hover {
        opacity: var(--codex-bili-search-hover-opacity, 0.18) !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function opacityValue(percent) {
    return String(clampInteger(percent, 1, 100, 7) / 100);
  }

  function hoverOpacityValue(percent) {
    const value = clampInteger(percent, 1, 100, 7);
    return String(Math.min(100, Math.max(18, value + 15)) / 100);
  }

  function applyOpacitySettings() {
    const rootStyle = document.documentElement?.style;
    if (!rootStyle) return;
    rootStyle.setProperty(
      '--codex-bili-comment-dim-opacity',
      opacityValue(runtime.settings.commentDimOpacity),
    );
    rootStyle.setProperty(
      '--codex-bili-comment-hover-opacity',
      hoverOpacityValue(runtime.settings.commentDimOpacity),
    );
    rootStyle.setProperty(
      '--codex-bili-search-dim-opacity',
      opacityValue(runtime.settings.searchDimOpacity),
    );
    rootStyle.setProperty(
      '--codex-bili-search-hover-opacity',
      hoverOpacityValue(runtime.settings.searchDimOpacity),
    );
  }

  function findDimmedTarget(event) {
    return event.composedPath?.().find((node) => (
      node?.getAttribute?.('data-codex-bili-mode') === 'dim' ||
      node?.getAttribute?.('data-codex-search-mode') === 'dim'
    )) || null;
  }

  function hideReasonTooltip() {
    if (!runtime.ui?.reasonTooltip) return;
    window.clearTimeout(runtime.tooltipTimer);
    runtime.ui.reasonTooltip.hidden = true;
    runtime.tooltipTarget = null;
  }

  function showReasonTooltip(target, event) {
    const tooltip = runtime.ui?.reasonTooltip;
    if (!tooltip || !target) return;
    const reason = target.getAttribute('data-codex-bili-filtered')
      || target.getAttribute('data-codex-search-filtered');
    if (!reason) return;
    window.clearTimeout(runtime.tooltipTimer);
    runtime.tooltipTarget = target;
    tooltip.textContent = `淡化原因：${reason}`;
    tooltip.hidden = false;
    const left = Math.min(event.clientX + 14, Math.max(8, window.innerWidth - 330));
    const top = Math.min(event.clientY + 16, Math.max(8, window.innerHeight - 74));
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function bindReasonTooltip(root) {
    if (!root || reasonTooltipRoots.has(root)) return;
    reasonTooltipRoots.add(root);
    root.addEventListener('pointerover', (event) => {
      const target = findDimmedTarget(event);
      if (target) showReasonTooltip(target, event);
    });
    root.addEventListener('pointerout', (event) => {
      if (runtime.tooltipTarget && findDimmedTarget(event) === runtime.tooltipTarget) {
        runtime.tooltipTimer = window.setTimeout(hideReasonTooltip, 45);
      }
    });
  }

  function observeNestedShadow(root, thread) {
    if (!root || observedShadowRoots.has(root)) return Boolean(root);
    observedShadowRoots.add(root);
    const observer = new MutationObserver(() => {
      if (thread?.isConnected) {
        dirtyCommentThreads.add(thread);
        observedCommentThreads.delete(thread);
      }
      scheduleObserverProcess('评论内容已更新');
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    nestedObservers.set(root, observer);
    return true;
  }

  function observeCommentInternals(thread) {
    if (observedCommentThreads.has(thread)) return;
    const threadRoot = thread?.shadowRoot;
    const renderer = findMainRenderer(thread);
    const root = renderer?.shadowRoot;
    if (!root) return;
    observeNestedShadow(threadRoot, thread);
    observeNestedShadow(root, thread);
    const actionRoot = root.querySelector('bili-comment-action-buttons-renderer')?.shadowRoot;
    const repliesRoot = threadRoot?.querySelector('bili-comment-replies-renderer')?.shadowRoot;
    observeNestedShadow(actionRoot, thread);
    observeNestedShadow(repliesRoot, thread);
    if (threadRoot && actionRoot) observedCommentThreads.add(thread);
  }

  function cleanupDetachedReferences() {
    if (runtime.tooltipTarget && !runtime.tooltipTarget.isConnected) hideReasonTooltip();
    for (const element of touchedComments) {
      if (!element.isConnected) touchedComments.delete(element);
    }
    for (const element of touchedSearchCards) {
      if (!element.isConnected) touchedSearchCards.delete(element);
    }
    for (const thread of dirtyCommentThreads) {
      if (!thread.isConnected) dirtyCommentThreads.delete(thread);
    }
    for (const card of dirtySearchCards) {
      if (!card.isConnected) dirtySearchCards.delete(card);
    }
    for (const card of ratioObservedCards) {
      if (card.isConnected) continue;
      runtime.ratioObserver?.unobserve(card);
      ratioObservedCards.delete(card);
    }
    for (const card of tagObservedCards) {
      if (card.isConnected) continue;
      runtime.tagObserver?.unobserve(card);
      tagObservedCards.delete(card);
    }
    for (const element of visuallySortedElements) {
      if (!element.isConnected) visuallySortedElements.delete(element);
    }
    for (const parent of visuallySortedParents) {
      if (!parent.isConnected) visuallySortedParents.delete(parent);
    }
    for (const [root, observer] of nestedObservers) {
      if (root.host?.isConnected) continue;
      observer.disconnect();
      nestedObservers.delete(root);
      observedShadowRoots.delete(root);
    }
  }

  function ensureOriginalOrder(comments) {
    const groups = groupByParent(comments);
    for (const [parent, group] of groups) {
      let next = parentSequence.get(parent) || 0;
      const current = new Set(group.map((comment) => comment.thread));
      for (const child of parent.children) {
        if (!current.has(child) || originalOrder.has(child)) continue;
        originalOrder.set(child, next);
        next += 1;
      }
      for (const comment of group) {
        if (originalOrder.has(comment.thread)) continue;
        originalOrder.set(comment.thread, next);
        next += 1;
      }
      parentSequence.set(parent, next);
    }
  }

  function groupByParent(comments) {
    const groups = new Map();
    for (const comment of comments) {
      const parent = comment.thread.parentElement;
      if (!parent) continue;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(comment);
    }
    return groups;
  }

  function scoreFor(comment) {
    if (runtime.settings.sortBy === 'replies') return comment.replies;
    if (runtime.settings.sortBy === 'balanced') {
      return Math.log1p(comment.likes) + 1.7 * Math.log1p(comment.replies);
    }
    return comment.likes;
  }

  function assignSortBatches(comments, now = Date.now()) {
    for (const [parent, group] of groupByParent(comments)) {
      let state = sortBatchStates.get(parent);
      if (!state) {
        state = {
          members: new Set(),
          appendBatch: 0,
          nextBatch: 1,
          lastAdditionAt: now,
        };
        sortBatchStates.set(parent, state);
      }

      // B站切换评论视图或整批重建节点时，旧元素可能全部消失但父容器复用。
      // 没有任何成员重叠就视作一份新列表，避免“仅首批”模式把它误判为后续评论。
      const overlap = group.reduce(
        (count, comment) => count + Number(state.members.has(comment.thread)),
        0,
      );
      if (state.members.size > 0 && group.length > 0 && overlap === 0) {
        state = {
          members: new Set(),
          appendBatch: 0,
          nextBatch: 1,
          lastAdditionAt: now,
        };
        sortBatchStates.set(parent, state);
      }

      const currentMembers = new Set(group.map((comment) => comment.thread));
      const added = group.filter((comment) => !state.members.has(comment.thread));
      if (added.length) {
        let batch = 0;
        if (state.members.size > 0) {
          const joinsCurrentAppendBatch = state.appendBatch > 0
            && now - state.lastAdditionAt <= APPEND_SORT_BATCH_WINDOW_MS;
          if (joinsCurrentAppendBatch) batch = state.appendBatch;
          else {
            batch = state.nextBatch;
            state.appendBatch = batch;
            state.nextBatch += 1;
          }
        }
        for (const comment of added) commentSortBatch.set(comment.thread, batch);
        state.lastAdditionAt = now;
      }
      // B站可能回收旧节点；只保留仍在当前评论容器内的成员，避免状态集合无限增长。
      state.members = currentMembers;
    }
  }

  function sortBatchFor(comment) {
    return commentSortBatch.get(comment.thread) ?? 0;
  }

  function compareComments(left, right) {
    const leftBatch = sortBatchFor(left);
    const rightBatch = sortBatchFor(right);
    if (runtime.settings.sortUpdateMode === 'batch' && leftBatch !== rightBatch) {
      return leftBatch - rightBatch;
    }
    if (runtime.settings.sortUpdateMode === 'initial') {
      const leftIsInitial = leftBatch === 0;
      const rightIsInitial = rightBatch === 0;
      if (leftIsInitial !== rightIsInitial) return leftIsInitial ? -1 : 1;
      if (!leftIsInitial) {
        return (originalOrder.get(left.thread) ?? 0) - (originalOrder.get(right.thread) ?? 0);
      }
    }
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    const primary = scoreFor(right) - scoreFor(left);
    if (primary !== 0) return primary;
    // 按赞模式的同赞评论保持 B 站原顺序；其它模式再用点赞数做稳定次级排序。
    const secondary = runtime.settings.sortBy === 'likes' ? 0 : right.likes - left.likes;
    if (secondary !== 0) return secondary;
    return (originalOrder.get(left.thread) ?? 0) - (originalOrder.get(right.thread) ?? 0);
  }

  function hasSameSortMembers(snapshot, group) {
    return Boolean(
      snapshot &&
      snapshot.members.size === group.length &&
      group.every((comment) => snapshot.members.has(comment.thread))
    );
  }

  function sortNeedsRefresh(comments) {
    if (runtime.sortRequested) return true;
    const now = Date.now();
    const groups = groupByParent(comments);
    for (const [parent, group] of groups) {
      if (group.length < 2) continue;
      const snapshot = sortGroupSnapshots.get(parent);
      if (!hasSameSortMembers(snapshot, group)) return true;
      for (const comment of group) {
        const previous = snapshot.details.get(comment.thread);
        if (!previous) return true;
        if (previous.pinned !== comment.pinned) return true;
        if (!previous.likesKnown && comment.likesKnown) return true;
        // 新一批评论出现后的短暂数据填充期允许点赞数从占位值更新；稳定后不因日常点赞跳动。
        if (
          previous.likes !== comment.likes &&
          now - snapshot.membersChangedAt <= SORT_HYDRATION_WINDOW_MS
        ) return true;
        if (
          runtime.settings.sortBy !== 'likes' &&
          !previous.repliesKnown && comment.repliesKnown
        ) return true;
      }
    }
    return false;
  }

  function captureSortSnapshots(comments) {
    const now = Date.now();
    for (const [parent, group] of groupByParent(comments)) {
      const previous = sortGroupSnapshots.get(parent);
      const sameMembers = hasSameSortMembers(previous, group);
      const details = new Map(group.map((comment) => [comment.thread, {
        likes: comment.likes,
        likesKnown: comment.likesKnown,
        repliesKnown: comment.repliesKnown,
        pinned: comment.pinned,
      }]));
      sortGroupSnapshots.set(parent, {
        members: new Set(group.map((comment) => comment.thread)),
        details,
        membersChangedAt: sameMembers ? previous.membersChangedAt : now,
      });
    }
  }

  function applySort(comments) {
    for (const [parent, group] of groupByParent(comments)) {
      if (group.length < 2) continue;

      if (!originalParentLayout.has(parent)) {
        originalParentLayout.set(parent, {
          display: parent.style.getPropertyValue('display'),
          displayPriority: parent.style.getPropertyPriority('display'),
          flexDirection: parent.style.getPropertyValue('flex-direction'),
          flexDirectionPriority: parent.style.getPropertyPriority('flex-direction'),
        });
      }
      visuallySortedParents.add(parent);

      // 只改变视觉顺序，不移动/删除 B 站的自定义评论节点。
      // 直接用 DOM 方法搬动节点会触发组件重新连接，造成头像等内部状态丢失。
      if (
        parent.style.getPropertyValue('display') !== 'flex' ||
        parent.style.getPropertyPriority('display') !== 'important'
      ) parent.style.setProperty('display', 'flex', 'important');
      if (
        parent.style.getPropertyValue('flex-direction') !== 'column' ||
        parent.style.getPropertyPriority('flex-direction') !== 'important'
      ) parent.style.setProperty('flex-direction', 'column', 'important');

      const ordered = [...group].sort(compareComments);
      ordered.forEach((comment, index) => {
        const element = comment.thread;
        if (!originalSortStyle.has(element)) {
          originalSortStyle.set(element, {
            order: element.style.getPropertyValue('order'),
            orderPriority: element.style.getPropertyPriority('order'),
          });
        }
        visuallySortedElements.add(element);
        // 使用负数，让评论保持在加载器等非评论节点之前。
        const desiredOrder = String(-100000 + index);
        if (
          element.style.getPropertyValue('order') !== desiredOrder ||
          element.style.getPropertyPriority('order') !== 'important'
        ) element.style.setProperty('order', desiredOrder, 'important');
      });
    }
    captureSortSnapshots(comments);
    runtime.orderDirty = visuallySortedElements.size > 0;
  }

  function restoreOriginalOrder() {
    for (const element of visuallySortedElements) {
      const saved = originalSortStyle.get(element);
      if (!saved) continue;
      restoreStyleProperty(element, 'order', saved.order, saved.orderPriority);
    }
    for (const parent of visuallySortedParents) {
      const saved = originalParentLayout.get(parent);
      if (!saved) continue;
      restoreStyleProperty(parent, 'display', saved.display, saved.displayPriority);
      restoreStyleProperty(parent, 'flex-direction', saved.flexDirection, saved.flexDirectionPriority);
    }
    visuallySortedElements.clear();
    visuallySortedParents.clear();
    sortGroupSnapshots = new WeakMap();
    sortBatchStates = new WeakMap();
    commentSortBatch = new WeakMap();
    runtime.orderDirty = false;
  }

  function isSearchPage() {
    return location.hostname === 'search.bilibili.com' || location.pathname.startsWith('/search');
  }

  function getSearchQuery() {
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('keyword') || params.get('search_keyword') || '';
    if (fromUrl.trim()) return fromUrl.trim();
    return (
      document.querySelector('input[name="keyword"], input.search-input, input[placeholder*="搜索"]')?.value || ''
    ).trim();
  }

  function normalizeSearchTerm(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      // 保留 C++ / C# 这类主题词的区分度，避免退化成到处都会出现的单字母 c。
      .replace(/\+/gu, 'plus')
      .replace(/#/gu, 'sharp')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function parseSearchKeepWords(value, normalizedQuery = '') {
    const words = [];
    for (const rawLine of String(value || '').split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) continue;
      const separator = line.search(/[=＝]/u);
      if (separator >= 0) {
        const scope = normalizeSearchTerm(line.slice(0, separator));
        const applies = scope && normalizedQuery
          && (normalizedQuery.includes(scope) || scope.includes(normalizedQuery));
        if (!applies) continue;
        words.push(...line.slice(separator + 1).split(/[,，、/]/u));
      } else {
        words.push(...line.split(/[,，、]/u));
      }
    }
    return [...new Set(words.map((word) => normalizeSearchTerm(word)).filter(Boolean))].slice(0, 100);
  }

  function tokenizeSearchQuery(query) {
    const tokens = [];
    // Intl.Segmenter 会把 C++ / C# 拆成单字母，先单独保留这类技术词。
    tokens.push(...(String(query || '').match(/[a-z]\s*(?:\+\+|#)/giu) || []));
    try {
      if (typeof Intl?.Segmenter === 'function') {
        const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
        for (const part of segmenter.segment(String(query || ''))) {
          if (part.isWordLike) tokens.push(part.segment);
        }
      }
    } catch {
      // 旧浏览器不支持 Intl.Segmenter 时使用下方的保守正则兜底。
    }
    if (!tokens.length) {
      tokens.push(...(String(query || '').match(/[a-z\d][a-z\d+#._-]*|[\p{Script=Han}]+/giu) || []));
    }
    return [...new Set(tokens.map(normalizeSearchTerm).filter(Boolean))];
  }

  function buildSearchQueryProfile(query, keepWords = '') {
    const normalizedQuery = normalizeSearchTerm(query);
    const tokens = tokenizeSearchQuery(query);
    const informative = tokens.filter((token) => token.length >= 2 && !GENERIC_SEARCH_WORDS.has(token));
    const genericResidue = [...GENERIC_SEARCH_WORDS]
      .sort((left, right) => right.length - left.length)
      .reduce((value, word) => value.replaceAll(word, ''), normalizedQuery);
    // 人名、角色名有时会被 Intl.Segmenter 拆成单字；用去掉泛词后的连续文本兜底。
    if (!informative.length && genericResidue.length >= 2) informative.push(genericResidue);
    return {
      normalizedQuery,
      // 查询若只有“教程/入门”等泛词，不做负面相关度判断，避免把宽泛搜索硬切窄。
      coreTokens: informative,
      broadQuery: informative.length === 0,
      hanChars: [...new Set([...normalizedQuery].filter((char) => /\p{Script=Han}/u.test(char)))],
      hasDistinctLatin: informative.some((token) => /[a-z]/iu.test(token) && token.length >= 2),
      keepWords: parseSearchKeepWords(keepWords, normalizedQuery),
    };
  }

  function extractSearchTitle(card) {
    const titleNode = card.querySelector([
      '.bili-video-card__info--tit',
      '.bili-video-card__info--tit a',
      'h3[title]',
      'h3 a',
      'a[title][href*="/video/"]',
    ].join(','));
    return String(
      titleNode?.getAttribute?.('title') ||
      titleNode?.getAttribute?.('aria-label') ||
      deepTextContent(titleNode),
    ).trim();
  }

  function extractSearchAuthor(card) {
    const authorNode = card.querySelector([
      '.bili-video-card__info--author',
      '.bili-video-card__info--author a',
      '.bili-video-card__info--owner',
      '.up-name',
      'a[href*="space.bilibili.com"]',
    ].join(','));
    return String(
      authorNode?.getAttribute?.('title') ||
      authorNode?.getAttribute?.('aria-label') ||
      deepTextContent(authorNode),
    ).replace(/\s*[·•]\s*(?:\d{4}[-/])?\d{1,2}[-/]\d{1,2}.*$/u, '').trim();
  }

  function stringSimilarity(left, right) {
    const a = normalizeSearchTerm(left).slice(0, 32);
    const b = normalizeSearchTerm(right).slice(0, 32);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row += 1) {
      const current = [row];
      for (let column = 1; column <= b.length; column += 1) {
        current[column] = Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
        );
      }
      for (let column = 0; column <= b.length; column += 1) previous[column] = current[column];
    }
    return 1 - previous[b.length] / Math.max(a.length, b.length);
  }

  function bestTokenSimilarity(coreTokens, candidateTokens) {
    let best = { score: 0, queryToken: '', candidateToken: '' };
    for (const queryToken of coreTokens) {
      if (queryToken.length < 4) continue;
      for (const candidateToken of candidateTokens) {
        if (candidateToken.length < 3) continue;
        const score = stringSimilarity(queryToken, candidateToken);
        if (score > best.score) best = { score, queryToken, candidateToken };
      }
    }
    return best;
  }

  function bestHanCoverage(coreTokens, normalizedContext) {
    let best = { coverage: 0, shared: 0, token: '' };
    for (const token of coreTokens) {
      const chars = [...new Set([...token].filter((char) => /\p{Script=Han}/u.test(char)))];
      if (chars.length < 3) continue;
      const shared = chars.filter((char) => normalizedContext.includes(char)).length;
      const coverage = shared / chars.length;
      if (coverage > best.coverage) best = { coverage, shared, token };
    }
    return best;
  }

  function classifySearchRelevance(profile, title, context = {}) {
    const normalizedTitle = normalizeSearchTerm(title);
    if (!profile?.normalizedQuery || !normalizedTitle) {
      return { state: 'uncertain', unrelated: false, reason: '信息不足，保守保留' };
    }
    if (normalizedTitle.includes(profile.normalizedQuery)) {
      return { state: 'relevant', unrelated: false, reason: '', score: 100, matchedBy: '完整搜索词' };
    }

    const author = String(context.author || '');
    const metadataText = String(context.metadataText || '').slice(0, 2500);
    const normalizedAuthor = normalizeSearchTerm(author);
    const normalizedMetadata = normalizeSearchTerm(metadataText);
    const normalizedContext = `${normalizedTitle}${normalizedAuthor}${normalizedMetadata}`;
    const protectedWord = profile.keepWords.find((word) => normalizedContext.includes(word));
    if (protectedWord) {
      return {
        unrelated: false,
        state: 'relevant',
        reason: '',
        score: 100,
        protectedBy: `保护词“${protectedWord}”`,
        explicitProtection: true,
      };
    }

    if (profile.broadQuery || profile.coreTokens.length === 0) {
      return { state: 'uncertain', unrelated: false, reason: '搜索词过于宽泛，保守保留', score: 45 };
    }

    const matchedCore = profile.coreTokens.find((token) => normalizedContext.includes(token));
    if (matchedCore) {
      const matchedBy = normalizedTitle.includes(matchedCore)
        ? `标题主题词“${matchedCore}”`
        : (normalizedAuthor.includes(matchedCore)
          ? `UP主主题词“${matchedCore}”`
          : `视频标签/简介主题词“${matchedCore}”`);
      return {
        state: 'relevant', unrelated: false, reason: '', score: 86,
        matchedBy,
      };
    }

    const candidateTokens = tokenizeSearchQuery(`${title} ${author} ${metadataText}`);
    const fuzzy = bestTokenSimilarity(profile.coreTokens, candidateTokens);
    if (fuzzy.score >= 0.8) {
      return {
        state: 'relevant', unrelated: false, reason: '', score: 72,
        matchedBy: `近似词“${fuzzy.candidateToken}”`,
      };
    }

    const hanCoverage = bestHanCoverage(profile.coreTokens, normalizedContext);
    if (hanCoverage.shared >= 2 && hanCoverage.coverage >= 0.67) {
      return {
        state: 'relevant', unrelated: false, reason: '', score: 68,
        matchedBy: `主题词大部分文字相符“${hanCoverage.token}”`,
      };
    }

    const sharedHan = profile.hanChars.filter((char) => normalizedContext.includes(char)).length;
    const position = clampInteger(context.position, 1, 9999, 9999);
    const sensitivity = new Set(['conservative', 'balanced', 'strict']).has(context.sensitivity)
      ? context.sensitivity
      : DEFAULTS.searchRelevanceSensitivity;

    // 二创、角色昵称和CP名经常不包含作品全称：归入灰区而非直接过滤。
    if (FANWORK_PATTERN.test(`${title} ${metadataText}`)) {
      return {
        state: 'uncertain', unrelated: false, score: sharedHan ? 58 : 48,
        reason: sharedHan ? '可能是二创或别名，且与搜索词有共同字' : '可能是二创或角色别名',
      };
    }

    if (sharedHan > 0) {
      return { state: 'uncertain', unrelated: false, score: 48, reason: '与搜索词有部分文字关联' };
    }

    // 拉丁主题词（软件、游戏、编程语言等）缺失时负面证据较强；中文别名则结合排名保守判断。
    const safeRank = sensitivity === 'conservative'
      ? (profile.hasDistinctLatin ? 8 : 12)
      : (sensitivity === 'balanced' ? (profile.hasDistinctLatin ? 3 : 6) : 0);
    if (position <= safeRank) {
      return { state: 'uncertain', unrelated: false, score: 38, reason: `前${safeRank}位灰区结果，保守保留` };
    }

    const shownTokens = profile.coreTokens.slice(0, 3).join(' / ').slice(0, 42);
    return {
      state: 'unrelated',
      unrelated: true,
      score: profile.hasDistinctLatin ? 12 : 22,
      reason: shownTokens
        ? `智能判断：标题、UP主${metadataText ? '和视频标签/简介' : ''}均未出现主题词“${shownTokens}”`
        : '本地智能判断：未找到可靠关联',
    };
  }

  function getCachedSearchRelevance(card, profile, title, context = {}) {
    const cacheKey = [
      profile.normalizedQuery,
      profile.keepWords.join('\u0001'),
      title,
      context.author || '',
      context.metadataText || '',
      context.position || 0,
      context.sensitivity || '',
    ].join('\u0002');
    let cached = searchRelevanceCache.get(card);
    if (cached?.has(cacheKey)) return cached.get(cacheKey);
    const value = classifySearchRelevance(profile, title, context);
    if (!cached) {
      cached = new Map();
      searchRelevanceCache.set(card, cached);
    } else if (cached.size >= 4) cached.clear();
    cached.set(cacheKey, value);
    return value;
  }

  function findSearchCardFromLink(link) {
    const exactClasses = new Set([
      'video-list-item',
      'bili-video-card',
      'video-item',
      'search-video-card',
      'bili-video-card-v2',
    ]);
    let current = link;
    let candidate = null;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if ([...current.classList || []].some((name) => exactClasses.has(name))) candidate = current;
    }
    return candidate;
  }

  function collectSearchCards() {
    if (!isSearchPage()) return [];
    const result = new Set();
    document.querySelectorAll(SEARCH_CARD_SELECTOR).forEach((element) => {
      // 广告卡通常只有 cm.bilibili.com 链接，不能用“必须有 /video/”作为前置条件。
      result.add(element);
    });
    if (result.size === 0) {
      document.querySelectorAll('a[href*="/video/"]').forEach((link) => {
        const card = findSearchCardFromLink(link);
        if (card) result.add(card);
      });
    }

    // 同一个结果可能同时匹配外层与内层选择器。向上找匹配祖先是 O(n×层级)，
    // 避免旧实现逐卡两两 contains 的 O(n²) 扫描。
    return [...result].filter((card) => (
      card.isConnected && !card.parentElement?.closest?.(SEARCH_CARD_SELECTOR)
    ));
  }

  function parseMetricCount(text) {
    const normalized = String(text || '').trim().replaceAll(',', '');
    if (!normalized || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(normalized)) return null;
    const match = normalized.match(/([\d.]+\s*(?:千|万|亿|k|m)?)/iu);
    return match ? parseCompactCount(match[1]) : null;
  }

  function extractSearchViewCount(card) {
    // 付费课程等特殊卡片的数字可能是课时或学习人数，不能冒充普通视频播放量。
    if (!extractBvid(card)) return { value: 0, known: false };
    // 优先使用 2026-09 实际页面结构：统计区第一项是播放量，第二项是弹幕数。
    const current = card.querySelector(
      '.bili-video-card__stats--left > .bili-video-card__stats--item:first-child',
    );
    const currentValue = parseMetricCount(deepTextContent(current));
    if (currentValue !== null) return { value: currentValue, known: true };

    const legacySelectors = [
      '[title*="播放"]',
      '[aria-label*="播放"]',
      '[data-type="play"]',
      '[data-stat="play"]',
      '[class*="play-count"]',
      '[class~="play-text"]',
      '.bili-video-card__stats--play',
      '.so-icon.watch-num',
      '.watch-num',
    ];
    for (const element of card.querySelectorAll(legacySelectors.join(','))) {
      const value = parseMetricCount(
        `${element.getAttribute('title') || ''} ${element.getAttribute('aria-label') || ''} ${deepTextContent(element)}`,
      );
      if (value !== null) return { value, known: true };
    }

    // 不再遍历卡片中的所有 div/span。标题、日期、集数都可能含数字，宽泛兜底既慢又会误判。
    return { value: 0, known: false };
  }

  function extractBvid(card) {
    const href = card?.querySelector('a[href*="/video/BV" i]')?.href || '';
    return href.match(/\/video\/(BV[a-z\d]+)/iu)?.[1] || '';
  }

  function getSearchCardData(card, includeViews = false) {
    const now = Date.now();
    let cached = searchCardDataCache.get(card);
    const mustRefresh = !cached || dirtySearchCards.has(card);

    if (mustRefresh) {
      const title = extractSearchTitle(card);
      const href = card.querySelector(
        'a[href*="/video/"], a[href*="cm.bilibili.com"], a[href*="/cheese/play/"]',
      )?.href || '';
      const bvid = href.match(/\/video\/(BV[a-z\d]+)/iu)?.[1] || extractBvid(card);
      const commercialReason = isSearchAd(card)
        ? '广告或推广'
        : (isPaidCourseCard(card) ? 'B站付费课程卡片' : '');
      cached = {
        title,
        author: extractSearchAuthor(card),
        href,
        bvid,
        target: getSearchDisplayTarget(card),
        commercialReason,
        views: includeViews ? extractSearchViewCount(card) : null,
        lastDomReadAt: now,
      };
      searchCardDataCache.set(card, cached);
      dirtySearchCards.delete(card);
      return cached;
    }

    // 若首次读取时文字或播放量尚未出现，最多每750毫秒补读一次；正常已就绪卡片零DOM读取。
    const needsLateText = !cached.title && !cached.commercialReason;
    const needsLateViews = includeViews && !cached.views?.known;
    if ((needsLateText || needsLateViews) && now - cached.lastDomReadAt >= 750) {
      const title = needsLateText ? extractSearchTitle(card) : cached.title;
      const author = needsLateText ? extractSearchAuthor(card) : cached.author;
      const views = needsLateViews ? extractSearchViewCount(card) : cached.views;
      cached = { ...cached, title, author, views, lastDomReadAt: now };
      searchCardDataCache.set(card, cached);
    } else if (includeViews && !cached.views) {
      cached = { ...cached, views: extractSearchViewCount(card), lastDomReadAt: now };
      searchCardDataCache.set(card, cached);
    }
    return cached;
  }

  function getCachedCardBvid(card) {
    const cached = searchCardDataCache.get(card);
    if (cached && !dirtySearchCards.has(card)) return cached.bvid;
    return extractBvid(card);
  }

  function formatCompactNumber(value) {
    const number = Math.max(0, Number(value) || 0);
    const format = (divisor, suffix) => `${(number / divisor).toFixed(number >= divisor * 10 ? 1 : 2).replace(/\.0+$/u, '').replace(/(\.\d*[1-9])0+$/u, '$1')}${suffix}`;
    if (number >= 100000000) return format(100000000, '亿');
    if (number >= 10000) return format(10000, '万');
    return String(Math.round(number));
  }

  function assessLikeViewRatio(stats, minimumPercent, minimumViews) {
    const views = Number(stats?.views);
    const likes = Number(stats?.likes);
    if (!Number.isFinite(views) || !Number.isFinite(likes) || views <= 0 || likes < 0) {
      return { state: 'unavailable' };
    }
    if (views < minimumViews) return { state: 'skipped', views, likes };
    const percent = (likes / views) * 100;
    const shownPercent = percent < 0.1 ? percent.toFixed(3) : percent.toFixed(2);
    const shownMinimum = Number(minimumPercent).toFixed(2);
    return {
      state: percent < minimumPercent ? 'low' : 'ok',
      views,
      likes,
      percent,
      reason: `点赞播放比${shownPercent}%＜${shownMinimum}%（${formatCompactNumber(likes)}赞/${formatCompactNumber(views)}播放）`,
    };
  }

  function requestVideoStats(bvid) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前油猴不支持 GM_xmlhttpRequest'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
        anonymous: true,
        redirect: 'error',
        responseType: 'json',
        timeout: 8000,
        onload(response) {
          try {
            const payload = response.response && typeof response.response === 'object'
              ? response.response
              : JSON.parse(response.responseText || '{}');
            const data = payload?.data;
            const stats = data?.stat;
            const views = Number(stats?.view);
            const likes = Number(stats?.like);
            const hasStatFields = stats && stats.view !== undefined && stats.like !== undefined;
            if (
              response.status !== 200 || payload?.code !== 0 || !hasStatFields ||
              !Number.isFinite(views) || !Number.isFinite(likes) || views < 0 || likes < 0
            ) {
              reject(new Error(`B站统计接口返回异常：${payload?.code ?? response.status}`));
              return;
            }
            resolve({
              views,
              likes,
              metadata: {
                category: String(data?.tname || '').slice(0, 80),
                description: String(data?.desc || '').slice(0, 1200),
                dynamic: String(data?.dynamic || '').slice(0, 300),
                author: String(data?.owner?.name || '').slice(0, 80),
                parts: Array.isArray(data?.pages)
                  ? data.pages.slice(0, 12).map((page) => String(page?.part || '').slice(0, 100)).filter(Boolean)
                  : [],
              },
            });
          } catch (error) {
            reject(error);
          }
        },
        onerror() { reject(new Error('B站统计接口网络错误')); },
        ontimeout() { reject(new Error('B站统计接口超时')); },
      });
    });
  }

  function getVideoStatsEntry(bvid) {
    const entry = videoStatsCache.get(bvid);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now() && !['queued', 'pending'].includes(entry.state)) {
      videoStatsCache.delete(bvid);
      return null;
    }
    return entry;
  }

  function pruneVideoStatsCache() {
    const now = Date.now();
    for (const [bvid, entry] of videoStatsCache) {
      if (entry.expiresAt && entry.expiresAt <= now && !['queued', 'pending'].includes(entry.state)) {
        videoStatsCache.delete(bvid);
      }
    }
    // 只保留有限的会话缓存，避免连续浏览很多页后长期占用内存。
    if (videoStatsCache.size < 300) return;
    for (const [bvid, entry] of videoStatsCache) {
      if (['queued', 'pending'].includes(entry.state)) continue;
      videoStatsCache.delete(bvid);
      if (videoStatsCache.size < 300) break;
    }
  }

  function isRatioCircuitPaused() {
    return runtime.ratioPausedUntil > Date.now();
  }

  function clearQueuedVideoStats() {
    runtime.ratioQueue.length = 0;
    runtime.ratioQueued.clear();
    for (const [bvid, entry] of videoStatsCache) {
      if (entry.state === 'queued') videoStatsCache.delete(bvid);
    }
  }

  function noteRatioSuccess() {
    // 熔断已经打开后，在途旧请求即使成功也不能提前解除暂停。
    if (isRatioCircuitPaused()) return;
    runtime.ratioFailureStreak = 0;
    runtime.ratioPausedUntil = 0;
    runtime.ratioLastError = '';
  }

  function noteRatioFailure(error) {
    if (isRatioCircuitPaused()) return;
    runtime.ratioFailureStreak += 1;
    runtime.ratioLastError = String(error?.message || error || '未知接口错误');
    if (runtime.ratioFailureStreak < RATIO_CIRCUIT_FAILURES) return;
    runtime.ratioPausedUntil = Date.now() + RATIO_CIRCUIT_PAUSE_MS;
    clearQueuedVideoStats();
  }

  function pumpRatioQueue() {
    window.clearTimeout(runtime.ratioPumpTimer);
    runtime.ratioPumpTimer = 0;
    if (isRatioCircuitPaused()) {
      const waitForRecovery = Math.max(100, runtime.ratioPausedUntil - Date.now() + 20);
      runtime.ratioPumpTimer = window.setTimeout(() => {
        runtime.ratioFailureStreak = 0;
        runtime.ratioPausedUntil = 0;
        runtime.ratioLastError = '';
        scheduleSearchProcess('赞播比接口保护暂停结束', 20);
      }, waitForRecovery);
      return;
    }
    if (runtime.ratioActive >= RATIO_MAX_CONCURRENCY || runtime.ratioQueue.length === 0) return;

    const wait = Math.max(0, runtime.ratioNextStartAt - Date.now());
    if (wait > 0) {
      runtime.ratioPumpTimer = window.setTimeout(pumpRatioQueue, wait);
      return;
    }

    const bvid = runtime.ratioQueue.shift();
    runtime.ratioQueued.delete(bvid);
    const entry = videoStatsCache.get(bvid);
    if (!entry || entry.state !== 'queued') {
      pumpRatioQueue();
      return;
    }

    entry.state = 'pending';
    const generation = runtime.ratioGeneration;
    runtime.ratioActive += 1;
    runtime.ratioNextStartAt = Date.now() + RATIO_START_GAP_MS;
    requestVideoStats(bvid)
      .then((stats) => {
        if (generation !== runtime.ratioGeneration) return;
        noteRatioSuccess();
        videoStatsCache.delete(bvid);
        videoStatsCache.set(bvid, { state: 'ok', stats, expiresAt: Date.now() + RATIO_SUCCESS_TTL_MS });
      })
      .catch((error) => {
        if (generation !== runtime.ratioGeneration) return;
        noteRatioFailure(error);
        videoStatsCache.delete(bvid);
        videoStatsCache.set(bvid, {
          state: 'error',
          error: String(error?.message || error),
          expiresAt: Date.now() + RATIO_ERROR_TTL_MS,
        });
      })
      .finally(() => {
        if (generation === runtime.ratioGeneration) {
          runtime.ratioActive = Math.max(0, runtime.ratioActive - 1);
          scheduleSearchProcess('点赞播放比已更新', 35);
        }
        // 即使旧代请求刚结束，也要允许当前代队列继续；旧结果本身不会回写。
        pumpRatioQueue();
      });
    pumpRatioQueue();
  }

  function queueVideoStats(bvid) {
    pruneVideoStatsCache();
    if (isRatioCircuitPaused()) return;
    if (!bvid || getVideoStatsEntry(bvid) || runtime.ratioQueued.has(bvid)) return;
    videoStatsCache.set(bvid, { state: 'queued', expiresAt: 0 });
    runtime.ratioQueued.add(bvid);
    runtime.ratioQueue.push(bvid);
    pumpRatioQueue();
  }

  function ensureRatioObserver() {
    if (runtime.ratioObserver || runtime.settings.searchLikeViewMode === 'off') return;
    if (typeof IntersectionObserver !== 'function') return;
    runtime.ratioObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        runtime.ratioObserver?.unobserve(entry.target);
        ratioObservedCards.delete(entry.target);
        queueVideoStats(getCachedCardBvid(entry.target));
      }
    }, { rootMargin: '1600px 0px' });
  }

  function watchCardForRatio(card, knownBvid = '') {
    const bvid = knownBvid || getCachedCardBvid(card);
    if (!bvid || getVideoStatsEntry(bvid)) return;
    ensureRatioObserver();
    if (!runtime.ratioObserver) {
      queueVideoStats(bvid);
      return;
    }
    if (ratioObservedCards.has(card)) return;
    ratioObservedCards.add(card);
    runtime.ratioObserver.observe(card);
  }

  function stopRatioPipeline() {
    const hadLiveWork = runtime.ratioActive > 0 || runtime.ratioQueue.length > 0 || runtime.ratioObserver;
    if (hadLiveWork) runtime.ratioGeneration += 1;
    runtime.ratioObserver?.disconnect();
    runtime.ratioObserver = null;
    ratioObservedCards = new Set();
    clearQueuedVideoStats();
    window.clearTimeout(runtime.ratioPumpTimer);
    runtime.ratioPumpTimer = 0;
    runtime.ratioActive = 0;
    runtime.ratioNextStartAt = 0;
    // 被停用或切页的在途项不能永久保持 pending；旧代回调会被 generation 隔离。
    for (const [bvid, entry] of videoStatsCache) {
      if (entry.state === 'pending') videoStatsCache.delete(bvid);
    }
    runtime.ratioFailureStreak = 0;
    runtime.ratioPausedUntil = 0;
    runtime.ratioLastError = '';
    pruneVideoStatsCache();
  }

  function requestVideoTags(bvid) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('当前油猴不支持 GM_xmlhttpRequest'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`,
        anonymous: true,
        redirect: 'error',
        responseType: 'json',
        timeout: 8000,
        onload(response) {
          try {
            const payload = response.response && typeof response.response === 'object'
              ? response.response
              : JSON.parse(response.responseText || '{}');
            if (response.status !== 200 || payload?.code !== 0 || !Array.isArray(payload?.data)) {
              reject(new Error(`B站标签接口返回异常：${payload?.code ?? response.status}`));
              return;
            }
            const tags = [...new Set(payload.data
              .map((item) => String(item?.tag_name || '').trim().slice(0, 80))
              .filter(Boolean))].slice(0, 30);
            resolve(tags);
          } catch (error) {
            reject(error);
          }
        },
        onerror() { reject(new Error('B站标签接口网络错误')); },
        ontimeout() { reject(new Error('B站标签接口超时')); },
      });
    });
  }

  function getVideoTagsEntry(bvid) {
    const entry = videoTagsCache.get(bvid);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now() && !['queued', 'pending'].includes(entry.state)) {
      videoTagsCache.delete(bvid);
      return null;
    }
    return entry;
  }

  function pruneVideoTagsCache() {
    const now = Date.now();
    for (const [bvid, entry] of videoTagsCache) {
      if (entry.expiresAt && entry.expiresAt <= now && !['queued', 'pending'].includes(entry.state)) {
        videoTagsCache.delete(bvid);
      }
    }
    if (videoTagsCache.size < 300) return;
    for (const [bvid, entry] of videoTagsCache) {
      if (['queued', 'pending'].includes(entry.state)) continue;
      videoTagsCache.delete(bvid);
      if (videoTagsCache.size < 300) break;
    }
  }

  function isTagCircuitPaused() {
    return runtime.tagPausedUntil > Date.now();
  }

  function clearQueuedVideoTags() {
    runtime.tagQueue.length = 0;
    runtime.tagQueued.clear();
    for (const [bvid, entry] of videoTagsCache) {
      if (entry.state === 'queued') videoTagsCache.delete(bvid);
    }
  }

  function noteTagSuccess() {
    if (isTagCircuitPaused()) return;
    runtime.tagFailureStreak = 0;
    runtime.tagPausedUntil = 0;
    runtime.tagLastError = '';
  }

  function noteTagFailure(error) {
    if (isTagCircuitPaused()) return;
    runtime.tagFailureStreak += 1;
    runtime.tagLastError = String(error?.message || error || '未知标签接口错误');
    if (runtime.tagFailureStreak < TAG_CIRCUIT_FAILURES) return;
    runtime.tagPausedUntil = Date.now() + TAG_CIRCUIT_PAUSE_MS;
    clearQueuedVideoTags();
  }

  function pumpTagQueue() {
    window.clearTimeout(runtime.tagPumpTimer);
    runtime.tagPumpTimer = 0;
    if (isTagCircuitPaused()) {
      const waitForRecovery = Math.max(100, runtime.tagPausedUntil - Date.now() + 20);
      runtime.tagPumpTimer = window.setTimeout(() => {
        runtime.tagFailureStreak = 0;
        runtime.tagPausedUntil = 0;
        runtime.tagLastError = '';
        scheduleSearchProcess('标签接口保护暂停结束', 20);
      }, waitForRecovery);
      return;
    }
    if (runtime.tagActive >= TAG_MAX_CONCURRENCY || runtime.tagQueue.length === 0) return;

    const wait = Math.max(0, runtime.tagNextStartAt - Date.now());
    if (wait > 0) {
      runtime.tagPumpTimer = window.setTimeout(pumpTagQueue, wait);
      return;
    }

    const bvid = runtime.tagQueue.shift();
    runtime.tagQueued.delete(bvid);
    const entry = videoTagsCache.get(bvid);
    if (!entry || entry.state !== 'queued') {
      pumpTagQueue();
      return;
    }

    entry.state = 'pending';
    const generation = runtime.tagGeneration;
    runtime.tagActive += 1;
    runtime.tagNextStartAt = Date.now() + TAG_START_GAP_MS;
    requestVideoTags(bvid)
      .then((tags) => {
        if (generation !== runtime.tagGeneration) return;
        noteTagSuccess();
        videoTagsCache.delete(bvid);
        videoTagsCache.set(bvid, { state: 'ok', tags, expiresAt: Date.now() + TAG_SUCCESS_TTL_MS });
      })
      .catch((error) => {
        if (generation !== runtime.tagGeneration) return;
        noteTagFailure(error);
        videoTagsCache.delete(bvid);
        videoTagsCache.set(bvid, {
          state: 'error',
          error: String(error?.message || error),
          expiresAt: Date.now() + TAG_ERROR_TTL_MS,
        });
      })
      .finally(() => {
        if (generation === runtime.tagGeneration) {
          runtime.tagActive = Math.max(0, runtime.tagActive - 1);
          scheduleSearchProcess('视频标签已更新', 35);
        }
        pumpTagQueue();
      });
    pumpTagQueue();
  }

  function queueVideoTags(bvid) {
    pruneVideoTagsCache();
    if (isTagCircuitPaused()) return;
    if (!bvid || getVideoTagsEntry(bvid) || runtime.tagQueued.has(bvid)) return;
    videoTagsCache.set(bvid, { state: 'queued', expiresAt: 0 });
    runtime.tagQueued.add(bvid);
    runtime.tagQueue.push(bvid);
    pumpTagQueue();
  }

  function ensureTagObserver() {
    if (runtime.tagObserver || !runtime.settings.searchTagReviewEnabled) return;
    if (typeof IntersectionObserver !== 'function') return;
    runtime.tagObserver = new IntersectionObserver((entries) => {
      const candidates = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => (
          Math.abs(left.boundingClientRect?.top || 0) - Math.abs(right.boundingClientRect?.top || 0)
        ));
      for (const entry of candidates) {
        runtime.tagObserver?.unobserve(entry.target);
        tagObservedCards.delete(entry.target);
        queueVideoTags(getCachedCardBvid(entry.target));
      }
    }, { rootMargin: '1600px 0px' });
  }

  function watchCardForTags(card, knownBvid = '') {
    const bvid = knownBvid || getCachedCardBvid(card);
    if (!bvid || getVideoTagsEntry(bvid)) return;
    ensureTagObserver();
    if (!runtime.tagObserver) {
      queueVideoTags(bvid);
      return;
    }
    if (tagObservedCards.has(card)) return;
    tagObservedCards.add(card);
    runtime.tagObserver.observe(card);
  }

  function stopTagPipeline() {
    const hadLiveWork = runtime.tagActive > 0 || runtime.tagQueue.length > 0 || runtime.tagObserver;
    if (hadLiveWork) runtime.tagGeneration += 1;
    runtime.tagObserver?.disconnect();
    runtime.tagObserver = null;
    tagObservedCards = new Set();
    clearQueuedVideoTags();
    window.clearTimeout(runtime.tagPumpTimer);
    runtime.tagPumpTimer = 0;
    runtime.tagActive = 0;
    runtime.tagNextStartAt = 0;
    for (const [bvid, entry] of videoTagsCache) {
      if (entry.state === 'pending') videoTagsCache.delete(bvid);
    }
    runtime.tagFailureStreak = 0;
    runtime.tagPausedUntil = 0;
    runtime.tagLastError = '';
    pruneVideoTagsCache();
  }

  function getCachedVideoMetadataText(bvid, tags = []) {
    const statsEntry = bvid ? getVideoStatsEntry(bvid) : null;
    const metadata = statsEntry?.state === 'ok' ? statsEntry.stats?.metadata : null;
    return [
      ...tags,
      metadata?.category,
      metadata?.author,
      metadata?.description,
      metadata?.dynamic,
      ...(metadata?.parts || []),
    ].filter(Boolean).join(' ').slice(0, 2500);
  }

  function isSearchAd(card) {
    if (card.matches('[data-ad], [data-adid], [data-ad-id], [class~="ad-card"]')) return true;
    if (card.querySelector('a[href*="cm.bilibili.com"], a[href*="ad-report"], [data-ad], [data-adid]')) return true;
    for (const label of card.querySelectorAll('span, i, em')) {
      const text = deepTextContent(label).trim();
      if (text.length <= 6 && /^(?:广告|推广|商业推广|赞助)$/u.test(text)) return true;
    }
    return false;
  }

  function isPaidCourseCard(card) {
    return Boolean(card.querySelector('a[href*="/cheese/play/"], a[href*="cheese.bilibili.com"]'));
  }

  function getSearchDisplayTarget(card) {
    const parent = card?.parentElement;
    if (
      parent &&
      parent.children.length === 1 &&
      /(?:^|\s)col_(?:xs_|md_|xl_)?[\d.]+(?:\s|$)/u.test(parent.className || '')
    ) return parent;
    return card;
  }

  function restoreSearchCard(target) {
    if (!target) return;
    if (target.getAttribute('data-codex-search-mode') !== null) {
      target.removeAttribute('data-codex-search-mode');
    }
    if (target.getAttribute('data-codex-search-filtered') !== null) {
      target.removeAttribute('data-codex-search-filtered');
    }
  }

  function restoreAllSearchCards() {
    for (const card of touchedSearchCards) {
      restoreSearchCard(card);
      searchCardIdentity.delete(card);
    }
    touchedSearchCards.clear();
  }

  function prepareSearchTarget(card, title = '', cardData = null) {
    const target = cardData?.target || getSearchDisplayTarget(card);
    const href = cardData?.href || card.querySelector(
      'a[href*="/video/"], a[href*="cm.bilibili.com"]',
    )?.href || '';
    const identity = `${href}|${normalizeSearchTerm(title)}`;
    const previousIdentity = searchCardIdentity.get(target);
    // B站可能复用卡片外壳。身份变化时先清掉旧结果，防止旧视频的过滤状态粘到新视频。
    if (previousIdentity && identity && previousIdentity !== identity) restoreSearchCard(target);
    if (identity) searchCardIdentity.set(target, identity);
    touchedSearchCards.add(target);
    return target;
  }

  function setSearchTargetState(target, reason, mode) {
    if (mode !== 'dim' && runtime.tooltipTarget === target) hideReasonTooltip();
    if (!reason || mode === 'off') {
      restoreSearchCard(target);
      return;
    }
    if (
      target.getAttribute('data-codex-search-mode') === mode &&
      target.getAttribute('data-codex-search-filtered') === reason
    ) return;
    target.setAttribute('data-codex-search-filtered', reason);
    target.setAttribute('data-codex-search-mode', mode);
  }

  function processSearchResults(reason = '自动检查') {
    cleanupDetachedReferences();
    if (!isSearchPage()) {
      stopRatioPipeline();
      stopTagPipeline();
      restoreAllSearchCards();
      return { query: '', loaded: 0, ads: 0, lowViews: 0, viewUnknown: 0, unrelated: 0, uncertain: 0, tagPending: 0, tagUnavailable: 0, tagRescued: 0, ratioLow: 0, ratioPending: 0, ratioUnavailable: 0, ratioSkipped: 0, ratioPaused: 0, protected: 0, reason: '当前不是搜索页' };
    }

    const cards = collectSearchCards();
    const query = getSearchQuery();
    if (!runtime.settings.searchEnabled) {
      stopRatioPipeline();
      stopTagPipeline();
      restoreAllSearchCards();
      return { query, loaded: cards.length, ads: 0, lowViews: 0, viewUnknown: 0, unrelated: 0, uncertain: 0, tagPending: 0, tagUnavailable: 0, tagRescued: 0, ratioLow: 0, ratioPending: 0, ratioUnavailable: 0, ratioSkipped: 0, ratioPaused: 0, protected: 0, reason: '搜索净化已关闭' };
    }

    let ads = 0;
    let lowViews = 0;
    let viewUnknown = 0;
    let unrelated = 0;
    let uncertain = 0;
    let tagPending = 0;
    let tagUnavailable = 0;
    let tagRescued = 0;
    let ratioLow = 0;
    let ratioPending = 0;
    let ratioUnavailable = 0;
    let ratioSkipped = 0;
    let ratioPaused = 0;
    let protectedCount = 0;
    const checksLowViews = runtime.settings.searchLowViewMode !== 'off'
      && runtime.settings.searchMinViews > 0;
    const checksRatio = runtime.settings.searchLikeViewMode !== 'off'
      && runtime.settings.searchMinLikeViewPercent > 0;
    if (checksRatio) ensureRatioObserver();
    else stopRatioPipeline();
    const checksTagReview = runtime.settings.searchTagReviewEnabled
      && runtime.settings.searchRelevanceMode !== 'off';
    if (checksTagReview) ensureTagObserver();
    else stopTagPipeline();
    const queryProfile = buildSearchQueryProfile(query, runtime.settings.searchKeepWords);

    for (const [cardIndex, card] of cards.entries()) {
      try {
        const cardData = getSearchCardData(card, checksLowViews || checksRatio);
        const { title, author, bvid, commercialReason } = cardData;
        const target = prepareSearchTarget(card, title, cardData);
        if (runtime.settings.searchHideAds && commercialReason) {
          setSearchTargetState(target, commercialReason, 'hide');
          ads += 1;
          continue;
        }

        const decisions = [];
        let relevance = title
          ? getCachedSearchRelevance(card, queryProfile, title, {
            author,
            position: cardIndex + 1,
            sensitivity: runtime.settings.searchRelevanceSensitivity,
          })
          : { state: 'uncertain', unrelated: false, reason: '', explicitProtection: false };

        let tagPendingForCard = false;
        // 标签只做“救回”复核：仅查询本地已判明确无关的卡片。等待期间立即按本地结果
        // 临时淡化，标签命中后再救回；这样下滑时无需等待接口，又避免临时直接隐藏造成跳动。
        if (checksTagReview && title && relevance.unrelated) {
          const tagEntry = bvid ? getVideoTagsEntry(bvid) : null;
          if (!bvid || (!tagEntry && isTagCircuitPaused())) {
            tagUnavailable += 1;
            relevance = { state: 'uncertain', unrelated: false, reason: '视频标签暂不可用，保守放行' };
          } else if (!tagEntry) {
            watchCardForTags(card, bvid);
            tagPending += 1;
            tagPendingForCard = true;
            relevance = { ...relevance, reason: `${relevance.reason}；标签复核中，先临时淡化` };
          } else if (['queued', 'pending'].includes(tagEntry.state)) {
            tagPending += 1;
            tagPendingForCard = true;
            relevance = { ...relevance, reason: `${relevance.reason}；标签复核中，先临时淡化` };
          } else if (tagEntry.state === 'error') {
            tagUnavailable += 1;
            relevance = { state: 'uncertain', unrelated: false, reason: '视频标签读取失败，保守放行' };
          } else {
            const metadataText = getCachedVideoMetadataText(bvid, tagEntry.tags);
            if (!metadataText) {
              tagUnavailable += 1;
              relevance = { state: 'uncertain', unrelated: false, reason: '视频标签为空，保守放行' };
            } else {
              const reviewed = getCachedSearchRelevance(card, queryProfile, title, {
                author,
                metadataText,
                position: cardIndex + 1,
                sensitivity: runtime.settings.searchRelevanceSensitivity,
              });
              if (!reviewed.unrelated) tagRescued += 1;
              relevance = reviewed;
            }
          }
        }
        if (relevance.state === 'uncertain') uncertain += 1;
        // 白名单只保护“相关性”，低播放和低赞播比仍是独立质量规则。
        const explicitlyProtected = runtime.settings.searchRelevanceMode !== 'off'
          && Boolean(relevance.explicitProtection);
        if (explicitlyProtected) protectedCount += 1;
        let views = cardData.views || { value: 0, known: false };
        if (checksLowViews || checksRatio) {
          if (!views.known) viewUnknown += 1;
          else if (checksLowViews && views.value < runtime.settings.searchMinViews) {
            decisions.push({
              reason: `播放量${views.value}＜${runtime.settings.searchMinViews}`,
              mode: runtime.settings.searchLowViewMode,
            });
            lowViews += 1;
          }
        }

        if (runtime.settings.searchRelevanceMode !== 'off' && title) {
          if (relevance.unrelated) {
            decisions.push({
              reason: relevance.reason,
              mode: tagPendingForCard ? 'dim' : runtime.settings.searchRelevanceMode,
            });
            unrelated += 1;
          }
        }

        let ratioPendingForCard = false;
        const alreadyHidden = decisions.some((decision) => decision.mode === 'hide');
        if (checksRatio && !alreadyHidden) {
          if (views.known && views.value < runtime.settings.searchRatioMinViews) {
            ratioSkipped += 1;
          } else {
            const entry = bvid ? getVideoStatsEntry(bvid) : null;
            if (!bvid) {
              ratioUnavailable += 1;
            } else if (!entry && isRatioCircuitPaused()) {
              ratioPaused += 1;
            } else if (!entry) {
              watchCardForRatio(card, bvid);
              ratioPending += 1;
              ratioPendingForCard = true;
            } else if (['queued', 'pending'].includes(entry.state)) {
              ratioPending += 1;
              ratioPendingForCard = true;
            } else if (entry.state === 'error') {
              ratioUnavailable += 1;
            } else {
              const assessment = assessLikeViewRatio(
                entry.stats,
                runtime.settings.searchMinLikeViewPercent,
                runtime.settings.searchRatioMinViews,
              );
              if (assessment.state === 'low') {
                decisions.push({ reason: assessment.reason, mode: runtime.settings.searchLikeViewMode });
                ratioLow += 1;
              } else if (assessment.state === 'skipped') ratioSkipped += 1;
              else if (assessment.state === 'unavailable') ratioUnavailable += 1;
            }
          }
        }

        if (decisions.length) {
          const mode = decisions.some((decision) => decision.mode === 'hide') ? 'hide' : 'dim';
          setSearchTargetState(target, [...new Set(decisions.map((decision) => decision.reason))].join('；'), mode);
        } else {
          const oldReason = target.getAttribute('data-codex-search-filtered') || '';
          // 页面数字或匿名统计仍在加载时保留上一次确定判断，防止卡片闪烁。
          const preserveLowView = checksLowViews && !views.known && oldReason.includes('播放量');
          const preserveRatio = ratioPendingForCard && oldReason.includes('点赞播放比');
          if (!preserveLowView && !preserveRatio) {
            setSearchTargetState(target, null, 'off');
          }
        }
      } catch (error) {
        viewUnknown += 1;
        console.debug(`[${SCRIPT_ID}] 跳过一个尚未稳定的搜索卡片。`, error);
      }
    }

    return {
      query,
      loaded: cards.length,
      ads,
      lowViews,
      viewUnknown,
      unrelated,
      uncertain,
      tagPending,
      tagUnavailable,
      tagRescued,
      ratioLow,
      ratioPending,
      ratioUnavailable,
      ratioSkipped,
      ratioPaused,
      protected: protectedCount,
      reason,
    };
  }

  function processComments(reason = '自动检查') {
    if (runtime.applying) {
      runtime.rerunRequested = true;
      return;
    }
    runtime.applying = true;
    try {
      cleanupDetachedReferences();
      const threads = collectThreadElements();
      const comments = threads.map((thread) => {
        try {
          return getCommentData(thread);
        } catch (error) {
          console.debug(`[${SCRIPT_ID}] 跳过一个尚未稳定的评论节点。`, error);
          return null;
        }
      }).filter(Boolean);
      if (runtime.settings.sortEnabled) {
        ensureOriginalOrder(comments);
        assignSortBatches(comments);
      }
      const customKeywords = getCustomKeywords();
      const commentRuleKey = [
        runtime.settings.minMeaningfulChars,
        runtime.settings.lowLikeThreshold,
        Number(runtime.settings.lowLikesDirect),
        runtime.settings.ordinaryRuleThreshold,
        runtime.settings.minUserLevel,
        runtime.settings.customKeywords,
      ].join('\u0002');
      let filtered = 0;
      let readable = 0;
      let likeUnknown = 0;
      const reasonCounts = new Map();

      for (const comment of comments) {
        if (comment.hasReadableData) {
          readable += 1;
          if (!comment.likesKnown) likeUnknown += 1;
        }
        const filterReason = runtime.settings.filterEnabled
          ? getCachedLowQualityReason(comment, customKeywords, commentRuleKey)
          : null;
        const decisionComplete = comment.textReady && (
          !runtime.settings.filterEnabled ||
          !runtime.settings.lowLikesDirect ||
          comment.likesKnown
        );
        // 组件加载中的“未知”不是“通过”。保留原状态，避免同一评论来回显隐。
        if (filterReason || decisionComplete) setFilterState(comment.thread, filterReason);
        if (filterReason) {
          filtered += 1;
          const shortReason = filterReason.split('：')[0];
          reasonCounts.set(shortReason, (reasonCounts.get(shortReason) || 0) + 1);
        }
      }

      if (runtime.settings.sortEnabled) {
        if (sortNeedsRefresh(comments)) {
          applySort(comments);
          runtime.sortRequested = false;
        }
      } else restoreOriginalOrder();

      runtime.lastSummary = {
        loaded: comments.length,
        filtered,
        readable,
        likeUnknown,
        reasons: [...reasonCounts.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3)
          .map(([name, count]) => `${name}×${count}`)
          .join('，'),
        reason,
      };
      updateUi();
    } catch (error) {
      console.error(`[${SCRIPT_ID}] 处理评论时出错。`, error);
      runtime.lastSummary.reason = '处理失败，请刷新页面或暂时关闭脚本';
      updateUi();
    } finally {
      runtime.applying = false;
      if (runtime.rerunRequested) {
        runtime.rerunRequested = false;
        scheduleObserverProcess('合并处理加载中的变化', 40);
      }
    }
  }

  function scheduleProcess(reason, delay = 120) {
    window.clearTimeout(runtime.timer);
    runtime.timer = window.setTimeout(() => processComments(reason), delay);
  }

  function scheduleObserverProcess(reason, delay = 70) {
    window.clearTimeout(runtime.observerTimer);
    runtime.observerTimer = window.setTimeout(() => processComments(reason), delay);
  }

  function scheduleSearchProcess(reason, delay = 70) {
    window.clearTimeout(runtime.searchTimer);
    runtime.searchTimer = window.setTimeout(() => {
      runtime.lastSearchSummary = processSearchResults(reason);
      updateUi();
    }, delay);
  }

  function disconnectObservers() {
    window.clearTimeout(runtime.searchTimer);
    runtime.searchTimer = 0;
    for (const observer of runtime.commentObservers.values()) observer.disconnect();
    runtime.commentObservers.clear();
    runtime.commentHostObserver?.disconnect();
    runtime.commentHostObserver = null;
    window.clearTimeout(runtime.commentHostRetryTimer);
    runtime.commentHostRetryTimer = 0;
    runtime.searchObserver?.disconnect();
    runtime.searchObserver = null;
    runtime.searchContainer = null;
    for (const observer of nestedObservers.values()) observer.disconnect();
    nestedObservers.clear();
    observedShadowRoots.clear();
    dirtyCommentThreads.clear();
    dirtySearchCards.clear();
    commentDataCache = new WeakMap();
    commentQualityCache = new WeakMap();
    searchCardDataCache = new WeakMap();
    searchRelevanceCache = new WeakMap();
    customKeywordCache = { source: '', values: [] };
    observedCommentThreads = new WeakSet();
    stopRatioPipeline();
    stopTagPipeline();
  }

  function setupCommentObservers() {
    for (const [host, observer] of runtime.commentObservers) {
      if (host.isConnected && host.shadowRoot) continue;
      observer.disconnect();
      runtime.commentObservers.delete(host);
    }

    let added = 0;
    for (const host of document.querySelectorAll('bili-comments')) {
      const root = host.shadowRoot;
      if (!root) continue;
      ensureCommentStyles(root);
      if (runtime.commentObservers.has(host)) continue;
      const observer = new MutationObserver(() => scheduleObserverProcess('检测到新评论'));
      observer.observe(root, { childList: true, subtree: true });
      runtime.commentObservers.set(host, observer);
      added += 1;
    }

    if (!added) return;
    scheduleObserverProcess(added > 1 ? `已连接${added}个动态评论区` : '评论区已连接', 30);
    window.setTimeout(() => processComments('评论组件已稳定'), 300);
    window.setTimeout(() => processComments('评论数据已复核'), 850);
  }

  function shouldWatchForCommentHosts() {
    if (document.querySelector('bili-comments')) return true;
    if (location.hostname === 't.bilibili.com') return true;
    if (location.hostname === 'space.bilibili.com') {
      return /\/dynamic(?:\/|$)/u.test(location.pathname);
    }
    if (location.hostname !== 'www.bilibili.com') return false;
    return /^\/(?:video|opus|read|audio|bangumi\/play|cheese\/play|medialist\/play|list)\b/u.test(
      location.pathname,
    );
  }

  function setupCommentHostDiscovery() {
    // 首页等不会出现评论区的页面不挂全页观察器，避免为了极少发生的组件插入
    // 持续接收无关 DOM 变化；轮询仍会发现未知页面上已实际出现的评论组件。
    if (
      runtime.commentHostObserver ||
      !document.documentElement ||
      !shouldWatchForCommentHosts()
    ) return;
    runtime.commentHostObserver = new MutationObserver((records) => {
      const foundHost = records.some((record) => [...record.addedNodes].some((node) => (
        node?.matches?.('bili-comments') || node?.querySelector?.('bili-comments')
      )));
      if (!foundHost) return;
      // 大多数评论组件插入时 Shadow Root 已就绪，立即连接；再补一次短延迟检查，
      // 覆盖“先插宿主、后挂 Shadow Root”的动态详情实现。
      setupCommentObservers();
      window.clearTimeout(runtime.commentHostRetryTimer);
      runtime.commentHostRetryTimer = window.setTimeout(() => {
        runtime.commentHostRetryTimer = 0;
        setupCommentObservers();
      }, 260);
    });
    runtime.commentHostObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function markSearchCardsDirty(records) {
    const markNode = (node) => {
      const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
      if (!element) return;
      const ownerCard = element.matches?.(SEARCH_CARD_SELECTOR)
        ? element
        : element.closest?.(SEARCH_CARD_SELECTOR);
      if (ownerCard) dirtySearchCards.add(ownerCard);
      element.querySelectorAll?.(SEARCH_CARD_SELECTOR).forEach((card) => dirtySearchCards.add(card));
    };

    for (const record of records) {
      markNode(record.target);
      record.addedNodes?.forEach(markNode);
    }
  }

  function setupSearchObserver() {
    ensureSearchStyles();
    if (!isSearchPage()) {
      runtime.searchObserver?.disconnect();
      runtime.searchObserver = null;
      runtime.searchContainer = null;
      return;
    }
    // B站会不定期替换搜索页外层类名。优先监听结果区；未命中时监听 main/#i_cecream/body
    // 的 childList 作为低开销兜底，避免首轮检测早于卡片加载后只能靠手动按钮重试。
    const preciseContainer = document.querySelector([
      '.search-all-list',
      '.video-list.row',
      '.search-page-wrapper',
      '.search-layout',
      '.search-content',
      '.search-content__wrap',
      '.search-video-list',
      '.video-list',
    ].join(','));
    const container = preciseContainer
      || document.querySelector('main')
      || document.getElementById('i_cecream')
      || document.body;
    if (!container || (runtime.searchContainer === container && runtime.searchObserver)) return;

    runtime.searchObserver?.disconnect();
    runtime.searchContainer = container;
    runtime.searchObserver = new MutationObserver((records) => {
      markSearchCardsDirty(records);
      scheduleSearchProcess('搜索结果已更新', 55);
    });
    const searchObserverOptions = {
      childList: true,
      subtree: true,
      // 只有精确结果容器才监听文字变化；大范围兜底不监听，避免动态页面产生无意义刷新。
      characterData: Boolean(preciseContainer),
    };
    if (preciseContainer) {
      // 只监听会改变卡片身份/可读文字的属性，不监听脚本自己写入的 data-codex-* 属性。
      searchObserverOptions.attributes = true;
      searchObserverOptions.attributeFilter = ['href', 'title', 'aria-label'];
    }
    runtime.searchObserver.observe(container, searchObserverOptions);
    scheduleSearchProcess('搜索结果已连接', 20);
    window.setTimeout(() => scheduleSearchProcess('搜索数据已稳定', 0), 300);
    window.setTimeout(() => scheduleSearchProcess('搜索数据已复核', 0), 900);
  }

  function setupObservers() {
    setupCommentHostDiscovery();
    setupCommentObservers();
    setupSearchObserver();
  }

  function createUi() {
    if (document.getElementById(`${SCRIPT_ID}-host`)) return;

    const host = document.createElement('div');
    host.id = `${SCRIPT_ID}-host`;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        #launcher {
          position: fixed; right: 24px; bottom: 96px; z-index: 2147483646;
          width: 46px; height: 46px; border: 0; border-radius: 50%;
          color: #fff; background: #fb7299; box-shadow: 0 6px 22px rgba(0,0,0,.22);
          font: 700 17px/46px system-ui, sans-serif; cursor: grab;
          touch-action: none; user-select: none;
        }
        #launcher:active { cursor: grabbing; }
        #startupToast {
          position: fixed; top: 76px; left: 50%; z-index: 2147483647;
          transform: translateX(-50%); max-width: calc(100vw - 32px); padding: 10px 16px;
          border-radius: 999px; color: #fff; background: rgba(0,137,108,.94);
          box-shadow: 0 6px 22px rgba(0,0,0,.2); white-space: nowrap;
          font: 600 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
          animation: toastOut .35s ease 6.5s forwards;
        }
        @keyframes toastOut { to { opacity: 0; visibility: hidden; } }
        #panel {
          position: fixed; right: 24px; bottom: 154px; z-index: 2147483646;
          width: min(360px, calc(100vw - 32px)); max-height: min(650px, calc(100vh - 190px));
          display: flex; flex-direction: column; overflow: hidden; padding: 0;
          border: 1px solid rgba(0,0,0,.12); border-radius: 14px;
          color: #18191c; background: rgba(255,255,255,.98); box-shadow: 0 12px 38px rgba(0,0,0,.2);
          font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        #panel[hidden] { display: none; }
        .panel-header {
          flex: none; display: flex; align-items: center; gap: 8px;
          margin: 0; padding: 10px 10px 9px 16px;
          border-bottom: 1px solid rgba(0,0,0,.08);
          background: rgba(255,255,255,.98); backdrop-filter: blur(8px);
        }
        .panel-header h2 {
          flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .panel-close {
          flex: none; width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%;
          color: #61666d; background: #f1f2f3; font: 700 22px/30px system-ui, sans-serif;
          cursor: pointer;
        }
        .panel-close:hover { color: #fff; background: #fb7299; }
        .panel-body {
          min-height: 0; overflow: auto; padding: 8px 16px 16px;
          overscroll-behavior: contain; scrollbar-gutter: stable;
        }
        h2 { margin: 0; font-size: 17px; }
        .sub { margin: 4px 0 13px; color: #6d757a; font-size: 12px; }
        .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 11px 0 8px; }
        .tab {
          min-height: 34px; padding: 6px; border: 1px solid #e3e5e7; border-radius: 8px;
          color: #61666d; background: #f6f7f8; font: inherit; cursor: pointer;
        }
        .tab[aria-selected="true"] { color: #fff; background: #fb7299; border-color: #fb7299; }
        .section { padding: 4px 0 8px; }
        .section[hidden] { display: none; }
        .toggle { display: flex; align-items: center; gap: 8px; margin: 7px 0; cursor: pointer; }
        input[type="checkbox"] { width: 16px; height: 16px; accent-color: #fb7299; }
        .grid { display: grid; grid-template-columns: 1fr 94px; gap: 8px; align-items: center; margin: 8px 0; }
        input[type="number"], select, textarea {
          width: 100%; padding: 7px 8px; border: 1px solid #ccd0d7; border-radius: 7px;
          color: #18191c; background: #fff; font: inherit;
        }
        textarea { min-height: 68px; resize: vertical; }
        .hint { margin: 5px 0 0; color: #777; font-size: 12px; }
        details.advanced { margin: 8px 0; padding: 7px 9px; border: 1px solid #e7e7e7; border-radius: 8px; }
        details.advanced > summary { color: #61666d; font-weight: 600; cursor: pointer; user-select: none; }
        details.advanced[open] > summary { margin-bottom: 7px; }
        .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
        button.action {
          min-height: 34px; padding: 7px 9px; border: 1px solid #fb7299; border-radius: 8px;
          color: #fb7299; background: #fff; font: inherit; cursor: pointer;
        }
        button.action.primary { color: #fff; background: #fb7299; }
        button.action:hover { filter: brightness(.97); }
        button.action:disabled { cursor: not-allowed; opacity: .5; }
        button.action.wide { width: 100%; margin-top: 8px; }
        button.action.danger { color: #d03050; border-color: #d03050; }
        button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible,
        summary:focus-visible {
          outline: 2px solid #00aeec; outline-offset: 2px;
        }
        .status-box { margin: 9px 0 0; padding: 9px; border-radius: 8px; background: #f6f7f8; font-size: 12px; }
        #safety { color: #00896c; }
        #reasonTooltip {
          position: fixed; z-index: 2147483647; width: max-content; max-width: min(310px, calc(100vw - 24px));
          padding: 7px 9px; border-radius: 7px; color: #fff; background: rgba(24,25,28,.96);
          box-shadow: 0 4px 16px rgba(0,0,0,.25); font: 12px/1.45 system-ui, sans-serif;
          pointer-events: none; white-space: normal;
        }
        #reasonTooltip[hidden] { display: none; }
        @media (prefers-color-scheme: dark) {
          #panel { color: #e3e5e7; background: rgba(31,31,31,.98); border-color: #4a4a4a; }
          .panel-header { background: rgba(31,31,31,.98); border-color: #484848; }
          .panel-close { color: #ddd; background: #3a3a3a; }
          .tab { color: #bbb; background: #292929; border-color: #4a4a4a; }
          .tab[aria-selected="true"] { color: #fff; background: #fb7299; border-color: #fb7299; }
          .sub, .hint { color: #aaa; }
          details.advanced { border-color: #484848; }
          details.advanced > summary { color: #bbb; }
          input[type="number"], select, textarea { color: #eee; background: #292929; border-color: #555; }
          button.action { background: #292929; }
          button.action.primary { background: #fb7299; }
          .status-box { background: #292929; }
        }
        @media (max-width: 480px) {
          #panel {
            right: 8px; left: 8px; bottom: 154px; width: auto;
            max-height: calc(100vh - 170px);
          }
          .panel-header { padding-left: 14px; }
          .panel-body { padding: 8px 14px 14px; }
          .grid { grid-template-columns: minmax(0, 1fr) 90px; }
          .buttons { grid-template-columns: 1fr; }
        }
      </style>
      <div id="startupToast" role="status">✓ B站净化 v0.18 已启动：评论与搜索淡化程度可分别设置</div>
      <div id="reasonTooltip" role="tooltip" hidden></div>
      <button id="launcher" type="button" title="打开评论净化设置">评</button>
      <section id="panel" aria-label="B站评论净化设置">
        <div class="panel-header">
          <h2>B站搜索与评论净化 v0.18</h2>
          <button class="panel-close" id="closePanelTop" type="button" aria-label="收起设置面板" title="收起设置面板（Esc）">×</button>
        </div>
        <div class="panel-body">
        <p class="sub" id="safety">即时初筛 · 标签救回 · 新评论分批排序</p>
        <div class="tabs" role="tablist" aria-label="功能分类">
          <button class="tab" type="button" role="tab" data-tab="comments">评论</button>
          <button class="tab" type="button" role="tab" data-tab="search">搜索</button>
          <button class="tab" type="button" role="tab" data-tab="sort">排序</button>
        </div>

        <div class="section" role="tabpanel" data-tab-panel="comments">
          <label class="toggle"><input id="filterEnabled" type="checkbox">开启低质量过滤</label>
          <label class="toggle"><input id="showFiltered" type="checkbox">显示被过滤评论（变淡）</label>
          <div class="grid"><label for="commentDimOpacity">评论淡化后可见度（%）</label><input id="commentDimOpacity" type="number" min="1" max="100" step="1"></div>
          <p class="hint">数值越小越淡；默认 7%，鼠标移入时会临时提高可见度并显示原因。</p>
          <details class="advanced" open>
          <summary>规则与阈值</summary>
          <div class="grid"><label for="minChars">最少有效字符</label><input id="minChars" type="number" min="1" max="50"></div>
          <div class="grid"><label for="lowLikeThreshold">低赞阈值（≤）</label><input id="lowLikeThreshold" type="number" min="0" max="1000000"></div>
          <label class="toggle"><input id="lowLikesDirect" type="checkbox">低赞直接过滤（不受等级影响）</label>
          <div class="grid"><label for="ordinaryRuleThreshold">普通规则命中数</label><select id="ordinaryRuleThreshold">
            <option value="1">1 条（强力）</option><option value="2">2 条（推荐）</option>
            <option value="3">3 条（保守）</option><option value="4">4 条（最保守）</option>
          </select></div>
          <div class="grid"><label for="minLevel">最低用户等级</label><select id="minLevel">
            <option value="0">关闭</option><option value="1">L1</option><option value="2">L2</option>
            <option value="3">L3</option><option value="4">L4</option><option value="5">L5</option><option value="6">L6</option>
          </select></div>
          <label for="keywords">自定义屏蔽词（每行一个）</label>
          <textarea id="keywords" placeholder="例如：私信领取\n无脑洗地"></textarea>
          <p class="hint">广告和自定义屏蔽词始终生效；其余短评、表情和重复梗只要点赞高于低赞阈值就保留。低赞直接过滤开启时，点赞≤阈值独立生效。</p>
          </details>
          <p id="status" class="status-box" role="status">等待评论区加载</p>
        </div>

        <div class="section" role="tabpanel" data-tab-panel="search" hidden>
          <label class="toggle"><input id="searchEnabled" type="checkbox">开启搜索结果净化</label>
          <label class="toggle"><input id="searchHideAds" type="checkbox">隐藏广告、推广和付费课程</label>
          <div class="grid"><label for="searchDimOpacity">搜索淡化后可见度（%）</label><input id="searchDimOpacity" type="number" min="1" max="100" step="1"></div>
          <p class="hint">数值越小越淡；只改变显示效果，不会改变相关性或质量判断。</p>
          <details class="advanced" open>
          <summary>播放量与赞播比</summary>
          <div class="grid"><label for="searchMinViews">最低播放量</label><input id="searchMinViews" type="number" min="0" max="100000000000"></div>
          <div class="grid"><label for="searchLowViewMode">低播放结果</label><select id="searchLowViewMode">
            <option value="off">不处理</option><option value="dim">淡化</option><option value="hide">隐藏</option>
          </select></div>
          <div class="grid"><label for="searchLikeViewMode">低点赞播放比</label><select id="searchLikeViewMode">
            <option value="off">关闭（零请求）</option><option value="dim">淡化</option><option value="hide">隐藏</option>
          </select></div>
          <div class="grid"><label for="searchMinLikeViewPercent">最低赞播比（%）</label><input id="searchMinLikeViewPercent" type="number" min="0" max="100" step="0.1"></div>
          <div class="grid"><label for="searchRatioMinViews">最低样本播放量</label><input id="searchRatioMinViews" type="number" min="0" max="100000000000"></div>
          </details>
          <div class="grid"><label for="searchRelevanceMode">明显无关结果</label><select id="searchRelevanceMode">
            <option value="off">不处理</option><option value="dim">淡化（推荐）</option><option value="hide">隐藏</option>
          </select></div>
          <div class="grid"><label for="searchRelevanceSensitivity">智能判断强度</label><select id="searchRelevanceSensitivity">
            <option value="conservative">保守（推荐）</option><option value="balanced">均衡</option><option value="strict">严格</option>
          </select></div>
          <label class="toggle"><input id="searchTagReviewEnabled" type="checkbox">用 B站视频标签复核无关结果（匿名）</label>
          <details class="advanced" open>
          <summary>相关度高级设置</summary>
          <label for="searchKeepWords">搜索白名单/别名（每行一个）</label>
          <textarea id="searchKeepWords" placeholder="例如：芙宁娜=芙芙\n原神=提瓦特"></textarea>
          </details>
          <button class="action wide" id="externalSearch" type="button">用 Bing 精确搜索 B站视频</button>
          <p class="hint">标题与UP主先在本地即时判断；待标签复核的结果先淡化，标签相关则自动救回。白名单只保护相关性，低播放和低赞播比仍独立判断质量。</p>
          <p id="searchStatus" class="status-box">打开 B 站搜索页后显示统计</p>
        </div>

        <div class="section" role="tabpanel" data-tab-panel="sort" hidden>
          <label class="toggle"><input id="sortEnabled" type="checkbox">自动按点赞重排评论</label>
          <div class="grid"><label for="sortBy">排序依据</label><select id="sortBy">
            <option value="likes">点赞数</option><option value="replies">回复数</option><option value="balanced">综合互动</option>
          </select></div>
          <div class="grid"><label for="sortUpdateMode">后来加载的评论</label><select id="sortUpdateMode">
            <option value="batch">分批排序，不跳回前面（推荐）</option>
            <option value="initial">保持B站加载顺序</option>
            <option value="global">加入全部评论重新排序</option>
          </select></div>
          <p class="hint">“分批排序”会把首屏按赞排好；后来每批只在本批内部排序，并接在你已读内容后面，因此新高赞不会跳到页面前端。“保持B站加载顺序”则只排序首批。</p>
        </div>

        <div class="buttons">
          <button class="action primary" id="applyNow" type="button">立即复核/重排</button>
          <button class="action danger" id="restorePage" type="button">停用全部并恢复</button>
          <button class="action" id="resetSettings" type="button">恢复默认设置</button>
          <button class="action" id="closePanel" type="button">收起面板</button>
        </div>
        </div>
      </section>
    `;

    document.documentElement.appendChild(host);
    window.setTimeout(() => root.querySelector('#startupToast')?.remove(), 7200);
    console.info(`[${SCRIPT_ID}] v0.18.0 已启动：${location.href}`);
    runtime.ui = {
      host,
      root,
      tabs: [...root.querySelectorAll('[data-tab]')],
      tabPanels: [...root.querySelectorAll('[data-tab-panel]')],
      activeTab: '',
      reasonTooltip: root.querySelector('#reasonTooltip'),
      launcher: root.querySelector('#launcher'),
      panel: root.querySelector('#panel'),
      panelBody: root.querySelector('.panel-body'),
      filterEnabled: root.querySelector('#filterEnabled'),
      showFiltered: root.querySelector('#showFiltered'),
      commentDimOpacity: root.querySelector('#commentDimOpacity'),
      minChars: root.querySelector('#minChars'),
      lowLikeThreshold: root.querySelector('#lowLikeThreshold'),
      lowLikesDirect: root.querySelector('#lowLikesDirect'),
      ordinaryRuleThreshold: root.querySelector('#ordinaryRuleThreshold'),
      minLevel: root.querySelector('#minLevel'),
      keywords: root.querySelector('#keywords'),
      searchEnabled: root.querySelector('#searchEnabled'),
      searchHideAds: root.querySelector('#searchHideAds'),
      searchDimOpacity: root.querySelector('#searchDimOpacity'),
      searchMinViews: root.querySelector('#searchMinViews'),
      searchLowViewMode: root.querySelector('#searchLowViewMode'),
      searchLikeViewMode: root.querySelector('#searchLikeViewMode'),
      searchMinLikeViewPercent: root.querySelector('#searchMinLikeViewPercent'),
      searchRatioMinViews: root.querySelector('#searchRatioMinViews'),
      searchRelevanceMode: root.querySelector('#searchRelevanceMode'),
      searchRelevanceSensitivity: root.querySelector('#searchRelevanceSensitivity'),
      searchTagReviewEnabled: root.querySelector('#searchTagReviewEnabled'),
      searchKeepWords: root.querySelector('#searchKeepWords'),
      externalSearch: root.querySelector('#externalSearch'),
      searchStatus: root.querySelector('#searchStatus'),
      sortEnabled: root.querySelector('#sortEnabled'),
      sortBy: root.querySelector('#sortBy'),
      sortUpdateMode: root.querySelector('#sortUpdateMode'),
      status: root.querySelector('#status'),
    };

    setUiTab(isSearchPage() ? 'search' : 'comments');
    bindUiEvents();
    bindReasonTooltip(document);
    bindLauncherDrag();
    applyLauncherPosition();
    updateUi();
  }

  function setUiTab(tab) {
    const ui = runtime.ui;
    if (!ui || !new Set(['comments', 'search', 'sort']).has(tab)) return;
    const changed = Boolean(ui.activeTab && ui.activeTab !== tab);
    ui.activeTab = tab;
    for (const button of ui.tabs) {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of ui.tabPanels) panel.hidden = panel.dataset.tabPanel !== tab;
    if (changed) ui.panelBody.scrollTop = 0;
    if (changed) schedulePanelPosition();
  }

  function bindUiEvents() {
    const ui = runtime.ui;
    const closePanel = () => {
      if (!runtime.settings.panelOpen) return;
      runtime.settings.panelOpen = false;
      saveSettings();
      updateUi();
    };
    const disableAllAndRestore = () => {
      runtime.settings.filterEnabled = false;
      runtime.settings.sortEnabled = false;
      runtime.settings.searchEnabled = false;
      saveSettings();
      stopRatioPipeline();
      stopTagPipeline();
      restoreAllComments();
      restoreAllSearchCards();
      processComments('已关闭全部净化并恢复页面');
    };
    for (const button of ui.tabs) {
      button.addEventListener('click', () => setUiTab(button.dataset.tab));
    }
    ui.launcher.addEventListener('click', () => {
      if (runtime.dragMoved) {
        runtime.dragMoved = false;
        return;
      }
      runtime.settings.panelOpen = !runtime.settings.panelOpen;
      saveSettings();
      updateUi();
      if (runtime.settings.panelOpen) schedulePanelPosition();
    });
    ui.root.querySelector('#closePanel').addEventListener('click', closePanel);
    ui.root.querySelector('#closePanelTop').addEventListener('click', closePanel);
    ui.root.querySelectorAll('details').forEach((details) => {
      details.addEventListener('toggle', schedulePanelPosition);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closePanel();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!runtime.settings.panelOpen) return;
      const path = event.composedPath?.() || [];
      if (path.includes(ui.panel) || path.includes(ui.launcher)) return;
      closePanel();
    }, true);

    ui.filterEnabled.addEventListener('change', () => {
      runtime.settings.filterEnabled = ui.filterEnabled.checked;
      saveSettings();
      if (!runtime.settings.filterEnabled) restoreAllComments();
      scheduleProcess('过滤开关已更新');
    });
    ui.showFiltered.addEventListener('change', () => {
      runtime.settings.showFiltered = ui.showFiltered.checked;
      saveSettings();
      scheduleProcess('过滤显示方式已更新');
    });
    ui.commentDimOpacity.addEventListener('input', () => {
      runtime.settings.commentDimOpacity = clampInteger(
        ui.commentDimOpacity.value,
        1,
        100,
        DEFAULTS.commentDimOpacity,
      );
      applyOpacitySettings();
      saveSettings();
    });
    ui.minChars.addEventListener('input', () => {
      runtime.settings.minMeaningfulChars = clampInteger(ui.minChars.value, 1, 50, DEFAULTS.minMeaningfulChars);
      saveSettings();
      scheduleProcess('短评论阈值已更新');
    });
    ui.lowLikeThreshold.addEventListener('input', () => {
      runtime.settings.lowLikeThreshold = clampInteger(
        ui.lowLikeThreshold.value,
        0,
        1000000,
        DEFAULTS.lowLikeThreshold,
      );
      saveSettings();
      scheduleProcess('低赞阈值已更新');
    });
    ui.lowLikesDirect.addEventListener('change', () => {
      runtime.settings.lowLikesDirect = ui.lowLikesDirect.checked;
      saveSettings();
      scheduleProcess('低赞直接过滤开关已更新');
    });
    ui.ordinaryRuleThreshold.addEventListener('change', () => {
      runtime.settings.ordinaryRuleThreshold = clampInteger(
        ui.ordinaryRuleThreshold.value,
        1,
        4,
        DEFAULTS.ordinaryRuleThreshold,
      );
      saveSettings();
      scheduleProcess('普通规则叠加数量已更新');
    });
    ui.minLevel.addEventListener('change', () => {
      runtime.settings.minUserLevel = clampInteger(ui.minLevel.value, 0, 6, 0);
      saveSettings();
      scheduleProcess('等级条件已更新');
    });
    ui.keywords.addEventListener('input', () => {
      runtime.settings.customKeywords = ui.keywords.value.slice(0, 4000);
      window.clearTimeout(runtime.keywordTimer);
      runtime.keywordTimer = window.setTimeout(() => {
        saveSettings();
        scheduleProcess('自定义屏蔽词已更新');
      }, 350);
    });
    ui.searchEnabled.addEventListener('change', () => {
      runtime.settings.searchEnabled = ui.searchEnabled.checked;
      saveSettings();
      if (!runtime.settings.searchEnabled) {
        stopRatioPipeline();
        stopTagPipeline();
        restoreAllSearchCards();
      }
      scheduleSearchProcess('搜索净化开关已更新');
    });
    ui.searchHideAds.addEventListener('change', () => {
      runtime.settings.searchHideAds = ui.searchHideAds.checked;
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('广告过滤已更新');
    });
    ui.searchDimOpacity.addEventListener('input', () => {
      runtime.settings.searchDimOpacity = clampInteger(
        ui.searchDimOpacity.value,
        1,
        100,
        DEFAULTS.searchDimOpacity,
      );
      applyOpacitySettings();
      saveSettings();
    });
    ui.searchMinViews.addEventListener('input', () => {
      runtime.settings.searchMinViews = clampInteger(
        ui.searchMinViews.value,
        0,
        100000000000,
        DEFAULTS.searchMinViews,
      );
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('最低播放量已更新');
    });
    ui.searchLowViewMode.addEventListener('change', () => {
      runtime.settings.searchLowViewMode = ui.searchLowViewMode.value;
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('低播放结果显示方式已更新');
    });
    ui.searchLikeViewMode.addEventListener('change', () => {
      runtime.settings.searchLikeViewMode = ui.searchLikeViewMode.value;
      stopRatioPipeline();
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('点赞播放比显示方式已更新');
    });
    ui.searchMinLikeViewPercent.addEventListener('input', () => {
      runtime.settings.searchMinLikeViewPercent = clampNumber(
        ui.searchMinLikeViewPercent.value,
        0,
        100,
        DEFAULTS.searchMinLikeViewPercent,
      );
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('点赞播放比阈值已更新');
    });
    ui.searchRatioMinViews.addEventListener('input', () => {
      runtime.settings.searchRatioMinViews = clampInteger(
        ui.searchRatioMinViews.value,
        0,
        100000000000,
        DEFAULTS.searchRatioMinViews,
      );
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('点赞播放比最低样本已更新');
    });
    ui.searchRelevanceMode.addEventListener('change', () => {
      runtime.settings.searchRelevanceMode = ui.searchRelevanceMode.value;
      if (runtime.settings.searchRelevanceMode === 'off') stopTagPipeline();
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('无关结果显示方式已更新');
    });
    ui.searchRelevanceSensitivity.addEventListener('change', () => {
      runtime.settings.searchRelevanceSensitivity = ui.searchRelevanceSensitivity.value;
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('智能相关度强度已更新');
    });
    ui.searchTagReviewEnabled.addEventListener('change', () => {
      runtime.settings.searchTagReviewEnabled = ui.searchTagReviewEnabled.checked;
      stopTagPipeline();
      saveSettings();
      restoreAllSearchCards();
      scheduleSearchProcess('视频标签复核开关已更新');
    });
    ui.searchKeepWords.addEventListener('input', () => {
      runtime.settings.searchKeepWords = ui.searchKeepWords.value.slice(0, 2000);
      window.clearTimeout(runtime.searchKeywordTimer);
      runtime.searchKeywordTimer = window.setTimeout(() => {
        saveSettings();
        restoreAllSearchCards();
        scheduleSearchProcess('搜索保护词已更新');
      }, 350);
    });
    ui.externalSearch.addEventListener('click', () => {
      const query = getSearchQuery();
      if (!query) {
        window.alert('请先在 B 站搜索页输入并搜索一个关键词。');
        return;
      }
      const target = `https://www.bing.com/search?q=${encodeURIComponent(`site:bilibili.com/video ${query}`)}`;
      const opened = window.open(target, '_blank', 'noopener,noreferrer');
      if (opened) opened.opener = null;
    });
    ui.sortEnabled.addEventListener('change', () => {
      runtime.settings.sortEnabled = ui.sortEnabled.checked;
      runtime.sortRequested = runtime.settings.sortEnabled;
      saveSettings();
      scheduleProcess(runtime.settings.sortEnabled ? '已开启自动重排' : '已恢复 B 站顺序');
    });
    ui.sortBy.addEventListener('change', () => {
      runtime.settings.sortBy = ui.sortBy.value;
      runtime.sortRequested = runtime.settings.sortEnabled;
      saveSettings();
      if (runtime.settings.sortEnabled) scheduleProcess('排序依据已更新');
    });
    ui.sortUpdateMode.addEventListener('change', () => {
      runtime.settings.sortUpdateMode = ui.sortUpdateMode.value;
      runtime.sortRequested = runtime.settings.sortEnabled;
      saveSettings();
      if (runtime.settings.sortEnabled) scheduleProcess('新增评论排序策略已更新');
    });

    ui.root.querySelector('#applyNow').addEventListener('click', () => {
      runtime.sortRequested = runtime.settings.sortEnabled;
      processComments('手动检测完成');
      runtime.lastSearchSummary = processSearchResults('手动搜索复核完成');
      updateUi();
    });
    ui.root.querySelector('#restorePage').addEventListener('click', disableAllAndRestore);
    ui.root.querySelector('#resetSettings').addEventListener('click', () => {
      if (!window.confirm('恢复默认设置并重新处理当前评论？')) return;
      runtime.settings = { ...DEFAULTS };
      runtime.sortRequested = false;
      applyOpacitySettings();
      stopRatioPipeline();
      stopTagPipeline();
      restoreAllComments();
      restoreAllSearchCards();
      saveSettings();
      processComments('已恢复默认设置');
      scheduleSearchProcess('已恢复搜索默认设置', 20);
    });
  }

  function getViewportSize() {
    return {
      width: Math.max(1, window.visualViewport?.width || window.innerWidth),
      height: Math.max(1, window.visualViewport?.height || window.innerHeight),
    };
  }

  function positionPanelNearLauncher() {
    const ui = runtime.ui;
    if (!ui || !runtime.settings.panelOpen || ui.panel.hidden) return;
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const launcherRect = ui.launcher.getBoundingClientRect();
    const gap = 10;
    const edge = 8;
    const aboveSpace = Math.max(0, launcherRect.top - gap - edge);
    const belowSpace = Math.max(0, viewportHeight - launcherRect.bottom - gap - edge);
    const placeAbove = aboveSpace >= belowSpace;
    const availableHeight = Math.max(120, placeAbove ? aboveSpace : belowSpace);

    ui.panel.style.maxHeight = `${Math.min(650, availableHeight)}px`;
    const panelWidth = ui.panel.offsetWidth || Math.min(360, viewportWidth - edge * 2);
    const panelHeight = ui.panel.offsetHeight || Math.min(650, availableHeight);
    const alignRight = launcherRect.left + launcherRect.width / 2 > viewportWidth / 2;
    const preferredLeft = alignRight
      ? launcherRect.right - panelWidth
      : launcherRect.left;
    const left = Math.min(
      Math.max(edge, preferredLeft),
      Math.max(edge, viewportWidth - panelWidth - edge),
    );
    const preferredTop = placeAbove
      ? launcherRect.top - gap - panelHeight
      : launcherRect.bottom + gap;
    const top = Math.min(
      Math.max(edge, preferredTop),
      Math.max(edge, viewportHeight - panelHeight - edge),
    );

    ui.panel.style.left = `${Math.round(left)}px`;
    ui.panel.style.top = `${Math.round(top)}px`;
    ui.panel.style.right = 'auto';
    ui.panel.style.bottom = 'auto';
  }

  function schedulePanelPosition() {
    if (!runtime.ui || !runtime.settings.panelOpen) return;
    window.cancelAnimationFrame(runtime.panelPositionFrame || 0);
    runtime.panelPositionFrame = window.requestAnimationFrame(() => {
      runtime.panelPositionFrame = 0;
      positionPanelNearLauncher();
    });
  }

  function applyLauncherPosition() {
    const launcher = runtime.ui?.launcher;
    if (!launcher) return;
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const width = launcher.offsetWidth || 46;
    const height = launcher.offsetHeight || 46;
    runtime.settings.launcherRight = Math.min(
      Math.max(8, runtime.settings.launcherRight),
      Math.max(8, viewportWidth - width - 8),
    );
    runtime.settings.launcherBottom = Math.min(
      Math.max(8, runtime.settings.launcherBottom),
      Math.max(8, viewportHeight - height - 8),
    );
    launcher.style.right = `${runtime.settings.launcherRight}px`;
    launcher.style.bottom = `${runtime.settings.launcherBottom}px`;
    schedulePanelPosition();
  }

  function bindLauncherDrag() {
    const launcher = runtime.ui.launcher;
    let drag = null;

    launcher.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const rect = launcher.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        originX: event.clientX,
        originY: event.clientY,
        moved: false,
      };
      launcher.setPointerCapture?.(event.pointerId);
    });

    launcher.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.originX;
      const dy = event.clientY - drag.originY;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      event.preventDefault();
      const { width: viewportWidth, height: viewportHeight } = getViewportSize();
      const width = launcher.offsetWidth || 46;
      const height = launcher.offsetHeight || 46;
      const left = Math.min(
        Math.max(8, event.clientX - drag.offsetX),
        Math.max(8, viewportWidth - width - 8),
      );
      const top = Math.min(
        Math.max(8, event.clientY - drag.offsetY),
        Math.max(8, viewportHeight - height - 8),
      );
      runtime.settings.launcherRight = Math.round(viewportWidth - left - width);
      runtime.settings.launcherBottom = Math.round(viewportHeight - top - height);
      applyLauncherPosition();
    });

    const finishDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.moved) {
        runtime.dragMoved = true;
        saveSettings();
        window.setTimeout(() => { runtime.dragMoved = false; }, 350);
      }
      launcher.releasePointerCapture?.(event.pointerId);
      drag = null;
    };
    launcher.addEventListener('pointerup', finishDrag);
    launcher.addEventListener('pointercancel', finishDrag);
    const handleViewportChange = () => applyLauncherPosition();
    window.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
  }

  function syncControl(control, property, value) {
    if (control[property] !== value) control[property] = value;
  }

  function updateUi() {
    const ui = runtime.ui;
    if (!ui) return;
    const settings = runtime.settings;
    const summary = runtime.lastSummary;
    const activeControl = ui.root.activeElement;

    syncControl(ui.panel, 'hidden', !settings.panelOpen);
    syncControl(ui.launcher, 'textContent', settings.panelOpen ? '×' : '评');
    syncControl(ui.launcher, 'title', settings.panelOpen ? '收起评论净化设置' : '打开评论净化设置');
    syncControl(ui.filterEnabled, 'checked', settings.filterEnabled);
    syncControl(ui.showFiltered, 'checked', settings.showFiltered);
    if (activeControl !== ui.commentDimOpacity) {
      syncControl(ui.commentDimOpacity, 'value', String(settings.commentDimOpacity));
    }
    if (activeControl !== ui.minChars) syncControl(ui.minChars, 'value', String(settings.minMeaningfulChars));
    if (activeControl !== ui.lowLikeThreshold) {
      syncControl(ui.lowLikeThreshold, 'value', String(settings.lowLikeThreshold));
    }
    syncControl(ui.lowLikesDirect, 'checked', settings.lowLikesDirect);
    syncControl(ui.ordinaryRuleThreshold, 'value', String(settings.ordinaryRuleThreshold));
    syncControl(ui.minLevel, 'value', String(settings.minUserLevel));
    // 面板位于 Shadow DOM 内；document.activeElement 只会得到宿主元素。
    // 使用 shadowRoot.activeElement，避免定时刷新时覆盖用户尚未输完的关键词。
    if (activeControl !== ui.keywords) syncControl(ui.keywords, 'value', settings.customKeywords);
    syncControl(ui.searchEnabled, 'checked', settings.searchEnabled);
    syncControl(ui.searchHideAds, 'checked', settings.searchHideAds);
    if (activeControl !== ui.searchDimOpacity) {
      syncControl(ui.searchDimOpacity, 'value', String(settings.searchDimOpacity));
    }
    if (activeControl !== ui.searchMinViews) {
      syncControl(ui.searchMinViews, 'value', String(settings.searchMinViews));
    }
    syncControl(ui.searchLowViewMode, 'value', settings.searchLowViewMode);
    syncControl(ui.searchLikeViewMode, 'value', settings.searchLikeViewMode);
    if (activeControl !== ui.searchMinLikeViewPercent) {
      syncControl(ui.searchMinLikeViewPercent, 'value', String(settings.searchMinLikeViewPercent));
    }
    if (activeControl !== ui.searchRatioMinViews) {
      syncControl(ui.searchRatioMinViews, 'value', String(settings.searchRatioMinViews));
    }
    syncControl(ui.searchRelevanceMode, 'value', settings.searchRelevanceMode);
    syncControl(ui.searchRelevanceSensitivity, 'value', settings.searchRelevanceSensitivity);
    syncControl(ui.searchTagReviewEnabled, 'checked', settings.searchTagReviewEnabled);
    if (activeControl !== ui.searchKeepWords) syncControl(ui.searchKeepWords, 'value', settings.searchKeepWords);
    syncControl(ui.sortEnabled, 'checked', settings.sortEnabled);
    syncControl(ui.sortBy, 'value', settings.sortBy);
    syncControl(ui.sortUpdateMode, 'value', settings.sortUpdateMode);
    syncControl(ui.sortBy, 'disabled', !settings.sortEnabled);
    syncControl(ui.sortUpdateMode, 'disabled', !settings.sortEnabled);
    [ui.showFiltered, ui.minChars, ui.lowLikeThreshold, ui.lowLikesDirect,
      ui.ordinaryRuleThreshold, ui.minLevel, ui.keywords]
      .forEach((control) => syncControl(control, 'disabled', !settings.filterEnabled));
    syncControl(
      ui.commentDimOpacity,
      'disabled',
      !settings.filterEnabled || !settings.showFiltered,
    );
    syncControl(ui.searchHideAds, 'disabled', !settings.searchEnabled);
    syncControl(ui.searchDimOpacity, 'disabled', !settings.searchEnabled);
    syncControl(ui.searchMinViews, 'disabled', !settings.searchEnabled || settings.searchLowViewMode === 'off');
    syncControl(ui.searchLowViewMode, 'disabled', !settings.searchEnabled);
    syncControl(ui.searchLikeViewMode, 'disabled', !settings.searchEnabled);
    syncControl(ui.searchMinLikeViewPercent, 'disabled', !settings.searchEnabled || settings.searchLikeViewMode === 'off');
    syncControl(ui.searchRatioMinViews, 'disabled', !settings.searchEnabled || settings.searchLikeViewMode === 'off');
    syncControl(ui.searchRelevanceMode, 'disabled', !settings.searchEnabled);
    syncControl(ui.searchRelevanceSensitivity, 'disabled', !settings.searchEnabled || settings.searchRelevanceMode === 'off');
    syncControl(ui.searchTagReviewEnabled, 'disabled', !settings.searchEnabled || settings.searchRelevanceMode === 'off');
    syncControl(ui.searchKeepWords, 'disabled', !settings.searchEnabled || settings.searchRelevanceMode === 'off');
    syncControl(ui.externalSearch, 'disabled', !isSearchPage() || !getSearchQuery());

    const sortNames = { likes: '点赞数', replies: '回复数', balanced: '综合互动' };
    const sortFlowNames = { batch: '分批不回跳', initial: '仅首批', global: '全局更新' };
    const sorting = settings.sortEnabled
      ? `重排：${sortNames[settings.sortBy]} / ${sortFlowNames[settings.sortUpdateMode]}`
      : '重排：关闭';
    const filteredLabel = settings.showFiltered ? '标淡' : '隐藏';
    syncControl(ui.status, 'textContent', summary.loaded
      ? `已发现 ${summary.loaded} 条，读取 ${summary.readable} 条；${filteredLabel} ${summary.filtered} 条${summary.reasons ? `（${summary.reasons}）` : ''}${summary.likeUnknown ? `；点赞未识别 ${summary.likeUnknown} 条` : ''}；${sorting}。${summary.reason}`
      : `尚未发现新版评论节点。请下滑到评论区；若已看到评论仍为 0，可能是 B 站页面结构已变。`);

    const search = runtime.lastSearchSummary;
    if (!isSearchPage()) {
      syncControl(ui.searchStatus, 'textContent', '当前不是搜索页；进入 search.bilibili.com 后自动处理。');
    } else if (!search.loaded) {
      syncControl(ui.searchStatus, 'textContent', `正在等待“${(search.query || getSearchQuery()).slice(0, 24)}”的搜索结果加载。`);
    } else {
      const ratioStatus = settings.searchLikeViewMode === 'off'
        ? '赞播比关闭（无接口请求）'
        : (isRatioCircuitPaused()
          ? `赞播比接口保护暂停中（约${Math.max(1, Math.ceil((runtime.ratioPausedUntil - Date.now()) / 1000))}秒后恢复）；已放行 ${search.ratioPaused || 0} 个`
          : `低赞播比 ${search.ratioLow || 0} 个；待查 ${search.ratioPending || 0} 个；样本不足 ${search.ratioSkipped || 0} 个；接口不可用 ${search.ratioUnavailable || 0} 个`);
      const sensitivityName = {
        conservative: '保守', balanced: '均衡', strict: '严格',
      }[settings.searchRelevanceSensitivity] || '保守';
      const tagStatus = !settings.searchTagReviewEnabled || settings.searchRelevanceMode === 'off'
        ? '标签复核关闭'
        : (isTagCircuitPaused()
          ? `标签接口保护暂停中；接口灰区全部放行`
          : `标签救回 ${search.tagRescued || 0} 个；待复核 ${search.tagPending || 0} 个；标签不可用并放行 ${search.tagUnavailable || 0} 个`);
      syncControl(ui.searchStatus, 'textContent', `已识别 ${search.loaded} 个结果；广告/付费课程 ${search.ads} 个；低播放 ${search.lowViews || 0} 个；智能明确无关 ${search.unrelated || 0} 个、灰区放行 ${search.uncertain || 0} 个（${sensitivityName}）；${tagStatus}；相关性白名单命中 ${search.protected || 0} 个；${ratioStatus}；播放量未识别 ${search.viewUnknown || 0} 个。`);
    }
  }

  function handleNavigation() {
    if (location.href === runtime.lastUrl) return;
    hideReasonTooltip();
    restoreOriginalOrder();
    restoreAllComments();
    restoreAllSearchCards();
    disconnectObservers();
    runtime.lastUrl = location.href;
    runtime.lastSummary = {
      loaded: 0, filtered: 0, readable: 0, likeUnknown: 0, reasons: '', reason: '页面已切换',
    };
    runtime.lastSearchSummary = {
      query: '', loaded: 0, ads: 0, lowViews: 0, viewUnknown: 0, unrelated: 0, uncertain: 0,
      tagPending: 0, tagUnavailable: 0, tagRescued: 0,
      ratioLow: 0, ratioPending: 0, ratioUnavailable: 0, ratioSkipped: 0,
      ratioPaused: 0, protected: 0, reason: '页面已切换',
    };
    setUiTab(isSearchPage() ? 'search' : 'comments');
    setupObservers();
    scheduleProcess('页面已切换', 180);
    scheduleSearchProcess('搜索页面已切换', 80);
  }

  function init() {
    createUi();
    applyOpacitySettings();
    ensureSearchStyles();
    setupObservers();
    scheduleProcess('脚本已启动', 120);
    scheduleSearchProcess('搜索净化已启动', 100);
    window.setInterval(() => {
      handleNavigation();
      if (!document.hidden) setupObservers();
    }, 1200);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        setupObservers();
        scheduleProcess('页面重新可见', 100);
        scheduleSearchProcess('搜索页重新可见', 80);
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
