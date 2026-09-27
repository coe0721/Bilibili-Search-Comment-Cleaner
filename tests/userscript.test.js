const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let source = fs.readFileSync('bilibili-search-comment-cleaner.user.js', 'utf8');
source = source.replace(
  /\}\)\(\);\s*$/u,
  `globalThis.__biliTest = {
    parseCompactCount,
    deepTextContent,
    extractDomDetails,
    getCommentData,
    meaningfulText,
    looksRepetitive,
    sanitizeSettings,
    getLowQualityReason,
    getCachedLowQualityReason,
    setFilterState,
    compareComments,
    ensureOriginalOrder,
    assignSortBatches,
    sortBatchFor,
    sortNeedsRefresh,
    captureSortSnapshots,
    applySort,
    restoreOriginalOrder,
    parseMetricCount,
    extractSearchViewCount,
    extractBvid,
    getSearchCardData,
    markSearchCardsDirty,
    assessLikeViewRatio,
    requestVideoStats,
    requestVideoTags,
    isSearchAd,
    isPaidCourseCard,
    getSearchDisplayTarget,
    normalizeSearchTerm,
    buildSearchQueryProfile,
    stringSimilarity,
    classifySearchRelevance,
    getCachedSearchRelevance,
    getCachedVideoMetadataText,
    isRatioCircuitPaused,
    noteRatioFailure,
    noteRatioSuccess,
    clearQueuedVideoStats,
    stopRatioPipeline,
    isTagCircuitPaused,
    noteTagFailure,
    noteTagSuccess,
    clearQueuedVideoTags,
    stopTagPipeline,
    saveSettings,
    syncControl,
    originalOrder,
    videoStatsCache,
    videoTagsCache,
    runtime,
    dirtyCommentThreads,
    dirtySearchCards,
  };
})();`,
);

const context = {
  console,
  setTimeout,
  clearTimeout,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  location: { href: 'https://www.bilibili.com/video/BV1test' },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
  },
  document: {
    readyState: 'loading',
    addEventListener: () => {},
  },
};
let storedSettings = null;
let lastStatsRequest = null;
let lastTagRequest = null;
context.GM_getValue = () => null;
context.GM_setValue = (key, value) => { storedSettings = { key, value }; };
context.GM_xmlhttpRequest = (options) => {
  if (options.url.includes('/x/tag/archive/tags')) {
    lastTagRequest = options;
    options.onload({
      status: 200,
      response: { code: 0, data: [{ tag_name: '芙宁娜' }, { tag_name: '原神' }, { tag_name: '芙宁娜' }] },
      responseText: '',
    });
  } else {
    lastStatsRequest = options;
    options.onload({
      status: 200,
      response: {
        code: 0,
        data: {
          tname: '知识', desc: 'Python 完整教程', dynamic: '编程学习',
          owner: { name: 'Python频道' }, pages: [{ part: '第一章' }],
          stat: { view: 2000, like: 25 },
        },
      },
      responseText: '',
    });
  }
  return { abort: () => {} };
};
context.window = context;
context.globalThis = context;
vm.runInNewContext(source, context);

