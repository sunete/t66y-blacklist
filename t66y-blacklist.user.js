// ==UserScript==
// @name         Discuz 黑名单屏蔽（t66y）
// @namespace    https://t66y.com/
// @version      2.0.0
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

  const STORAGE_KEY = '__t66y_blacklist_v2__';
  const HISTORY_CACHE_TTL = 10 * 60 * 1000;
  const HISTORY_PREVIEW_COUNT = 5;

  // 初始黑名单（仅首次运行时作为默认值导入）
  const CONFIG = {
    initialBlockedUsernames: [],
    initialBlockedUids: ['123456', '654321'],
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
  const MANAGER_PAGE_SIZE = 10;
  let isManagerComposing = false;

  const blacklist = loadBlacklist();

  function normalizeName(name) {
    return String(name || '').replace(/\s+/g, '').trim().toLowerCase();
  }

  function normalizeUid(uid) {
    return String(uid || '').trim();
  }

  function parseUidFromHref(href) {
    if (!href) return '';
    try {
      const url = new URL(href, location.origin);
      const keys = ['uid', 'touid', 'search', 'authorid'];
      for (const key of keys) {
        const value = url.searchParams.get(key);
        if (value && /^\d+$/.test(value)) return value;
      }
    } catch (e) {
      // 忽略 URL 解析失败，继续走正则兜底
    }
    const m = String(href).match(/(?:uid|touid|search|authorid)=(\d+)/i);
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
        };
      }
    } catch (e) {
      // 忽略损坏数据，回退默认
    }

    const initial = {
      usernames: new Set((CONFIG.initialBlockedUsernames || []).map(normalizeName).filter(Boolean)),
      uids: new Set((CONFIG.initialBlockedUids || []).map(normalizeUid).filter(Boolean)),
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
      })
    );
  }

  function isBlocked(username, uid) {
    const uname = normalizeName(username);
    const u = normalizeUid(uid);
    return (!!uname && blacklist.usernames.has(uname)) || (!!u && blacklist.uids.has(u));
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

  function clearBlacklist() {
    blacklist.usernames.clear();
    blacklist.uids.clear();
    persistBlacklist(blacklist);
    applyAll();
  }

  function exportBlacklistText() {
    return JSON.stringify(
      {
        usernames: Array.from(blacklist.usernames),
        uids: Array.from(blacklist.uids),
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
      return { ok: false, message: '导入失败：JSON 格式无效' };
    }

    const usernames = Array.isArray(parsed.usernames) ? parsed.usernames : [];
    const uids = Array.isArray(parsed.uids) ? parsed.uids : [];

    blacklist.usernames = new Set(usernames.map(normalizeName).filter(Boolean));
    blacklist.uids = new Set(uids.map(normalizeUid).filter(Boolean));
    persistBlacklist(blacklist);
    applyAll();
    return { ok: true, message: `导入成功：用户名 ${blacklist.usernames.size}，UID ${blacklist.uids.size}` };
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

  function applyPostPageBlacklist() {
    const postBlocks = document.querySelectorAll('div.t.t2');
    if (!postBlocks.length) return;

    postBlocks.forEach((block) => {
      const userName = (block.querySelector('tr.tr1.do_not_catch > th b')?.textContent || '').trim();
      let uid = '';
      const links = block.querySelectorAll('.tiptop a[href*="uid="], .tiptop a[href*="touid="], .tiptop a[href*="search="]');
      for (const link of links) {
        uid = parseUidFromHref(link.getAttribute('href') || link.href);
        if (uid) break;
      }

      const blocked = isBlocked(userName, uid);
      const prev = block.previousElementSibling;
      if (prev && prev.tagName === 'A' && prev.getAttribute('name')) {
        setElementBlocked(prev, blocked);
      }
      setElementBlocked(block, blocked);
    });
  }

  function applyThreadListBlacklist() {
    const tbody = document.getElementById('tbody');
    if (!tbody) return;

    const rows = Array.from(tbody.children).filter((el) => el.tagName === 'TR');
    rows.forEach((row) => {
      const authorLink = row.querySelector('td:nth-child(3) a[href*="search="]');
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
      .tm-card { 
        --bg1: #f6fbff;
        --bg2: #edf6ff;
        --brand: #3a76d2;
        --brand-soft: #6ea1ea;
        --text: #1f2a37;
        --muted: #5f6b7a;
        background: linear-gradient(150deg, var(--bg1), var(--bg2));
        border: 1px solid rgba(96, 132, 184, 0.25);
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(55, 97, 160, 0.16), inset 0 1px 0 rgba(255,255,255,0.7);
        backdrop-filter: blur(6px);
        color: var(--text);
      }
      .tm-title { font-size: 13px; font-weight: 600; letter-spacing: .1px; }
      .tm-sub { font-size: 12px; color: var(--muted); }
      .tm-btn {
        border: 1px solid rgba(76, 118, 180, 0.26);
        border-radius: 999px;
        padding: 4px 10px;
        background: rgba(255,255,255,0.86);
        color: #2d4f82;
        font-size: 12px;
        cursor: pointer;
        transition: all .18s ease;
      }
      .tm-btn:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 5px 12px rgba(66, 110, 171, .2);
        border-color: rgba(58,118,210,.5);
      }
      .tm-btn:disabled { opacity: .5; cursor: not-allowed; }
      .tm-btn-primary {
        background: linear-gradient(135deg, var(--brand), var(--brand-soft));
        color: #fff;
        border-color: transparent;
      }
      .tm-section { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(76,118,180,.15); }
      .tm-list { margin: 6px 0 0 18px; padding: 0; }
      .tm-list li { margin: 4px 0; }
      .tm-textarea {
        width: 100%; min-height: 100px; resize: vertical;
        border: 1px solid rgba(76,118,180,.22);
        border-radius: 10px;
        padding: 8px;
        font-size: 12px;
        line-height: 1.45;
        color: #243549;
        background: rgba(255,255,255,.92);
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
    el.style.zIndex = '2147483646';
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
    el.style.zIndex = '2147483646';
    el.style.width = '420px';
    el.style.maxWidth = 'calc(100vw - 24px)';
    el.style.maxHeight = '68vh';
    el.style.overflow = 'auto';
    el.style.padding = '12px';
    el.style.display = 'none';

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
      } else if (action === 'clear-all') {
        clearBlacklist();
        renderManagerPanel();
      } else if (action === 'copy-export') {
        const ta = el.querySelector('textarea[data-role="backup"]');
        if (ta instanceof HTMLTextAreaElement) {
          ta.select();
          document.execCommand('copy');
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
      } else if (action === 'clear-search') {
        managerQuery = '';
        managerNamePage = 1;
        managerUidPage = 1;
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
      if (!(target instanceof HTMLInputElement)) return;
      if (target.getAttribute('data-role') !== 'manager-search') return;
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const firstRemoveBtn = el.querySelector('button[data-action="remove-name"], button[data-action="remove-uid"]');
      if (firstRemoveBtn instanceof HTMLElement) firstRemoveBtn.focus();
    });

    document.body.appendChild(el);
    managerEl = el;
    return el;
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

    const namePageCount = Math.max(1, Math.ceil(names.length / MANAGER_PAGE_SIZE));
    const uidPageCount = Math.max(1, Math.ceil(uids.length / MANAGER_PAGE_SIZE));
    managerNamePage = Math.min(managerNamePage, namePageCount);
    managerUidPage = Math.min(managerUidPage, uidPageCount);

    const nameStart = (managerNamePage - 1) * MANAGER_PAGE_SIZE;
    const uidStart = (managerUidPage - 1) * MANAGER_PAGE_SIZE;
    const nameItems = names.slice(nameStart, nameStart + MANAGER_PAGE_SIZE);
    const uidItems = uids.slice(uidStart, uidStart + MANAGER_PAGE_SIZE);

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

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <div class="tm-title">黑名单管理</div>
        <button class="tm-btn" data-action="close-manager">关闭</button>
      </div>

      <div class="tm-sub" style="margin-top:4px;">单一黑名单源：拉黑、取消、导入、导出均作用于同一份数据。</div>
      <div class="tm-section">
        <div style="display:flex;gap:8px;align-items:center;">
          <input class="tm-textarea" style="min-height:auto;height:34px;flex:1;" data-role="manager-search" value="${escapeHtml(
            managerQuery
          )}" placeholder="搜索用户名或UID（按 Enter 聚焦结果）" />
          <button class="tm-btn" data-action="clear-search" ${managerQuery ? '' : 'disabled'}>清空</button>
        </div>
        <div class="tm-sub" style="margin-top:6px;">过滤命中：用户名 ${names.length}，UID ${uids.length}</div>
      </div>

      <div class="tm-section">
        <div class="tm-title">用户名（${names.length}）</div>
        <ul class="tm-list">${nameHtml}</ul>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
          <button class="tm-btn" data-action="page-name-prev" ${managerNamePage <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="tm-sub">第 ${managerNamePage} / ${namePageCount} 页</span>
          <button class="tm-btn" data-action="page-name-next" ${managerNamePage >= namePageCount ? 'disabled' : ''}>下一页</button>
        </div>
      </div>

      <div class="tm-section">
        <div class="tm-title">UID（${uids.length}）</div>
        <ul class="tm-list">${uidHtml}</ul>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
          <button class="tm-btn" data-action="page-uid-prev" ${managerUidPage <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="tm-sub">第 ${managerUidPage} / ${uidPageCount} 页</span>
          <button class="tm-btn" data-action="page-uid-next" ${managerUidPage >= uidPageCount ? 'disabled' : ''}>下一页</button>
        </div>
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
    `;
  }

  function toggleManager() {
    const el = ensureManagerPanel();
    if (el.style.display === 'none') {
      renderManagerPanel();
      el.style.display = 'block';
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
    const selectors = ['a[href*="htm_data/"][href*=".html"]', 'a[href*="read.php?tid="]', 'h3 a[href]', 'tr td h3 a[href]'];
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

    const resp = await fetch(searchUrl, { credentials: 'include' });
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const titles = extractThreadTitles(doc);
    historyCache.set(userKey, { ts: now, data: titles });
    return titles;
  }

  function ensureCard() {
    ensureStyle();
    if (cardEl) return cardEl;

    const el = document.createElement('div');
    el.className = 'tm-card';
    el.style.position = 'fixed';
    el.style.zIndex = '2147483647';
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
    }, 180);
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

    let left = x + margin;
    let top = y + margin;
    el.style.display = 'block';

    // 先粗定位，再读取真实尺寸进行二次边界校正，避免展开后超出可视区。
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    const width = el.offsetWidth;
    const height = el.offsetHeight;
    if (left + width > vw - 6) left = Math.max(6, x - width - margin);
    if (top + height > vh - 6) top = Math.max(6, vh - height - 6);
    if (top < 6) top = 6;
    if (left < 6) left = 6;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  async function showHoverCard(anchor, evt) {
    const userName = (anchor.textContent || '').trim();
    const uid = parseUidFromHref(anchor.getAttribute('href') || anchor.href || '');
    const searchUrl = getSearchUrlFromAnchor(anchor);
    const userKey = `${uid || ''}::${normalizeName(userName)}`;

    activeAnchor = anchor;
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
        renderCardContent(userName, uid, history, expanded);
        positionCard(lastCardPoint.x, lastCardPoint.y);
      }
    };
  }

  function bindHoverCards() {
    const anchors = document.querySelectorAll('a[href*="search="], a[href*="uid="], a[href*="touid="]');
    anchors.forEach((a) => {
      if (a.dataset.tmBlacklistHoverBound === '1') return;
      a.dataset.tmBlacklistHoverBound = '1';

      a.addEventListener('mouseenter', (evt) => {
        clearTimeout(hideCardTimer);
        showHoverCard(a, evt);
      });

      a.addEventListener('mousemove', (evt) => {
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
    }, 140);
  });

  function refreshObserverRoots() {
    observer.disconnect();
    const roots = getObserveRoots();
    roots.forEach((root) => observer.observe(root, { childList: true, subtree: true }));
  }

  refreshObserverRoots();

  applyAll();
})();
