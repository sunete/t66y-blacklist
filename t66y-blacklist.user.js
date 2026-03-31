// ==UserScript==
// @name         Discuz 黑名单屏蔽（t66y）
// @namespace    https://t66y.com/
// @version      1.0.0
// @description  按用户名或 UID 屏蔽指定用户的发帖与回帖内容
// @author       local
// @match        *://t66y.com/thread0806.php*
// @match        *://t66y.com/read.php*
// @match        *://t66y.com/htm_data/*/*/*.html*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 在这里维护黑名单（支持用户名和 UID，二选一即可）
  const CONFIG = {
    blockedUsernames: [
      '示例用户A',
      '示例用户B',
    ],
    blockedUids: [
      '123456',
      '654321',
    ],
    // true 时：如果“最后发表人”命中黑名单，也隐藏该主题行
    hideTopicListIfLastReplyByBlocked: false,
  };

  const nameSet = new Set(CONFIG.blockedUsernames.map(normalizeName).filter(Boolean));
  const uidSet = new Set(CONFIG.blockedUids.map(String).map((s) => s.trim()).filter(Boolean));

  function normalizeName(name) {
    return String(name || '').replace(/\s+/g, '').trim().toLowerCase();
  }

  function parseUidFromHref(href) {
    if (!href) {
      return '';
    }

    try {
      const url = new URL(href, location.origin);
      const keys = ['uid', 'touid', 'search', 'authorid'];
      for (const key of keys) {
        const value = url.searchParams.get(key);
        if (value && /^\d+$/.test(value)) {
          return value;
        }
      }
    } catch (e) {
      // 忽略 URL 解析失败，继续走正则兜底
    }

    const m = String(href).match(/(?:uid|touid|search|authorid)=(\d+)/i);
    return m ? m[1] : '';
  }

  function isBlocked(username, uid) {
    const uname = normalizeName(username);
    const u = String(uid || '').trim();
    return (!!u && uidSet.has(u)) || (!!uname && nameSet.has(uname));
  }

  function hideElement(el) {
    if (!el || el.dataset.tmBlacklistHidden === '1') {
      return;
    }
    el.style.display = 'none';
    el.dataset.tmBlacklistHidden = '1';
  }

  function applyPostPageBlacklist() {
    const postBlocks = document.querySelectorAll('div.t.t2');
    if (!postBlocks.length) {
      return;
    }

    postBlocks.forEach((block) => {
      const userName = (block.querySelector('tr.tr1.do_not_catch > th b')?.textContent || '').trim();

      let uid = '';
      const links = block.querySelectorAll(
        '.tiptop a[href*="uid="], .tiptop a[href*="touid="], .tiptop a[href*="search="]'
      );

      for (const link of links) {
        uid = parseUidFromHref(link.getAttribute('href') || link.href);
        if (uid) {
          break;
        }
      }

      if (isBlocked(userName, uid)) {
        const prev = block.previousElementSibling;
        if (prev && prev.tagName === 'A' && prev.getAttribute('name')) {
          hideElement(prev);
        }
        hideElement(block);
      }
    });
  }

  function applyThreadListBlacklist() {
    const tbody = document.getElementById('tbody');
    if (!tbody) {
      return;
    }

    const rows = Array.from(tbody.children).filter((el) => el.tagName === 'TR');
    rows.forEach((row) => {
      const authorLink = row.querySelector('td:nth-child(3) a[href*="search="]');
      if (!authorLink) {
        return;
      }

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

      if (shouldHide) {
        hideElement(row);
      }
    });
  }

  function applyAll() {
    applyPostPageBlacklist();
    applyThreadListBlacklist();
  }

  let timer = 0;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(applyAll, 120);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  applyAll();
})();