const t = context.__biliTest;
assert.ok(t, 'test exports should be injected');
assert.match(source, /@version\s+0\.18\.0/u);
assert.match(source, /@name\s+B站搜索与评论净化/u);
assert.match(source, /@author\s+coe0721/u);
assert.match(source, /@updateURL\s+https:\/\/raw\.githubusercontent\.com\/coe0721\/Bilibili-Search-Comment-Cleaner\/main\/bilibili-search-comment-cleaner\.user\.js/u);
assert.match(source, /@downloadURL\s+https:\/\/raw\.githubusercontent\.com\/coe0721\/Bilibili-Search-Comment-Cleaner\/main\/bilibili-search-comment-cleaner\.user\.js/u);
assert.match(source, /class="panel-header"/u);
assert.match(source, /class="panel-body"/u);
assert.doesNotMatch(source, /id="restorePageTop"/u);
assert.match(source, /id="closePanelTop"/u);
assert.doesNotMatch(source, /\.panel-header\s*\{[^}]*position:\s*sticky/su);
assert.match(source, /\.panel-body\s*\{[^}]*overflow:\s*auto/su);
assert.equal((source.match(/<details class="advanced" open>/gu) || []).length, 3);
assert.match(source, /停用全部并恢复/u);
assert.match(source, /@media \(max-width:\s*480px\)/u);
assert.match(source, /event\.key === 'Escape'/u);
assert.match(source, /event\.composedPath\?\.\(\)/u);
assert.match(source, /function positionPanelNearLauncher\(\)/u);
assert.match(source, /offsetX:\s*event\.clientX - rect\.left/u);
assert.match(source, /offsetY:\s*event\.clientY - rect\.top/u);
assert.match(source, /launcherRect\.top - gap - panelHeight/u);
assert.match(source, /window\.visualViewport\?\.addEventListener\('resize'/u);
assert.match(source, /id="commentDimOpacity"/u);
assert.match(source, /id="searchDimOpacity"/u);
assert.match(source, /--codex-bili-comment-dim-opacity/u);
assert.match(source, /--codex-bili-search-dim-opacity/u);
const opacitySettings = t.sanitizeSettings({ commentDimOpacity: -5, searchDimOpacity: 999 });
assert.equal(opacitySettings.commentDimOpacity, 1);
assert.equal(opacitySettings.searchDimOpacity, 100);
assert.match(source, /@match\s+https:\/\/space\.bilibili\.com\/\*/u);
assert.match(source, /@match\s+https:\/\/t\.bilibili\.com\/\*/u);
assert.match(source, /sortUpdateMode:\s*'batch'/u);
assert.match(source, /标签复核中，先临时淡化/u);
assert.equal((source.match(/rootMargin:\s*'1600px 0px'/gu) || []).length, 2);
assert.match(source, /bili-comment-thread-renderer\[data-codex-bili-mode="hide"\][\s\S]*?height: 12px !important/u);
assert.doesNotMatch(
  source,
  /bili-comment-thread-renderer\[data-codex-bili-mode="hide"\]\s*\{[^}]*display:\s*none/iu,
  'hidden comments must keep a layout anchor for infinite loading',
);
assert.doesNotMatch(source, /(?:fetch\s*\(|\bXMLHttpRequest\b|WebSocket\s*\(|\beval\s*\(|new Function)/u);
assert.match(source, /@connect\s+api\.bilibili\.com/u);
assert.match(source, /GM_xmlhttpRequest\(\{[\s\S]*?anonymous:\s*true/u);
assert.match(source, /GM_xmlhttpRequest\(\{[\s\S]*?redirect:\s*'error'/u);
assert.match(source, /\/x\/tag\/archive\/tags\?bvid=/u);
assert.doesNotMatch(source, /\/x\/web-interface\/view\/detail/u, 'large detail endpoint must not be used');
assert.match(source, /scheduleSearchProcess\('点赞播放比已更新'/u);
assert.doesNotMatch(source, /scheduleProcess\('点赞播放比已更新'/u);
assert.match(source, /document\.getElementById\('i_cecream'\)[\s\S]*?document\.body/u);
assert.match(source, /characterData:\s*Boolean\(preciseContainer\)/u);
assert.match(source, /const TAG_MAX_CONCURRENCY = 4/u);
assert.match(source, /const TAG_START_GAP_MS = 200/u);
assert.match(source, /let commentDataCache = new WeakMap\(\)/u);
assert.match(source, /let searchCardDataCache = new WeakMap\(\)/u);
assert.match(source, /let ratioObservedCards = new Set\(\)/u);
assert.match(source, /let tagObservedCards = new Set\(\)/u);
assert.match(source, /commentHostObserver:\s*null/u);
assert.match(source, /setupCommentHostDiscovery\(\);/u);
assert.match(source, /function shouldWatchForCommentHosts\(\)/u);
assert.match(source, /location\.hostname === 't\.bilibili\.com'/u);
assert.doesNotMatch(source, /INITIAL_SORT_BATCH_WINDOW_MS/u);
assert.match(source, /searchObserverOptions\.attributeFilter = \['href', 'title', 'aria-label'\]/u);
assert.match(source, /commentObservers:\s*new Map\(\)/u);
assert.match(source, /for \(const host of document\.querySelectorAll\('bili-comments'\)\)/u);
assert.match(source, /data-tab-panel="comments"/u);
assert.match(source, /data-tab-panel="search"/u);
assert.match(source, /data-tab-panel="sort"/u);

assert.equal(t.parseCompactCount('1.2万'), 12000);
assert.equal(t.parseCompactCount('3亿'), 300000000);
assert.equal(t.parseCompactCount('1,234'), 1234);
assert.equal(t.parseCompactCount('2.5k'), 2500);
assert.equal(t.parseCompactCount('赞'), 0);
assert.equal(t.parseMetricCount('播放 1.2万'), 12000);
assert.equal(t.parseMetricCount('03:21'), null);

const textNode = (value) => ({ nodeType: 3, nodeValue: value });
const styleNode = { nodeType: 1, tagName: 'STYLE', childNodes: [textNode('.x{display:none}')] };
const slotNode = {
  nodeType: 1,
  tagName: 'SLOT',
  childNodes: [],
  assignedNodes: () => [textNode('插槽里的评论正文')],
};
assert.equal(t.deepTextContent({ nodeType: 11, childNodes: [styleNode, slotNode] }), '插槽里的评论正文');
const metricElement = {
  nodeType: 1,
  tagName: 'SPAN',
  childNodes: [textNode('1.2万')],
  getAttribute: (name) => name === 'title' ? '播放量' : '',
};
assert.deepEqual(
  { ...t.extractSearchViewCount({
    querySelector: (selector) => selector.includes('/video/BV')
      ? { href: 'https://www.bilibili.com/video/BV1metricTest/' }
      : metricElement,
    querySelectorAll: () => [],
  }) },
  { value: 12000, known: true },
);

let searchDomReads = 0;
const cachedTitleNode = {
  getAttribute: (name) => name === 'title' ? 'Python 缓存测试教程' : '',
  childNodes: [],
};
const cachedAuthorNode = {
  getAttribute: (name) => name === 'title' ? '缓存测试UP主' : '',
  childNodes: [],
};
const cachedVideoLink = { href: 'https://www.bilibili.com/video/BV1cacheTest/' };
const cachedSearchCard = {
  nodeType: 1,
  parentElement: null,
  matches: () => false,
  querySelector(selector) {
    searchDomReads += 1;
    if (selector.startsWith('.bili-video-card__info--tit')) return cachedTitleNode;
    if (selector.startsWith('.bili-video-card__info--author')) return cachedAuthorNode;
    if (selector === '.bili-video-card__stats--left > .bili-video-card__stats--item:first-child') {
      return metricElement;
    }
    if (selector === 'a[href*="/video/BV" i]') return cachedVideoLink;
    if (selector.includes('[data-ad]') || selector.includes('/cheese/play/')) return null;
    if (selector.startsWith('a[href*="/video/"],')) return cachedVideoLink;
    return null;
  },
  querySelectorAll: () => [],
};
const cachedSearchFirst = t.getSearchCardData(cachedSearchCard, true);
assert.equal(cachedSearchFirst.title, 'Python 缓存测试教程');
assert.equal(cachedSearchFirst.views.value, 12000);
const readsAfterFirstSearchPass = searchDomReads;
assert.equal(t.getSearchCardData(cachedSearchCard, true), cachedSearchFirst);
assert.equal(searchDomReads, readsAfterFirstSearchPass, 'stable search cards must not reread DOM');
const cachedSearchChild = {
  nodeType: 1,
  matches: () => false,
  closest: () => cachedSearchCard,
  querySelectorAll: () => [],
};
t.markSearchCardsDirty([{ target: cachedSearchChild, addedNodes: [] }]);
assert.equal(t.dirtySearchCards.has(cachedSearchCard), true);
t.getSearchCardData(cachedSearchCard, true);
assert.ok(searchDomReads > readsAfterFirstSearchPass, 'only a dirty search card should reread DOM');

const emptyCount = { nodeType: 1, tagName: 'SPAN', childNodes: [] };
const likeContainer = {
  nodeType: 1,
  tagName: 'DIV',
  childNodes: [emptyCount],
  getAttribute: () => '',
  querySelector: () => emptyCount,
};
const actionRoot = {
  querySelector: (selector) => selector.startsWith('#like,') ? likeContainer : null,
};
const contentNode = {
  nodeType: 1,
  tagName: 'DIV',
  childNodes: [textNode('零赞测试评论')],
  querySelector: () => null,
};
const levelNode = {
  getAttribute: (name) => name === 'src' ? '/user-profile/img/level_5.svg' : '',
};
const userRoot = { querySelector: () => levelNode };
const commentRoot = {
  nodeType: 11,
  childNodes: [contentNode],
  querySelector: (selector) => {
    if (selector === '#content') return contentNode;
    if (selector === 'bili-comment-action-buttons-renderer') return { shadowRoot: actionRoot };
    if (selector === 'bili-comment-user-info') return { shadowRoot: userRoot };
    return null;
  },
};
assert.deepEqual(
  { ...t.extractDomDetails({ shadowRoot: commentRoot }) },
  {
    text: '零赞测试评论', textReady: true, likes: 0, replies: 0,
    likesKnown: true, repliesKnown: false, level: 5, pinned: false,
    labelText: '零赞测试评论',
  },
);

let commentDomReads = 0;
const cachedActionRoot = { querySelector: () => null };
const cachedRendererRoot = {
  nodeType: 11,
  childNodes: [],
  querySelector(selector) {
    commentDomReads += 1;
    if (selector === 'bili-comment-action-buttons-renderer') {
      return { shadowRoot: cachedActionRoot };
    }
    return null;
  },
};
const cachedRenderer = {
  shadowRoot: cachedRendererRoot,
  __data: {
    content: { message: '缓存中的高赞评论' },
    like: 88,
    rcount: 3,
    member: { level_info: { current_level: 5 } },
  },
};
const cachedCommentThread = {
  isConnected: true,
  shadowRoot: {
    querySelector(selector) {
      commentDomReads += 1;
      return selector === 'bili-comment-renderer' ? cachedRenderer : null;
    },
  },
};
const cachedCommentFirst = t.getCommentData(cachedCommentThread);
assert.equal(cachedCommentFirst.likes, 88);
const readsAfterFirstCommentPass = commentDomReads;
assert.equal(t.getCommentData(cachedCommentThread), cachedCommentFirst);
assert.equal(commentDomReads, readsAfterFirstCommentPass, 'stable comments must not reread Shadow DOM');
t.dirtyCommentThreads.add(cachedCommentThread);
t.getCommentData(cachedCommentThread);
assert.ok(commentDomReads > readsAfterFirstCommentPass, 'only a dirty comment should reread Shadow DOM');

const oldSearchMetric = {
  nodeType: 1,
  tagName: 'SPAN',
  childNodes: [textNode('播放量 876')],
  getAttribute: () => '',
};
const oldSearchCard = {
  querySelector: (selector) => selector.includes('/video/BV')
    ? { href: 'https://www.bilibili.com/video/BV1oldMetric/' }
    : null,
  querySelectorAll: () => [oldSearchMetric],
};
assert.deepEqual(
  { ...t.extractSearchViewCount(oldSearchCard) },
  { value: 876, known: true },
);
assert.equal(
  t.extractBvid({ querySelector: () => ({ href: 'https://www.bilibili.com/video/BV1rpWjevEip/' }) }),
  'BV1rpWjevEip',
);
assert.deepEqual(
  { ...t.extractSearchViewCount({ querySelector: () => null, querySelectorAll: () => [oldSearchMetric] }) },
  { value: 0, known: false },
  'non-video course metrics must not be treated as view counts',
);
assert.equal(
  t.isPaidCourseCard({ querySelector: () => ({ href: 'https://www.bilibili.com/cheese/play/ss123' }) }),
  true,
);
assert.equal(t.assessLikeViewRatio({ views: 2000, likes: 10 }, 1, 1000).state, 'low');
assert.equal(t.assessLikeViewRatio({ views: 2000, likes: 50 }, 1, 1000).state, 'ok');
assert.equal(t.assessLikeViewRatio({ views: 500, likes: 0 }, 1, 1000).state, 'skipped');
assert.equal(t.assessLikeViewRatio({ views: 0, likes: 0 }, 1, 1000).state, 'unavailable');
assert.match(t.assessLikeViewRatio({ views: 2000, likes: 10 }, 1, 1000).reason, /0\.50%.*1\.00%/u);

const pythonProfile = t.buildSearchQueryProfile('Python 入门', 'Python=py教程\n芙宁娜=芙芙');
const relevanceCacheCard = {};
const cachedRelevanceFirst = t.getCachedSearchRelevance(
  relevanceCacheCard,
  pythonProfile,
  'Python 零基础完整教程',
  { author: '技术频道', position: 8, sensitivity: 'balanced' },
);
assert.equal(
  t.getCachedSearchRelevance(
    relevanceCacheCard,
    pythonProfile,
    'Python 零基础完整教程',
    { author: '技术频道', position: 8, sensitivity: 'balanced' },
  ),
  cachedRelevanceFirst,
  'unchanged relevance inputs must reuse the cached decision object',
);
assert.equal(t.classifySearchRelevance(pythonProfile, 'Python 零基础完整教程').unrelated, false);
assert.match(
  t.classifySearchRelevance(pythonProfile, 'Codex 从零开始教学').reason,
  /python/iu,
);
assert.equal(
  t.classifySearchRelevance(pythonProfile, 'PY教程：新手快速上手').unrelated,
  false,
  'custom keep words should protect aliases',
);
assert.equal(
  t.classifySearchRelevance(pythonProfile, 'PY教程：新手快速上手').explicitProtection,
  true,
  'a user keep word must be distinguishable as a high-priority whitelist match',
);
const unrelatedScopeFanwork = t.classifySearchRelevance(pythonProfile, '芙芙生日手书');
assert.notEqual(
  unrelatedScopeFanwork.explicitProtection,
  true,
  'query-scoped keep words must not leak into unrelated searches',
);
assert.equal(
  unrelatedScopeFanwork.state,
  'uncertain',
  'unrelated fanwork should be fail-open instead of pretending to match the Python whitelist',
);
const fanworkProfile = t.buildSearchQueryProfile('芙宁娜', '');
assert.equal(
  t.classifySearchRelevance(fanworkProfile, '芙芙生日手书').unrelated,
  false,
  'fanwork title sharing a Han character should be protected',
);
assert.notEqual(
  t.classifySearchRelevance(fanworkProfile, '芙芙生日手书').explicitProtection,
  true,
  'automatic fanwork protection must not bypass view and ratio quality rules',
);
assert.equal(
  t.classifySearchRelevance(fanworkProfile, '刻晴生日手书').unrelated,
  false,
  'fanwork and character aliases must stay in the uncertain bucket instead of being filtered',
);
assert.equal(t.classifySearchRelevance(fanworkProfile, '刻晴生日手书').state, 'uncertain');
assert.equal(
  t.classifySearchRelevance(fanworkProfile, '完全不同的数码产品评测', {
    position: 20, sensitivity: 'conservative',
  }).unrelated,
  true,
  'a late pure-Chinese result with no textual relation should be classed as clearly unrelated',
);
const opaqueRelatedTitle = '她终于卸下了伪装';
assert.equal(
  t.classifySearchRelevance(
    fanworkProfile,
    opaqueRelatedTitle,
    { position: 20, sensitivity: 'conservative' },
  ).unrelated,
  true,
  'an opaque title should reach metadata review instead of being locally rescued first',
);
const tagRescuedResult = t.classifySearchRelevance(
  fanworkProfile,
  opaqueRelatedTitle,
  { metadataText: '原神 芙宁娜 枫丹角色 二创', position: 20, sensitivity: 'conservative' },
);
assert.equal(tagRescuedResult.state, 'relevant', 'video tags should rescue a related alias title');
assert.match(tagRescuedResult.matchedBy, /视频标签\/简介/u);
assert.equal(
  t.classifySearchRelevance(
    fanworkProfile,
    '完全不同的数码产品评测',
    { metadataText: '手机 数码 开箱', position: 20, sensitivity: 'conservative' },
  ).unrelated,
  true,
  'unrelated tags must not falsely rescue a result',
);
assert.equal(
  t.classifySearchRelevance(fanworkProfile, '完全不同的数码产品评测', {
    position: 2, sensitivity: 'conservative',
  }).state,
  'uncertain',
  'top-ranked ambiguous results should fail open in conservative mode',
);
assert.equal(
  t.classifySearchRelevance(pythonProfile, 'Word 零基础教程', {
    position: 10, sensitivity: 'conservative',
  }).unrelated,
  true,
);
assert.equal(
  t.classifySearchRelevance(pythonProfile, 'Word 零基础教程', {
    position: 3, sensitivity: 'conservative',
  }).state,
  'uncertain',
);
assert.equal(
  t.classifySearchRelevance(pythonProfile, '零基础完整教程', {
    author: 'Python技术频道', position: 20, sensitivity: 'conservative',
  }).state,
  'relevant',
  'author identity is a valid local relevance signal',
);
assert.equal(t.buildSearchQueryProfile('教程', '').broadQuery, true);
assert.equal(t.classifySearchRelevance(t.buildSearchQueryProfile('教程', ''), '摄影后期').state, 'uncertain');
assert.equal(t.normalizeSearchTerm('C++ / C#'), 'cpluspluscsharp');
assert.equal(
  t.classifySearchRelevance(t.buildSearchQueryProfile('C++ 教程', ''), 'C++ 零基础入门').state,
  'relevant',
);
assert.ok(t.stringSimilarity('python', 'pyth0n') >= 0.8);

const relevanceBenchmarkTitles = Array.from({ length: 42 }, (_, index) => (
  index % 3 === 0
    ? `Python 零基础实战教程第${index}集`
    : (index % 3 === 1 ? `Word 办公软件完整教学${index}` : `编程语言入门经验分享${index}`)
));
const relevanceBenchmarkStart = performance.now();
for (let pass = 0; pass < 100; pass += 1) {
  relevanceBenchmarkTitles.forEach((title, index) => {
    t.classifySearchRelevance(pythonProfile, title, {
      author: index % 2 ? '技术学习频道' : 'Python开发者',
      position: index + 1,
      sensitivity: 'conservative',
    });
  });
}
const relevanceBenchmarkMs = performance.now() - relevanceBenchmarkStart;
assert.ok(relevanceBenchmarkMs < 1000, `local relevance benchmark was too slow: ${relevanceBenchmarkMs}ms`);

const attrs = new Map();
let attributeWrites = 0;
let attributeRemovals = 0;
const stableElement = {
  getAttribute: (name) => attrs.get(name) ?? null,
  setAttribute: (name, value) => { attributeWrites += 1; attrs.set(name, value); },
  removeAttribute: (name) => { attributeRemovals += 1; attrs.delete(name); },
};
t.runtime.settings.showFiltered = false;
t.setFilterState(stableElement, '低赞直接过滤：0赞≤1');
t.setFilterState(stableElement, '低赞直接过滤：0赞≤1');
assert.equal(attributeWrites, 2, 'same decision must not rewrite DOM attributes');
assert.equal(attrs.get('data-codex-bili-mode'), 'hide');
t.setFilterState(stableElement, null);
t.setFilterState(stableElement, null);
assert.equal(attributeRemovals, 2, 'already-clean comments must not repeat attribute removals');

let syncedValue = 'same';
let controlWrites = 0;
const stableControl = {};
Object.defineProperty(stableControl, 'value', {
  get: () => syncedValue,
  set: (value) => { controlWrites += 1; syncedValue = value; },
});
t.syncControl(stableControl, 'value', 'same');
t.syncControl(stableControl, 'value', 'changed');
t.syncControl(stableControl, 'value', 'changed');
assert.equal(controlWrites, 1, 'UI controls should only be written when their value changes');

assert.equal(t.meaningfulText('[doge] !!!'), '');
assert.equal(t.looksRepetitive('哈哈哈哈哈哈哈哈'), true);
assert.equal(t.looksRepetitive('这个观点有完整的论证过程'), false);
const baseComment = {
  text: '顶', likes: 0, replies: 0, likesKnown: true, repliesKnown: true,
  level: 3, pinned: false, upInteracted: false,
};
assert.match(t.getLowQualityReason(baseComment, []), /低赞直接过滤/u);
assert.equal(t.getLowQualityReason({ ...baseComment, likes: 20 }, []), null);
assert.match(t.getLowQualityReason({ ...baseComment, replies: 1 }, []), /低赞直接过滤/u);
assert.equal(t.getLowQualityReason({ ...baseComment, pinned: true }, []), null);
assert.equal(t.getLowQualityReason({ ...baseComment, upInteracted: true }, []), null);
assert.match(
  t.getLowQualityReason({ ...baseComment, text: '这是一条完整而且有观点的评论' }, []),
  /低赞直接过滤/u,
);
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '这是一条完整而且有观点的评论', likes: 20 }, []),
  null,
);
assert.match(
  t.getLowQualityReason({ ...baseComment, text: '这是一条完整而且有观点的评论', replies: 1 }, []),
  /低赞直接过滤/u,
);

t.runtime.settings.lowLikesDirect = false;
assert.match(
  t.getLowQualityReason({ ...baseComment, text: '这是一条完整而且有观点的评论' }, []),
  /低赞.*零回复/u,
);
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '这是一条完整而且有观点的评论', replies: 1 }, []),
  null,
);
t.runtime.settings.lowLikesDirect = true;
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '加群免费领取资源' }, []),
  '疑似广告或导流',
);
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '[图片]', likes: 128, likesKnown: true }, []),
  null,
  'engagement should protect a high-like image placeholder or short meme',
);
assert.match(
  t.getLowQualityReason({ ...baseComment, text: '[图片]', likes: 0, likesKnown: true }, []),
  /仅表情或符号/u,
  'a zero-like image placeholder can still be filtered as low information',
);
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '请戳我领取编程资料和PDF电子书', pinned: true }, []),
  '疑似广告或导流',
  'clear resource-claim promotion must remain a hard rule even when pinned',
);
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '跪求资料666', likes: 152 }, []),
  null,
);
assert.match(
  t.getLowQualityReason({ ...baseComment, text: '这是一段自定义屏蔽内容', likes: 999 }, ['屏蔽']),
  /自定义关键词/u,
);

