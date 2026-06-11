// ==UserScript==
// @name         Discuz 黑名单屏蔽（t66y）
// @namespace    https://t66y.com/
// @version      2.1.0
// @description  按用户名或 UID 屏蔽用户，支持悬浮卡片、一键拉黑、取消拉黑、导入导出备份
// @author       local
// @match        *://t66y.com/thread0806.php*
// @match        *://t66y.com/read.php*
// @match        *://t66y.com/htm_data/*/*/*.html*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 常量定义
  const STORAGE_KEY = '__t66y_blacklist_v2__';
  const HISTORY_CACHE_TTL = 10 * 60 * 1000;
  const HISTORY_PREVIEW_COUNT = 5;
  const ZINDEX_TOOLBAR = 2147483646;
  const ZINDEX_CARD = 2147483647;
  const DEBOUNCE_APPLY_MS = 140;
  const CARD_HIDE_DELAY_MS = 180;
  const FETCH_TIMEOUT_MS = 8000;
  const MEMORY_CLEANUP_INTERVAL_MS = 60000;
  const MANAGER_PAGE_SIZE = 10;

  // 初始黑名单（仅首次运行时作为默认值导入）
  const CONFIG = {
    initialBlockedUsernames: [],
    initialBlockedUids: ['123456', '654321'],
    initialBlockedKeywords: [],
    hideTopicListIfLastReplyByBlocked: false,
  };

  const historyCache = new Map();
  const hiddenElements = new Set();

  let showHiddenBlocked = false;
  let toolbarEl = null;
  let managerEl = null;
  let cardEl = null;
  let hideCardTimer = 0;
  let activeAnchor = null;
  let lastCardPoint = { x: 0, y: 0 };
  let isApplying = false;
  let managerQuery = '';
  let managerNamePage = 1;
  let managerUidPage = 1;
  let managerKeywordPage = 1;
  let isManagerComposing = false;
  let cachedCardSize = null;
  let keywordRegex = null;

  const blacklist = loadBlacklist();

  function normalizeName(name) {
    return String(name || '').replace(/\s+/g, '').trim().toLowerCase();
  }

  function normalizeUid(uid) {
    return String(uid || '').trim();
  }

  function normalizeKeyword(keyword) {
    return String(keyword || '').trim().toLowerCase();
  }

  function parseUidFromHref(href) {
    if (!href) return '';
    try {
      const url = new URL(href, location.origin);
      // 优先匹配更明确的 UID 参数，避免 search 参数混淆
      const keys = ['uid', 'authorid', 'touid'];
      for (const key of keys) {
        const value = url.searchParams.get(key);
        if (value && /^\d+$/.test(value)) return value;
      }
      // search 参数作为兜底，但必须是纯数字
      const search = url.searchParams.get('search');
      if (search && /^\d+$/.test(search)) return search;
    } catch (e) {
      // 忽略 URL 解析失败，继续走正则兜底
    }
    const m = String(href).match(/(?:uid|authorid|touid)=(\d+)/i);
    return m ? m[1] : '';
  }

  function loadBlacklist() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          usernames: new Set((parsed.usernames || []).map(normalizeName).filter(Boolean)),
          uids: new Set((parsed.uids || []).map(normalizeUid).filter(Boolean)),
          keywords: new Set((parsed.keywords || []).map(normalizeKeyword).filter(Boolean)),
        };
      }
    } catch (e) {
      // 忽略损坏数据，回退默认
    }

    const initial = {
      usernames: new Set((CONFIG.initialBlockedUsernames || []).map(normalizeName).filter(Boolean)),
      uids: new Set((CONFIG.initialBlockedUids || []).map(normalizeUid).filter(Boolean)),
      keywords: new Set((CONFIG.initialBlockedKeywords || []).map(normalizeKeyword).filter(Boolean)),
    };
    persistBlacklist(initial);
    return initial;
  }

  function persistBlacklist(data) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        usernames: Array.from(data.usernames),
        uids: Array.from(data.uids),
        keywords: Array.from(data.keywords),
      })
    );
    // 关键词变化时重新构建正则
    rebuildKeywordRegex();
  }

  function rebuildKeywordRegex() {
    if (blacklist.keywords.size === 0) {
      keywordRegex = null;
      return;
    }
    // 转义特殊字符并构建正则
    const escaped = Array.from(blacklist.keywords).map(kw =>
      kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
    keywordRegex = new RegExp(escaped.join('|'), 'i');
  }

  function isBlocked(username, uid) {
    const uname = normalizeName(username);
    const u = normalizeUid(uid);
    return (!!uname && blacklist.usernames.has(uname)) || (!!u && blacklist.uids.has(u));
  }

  function getCleanPostContent(contentEl) {
    if (!contentEl) return '';

    // 克隆元素以避免修改原DOM
    const clone = contentEl.cloneNode(true);

    // 移除非正文元素，尽量隔离其他脚本注入内容
    const selectorsToRemove = [
      '.tm-relayout-toolbar',
      '.tm-blacklist-toolbar',
      '.tm-toolbar',
      '.tm-switch',
      '.tm-card',
      '.tm-manager',
      'button',
      'input',
      'select',
      'textarea',
      '.toolbar',
      '[class*="toolbar"]',
      '[class*="tool-"]',
      '[id*="toolbar"]',
      '[class*="replycontrol"]',
      '[class*="quote"]',
      '.quote',
      'blockquote',
      '[data-role]',
      '[data-action]',
      '[contenteditable=\"true\"]',
      'script',
      'style',
      'iframe',
      'noscript',
      '.adsbygoogle',
      '[id*="ads"]',
      '[class*="ads"]'
    ];

    selectorsToRemove.forEach(selector => {
      clone.querySelectorAll(selector).forEach(el => el.remove());
    });

    // 获取纯文本内容
    let text = clone.textContent || '';

    // 移除常见的工具栏文字模式（正则兜底）
    text = text
      .replace(/舒适排版.*?关闭后恢复原始尺寸/g, '')
      .replace(/\d+\s*个媒体.*?保留图文顺序/g, '')
      .replace(/自动\s*\d+\s*列/g, '')
      .trim();

    return text;
  }

  function isBlockedByKeyword(content) {
    if (!content || !keywordRegex) return false;
    return keywordRegex.test(String(content).toLowerCase());
  }

  function getPostAuthorInfo(block) {
    const thEl = block.querySelector('tr.tr1.do_not_catch > th');
    const userNameEl = thEl?.querySelector('b');
    let userName = (userNameEl?.textContent || '').trim();
    // 移除 [楼主] 标记（可能在用户名后）
    userName = userName.replace(/\s*\[樓主\]|\[楼主\]\s*/gi, '').trim();

    let uid = '';
    const links = block.querySelectorAll('.tiptop a[href*="uid="], .tiptop a[href*="touid="], .tiptop a[href*="authorid="], a[href*="uid="], a[href*="authorid="]');
    for (const link of links) {
      uid = parseUidFromHref(link.getAttribute('href') || link.href);
      if (uid) break;
    }
    return { userName, uid };
  }

  function getTopicOwnerIdentity(postBlocks) {
    if (!postBlocks || !postBlocks.length) return { userName: '', uid: '' };
    const first = postBlocks[0];
    if (!first) return { userName: '', uid: '' };
    return getPostAuthorInfo(first);
  }

  function addToBlacklist(username, uid) {
    const uname = normalizeName(username);
    const u = normalizeUid(uid);
    if (!uname && !u) return false;
    if (uname) blacklist.usernames.add(uname);
    if (u) blacklist.uids.add(u);
    persistBlacklist(blacklist);
    applyAll();
    return true;
  }

  function removeFromBlacklist(username, uid) {
    const uname = normalizeName(username);
    const u = normalizeUid(uid);
    let changed = false;
    if (uname && blacklist.usernames.has(uname)) {
      blacklist.usernames.delete(uname);
      changed = true;
    }
    if (u && blacklist.uids.has(u)) {
      blacklist.uids.delete(u);
      changed = true;
    }
    if (changed) {
      persistBlacklist(blacklist);
      applyAll();
    }
    return changed;
  }

  function addKeyword(keyword) {
    const kw = normalizeKeyword(keyword);
    if (!kw) return false;
    blacklist.keywords.add(kw);
    persistBlacklist(blacklist);
    applyAll();
    return true;
  }

  function removeKeyword(keyword) {
    const kw = normalizeKeyword(keyword);
    if (!kw || !blacklist.keywords.has(kw)) return false;
    blacklist.keywords.delete(kw);
    persistBlacklist(blacklist);
    applyAll();
    return true;
  }

  function clearBlacklist() {
    if (!confirm('确定要清空所有黑名单数据吗？此操作无法撤销。')) {
      return false;
    }
    blacklist.usernames.clear();
    blacklist.uids.clear();
    blacklist.keywords.clear();
    persistBlacklist(blacklist);
    applyAll();
    return true;
  }

  function exportBlacklistText() {
    return JSON.stringify(
      {
        usernames: Array.from(blacklist.usernames),
        uids: Array.from(blacklist.uids),
        keywords: Array.from(blacklist.keywords),
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    );
  }

  function importBlacklistText(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, message: `导入失败：JSON 格式无效 - ${e.message}` };
    }

    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, message: '导入失败：数据格式不是有效对象' };
    }

    const usernames = Array.isArray(parsed.usernames) ? parsed.usernames : [];
    const uids = Array.isArray(parsed.uids) ? parsed.uids : [];
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];

    blacklist.usernames = new Set(usernames.map(normalizeName).filter(Boolean));
    blacklist.uids = new Set(uids.map(normalizeUid).filter(Boolean));
    blacklist.keywords = new Set(keywords.map(normalizeKeyword).filter(Boolean));
    persistBlacklist(blacklist);
    applyAll();
    return { ok: true, message: `导入成功：用户名 ${blacklist.usernames.size}，UID ${blacklist.uids.size}，关键词 ${blacklist.keywords.size}` };
  }

  function hideElement(el) {
    if (!el) return;
    if (el.dataset.tmBlacklistHidden !== '1') {
      el.dataset.tmBlacklistHidden = '1';
      el.dataset.tmBlacklistPrevDisplay = el.style.display || '';
      hiddenElements.add(el);
    }

    if (showHiddenBlocked) {
      el.style.display = el.dataset.tmBlacklistPrevDisplay || '';
      el.style.opacity = '0.45';
      el.style.filter = 'grayscale(0.25)';
    } else {
      el.style.display = 'none';
      el.style.opacity = '';
      el.style.filter = '';
    }
  }

  function showElement(el) {
    if (!el) return;
    if (el.dataset.tmBlacklistHidden === '1') {
      el.style.display = el.dataset.tmBlacklistPrevDisplay || '';
      el.style.opacity = '';
      el.style.filter = '';
      delete el.dataset.tmBlacklistHidden;
      delete el.dataset.tmBlacklistPrevDisplay;
      hiddenElements.delete(el);
    }
  }

  function setElementBlocked(el, blocked) {
    if (blocked) hideElement(el);
    else showElement(el);
  }

  function refreshHiddenVisibility() {
    hiddenElements.forEach((el) => {
      if (!el || !el.isConnected) {
        hiddenElements.delete(el);
        return;
      }
      if (showHiddenBlocked) {
        el.style.display = el.dataset.tmBlacklistPrevDisplay || '';
        el.style.opacity = '0.45';
        el.style.filter = 'grayscale(0.25)';
      } else {
        el.style.display = 'none';
        el.style.opacity = '';
        el.style.filter = '';
      }
    });
  }

  // 定期清理已移除的元素，防止内存泄漏
  setInterval(() => {
    hiddenElements.forEach((el) => {
      if (!el || !el.isConnected) {
        hiddenElements.delete(el);
      }
    });
  }, MEMORY_CLEANUP_INTERVAL_MS);

  function applyPostPageBlacklist() {
    const postBlocks = Array.from(document.querySelectorAll('div.t.t2'));
    if (!postBlocks.length) return;
    const owner = getTopicOwnerIdentity(postBlocks);

    postBlocks.forEach((block) => {
      const { userName, uid } = getPostAuthorInfo(block);

      // 楼主判断：检查 <b> 标签内是否包含 <span class="sgreen">[樓主]</span>
      const thEl = block.querySelector('tr.tr1.do_not_catch > th');
      const bEl = thEl?.querySelector('b');
      const hasOPTag = bEl?.querySelector('span.sgreen') !== null;
      const isOPByUid = !!owner.uid && !!uid && owner.uid === uid;
      const isOPByName = !owner.uid && !!owner.userName && normalizeName(owner.userName) === normalizeName(userName);
      const isOP = hasOPTag || isOPByUid || isOPByName;

      // 检查用户是否被屏蔽
      let blocked = isBlocked(userName, uid);

      // 只对非楼主回帖检查关键词；楼主正文即便命中关键词也不屏蔽（除非楼主在黑名单）
      if (!blocked && !isOP) {
        const contentEl = block.querySelector('.tpc_content.do_not_catch, div.tpc_content');
        if (contentEl) {
          const cleanContent = getCleanPostContent(contentEl);
          blocked = isBlockedByKeyword(cleanContent);
        }
      }

      const prev = block.previousElementSibling;
      if (prev && prev.tagName === 'A' && prev.getAttribute('name')) {
        setElementBlocked(prev, blocked);
      }
      setElementBlocked(block, blocked);
    });
  }

  function isPostPage() {
    return document.querySelectorAll('div.t.t2').length > 0;
  }

  function applyThreadListBlacklist() {
    const tbody = document.getElementById('tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.children).filter((el) => el.tagName === 'TR');
    rows.forEach((row) => {
      const authorLink = row.querySelector('td:nth-child(3) a[href*="search="], td:nth-child(3) a[href*="authorid="], td:nth-child(3) a[href*="uid="]');
      if (!authorLink) return;

      const authorName = (authorLink.textContent || '').trim();
      const authorUid = parseUidFromHref(authorLink.getAttribute('href') || authorLink.href);

      let shouldHide = isBlocked(authorName, authorUid);
      if (!shouldHide && CONFIG.hideTopicListIfLastReplyByBlocked) {
        const lastTd = row.querySelector('td:last-child');
        if (lastTd) {
          const lines = (lastTd.textContent || '')
            .split(/\n+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const lastReplyName = lines.length ? lines[lines.length - 1] : '';
          shouldHide = isBlocked(lastReplyName, '');
        }
      }

      setElementBlocked(row, shouldHide);
    });
  }

  function applyAll() {
    if (isApplying) return;
    isApplying = true;
    try {
      applyPostPageBlacklist();
      applyThreadListBlacklist();
      bindHoverCards();
      ensureToolbar();
      refreshHiddenVisibility();
    } finally {
      isApplying = false;
    }
  }

  function ensureStyle() {
    if (document.getElementById('tm-blacklist-style')) return;
    const style = document.createElement('style');
    style.id = 'tm-blacklist-style';
    style.textContent = `
      @keyframes tm-fade-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @keyframes tm-slide-in {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
      .tm-card {
        --bg1: #ffffff;
        --bg2: #f8fafc;
        --brand: #6366f1;
        --brand-hover: #4f46e5;
        --brand-soft: #818cf8;
        --text: #0f172a;
        --text-secondary: #475569;
        --muted: #64748b;
        --border: #e2e8f0;
        --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
        --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
        --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
        --shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
        background: linear-gradient(135deg, var(--bg1) 0%, var(--bg2) 100%);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow-xl), inset 0 1px 0 rgba(255,255,255,0.9);
        backdrop-filter: blur(12px) saturate(180%);
        color: var(--text);
        animation: tm-slide-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .tm-title {
        font-size: 14px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--text);
        line-height: 1.4;
      }
      .tm-sub {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.5;
      }
      .tm-btn {
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 6px 14px;
        background: white;
        color: var(--text-secondary);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: var(--shadow-sm);
        position: relative;
        overflow: hidden;
      }
      .tm-btn::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.8), rgba(255,255,255,0));
        opacity: 0;
        transition: opacity 0.2s;
      }
      .tm-btn:hover:not(:disabled) {
        transform: translateY(-2px);
        box-shadow: var(--shadow-md);
        border-color: var(--brand);
        color: var(--brand);
      }
      .tm-btn:hover:not(:disabled)::before {
        opacity: 1;
      }
      .tm-btn:active:not(:disabled) {
        transform: translateY(0);
        box-shadow: var(--shadow-sm);
      }
      .tm-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none !important;
      }
      .tm-btn-primary {
        background: linear-gradient(135deg, var(--brand) 0%, var(--brand-soft) 100%);
        color: white;
        border-color: transparent;
        box-shadow: var(--shadow-md), 0 0 0 1px rgba(99, 102, 241, 0.1);
      }
      .tm-btn-primary:hover:not(:disabled) {
        background: linear-gradient(135deg, var(--brand-hover) 0%, var(--brand) 100%);
        box-shadow: var(--shadow-lg), 0 0 0 1px rgba(99, 102, 241, 0.2);
        color: white;
      }
      .tm-section {
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--border);
        animation: tm-fade-in 0.3s ease-out;
      }
      .tm-list {
        margin: 8px 0 0 20px;
        padding: 0;
        list-style: none;
      }
      .tm-list li {
        margin: 6px 0;
        padding: 6px 10px;
        background: rgba(248, 250, 252, 0.6);
        border-radius: 8px;
        transition: all 0.2s;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .tm-list li:hover {
        background: rgba(241, 245, 249, 0.8);
        transform: translateX(2px);
      }
      .tm-textarea {
        width: 100%;
        min-height: 100px;
        resize: vertical;
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.6;
        color: var(--text);
        background: white;
        transition: all 0.2s;
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
      }
      .tm-textarea:focus {
        outline: none;
        border-color: var(--brand);
        box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
      }
      .tm-textarea::placeholder {
        color: var(--muted);
      }
      input.tm-textarea {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureToolbar() {
    ensureStyle();
    if (toolbarEl) {
      updateToolbarState();
      return;
    }
    const el = document.createElement('div');
    el.className = 'tm-card';
    el.style.position = 'fixed';
    el.style.right = '12px';
    el.style.bottom = '12px';
    el.style.zIndex = String(ZINDEX_TOOLBAR);
    el.style.padding = '8px 10px';
    el.style.display = 'flex';
    el.style.gap = '8px';
    el.innerHTML = `
      <button type="button" class="tm-btn" data-action="toggle-hidden">显示已屏蔽</button>
      <button type="button" class="tm-btn tm-btn-primary" data-action="open-manager">黑名单管理</button>
    `;
    el.onclick = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-action');
      if (action === 'toggle-hidden') {
        showHiddenBlocked = !showHiddenBlocked;
        refreshHiddenVisibility();
        updateToolbarState();
      } else if (action === 'open-manager') {
        toggleManager();
      }
    };
    document.body.appendChild(el);
    toolbarEl = el;
    updateToolbarState();
  }

  function updateToolbarState() {
    if (!toolbarEl) return;
    const btn = toolbarEl.querySelector('button[data-action="toggle-hidden"]');
    if (btn) btn.textContent = showHiddenBlocked ? '隐藏已屏蔽' : '显示已屏蔽';
  }

  function ensureManagerPanel() {
    ensureStyle();
    if (managerEl) return managerEl;

    const el = document.createElement('div');
    el.className = 'tm-card';
    el.style.position = 'fixed';
    el.style.right = '12px';
    el.style.bottom = '60px';
    el.style.zIndex = String(ZINDEX_TOOLBAR);
    el.style.width = '420px';
    el.style.maxWidth = 'calc(100vw - 24px)';
    el.style.maxHeight = '68vh';
    el.style.padding = '0';
    el.style.display = 'none';
    el.style.flexDirection = 'column';
    el.style.overflow = 'hidden';

    el.onclick = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-action');

      if (action === 'remove-name') {
        removeFromBlacklist(target.getAttribute('data-name') || '', '');
        renderManagerPanel();
      } else if (action === 'remove-uid') {
        removeFromBlacklist('', target.getAttribute('data-uid') || '');
        renderManagerPanel();
      } else if (action === 'remove-keyword') {
        removeKeyword(target.getAttribute('data-keyword') || '');
        renderManagerPanel();
      } else if (action === 'add-keyword') {
        const input = el.querySelector('input[data-role="keyword-input"]');
        if (input instanceof HTMLInputElement && input.value.trim()) {
          addKeyword(input.value.trim());
          input.value = '';
          renderManagerPanel();
        }
      } else if (action === 'clear-all') {
        if (clearBlacklist()) {
          renderManagerPanel();
        }
      } else if (action === 'copy-export') {
        const ta = el.querySelector('textarea[data-role="backup"]');
        if (ta instanceof HTMLTextAreaElement) {
          copyToClipboard(ta.value);
        }
      } else if (action === 'refresh-export') {
        const ta = el.querySelector('textarea[data-role="backup"]');
        if (ta instanceof HTMLTextAreaElement) {
          ta.value = exportBlacklistText();
        }
      } else if (action === 'import-apply') {
        const ta = el.querySelector('textarea[data-role="backup"]');
        const msg = el.querySelector('[data-role="import-msg"]');
        if (ta instanceof HTMLTextAreaElement && msg) {
          const result = importBlacklistText(ta.value);
          msg.textContent = result.message;
          renderManagerPanel();
        }
      } else if (action === 'close-manager') {
        el.style.display = 'none';
      } else if (action === 'page-name-prev') {
        managerNamePage = Math.max(1, managerNamePage - 1);
        renderManagerPanel();
      } else if (action === 'page-name-next') {
        managerNamePage += 1;
        renderManagerPanel();
      } else if (action === 'page-uid-prev') {
        managerUidPage = Math.max(1, managerUidPage - 1);
        renderManagerPanel();
      } else if (action === 'page-uid-next') {
        managerUidPage += 1;
        renderManagerPanel();
      } else if (action === 'page-keyword-prev') {
        managerKeywordPage = Math.max(1, managerKeywordPage - 1);
        renderManagerPanel();
      } else if (action === 'page-keyword-next') {
        managerKeywordPage += 1;
        renderManagerPanel();
      } else if (action === 'clear-search') {
        managerQuery = '';
        managerNamePage = 1;
        managerUidPage = 1;
        managerKeywordPage = 1;
        renderManagerPanel();
      }
    };

    el.addEventListener('input', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.getAttribute('data-role') !== 'manager-search') return;
      if (isManagerComposing) return;
      const caretStart = target.selectionStart;
      const caretEnd = target.selectionEnd;
      managerQuery = target.value || '';
      managerNamePage = 1;
      managerUidPage = 1;
      managerKeywordPage = 1;
      renderManagerPanel();
      const nextInput = el.querySelector('input[data-role="manager-search"]');
      if (nextInput instanceof HTMLInputElement) {
        nextInput.focus();
        const start = typeof caretStart === 'number' ? caretStart : nextInput.value.length;
        const end = typeof caretEnd === 'number' ? caretEnd : nextInput.value.length;
        nextInput.setSelectionRange(start, end);
      }
    });

    el.addEventListener('compositionstart', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.getAttribute('data-role') !== 'manager-search') return;
      isManagerComposing = true;
    });

    el.addEventListener('compositionend', (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.getAttribute('data-role') !== 'manager-search') return;
      isManagerComposing = false;
      managerQuery = target.value || '';
      managerNamePage = 1;
      managerUidPage = 1;
      managerKeywordPage = 1;
      renderManagerPanel();
      const nextInput = el.querySelector('input[data-role="manager-search"]');
      if (nextInput instanceof HTMLInputElement) {
        nextInput.focus();
        const len = nextInput.value.length;
        nextInput.setSelectionRange(len, len);
      }
    });

    el.addEventListener('keydown', (e) => {
      const target = e.target;
      if (target instanceof HTMLInputElement) {
        if (target.getAttribute('data-role') === 'manager-search' && e.key === 'Enter') {
          e.preventDefault();
          const firstRemoveBtn = el.querySelector('button[data-action="remove-name"], button[data-action="remove-uid"], button[data-action="remove-keyword"]');
          if (firstRemoveBtn instanceof HTMLElement) firstRemoveBtn.focus();
        } else if (target.getAttribute('data-role') === 'keyword-input' && e.key === 'Enter') {
          e.preventDefault();
          const addBtn = el.querySelector('button[data-action="add-keyword"]');
          if (addBtn instanceof HTMLElement) addBtn.click();
        }
      }
    });

    document.body.appendChild(el);
    managerEl = el;
    return el;
  }

  // 通用分页组件渲染
  function renderPagination(currentPage, totalPages, actionPrefix) {
    return `
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
        <button class="tm-btn" data-action="${actionPrefix}-prev" ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>
        <span class="tm-sub">第 ${currentPage} / ${totalPages} 页</span>
        <button class="tm-btn" data-action="${actionPrefix}-next" ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    `;
  }

  // 现代 Clipboard API 复制
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        alert('已复制到剪贴板');
      } else {
        // 降级方案
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        alert('已复制到剪贴板');
      }
    } catch (e) {
      alert('复制失败：' + e.message);
    }
  }

  function renderManagerPanel() {
    const el = ensureManagerPanel();
    const q = managerQuery.trim().toLowerCase();
    const names = Array.from(blacklist.usernames)
      .sort()
      .filter((v) => (!q ? true : v.includes(q)));
    const uids = Array.from(blacklist.uids)
      .sort((a, b) => Number(a) - Number(b))
      .filter((v) => (!q ? true : v.includes(q)));
    const keywords = Array.from(blacklist.keywords)
      .sort()
      .filter((v) => (!q ? true : v.includes(q)));

    const namePageCount = Math.max(1, Math.ceil(names.length / MANAGER_PAGE_SIZE));
    const uidPageCount = Math.max(1, Math.ceil(uids.length / MANAGER_PAGE_SIZE));
    const keywordPageCount = Math.max(1, Math.ceil(keywords.length / MANAGER_PAGE_SIZE));
    managerNamePage = Math.min(managerNamePage, namePageCount);
    managerUidPage = Math.min(managerUidPage, uidPageCount);
    managerKeywordPage = Math.min(managerKeywordPage, keywordPageCount);

    const nameStart = (managerNamePage - 1) * MANAGER_PAGE_SIZE;
    const uidStart = (managerUidPage - 1) * MANAGER_PAGE_SIZE;
    const keywordStart = (managerKeywordPage - 1) * MANAGER_PAGE_SIZE;
    const nameItems = names.slice(nameStart, nameStart + MANAGER_PAGE_SIZE);
    const uidItems = uids.slice(uidStart, uidStart + MANAGER_PAGE_SIZE);
    const keywordItems = keywords.slice(keywordStart, keywordStart + MANAGER_PAGE_SIZE);

    const nameHtml = nameItems.length
      ? nameItems
          .map((name) => `<li>${escapeHtml(name)} <button class="tm-btn" data-action="remove-name" data-name="${escapeHtml(name)}">移除</button></li>`)
          .join('')
      : '<li>无</li>';

    const uidHtml = uidItems.length
      ? uidItems
          .map((uid) => `<li>${escapeHtml(uid)} <button class="tm-btn" data-action="remove-uid" data-uid="${escapeHtml(uid)}">移除</button></li>`)
          .join('')
      : '<li>无</li>';

    const keywordHtml = keywordItems.length
      ? keywordItems
          .map((kw) => `<li>${escapeHtml(kw)} <button class="tm-btn" data-action="remove-keyword" data-keyword="${escapeHtml(kw)}">移除</button></li>`)
          .join('')
      : '<li>无</li>';

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:14px 16px;border-bottom:1px solid var(--border);flex-shrink:0;background:linear-gradient(135deg, var(--bg1) 0%, var(--bg2) 100%);">
        <div class="tm-title" style="font-size:15px;">黑名单管理</div>
        <button class="tm-btn" data-action="close-manager" style="flex-shrink:0;">关闭</button>
      </div>

      <div style="flex:1;overflow-y:auto;padding:12px 16px;">
        <div class="tm-section" style="margin-top:0;padding-top:0;border-top:none;">
          <div style="display:flex;gap:8px;align-items:center;">
            <input class="tm-textarea" style="min-height:auto;height:34px;flex:1;" data-role="manager-search" value="${escapeHtml(
              managerQuery
            )}" placeholder="搜索用户名、UID 或关键词（按 Enter 聚焦结果）" />
            <button class="tm-btn" data-action="clear-search" ${managerQuery ? '' : 'disabled'}>清空</button>
          </div>
          <div class="tm-sub" style="margin-top:6px;">过滤命中：用户名 ${names.length}，UID ${uids.length}，关键词 ${keywords.length}</div>
        </div>

        <div class="tm-section">
          <div class="tm-title">用户名（${names.length}）</div>
          <ul class="tm-list">${nameHtml}</ul>
          ${renderPagination(managerNamePage, namePageCount, 'page-name')}
        </div>

        <div class="tm-section">
          <div class="tm-title">UID（${uids.length}）</div>
          <ul class="tm-list">${uidHtml}</ul>
          ${renderPagination(managerUidPage, uidPageCount, 'page-uid')}
        </div>

        <div class="tm-section">
          <div class="tm-title">屏蔽关键词（${keywords.length}）</div>
          <div class="tm-sub" style="margin-top:4px;">包含关键词的回帖楼层将被屏蔽，不区分大小写。</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
            <input class="tm-textarea" style="min-height:auto;height:34px;flex:1;" data-role="keyword-input" placeholder="输入关键词后按 Enter 或点击添加" />
            <button class="tm-btn tm-btn-primary" data-action="add-keyword">添加</button>
          </div>
          <ul class="tm-list" style="margin-top:8px;">${keywordHtml}</ul>
          ${renderPagination(managerKeywordPage, keywordPageCount, 'page-keyword')}
        </div>

        <div class="tm-section" style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="tm-btn" data-action="clear-all">清空黑名单</button>
        </div>

        <div class="tm-section">
          <div class="tm-title">备份与恢复</div>
          <div class="tm-sub" style="margin-top:4px;">可复制导出 JSON，或粘贴 JSON 后覆盖导入。</div>
          <textarea class="tm-textarea" data-role="backup">${escapeHtml(exportBlacklistText())}</textarea>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
            <button class="tm-btn" data-action="refresh-export">刷新导出</button>
            <button class="tm-btn" data-action="copy-export">复制导出</button>
            <button class="tm-btn tm-btn-primary" data-action="import-apply">覆盖导入</button>
          </div>
          <div class="tm-sub" data-role="import-msg" style="margin-top:6px;"></div>
        </div>
      </div>
    `;
  }

  function toggleManager() {
    const el = ensureManagerPanel();
    if (el.style.display === 'none') {
      renderManagerPanel();
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
  }

  function getSearchUrlFromAnchor(anchor) {
    if (!anchor) return '';
    const href = anchor.getAttribute('href') || anchor.href || '';
    if (!href) return '';
    if (/search=|authorid=|uid=|touid=/i.test(href)) {
      try {
        return new URL(href, location.origin).toString();
      } catch (e) {
        return href;
      }
    }
    return '';
  }

  function extractThreadTitles(doc) {
    // 更精确的选择器，优先匹配主题链接
    const selectors = [
      'a[href*="htm_data/"][href*=".html"]',
      'a[href*="read.php?tid="]',
      'tr h3 a[href]',
      'tbody tr td:nth-child(2) a[href]'
    ];
    const titles = [];
    const seen = new Set();

    selectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((a) => {
        const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
        const href = a.getAttribute('href') || '';
        if (!title || title.length < 2 || !href) return;
        const key = `${title}@@${href}`;
        if (seen.has(key)) return;
        seen.add(key);

        let absoluteHref = href;
        try {
          absoluteHref = new URL(href, location.origin).toString();
        } catch (e) {
          // 忽略 URL 解析失败，保留原链接
        }
        titles.push({ title, href: absoluteHref });
      });
    });

    return titles.slice(0, 20);
  }

  async function fetchUserHistory(userKey, searchUrl) {
    const now = Date.now();
    const cached = historyCache.get(userKey);
    if (cached && now - cached.ts < HISTORY_CACHE_TTL) return cached.data;
    if (!searchUrl) return [];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const resp = await fetch(searchUrl, {
        credentials: 'include',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const titles = extractThreadTitles(doc);
      historyCache.set(userKey, { ts: now, data: titles });
      return titles;
    } catch (e) {
      console.warn('获取用户历史失败:', e);
      return [];
    }
  }

  function ensureCard() {
    ensureStyle();
    if (cardEl) return cardEl;

    const el = document.createElement('div');
    el.className = 'tm-card';
    el.style.position = 'fixed';
    el.style.zIndex = String(ZINDEX_CARD);
    el.style.width = '360px';
    el.style.maxWidth = 'calc(100vw - 24px)';
    el.style.maxHeight = '62vh';
    el.style.overflow = 'auto';
    el.style.padding = '12px';
    el.style.display = 'none';

    el.addEventListener('mouseenter', () => clearTimeout(hideCardTimer));
    el.addEventListener('mouseleave', () => scheduleHideCard());

    document.body.appendChild(el);
    cardEl = el;
    return el;
  }

  function scheduleHideCard() {
    clearTimeout(hideCardTimer);
    hideCardTimer = window.setTimeout(() => {
      if (cardEl) cardEl.style.display = 'none';
      activeAnchor = null;
    }, CARD_HIDE_DELAY_MS);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderHistoryList(history, expanded) {
    if (!history.length) return '<div class="tm-sub">未抓取到历史发帖标题</div>';

    const list = expanded ? history : history.slice(0, HISTORY_PREVIEW_COUNT);
    const html = list
      .map(
        (item) =>
          `<li style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"><a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer" style="color:#355f9f;text-decoration:none;">${escapeHtml(item.title)}</a></li>`
      )
      .join('');

    return `<ol class="tm-list">${html}</ol>`;
  }

  function renderCardLoading(userName, uid) {
    const el = ensureCard();
    el.innerHTML = `
      <div class="tm-title">${escapeHtml(userName || '未知用户')} ${uid ? `(UID: ${uid})` : ''}</div>
      <div class="tm-sub" style="margin-top:6px;">正在加载历史发帖...</div>
    `;
  }

  function renderCardContent(userName, uid, history, expanded) {
    const el = ensureCard();
    const blocked = isBlocked(userName, uid);

    el.innerHTML = `
      <div class="tm-title">${escapeHtml(userName || '未知用户')} ${uid ? `(UID: ${uid})` : ''}</div>
      <div class="tm-sub" style="margin-top:6px;">状态：${blocked ? '已拉黑' : '未拉黑'} · 历史发帖 ${history.length}</div>

      <div class="tm-section">
        ${renderHistoryList(history, expanded)}
      </div>

      <div class="tm-section" style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="tm-btn tm-btn-primary" data-action="blacklist" ${blocked ? 'disabled' : ''}>一键拉黑</button>
        <button class="tm-btn" data-action="unblacklist" ${blocked ? '' : 'disabled'}>取消拉黑</button>
        ${history.length > HISTORY_PREVIEW_COUNT ? `<button class="tm-btn" data-action="toggle">${expanded ? '收起' : '展开全部'}</button>` : ''}
      </div>
    `;
  }

  function positionCard(x, y) {
    const el = ensureCard();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const margin = 10;

    lastCardPoint = { x, y };

    // 使用缓存的尺寸或首次测量
    if (!cachedCardSize) {
      el.style.display = 'block';
      el.style.left = `${x + margin}px`;
      el.style.top = `${y + margin}px`;
      cachedCardSize = {
        width: el.offsetWidth,
        height: el.offsetHeight
      };
    }

    let left = x + margin;
    let top = y + margin;

    // 使用缓存尺寸进行边界检查
    if (left + cachedCardSize.width > vw - 6) left = Math.max(6, x - cachedCardSize.width - margin);
    if (top + cachedCardSize.height > vh - 6) top = Math.max(6, vh - cachedCardSize.height - 6);
    if (top < 6) top = 6;
    if (left < 6) left = 6;

    el.style.display = 'block';
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  async function showHoverCard(anchor, evt) {
    const userName = (anchor.textContent || '').trim();
    const uid = parseUidFromHref(anchor.getAttribute('href') || anchor.href || '');
    const searchUrl = getSearchUrlFromAnchor(anchor);
    const userKey = `${uid || ''}::${normalizeName(userName)}`;

    activeAnchor = anchor;
    cachedCardSize = null; // 重置缓存以适应新内容
    renderCardLoading(userName, uid);
    positionCard(evt.clientX, evt.clientY);

    let expanded = false;
    let history = [];

    try {
      history = await fetchUserHistory(userKey, searchUrl);
    } catch (e) {
      history = [];
    }

    if (activeAnchor !== anchor) return;

    cachedCardSize = null; // 内容变化后重置缓存
    renderCardContent(userName, uid, history, expanded);
    positionCard(evt.clientX, evt.clientY);

    const el = ensureCard();
    el.onclick = (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-action');

      if (action === 'blacklist') {
        addToBlacklist(userName, uid);
        renderCardContent(userName, uid, history, expanded);
        renderManagerPanel();
      } else if (action === 'unblacklist') {
        removeFromBlacklist(userName, uid);
        renderCardContent(userName, uid, history, expanded);
        renderManagerPanel();
      } else if (action === 'toggle') {
        expanded = !expanded;
        cachedCardSize = null; // 展开/收起时重置缓存
        renderCardContent(userName, uid, history, expanded);
        positionCard(lastCardPoint.x, lastCardPoint.y);
      }
    };
  }

  function bindHoverCards() {
    const anchors = document.querySelectorAll('a[href*="search="], a[href*="uid="], a[href*="touid="], a[href*="authorid="]');
    anchors.forEach((a) => {
      if (a.dataset.tmBlacklistHoverBound === '1') return;

      // 排除分页链接：检查是否包含 page= 或父元素是否为分页区域
      const href = a.getAttribute('href') || '';
      if (/page=/i.test(href) || a.closest('.pages, .pagination, [class*="page"]')) {
        return;
      }

      // 排除 search=today 等非用户搜索链接
      if (/search=(today|digest|hot)/i.test(href)) {
        return;
      }

      // 排除文本为"下一页"、"上一页"、纯数字等分页按钮
      const text = (a.textContent || '').trim();
      if (/^(下一页|上一頁|上一页|下一頁|首页|尾页|首頁|尾頁|\d+|»|«|>|<|\.\.\.|\[|\])$/i.test(text)) {
        return;
      }

      a.dataset.tmBlacklistHoverBound = '1';

      a.addEventListener('mouseenter', (evt) => {
        clearTimeout(hideCardTimer);
        showHoverCard(a, evt);
      });

      a.addEventListener('mousemove', (evt) => {
        // 限流：只在卡片已显示且锚点匹配时更新位置
        if (activeAnchor === a && cardEl && cardEl.style.display !== 'none') {
          positionCard(evt.clientX, evt.clientY);
        }
      });

      a.addEventListener('mouseleave', () => scheduleHideCard());
    });
  }

  function isInBlacklistScope(node) {
    if (!node || !(node instanceof Element)) return false;
    return !!node.closest('#tbody, div.t.t2, .tpc_content, #conttpc, .tpc_content.do_not_catch');
  }

  function getObserveRoots() {
    const roots = [
      document.getElementById('tbody'),
      ...Array.from(document.querySelectorAll('div.t.t2')),
      ...Array.from(document.querySelectorAll('#conttpc, .tpc_content, .tpc_content.do_not_catch')),
    ].filter(Boolean);
    if (!roots.length && document.body) roots.push(document.body);
    return roots;
  }

  let timer = 0;
  const observer = new MutationObserver((mutations) => {
    if (isApplying) return;
    const hit = mutations.some((m) => {
      if (m.type !== 'childList') return false;
      if (m.target && isInBlacklistScope(m.target)) return true;
      for (const n of m.addedNodes) {
        if (n instanceof Element && isInBlacklistScope(n)) return true;
      }
      return false;
    });
    if (!hit) return;

    clearTimeout(timer);
    timer = window.setTimeout(() => {
      applyAll();
      refreshObserverRoots();
    }, DEBOUNCE_APPLY_MS);
  });

  function refreshObserverRoots() {
    observer.disconnect();
    const roots = getObserveRoots();
    roots.forEach((root) => observer.observe(root, { childList: true, subtree: true }));
  }

  refreshObserverRoots();

  // 初始化时构建关键词正则
  rebuildKeywordRegex();
  applyAll();
})();

