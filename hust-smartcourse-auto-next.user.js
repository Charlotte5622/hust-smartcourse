// ==UserScript==
// @name         HUST SmartCourse 自动连播下一节
// @name:en      HUST SmartCourse Auto Next
// @namespace    https://github.com/Charlotte5622/hust-smartcourse
// @version      1.7.1
// @description  超星/智慧课程视频播完后自动点击目录里的下一节，支持顺序连播、跨 iframe 目录识别、防多跳
// @author       Charlotte5622
// @homepageURL  https://github.com/Charlotte5622/hust-smartcourse
// @supportURL   https://github.com/Charlotte5622/hust-smartcourse/issues
// @downloadURL  https://raw.githubusercontent.com/Charlotte5622/hust-smartcourse/main/hust-smartcourse-auto-next.user.js
// @updateURL    https://raw.githubusercontent.com/Charlotte5622/hust-smartcourse/main/hust-smartcourse-auto-next.user.js
// @match        *://smartcourse.hust.edu.cn/*
// @match        *://*.hust.edu.cn/*
// @match        *://*.chaoxing.com/*
// @match        *://*.chaoxing.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ==================================================================
   *  可调参数（改完保存，刷新页面即可生效）
   * ================================================================== */
  const CFG = {
    delayBeforeNext : 3000,  // 视频结束后等多久(ms)再切换：给平台上报"任务点完成"留时间
    switchCooldown  : 8000,  // 两次自动切换的最小间隔(ms)，防止重复触发导致连跳多节
    skipCompleted   : false, // ★顺序播放（默认）：严格按目录顺序，一节都不跳
                             //   改成 true 才会跳过绿勾（已完成）的章节
    skipNonVideo    : true,  // ★自动跳过章节测验/作业等非视频任务点（只跳过，不代答）
    nonVideoWaitMs  : 6000,  // 点进去后等多久判断任务点类型，超时则视为无法识别
    contentSettleMs : 1500,  // 点击后等 iframe 换完内容再判断类型
    maxHopsPerStep  : 10,    // 一次连播最多连续跳过几个非视频节点
    autoPlay        : true,  // 切换章节后，尝试自动点播放
    muteIfBlocked   : false, // 自动播放被浏览器拦截时，是否静音后重试（true 可能会静音播放）
    clickPopups     : true,  // 自动点掉"继续学习 / 下一节"之类的平台弹窗
    silencePlayerBug: true,  // 屏蔽超星播放器自身的 thumbnailsArray[...].picUrl 报错（只影响缩略图预览，无害）
    pollInterval    : 1500,  // 扫描视频元素的间隔(ms)
    debug           : true,  // 控制台输出日志
  };

  const TAG = '%c[自动连播]';
  const CSS = 'color:#2d8cf0;font-weight:bold';
  const log  = (...a) => CFG.debug && console.log(TAG, CSS, ...a);
  const warn = (...a) => console.warn(TAG, CSS, ...a);

  // 是否是顶层窗口（目录、URL 都在顶层）
  const IS_TOP = (() => { try { return window.top === window.self; } catch (e) { return false; } })();

  let enabled      = true;   // 总开关
  let switching    = false;  // 正在切换中
  let lastSwitchAt = 0;      // 上次成功切换的时间戳
  let switchCount  = 0;      // 本次打开页面后自动切换的次数
  let retryTimer   = null;   // 冷却期结束后的一次性重试
  const skippedQuizzes = []; // 本次被自动跳过的测验/作业（只记录，不代答）

  /* ==================================================================
   *  通用工具
   * ================================================================== */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function text(el) {
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  async function waitFor(fn, timeout = 8000, step = 300) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v && (!(v instanceof Array) || v.length)) return v;
      if (Date.now() - t0 > timeout) return v;
      await sleep(step);
    }
  }

  // 顶层 URL 中的 chapterId（每次实时读取：切换章节时 URL 会变，不能缓存）
  function currentChapterId() {
    const href = (IS_TOP ? location.href : (document.referrer || location.href));
    const m = href.match(/chapterId=(\d+)/i);
    return m ? m[1] : null;
  }

  /* ==================================================================
   *  0. 过滤超星播放器自身的老 bug
   *  showHTML5Player 里按序号取 thumbnailsArray[i].picUrl，元数据数组不够长就越界，
   *  每加载一次视频报一次。只影响进度条缩略图预览，不影响播放/计时/上报。
   *  这里只拦这一条，其他错误照常显示。
   * ================================================================== */
  function installPlayerBugFilter() {
    if (!CFG.silencePlayerBug) return;
    window.addEventListener('error', (e) => {
      const msg = String((e && (e.message || (e.error && e.error.message))) || '');
      if (/picUrl|thumbnailsArray/i.test(msg)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  /* ==================================================================
   *  一、视频监听：捕获"播放结束"
   * ================================================================== */
  function bindVideo(v) {
    if (!v || v.__autoNextBound) return;
    v.__autoNextBound = true;
    log('已绑定视频元素', v);

    const fire = (reason) => {
      const now = Date.now();
      if (v.__autoNextLastFire && now - v.__autoNextLastFire < 5000) return; // 去重
      v.__autoNextLastFire = now;

      if (IS_TOP) handleEnded(reason);
      else notifyTop(reason);
    };

    const remain = () => (v.duration && isFinite(v.duration) ? v.duration - v.currentTime : Infinity);
    const nearEnd = () => v.currentTime > 1 && remain() <= 0.8;

    // 1) 标准结束事件
    v.addEventListener('ended', () => fire('ended 事件'));

    // 2) 兜底：进度到达片尾（有的播放器不派发 ended）
    v.addEventListener('timeupdate', () => {
      if (v.seeking) return;
      if (nearEnd() || (!v.paused && remain() <= 1.2)) fire('进度到达片尾');
    });

    // 3) 兜底：有的播放器在片尾直接 pause 住，不派发 ended
    v.addEventListener('pause', () => { if (nearEnd()) fire('片尾暂停'); });

    v.addEventListener('playing', () => setStatus('播放中：' + (findChapterTitle() || '')));
    v.addEventListener('pause',   () => { if (!v.ended) setStatus('已暂停'); });
  }

  function notifyTop(reason) {
    try { window.top.postMessage({ __autoNext: true, type: 'VIDEO_ENDED', reason }, '*'); } catch (e) {}
  }

  // 递归查找同源 iframe 里的 video
  function deepCollectVideos(win, out, depth) {
    if (depth > 6) return;
    try {
      win.document.querySelectorAll('video').forEach((v) => out.push(v));
      win.document.querySelectorAll('iframe').forEach((f) => {
        try {
          if (f.contentWindow && f.contentDocument) deepCollectVideos(f.contentWindow, out, depth + 1);
        } catch (e) { /* 跨域，忽略：由子帧自己的脚本负责上报 */ }
      });
    } catch (e) {}
  }

  function scanVideos() {
    const vids = [];
    if (IS_TOP) deepCollectVideos(window, vids, 0);
    else vids.push(...document.querySelectorAll('video'));
    vids.forEach(bindVideo);
    if (!enabled) return;
    // 切换后如果视频还没起来，尝试自动播放
    if (pendingAutoplay > 0 && vids.length) {
      vids.forEach((v) => {
        if (v.__autoNextBound && v.paused && !v.ended) {
          pendingAutoplay--;
          tryPlay(v);
        }
      });
    }
  }

  let pendingAutoplay = 0;

  function tryPlay(v) {
    if (!CFG.autoPlay) return;
    const p = v.play();
    if (p && p.catch) {
      p.then(() => log('自动播放成功')).catch((err) => {
        if (CFG.muteIfBlocked && !v.muted) {
          v.muted = true;
          v.play().then(() => log('静音后自动播放成功')).catch(() => {});
        } else {
          log('自动播放被浏览器拦截（属于正常现象，点一下播放键即可）：', err && err.name);
        }
      });
    }
  }

  // 当前是否真的还有视频停在片尾（防止"用户已经手动续播/平台已切走"时误跳）
  function anyVideoAtEnd() {
    const vids = [];
    deepCollectVideos(window, vids, 0);
    return vids.some((v) => v.ended || (v.duration && isFinite(v.duration) && v.duration - v.currentTime <= 1.5));
  }

  /* ==================================================================
   *  二、播放结束后的主流程
   * ================================================================== */
  async function handleEnded(reason) {
    if (!IS_TOP || !enabled) return;
    if (switching) return;

    const now = Date.now();
    if (now - lastSwitchAt < CFG.switchCooldown) {
      const wait = CFG.switchCooldown - (now - lastSwitchAt);
      log(`冷却中（还需 ${Math.round(wait / 1000)} 秒），稍后确认一次`);
      if (!retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; handleEnded('冷却结束后复查'); }, wait + 300);
      }
      return;
    }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    switching = true;
    const beforeId = currentChapterId();
    try {
      log(`检测到视频结束（${reason}），${CFG.delayBeforeNext}ms 后切换下一节…`);
      setStatus('视频已结束，准备切换下一节…');
      await sleep(CFG.delayBeforeNext);

      // 平台自己已经跳走了，就不要重复点
      if (currentChapterId() !== beforeId) {
        log('平台已自动切换章节，跳过本次操作');
        setStatus('平台已自动切换');
        return;
      }

      // 这 3 秒里用户手动续播了 / 视频不处于片尾了 → 取消
      if (!anyVideoAtEnd()) {
        log('视频已不在片尾（可能被手动续播），取消本次跳转');
        setStatus('已取消跳转');
        return;
      }

      // 关弹窗（只点"继续观看"这类纯关闭按钮）；点完必须复查，防止平台按钮自己把章节切走了
      if (CFG.clickPopups) {
        const beforePop = currentChapterId();
        if (clickPopups()) {
          log('已关闭平台弹窗');
          await sleep(800);
          if (currentChapterId() !== beforePop) {
            log('弹窗按钮已经把章节切走了 → 本次不再点击目录，避免一次跳两节');
            lastSwitchAt = Date.now();
            setStatus('平台已切换，跳过本次自动跳转');
            pendingAutoplay = 4;
            return;
          }
        }
      }

      const ok = await goNextChapter();
      if (ok) {
        switchCount++;
        const gap = lastSwitchAt ? Math.round((Date.now() - lastSwitchAt) / 1000) : 0;
        lastSwitchAt = Date.now();
        setStatus(`已切换到下一节（本次共 ${switchCount} 次）`);
        log(`切换成功，本次打开页面第 ${switchCount} 次自动跳转` + (gap ? `，距上次 ${gap} 秒` : ''));
        if (gap && gap < 15) warn(`⚠️ 两次跳转只隔了 ${gap} 秒，如果内容被跳过请把 skipCompleted 设为 false`);
        pendingAutoplay = 4;   // 稍后尝试自动播放几次
      } else {
        setStatus('没找到下一个任务点，请检查目录是否加载');
        warn('没有找到可切换的下一节：可能是目录还没加载、或已经学到最后一节了');
      }
    } catch (e) {
      warn('切换过程出错：', e);
    } finally {
      switching = false;
    }
  }

  /* ==================================================================
   *  三、从右侧「目录」里找下一节并点击
   * ================================================================== */
  function attrString(el) {
    const keys = ['onclick', 'href', 'id', 'data-chapterid', 'data-chapter-id', 'data-id', 'data-url', 'data-href'];
    const buf = [];
    keys.forEach((k) => {
      const v = el.getAttribute && el.getAttribute(k);
      if (v) buf.push(v);
    });
    return buf.join(' ');
  }

  // 只认这些"看得见、点得动"的标签，避免把 <link href=".../studentStudy.css"> 这类资源当成章节
  const CLICKABLE_TAGS = /^(A|SPAN|DIV|LI|DD|DT|P|TD|B|I|EM|STRONG|BUTTON|LABEL|SECTION|ARTICLE|H1|H2|H3|H4)$/;

  function isChapterCandidate(el) {
    if (!CLICKABLE_TAGS.test(el.tagName)) return false;
    if (el.closest && el.closest('#auto-next-panel')) return false;
    const s = attrString(el);
    if (!s) return false;
    if (/chapterId=\d+/i.test(s)) return true;                                  // ?chapterId=xxx
    if (/getTeacherAjax\s*\(/i.test(s)) return true;                            // 超星经典目录
    if (/(toChapter|selectChapter|changeChapter|chapterClick|studyChapter)\s*\(/i.test(s)) return true;
    if (/\/mycourse\/studentstudy/i.test(s) && !/\.(css|js)(\?|$)/i.test(s)) return true; // 学习页链接
    return false;
  }

  // 收集所有同源 document（顶层 + 各层 iframe）
  // 超星新版的「目录」面板本身就是 iframe（如 .../mooc-ans/knowledge/cards?clazzid=...）
  function sameOriginDocs() {
    const docs = [];
    (function walk(doc, depth) {
      if (!doc || depth > 5 || docs.indexOf(doc) >= 0) return;
      docs.push(doc);
      let frames = [];
      try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { return; }
      frames.forEach((f) => {
        try { if (f.contentDocument) walk(f.contentDocument, depth + 1); } catch (e) {}
      });
    })(document, 0);
    return docs;
  }

  // 取章节标题：优先取"名字"元素的文本，并去掉末尾的"未完成任务点"计数角标
  // （目录行里除了章节名，还有个橙色数字角标，直接取整行文本会拖一个数字尾巴）
  function nodeTitle(el) {
    let nameEl = null;
    if (el.matches && el.matches('[class*="name"], [class*="title"]')) nameEl = el;
    if (!nameEl && el.querySelector) nameEl = el.querySelector('[class*="name"], [class*="title"]');
    const row = el.closest && el.closest('.chapter_item, li, tr, .catalog_points, .posCatalog_select, .card');
    const raw = text(nameEl) || text(el) || text(row) || '';
    const cleaned = raw.replace(/\s+\d{1,2}$/, '').trim();
    return (cleaned || raw).slice(0, 60);
  }

  function collectFromDoc(doc) {
    let all = [];
    try { all = Array.from(doc.querySelectorAll('[onclick],[href],[data-chapterid],[data-chapter-id]')); } catch (e) { return []; }
    const cand = all.filter(isChapterCandidate);
    if (!cand.length) return [];
    // 只保留最内层的可点元素
    const leaves = cand.filter((el) => !cand.some((o) => o !== el && el.contains(o)));

    const out = [];
    const seen = new Set();
    leaves.forEach((el) => {
      const title = nodeTitle(el);
      const key = el.tagName + '|' + (el.id || '') + '|' + title + '|' + (el.getAttribute('onclick') || '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ el, title, ids: extractIds(el), doc });
    });
    return out;
  }

  // 在所有同源文档里，取"章节节点最多"的那个（就是目录面板），并保持其 DOM 顺序
  let lastCatalogDoc = '';
  function collectChapterNodes() {
    const docs = sameOriginDocs();
    let best = [];
    let bestUrl = '';
    docs.forEach((doc) => {
      const nodes = collectFromDoc(doc);
      if (nodes.length > best.length) {
        best = nodes;
        bestUrl = (doc.location && doc.location.href) || '(about:blank)';
      }
    });
    if (best.length && bestUrl !== lastCatalogDoc) {
      lastCatalogDoc = bestUrl;
      log('目录面板所在文档：', bestUrl);
      log('采集到章节节点数：', best.length);
    }
    return best;
  }

  function extractIds(el) {
    const s = attrString(el);
    const ids = new Set();
    (s.match(/\d{6,}/g) || []).forEach((n) => ids.add(n));
    if (el.id) (el.id.match(/\d{6,}/g) || []).forEach((n) => ids.add(n));
    return ids;
  }

  function findCurrentIndex(nodes) {
    const cid = currentChapterId();
    if (cid) {
      const i = nodes.findIndex((n) => n.ids.has(cid));
      if (i >= 0) { log('通过 URL 中的 chapterId 定位到当前节：', nodes[i].title); return i; }
    }
    // 退而求其次：找高亮 / 正在播放的节点
    let i = nodes.findIndex((n) => /(^|\s)(active|current|curr|selected|playing|on)(\s|$)/i.test(n.el.className || ''));
    if (i >= 0) { log('通过高亮样式定位到当前节：', nodes[i].title); return i; }
    i = nodes.findIndex((n) => n.el.querySelector && n.el.querySelector('[class*="Playing"], [class*="playing"]'));
    if (i >= 0) { log('通过播放图标定位到当前节：', nodes[i].title); return i; }
    return -1;
  }

  // 判断某个任务点是否已完成：true=已完成 / false=未完成 / null=看不出来
  // ⚠️ 必须"未完成标记优先"：一个章节可能含多个任务点，
  //    当它部分完成时（如截图里的橙色①），行内会同时出现绿色勾和橙色数字，
  //    先判"已完成"就会把这种章节误当成学完了而跳过。
  function getCompleteState(el) {
    const scope = el.closest('.posCatalog_select, .chapter_item, .catalog_points, li, tr') || el.parentElement || el;
    const html = scope.innerHTML || '';
    if (/(icon_number|posCatalog_num|icon_orange|icon_uncomplete|icon_notComplete|icon_undo|未完成|待完成|进行中)/i.test(html)) return false;
    if (/(icon_Completed|icon_Complete|icon_success|icon_ok|已完成)/i.test(html)) return true;
    return null;
  }

  function clickNode(node) {
    let el = node.el;

    // <a> 是内层、真正的 onclick 在外层时，点外层，避免新开标签页
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') || '';
      if (el.target === '_blank') el.target = '_self';
      if (!/^javascript:/i.test(href) && !/^#/.test(href) && /^https?:/i.test(href)) {
        const parent = el.parentElement && el.parentElement.closest('[onclick]');
        if (parent && parent !== el) el = parent;
        else { log('直接跳转链接：', href); location.href = href; return true; }
      }
    }
    if (el.target === '_blank') el.target = '_self';

    const oc = (el.getAttribute && el.getAttribute('onclick')) || '';
    log('点击下一节 →', node.title, oc ? '\n   onclick = ' + oc.slice(0, 160) : '');
    el.click();
    return true;
  }

  // 平台自带的"下一节"按钮，作为兜底
  function clickPlatformNext() {
    const sels = ['.prev_next .next', '.prev_next_next', '#next', '.nextChapter', '.next_chapter',
                  '.jb_btn_next', '[title="下一节"]', '[title="下一章"]', '.chapter_next'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) {
        log('使用平台自带「下一节」按钮兜底：', s);
        el.click();
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------
   *  判断当前章节里加载的是哪种任务点
   *  返回 'video' | 'quiz' | 'unknown'
   *  —— 只做"识别"，不做任何答题动作
   * ------------------------------------------------------------------ */
  function detectContentType() {
    const docs = sameOriginDocs();
    let sawVideo = false;
    let sawQuiz = false;

    docs.forEach((doc) => {
      try {
        if (doc.querySelector('video')) sawVideo = true;

        // ① 最可靠的信号：内嵌模块 iframe 的地址
        doc.querySelectorAll('iframe').forEach((f) => {
          const src = f.src || '';
          if (/ananas\/modules\/video/i.test(src)) sawVideo = true;
          if (/(\/work\/|\/exam-ans\/|\/exam\/|doHomeWork|selectWorkQuestion|reVersionTestStartNew|work\/selectWork)/i.test(src)) sawQuiz = true;
        });

        // ② 次可靠：测验特有的 DOM —— 多个选项、题目容器、提交按钮
        const opts = doc.querySelectorAll('input[type=radio], input[type=checkbox]').length;
        const qBox = doc.querySelector('.TiMu, .questionLi, [class*="questionLi"], [class*="examTitle"], #submitBtn, .ans-job-answer');
        if (opts >= 2 || qBox) sawQuiz = true;

        // ③ 兜底：正文同时出现"测验/答题"字样和交互控件
        const body = (doc.body && doc.body.innerText) || '';
        if (/(章节测验|测验|答题|请在下方作答)/.test(body.slice(0, 4000)) &&
            doc.querySelector('textarea, input[type=text], button, .btn')) sawQuiz = true;
      } catch (e) { /* 跨域文档，忽略 */ }
    });

    if (sawVideo) return 'video';   // 视频优先：宁可当视频，也不要把视频课误跳过
    if (sawQuiz) return 'quiz';
    return 'unknown';
  }

  async function goNextChapter() {
    let nodes = await waitFor(collectChapterNodes, 6000, 400);
    if (!nodes || !nodes.length) {
      warn('目录里没找到章节节点，尝试平台自带的下节按钮…');
      return clickPlatformNext();
    }
    log(`目录共采集到 ${nodes.length} 个章节节点，当前 chapterId = ${currentChapterId()}`);

    const maxHops = CFG.skipNonVideo ? CFG.maxHopsPerStep : 1;

    for (let hop = 1; hop <= maxHops; hop++) {
      // 每跳一次都重新采集：平台导航后目录可能被重新渲染，旧的 DOM 引用会失效
      if (hop > 1) {
        await sleep(600);
        nodes = await waitFor(collectChapterNodes, 4000, 300);
        if (!nodes || !nodes.length) { warn('跳转后目录采集失败'); return true; }
      }

      const idx = findCurrentIndex(nodes);
      if (idx < 0) {
        warn('未能定位当前章节，为避免跳到课程开头，改用平台自带「下一节」按钮');
        return clickPlatformNext();
      }
      if (hop === 1) log(`当前在第 ${idx + 1} 个节点：${nodes[idx].title}`);

      // 向后找第一个可进入的节点
      let target = null;
      for (let i = idx + 1; i < nodes.length; i++) {
        const n = nodes[i];
        if (CFG.skipCompleted) {
          const done = getCompleteState(n.el);
          log(`第 ${i + 1} 个候选：${n.title} ｜完成状态：` +
              (done === true ? '已完成 → 跳过' : done === false ? '未完成' : '未知'));
          if (done === true) continue;
        } else {
          log(`顺序播放 → 第 ${i + 1} 个节点：${n.title}`);
        }
        target = { n, i };
        break;
      }
      if (!target) {
        if (hop === 1) {
          log('当前节之后已经没有可进入的节点了');
          setStatus('🎉 后面都学完了');
          return false;
        }
        log('跳到最后也没有可进入的节点了');
        return true;
      }

      // 点击并校验
      const before = currentChapterId();
      clickNode(target.n);
      const changed = await waitFor(() => currentChapterId() !== before, 5000, 250);
      if (!changed) {
        warn('点击后章节没有变化，改用平台自带「下一节」按钮兜底');
        clickPlatformNext();
        return true;
      }

      if (hop >= maxHops) return true;

      // 判断进去的到底是什么内容
      await sleep(CFG.contentSettleMs);
      const type = await waitFor(() => {
        const t = detectContentType();
        return t === 'unknown' ? null : t;
      }, CFG.nonVideoWaitMs, 500);

      if (type === 'video') {
        if (hop > 1) log(`已跳过 ${hop - 1} 个非视频任务点，落在视频节：${target.n.title}`);
        return true;
      }
      if (type === 'quiz') {
        skippedQuizzes.push(target.n.title);
        log(`「${target.n.title}」是测验/作业类任务点 → 已跳过（不代答，请自行补做）`);
        setStatus(`已跳过测验：${target.n.title}`);
        continue;   // 继续往后跳
      }

      // 既没有视频也认不出测验 —— 不猜，停下来让用户确认
      warn(`「${target.n.title}」进去后既没发现视频、也没认出测验，已停下等你手动确认`);
      setStatus('⚠️ 无法识别该任务点类型，已停下');
      return true;
    }
    return true;
  }

  /* ==================================================================
   *  四、顺手关掉平台弹窗（"继续学习 / 下一节"之类）
   * ================================================================== */
  // 注意：只放"纯关闭"性质的按钮，绝对不要放 下一节/下一章/下一个
  // —— 平台自己就有「下一节」按钮，点了它会跳一次，目录再跳一次 = 一次跳两节
  const CONTINUE_RE = /^(继续观看|继续播放|继续学习)$/;

  function clickPopups() {
    const roots = sameOriginDocs();
    let clicked = false;
    roots.forEach((root) => {
      root.querySelectorAll('a, button, div[onclick], span[onclick], .layui-layer-btn a, .ans-job-finish-btn').forEach((el) => {
        const t = text(el);
        if (!t || t.length > 12) return;
        if (!CONTINUE_RE.test(t)) return;
        if (el.offsetParent === null) return; // 不可见
        log('点击弹窗按钮：', t);
        el.click();
        clicked = true;
      });
    });
    return clicked;
  }

  /* ==================================================================
   *  五、右下角控制面板（只在顶层显示）
   * ================================================================== */
  function findChapterTitle() {
    if (!IS_TOP) return '';
    const h = document.querySelector('.chapter_title, .posCatalog_active, h1, .videoTitle');
    return text(h).slice(0, 30);
  }

  function setStatus(s) {
    const el = document.getElementById('auto-next-status');
    if (el) el.textContent = s;
  }

  function buildPanel() {
    if (!IS_TOP || !document.body || document.getElementById('auto-next-panel')) return;
    const d = document.createElement('div');
    d.id = 'auto-next-panel';
    d.innerHTML =
      '<div style="font-weight:700;margin-bottom:4px">🎬 自动连播' +
      '<span id="auto-next-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-left:6px"></span></div>' +
      '<div id="auto-next-status" style="opacity:.85;max-width:230px;line-height:1.4">待机中</div>' +
      '<button id="auto-next-toggle" style="margin-top:6px;cursor:pointer;border:0;border-radius:4px;padding:3px 10px;background:#2d8cf0;color:#fff;font-size:12px">暂停</button>';
    Object.assign(d.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 999999,
      background: 'rgba(20,22,26,.86)', color: '#fff', fontSize: '12px',
      padding: '10px 12px', borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,.35)',
      fontFamily: 'system-ui,-apple-system,"Microsoft YaHei",sans-serif',
      transition: 'opacity .3s', opacity: '.75',
    });
    d.addEventListener('mouseenter', () => (d.style.opacity = '1'));
    d.addEventListener('mouseleave', () => (d.style.opacity = '.75'));
    document.body.appendChild(d);

    d.querySelector('#auto-next-toggle').addEventListener('click', (e) => {
      enabled = !enabled;
      e.target.textContent = enabled ? '暂停' : '启用';
      d.querySelector('#auto-next-dot').style.background = enabled ? '#22c55e' : '#ef4444';
      setStatus(enabled ? '已启用' : '已暂停');
      log(enabled ? '已启用' : '已暂停');
    });
  }

  /* ==================================================================
   *  六、启动
   * ================================================================== */
  function boot() {
    if (IS_TOP) {
      buildPanel();
      setTimeout(buildPanel, 2000); // 目录是异步加载的，晚点再补一次
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (d && d.__autoNext && d.type === 'VIDEO_ENDED') handleEnded('子 iframe 上报：' + (d.reason || ''));
      });
    }
    scanVideos();
    setInterval(scanVideos, CFG.pollInterval);
    log(IS_TOP ? '顶层脚本已启动' : '子帧脚本已启动：' + location.href.slice(0, 80));

    // 调试入口：控制台里可用 __autoNext.xxx() 手动触发 / 查看
    window.__autoNext = {
      CFG,
      info: () => {
        const ns = collectChapterNodes();
        const i = findCurrentIndex(ns);
        const a = [];
        deepCollectVideos(window, a, 0);
        return {
          url: location.href,
          isTop: IS_TOP,
          enabled,
          switching,
          panel: !!document.getElementById('auto-next-panel'),
          chapters: ns.length,
          currentIndex: i,
          currentTitle: i >= 0 ? ns[i].title : '(未定位到)',
          nextTitle: i >= 0 && ns[i + 1] ? ns[i + 1].title : '(已经是最后一个节点)',
          videos: a.map((v) => ({ src: (v.currentSrc || '').slice(0, 60), t: +v.currentTime.toFixed(1), d: v.duration, paused: v.paused, ended: v.ended })),
        };
      },
      list: () => collectChapterNodes().map((n, i) => `${i}. ${n.title}`),
      states: () => collectChapterNodes().map((n, i) => `${i}. [${getCompleteState(n.el)}] ${n.title}`),
      next: () => goNextChapter(),
      detect: () => detectContentType(),
      skipped: () => skippedQuizzes.slice(),
      ended: () => handleEnded('手动触发'),
      scan: () => scanVideos(),
      on: () => { enabled = true; log('已启用'); },
      off: () => { enabled = false; log('已暂停'); },
    };
    log('调试入口已就绪：在控制台输入 __autoNext.info()');
  }

  // 立刻装上（不能等 DOMContentLoaded，报错发生在播放器初始化时）
  installPlayerBugFilter();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