t.runtime.settings.minUserLevel = 3;
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '这是一条完整评论', likes: 20, level: 2 }, []),
  null,
  'high engagement should outweigh generic zero-reply and short-text signals',
);
assert.equal(
  t.getLowQualityReason({ ...baseComment, text: '这是一条完整评论', likes: 20, level: null }, []),
  null,
);
assert.equal(
  t.getLowQualityReason({
    ...baseComment,
    text: '这是一条完整评论', likes: 20, level: 2, repliesKnown: false,
  }, []),
  null,
  'unknown reply count must not be treated as zero replies',
);

t.runtime.settings.sortBy = 'likes';
t.runtime.settings.sortUpdateMode = 'global';
const firstThread = {};
const secondThread = {};
t.originalOrder.set(firstThread, 0);
t.originalOrder.set(secondThread, 1);
assert.ok(t.compareComments(
  { thread: firstThread, pinned: false, likes: 5, replies: 2 },
  { thread: secondThread, pinned: false, likes: 30, replies: 0 },
) > 0, 'higher-like comment should sort first');
assert.ok(t.compareComments(
  { thread: firstThread, pinned: true, likes: 0, replies: 0 },
  { thread: secondThread, pinned: false, likes: 999, replies: 999 },
) < 0, 'pinned comment should stay first');
assert.ok(t.compareComments(
  { thread: firstThread, pinned: false, likes: 30, replies: 0 },
  { thread: secondThread, pinned: false, likes: 30, replies: 999 },
) < 0, 'equal-like comments must keep Bilibili original order');

const autoSortParent = {};
const autoSortThreadA = { parentElement: autoSortParent };
const autoSortThreadB = { parentElement: autoSortParent };
const autoSortComments = [
  { thread: autoSortThreadA, likes: 2, likesKnown: true, replies: 0, repliesKnown: true, pinned: false },
  { thread: autoSortThreadB, likes: 30, likesKnown: true, replies: 1, repliesKnown: true, pinned: false },
];
t.runtime.sortRequested = false;
assert.equal(t.sortNeedsRefresh(autoSortComments), true, 'the first loaded comment batch must be sorted');
t.captureSortSnapshots(autoSortComments);
assert.equal(t.sortNeedsRefresh(autoSortComments), false, 'an unchanged comment batch must not keep re-sorting');
const autoSortThreadC = { parentElement: autoSortParent };
const withNewComment = [...autoSortComments, {
  thread: autoSortThreadC, likes: 80, likesKnown: true, replies: 2, repliesKnown: true, pinned: false,
}];
assert.equal(t.sortNeedsRefresh(withNewComment), true, 'a newly loaded comment must trigger one automatic re-sort');
t.captureSortSnapshots(withNewComment);
withNewComment[2].likes = 120;
assert.equal(t.sortNeedsRefresh(withNewComment), true, 'like hydration just after insertion must refresh the order');

function createFakeStyle() {
  const values = new Map();
  const priorities = new Map();
  let writes = 0;
  return {
    get writes() { return writes; },
    getPropertyValue: (name) => values.get(name) || '',
    getPropertyPriority: (name) => priorities.get(name) || '',
    setProperty: (name, value, priority = '') => {
      writes += 1;
      values.set(name, String(value));
      priorities.set(name, priority);
    },
    removeProperty: (name) => {
      values.delete(name);
      priorities.delete(name);
    },
  };
}
const cssSortParent = { children: [], style: createFakeStyle(), isConnected: true };
const cssThreadLow = { parentElement: cssSortParent, style: createFakeStyle(), isConnected: true };
const cssThreadHigh = { parentElement: cssSortParent, style: createFakeStyle(), isConnected: true };
cssSortParent.children.push(cssThreadLow, cssThreadHigh);
const cssComments = [
  { thread: cssThreadLow, likes: 3, likesKnown: true, replies: 0, repliesKnown: true, pinned: false },
  { thread: cssThreadHigh, likes: 90, likesKnown: true, replies: 0, repliesKnown: true, pinned: false },
];
t.ensureOriginalOrder(cssComments);
t.applySort(cssComments);
assert.equal(cssThreadHigh.style.getPropertyValue('order'), '-100000');
assert.equal(cssThreadLow.style.getPropertyValue('order'), '-99999');
const stableSortWrites = cssSortParent.style.writes + cssThreadLow.style.writes + cssThreadHigh.style.writes;
t.applySort(cssComments);
assert.equal(
  cssSortParent.style.writes + cssThreadLow.style.writes + cssThreadHigh.style.writes,
  stableSortWrites,
  'reapplying an unchanged order must not rewrite layout styles',
);
const cssThreadNewest = { parentElement: cssSortParent, style: createFakeStyle(), isConnected: true };
cssSortParent.children.push(cssThreadNewest);
const cssCommentsWithNewHigh = [...cssComments, {
  thread: cssThreadNewest, likes: 300, likesKnown: true, replies: 0, repliesKnown: true, pinned: false,
}];
t.ensureOriginalOrder(cssCommentsWithNewHigh);
assert.equal(t.sortNeedsRefresh(cssCommentsWithNewHigh), true);
t.applySort(cssCommentsWithNewHigh);
assert.equal(cssThreadNewest.style.getPropertyValue('order'), '-100000');
assert.equal(cssThreadHigh.style.getPropertyValue('order'), '-99999');
t.restoreOriginalOrder();
assert.equal(cssThreadNewest.style.getPropertyValue('order'), '');

// 默认的分批模式：后加载的高赞评论只在新批次中靠前，不会跳到已读的首批之前。
const batchParent = { children: [], style: createFakeStyle(), isConnected: true };
const batchOldLow = { parentElement: batchParent, style: createFakeStyle(), isConnected: true };
const batchOldHigh = { parentElement: batchParent, style: createFakeStyle(), isConnected: true };
batchParent.children.push(batchOldLow, batchOldHigh);
const batchInitialComments = [
  { thread: batchOldLow, likes: 2, likesKnown: true, replies: 0, repliesKnown: true, pinned: false },
  { thread: batchOldHigh, likes: 80, likesKnown: true, replies: 0, repliesKnown: true, pinned: false },
];
t.runtime.settings.sortUpdateMode = 'batch';
t.ensureOriginalOrder(batchInitialComments);
t.assignSortBatches(batchInitialComments, 1000);
t.applySort(batchInitialComments);
assert.equal(batchOldHigh.style.getPropertyValue('order'), '-100000');
const batchNewLow = { parentElement: batchParent, style: createFakeStyle(), isConnected: true };
const batchNewHigh = { parentElement: batchParent, style: createFakeStyle(), isConnected: true };
batchParent.children.push(batchNewLow, batchNewHigh);
const batchAllComments = [
  ...batchInitialComments,
  { thread: batchNewLow, likes: 1, likesKnown: true, replies: 0, repliesKnown: true, pinned: false },
  { thread: batchNewHigh, likes: 999, likesKnown: true, replies: 0, repliesKnown: true, pinned: false },
];
t.ensureOriginalOrder(batchAllComments);
t.assignSortBatches(batchAllComments, 4000);
assert.equal(t.sortBatchFor(batchAllComments[2]), 1);
assert.equal(t.sortBatchFor(batchAllComments[3]), 1);
t.applySort(batchAllComments);
assert.equal(batchOldHigh.style.getPropertyValue('order'), '-100000');
assert.equal(batchOldLow.style.getPropertyValue('order'), '-99999');
assert.equal(batchNewHigh.style.getPropertyValue('order'), '-99998');
assert.equal(batchNewLow.style.getPropertyValue('order'), '-99997');

// “仅首批”模式保留后来评论的 B站加载顺序；“全局更新”则允许新高赞到最前。
t.runtime.settings.sortUpdateMode = 'initial';
t.applySort(batchAllComments);
assert.equal(batchNewLow.style.getPropertyValue('order'), '-99998');
assert.equal(batchNewHigh.style.getPropertyValue('order'), '-99997');
t.runtime.settings.sortUpdateMode = 'global';
t.applySort(batchAllComments);
assert.equal(batchNewHigh.style.getPropertyValue('order'), '-100000');
t.restoreOriginalOrder();
t.runtime.settings.sortUpdateMode = 'batch';

// 一旦首批已建立，即使下一批很快出现也不能并回首批；整批节点替换则重新视为首批。
const rapidParent = { children: [] };
const rapidOldThread = { parentElement: rapidParent };
const rapidOld = [{
  thread: rapidOldThread, likes: 2, likesKnown: true, replies: 0, repliesKnown: true, pinned: false,
}];
t.assignSortBatches(rapidOld, 1000);
const rapidNewThread = { parentElement: rapidParent };
const rapidWithNew = [...rapidOld, {
  thread: rapidNewThread, likes: 999, likesKnown: true, replies: 0, repliesKnown: true, pinned: false,
}];
t.assignSortBatches(rapidWithNew, 1100);
assert.equal(t.sortBatchFor(rapidWithNew[1]), 1, 'rapid additions must not merge back into the initial batch');
const rebuiltThread = { parentElement: rapidParent };
const rebuiltComments = [{
  thread: rebuiltThread, likes: 50, likesKnown: true, replies: 0, repliesKnown: true, pinned: false,
}];
t.assignSortBatches(rebuiltComments, 1200);
assert.equal(t.sortBatchFor(rebuiltComments[0]), 0, 'a wholesale DOM rebuild must start a fresh initial batch');
t.restoreOriginalOrder();

t.saveSettings();
assert.ok(storedSettings?.key?.includes('settings:v1'));
assert.equal(storedSettings.value, t.runtime.settings);

t.runtime.ratioFailureStreak = 0;
t.runtime.ratioPausedUntil = 0;
t.runtime.ratioQueue.push('BVqueued');
t.runtime.ratioQueued.add('BVqueued');
t.videoStatsCache.set('BVqueued', { state: 'queued', expiresAt: 0 });
t.noteRatioFailure(new Error('failure 1'));
t.noteRatioFailure(new Error('failure 2'));
assert.equal(t.isRatioCircuitPaused(), false);
t.noteRatioFailure(new Error('failure 3'));
assert.equal(t.isRatioCircuitPaused(), true, 'three consecutive failures must open the circuit');
assert.equal(t.runtime.ratioQueue.length, 0, 'opening the circuit must clear queued requests');
assert.equal(t.videoStatsCache.has('BVqueued'), false, 'queued cache placeholders must be cleared');
const ratioPausedUntil = t.runtime.ratioPausedUntil;
t.noteRatioSuccess();
assert.equal(t.runtime.ratioPausedUntil, ratioPausedUntil, 'an in-flight success must not close an open circuit');
t.runtime.ratioPausedUntil = 0;
t.noteRatioSuccess();
assert.equal(t.isRatioCircuitPaused(), false, 'success resets the failure streak after the pause has ended');
let ratioObserverDisconnected = false;
t.runtime.ratioActive = 2;
t.runtime.ratioNextStartAt = 9999;
t.runtime.ratioObserver = { disconnect: () => { ratioObserverDisconnected = true; } };
const ratioGenerationBeforeStop = t.runtime.ratioGeneration;
t.stopRatioPipeline();
assert.equal(ratioObserverDisconnected, true);
assert.equal(t.runtime.ratioGeneration, ratioGenerationBeforeStop + 1);
assert.equal(t.runtime.ratioActive, 0);
assert.equal(t.runtime.ratioNextStartAt, 0);

t.runtime.tagFailureStreak = 0;
t.runtime.tagPausedUntil = 0;
t.runtime.tagQueue.push('BVtagQueued');
t.runtime.tagQueued.add('BVtagQueued');
t.videoTagsCache.set('BVtagQueued', { state: 'queued', expiresAt: 0 });
t.noteTagFailure(new Error('failure 1'));
t.noteTagFailure(new Error('failure 2'));
assert.equal(t.isTagCircuitPaused(), false);
t.noteTagFailure(new Error('failure 3'));
assert.equal(t.isTagCircuitPaused(), true, 'three tag failures must open the tag circuit');
assert.equal(t.runtime.tagQueue.length, 0);
assert.equal(t.videoTagsCache.has('BVtagQueued'), false);
const tagPausedUntil = t.runtime.tagPausedUntil;
t.noteTagSuccess();
assert.equal(t.runtime.tagPausedUntil, tagPausedUntil, 'an in-flight tag success must not close an open circuit');
t.runtime.tagPausedUntil = 0;
t.noteTagSuccess();
assert.equal(t.isTagCircuitPaused(), false);
let tagObserverDisconnected = false;
t.runtime.tagActive = 2;
t.runtime.tagNextStartAt = 9999;
t.runtime.tagObserver = { disconnect: () => { tagObserverDisconnected = true; } };
const tagGenerationBeforeStop = t.runtime.tagGeneration;
t.stopTagPipeline();
assert.equal(tagObserverDisconnected, true);
assert.equal(t.runtime.tagGeneration, tagGenerationBeforeStop + 1);
assert.equal(t.runtime.tagActive, 0);
assert.equal(t.runtime.tagNextStartAt, 0);

const reloadContext = {
  console,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  location: { href: 'https://www.bilibili.com/video/BV1test' },
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { readyState: 'loading', addEventListener: () => {} },
  GM_getValue: () => storedSettings.value,
  GM_setValue: () => {},
};
reloadContext.window = reloadContext;
reloadContext.globalThis = reloadContext;
vm.runInNewContext(source, reloadContext);
assert.equal(reloadContext.__biliTest.runtime.settings.minUserLevel, 3);
assert.equal(reloadContext.__biliTest.runtime.settings.sortBy, 'likes');
assert.equal(reloadContext.__biliTest.runtime.settings.sortUpdateMode, 'batch');
assert.equal(reloadContext.__biliTest.runtime.settings.lowLikeThreshold, 1);
assert.equal(reloadContext.__biliTest.runtime.settings.lowLikesDirect, true);
assert.equal(reloadContext.__biliTest.runtime.settings.ordinaryRuleThreshold, 2);
assert.equal(reloadContext.__biliTest.runtime.settings.commentDimOpacity, 7);
assert.equal(reloadContext.__biliTest.runtime.settings.searchMinViews, 1000);
assert.equal(reloadContext.__biliTest.runtime.settings.searchDimOpacity, 7);
assert.equal(reloadContext.__biliTest.runtime.settings.searchLowViewMode, 'dim');
assert.equal(reloadContext.__biliTest.runtime.settings.searchLikeViewMode, 'off');
assert.equal(reloadContext.__biliTest.runtime.settings.searchMinLikeViewPercent, 1);
assert.equal(reloadContext.__biliTest.runtime.settings.searchRatioMinViews, 1000);
assert.equal(reloadContext.__biliTest.runtime.settings.searchRelevanceMode, 'dim');
assert.equal(reloadContext.__biliTest.runtime.settings.searchRelevanceSensitivity, 'balanced');
assert.equal(reloadContext.__biliTest.runtime.settings.searchTagReviewEnabled, true);
assert.equal(reloadContext.__biliTest.runtime.settings.tagAutoVersion, 1);
assert.equal(reloadContext.__biliTest.runtime.settings.searchTuningVersion, 1);
assert.equal(reloadContext.__biliTest.runtime.settings.sortEnabled, true);
assert.equal(reloadContext.__biliTest.runtime.settings.sortAutoVersion, 1);
assert.equal(reloadContext.__biliTest.runtime.settings.sortFlowVersion, 1);
assert.equal(reloadContext.__biliTest.runtime.settings.searchKeepWords, '');
assert.equal(reloadContext.__biliTest.runtime.settings.stabilityVersion, 2);
assert.equal('searchLowRelevance' in reloadContext.__biliTest.runtime.settings, false);

const migrationContext = {
  console,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  location: { href: 'https://search.bilibili.com/all?keyword=test' },
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { readyState: 'loading', addEventListener: () => {} },
  GM_getValue: () => ({ searchLowRelevance: 'hide', searchStrictness: 'strict', sortEnabled: true }),
  GM_setValue: () => {},
};
migrationContext.window = migrationContext;
migrationContext.globalThis = migrationContext;
vm.runInNewContext(source, migrationContext);
assert.equal('searchLowRelevance' in migrationContext.__biliTest.runtime.settings, false);
assert.equal(migrationContext.__biliTest.runtime.settings.sortEnabled, true);
assert.equal(migrationContext.__biliTest.runtime.settings.sortUpdateMode, 'batch');
assert.equal(migrationContext.__biliTest.runtime.settings.searchRelevanceMode, 'dim');
assert.equal(migrationContext.__biliTest.runtime.settings.searchRelevanceSensitivity, 'balanced');
assert.equal(migrationContext.__biliTest.runtime.settings.searchTagReviewEnabled, true);
assert.equal(migrationContext.__biliTest.runtime.settings.stabilityVersion, 2);

const disabledTagContext = {
  console,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  location: { href: 'https://search.bilibili.com/all?keyword=test' },
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { readyState: 'loading', addEventListener: () => {} },
  GM_getValue: () => ({
    searchTagReviewEnabled: false,
    tagAutoVersion: 1,
    searchTuningVersion: 1,
    stabilityVersion: 2,
  }),
  GM_setValue: () => {},
};
disabledTagContext.window = disabledTagContext;
disabledTagContext.globalThis = disabledTagContext;
vm.runInNewContext(source, disabledTagContext);
assert.equal(
  disabledTagContext.__biliTest.runtime.settings.searchTagReviewEnabled,
  false,
  'after the one-time v0.11 migration, manually disabling tag review must persist',
);

const disabledSortContext = {
  console,
  Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
  location: { href: 'https://www.bilibili.com/video/BV1test' },
  localStorage: { getItem: () => null, setItem: () => {} },
  document: { readyState: 'loading', addEventListener: () => {} },
  GM_getValue: () => ({
    sortEnabled: false,
    sortAutoVersion: 1,
    tagAutoVersion: 1,
    searchTuningVersion: 1,
    stabilityVersion: 2,
  }),
  GM_setValue: () => {},
};
disabledSortContext.window = disabledSortContext;
disabledSortContext.globalThis = disabledSortContext;
vm.runInNewContext(source, disabledSortContext);
assert.equal(
  disabledSortContext.__biliTest.runtime.settings.sortEnabled,
  false,
  'after the one-time v0.12 migration, manually disabling automatic sorting must persist',
);

Promise.all([
  t.requestVideoStats('BV1requestTest'),
  t.requestVideoTags('BV1tagTest'),
]).then(([stats, tags]) => {
  assert.equal(stats.views, 2000);
  assert.equal(stats.likes, 25);
  assert.equal(stats.metadata.category, '知识');
  assert.equal(stats.metadata.description, 'Python 完整教程');
  assert.deepEqual(Array.from(stats.metadata.parts), ['第一章']);
  assert.equal(lastStatsRequest.anonymous, true);
  assert.equal(lastStatsRequest.method, 'GET');
  assert.equal(lastStatsRequest.redirect, 'error');
  assert.match(lastStatsRequest.url, /^https:\/\/api\.bilibili\.com\/x\/web-interface\/view\?bvid=BV1requestTest$/u);
  assert.deepEqual(Array.from(tags), ['芙宁娜', '原神']);
  assert.equal(lastTagRequest.anonymous, true);
  assert.equal(lastTagRequest.method, 'GET');
  assert.equal(lastTagRequest.redirect, 'error');
  assert.match(lastTagRequest.url, /^https:\/\/api\.bilibili\.com\/x\/tag\/archive\/tags\?bvid=BV1tagTest$/u);

  t.videoStatsCache.set('BV1metadataTest', {
    state: 'ok', stats, expiresAt: Date.now() + 1000,
  });
  assert.match(t.getCachedVideoMetadataText('BV1metadataTest', tags), /芙宁娜.*知识.*Python 完整教程/u);
  console.log(`userscript logic tests passed; 4200 local relevance decisions: ${relevanceBenchmarkMs.toFixed(1)}ms`);
});
