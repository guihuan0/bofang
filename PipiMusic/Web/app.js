/* ============================================================
   PipiMusic — 前端逻辑
   ============================================================ */

(function () {
  'use strict';

  // ---------------------------------------------------------- DOM
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const audio       = $('#audio');
  const elSearch    = $('#searchInput');
  const elSearchBtn = $('#searchBtn');
  const elHero      = $('#hero');
  const elSearchHead= $('#searchHead');
  const elSearchTtl = $('#searchTitle');
  const elSearchMeta= $('#searchMeta');
  const elSearchList= $('#searchList');
  const elTopList   = $('#topList');
  const elFavList   = $('#favList');
  const elHisList   = $('#historyList');
  const elFavCount  = $('#favCount');
  const elFavMeta   = $('#favMeta');
  const elNowTitle  = $('#nowTitle');
  const elNowArtist = $('#nowArtist');
  const elNowCover  = $('#nowCover');
  const elFavBtn    = $('#favBtn');
  const elSeekBar   = $('#seekBar');
  const elSeekFill  = $('#seekFill');
  const elSeekKnob  = $('#seekKnob');
  const elTCur      = $('#tCur');
  const elTDur      = $('#tDur');
  const elVolBar    = $('#volBar');
  const elVolFill   = $('#volFill');
  const elMute      = $('#btnMute');
  const elToast     = $('#toast');
  const elLyricList = $('#lyricList');
  const elLyricBody = $('#lyricBody');
  const elLyricEmpty= $('#lyricEmpty');
  const elMiniEq    = $('#miniEq');
  const elSideTip   = $('#sideTip');
  const elDisc      = $('#disc');

  // ---------------------------------------------------------- state
  const state = {
    view: 'search',
    queue: [],
    index: -1,
    current: null,
    lyrics: [],
    lyricIdx: -1,
    favs: [],
    loop: false,
    visible: false,
    source: 'vipp3',
    sources: [],
  };

  let toastTimer = null;

  function toast(msg, isErr) {
    elToast.textContent = msg;
    elToast.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { elToast.className = 'toast'; }, 2600);
  }

  function api(path, opts) {
    return fetch(path, opts || {}).then((r) => r.json());
  }

  function postJSON(path, obj, method) {
    return fetch(path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    }).then((r) => r.json());
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function coverURL(u) {
    if (!u) return '';
    // iOS 没有本地图片代理，直接交给 WebView 加载原图
    if (window.__PIPI_IOS__) return u;
    return '/img?u=' + encodeURIComponent(u);
  }

  function favKey(it) {
    return (it.id || '') + '|' + (it.title || '') + '|' + (it.artist || '');
  }

  function isFav(it) {
    if (!it) return false;
    const k = favKey(it);
    return state.favs.some((x) => favKey(x) === k);
  }

  // ---------------------------------------------------------- 音源
  const elSourceBar = $('#sourceBar');

  function loadSources() {
    api('/api/sources')
      .then((res) => {
        state.sources = res.items || [];
        state.source = res.default || 'vipp3';
        renderSources();
      })
      .catch(() => {});
  }

  function renderSources() {
    elSourceBar.innerHTML = '';
    state.sources.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'source-chip' + (s.id === state.source ? ' active' : '');
      b.dataset.source = s.id;
      b.innerHTML = '<span class="dot"></span><span></span>';
      b.querySelector('span:last-child').textContent = s.label;
      b.addEventListener('click', () => {
        if (state.source === s.id) return;
        state.source = s.id;
        renderSources();
        elSideTip.textContent = '音源：' + s.label;
        // 换了源就重搜当前关键词，避免看到上个源的结果
        const kw = elSearch.value.trim();
        if (kw && state.view === 'search') doSearch(kw);
        if (state.view === 'top') loadTop(topWhich);
      });
      elSourceBar.appendChild(b);
    });
  }

  function currentSource() {
    return state.source || 'vipp3';
  }

  // ---------------------------------------------------------- 下载
  const dlActive = {};

  function fmtMB(n) {
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  function downloadSong(item) {
    if (!item || !item.title) {
      toast('不知道要下载哪首', true);
      return;
    }
    const key = (item.id || '') + '|' + item.title;
    if (dlActive[key]) {
      toast('这首正在下载中');
      return;
    }
    dlActive[key] = true;
    elSideTip.textContent = '正在优选最高音质…';
    toast('正在比较各音源音质…');

    postJSON('/api/download', {
      id: item.id,
      title: item.title || item.raw || '',
      artist: item.artist || '',
      source: item.source || currentSource(),
    })
      .then((res) => {
        if (!res.ok) {
          delete dlActive[key];
          toast(res.error || '下载失败', true);
          elSideTip.textContent = '下载失败';
          return;
        }
        const cand = res.candidates || [];
        const best = cand[0];
        toast('最高音质 ' + fmtMB(res.size) + '（' + (best ? best.source : res.source) + '）');
        pollDownload(res.task, key);
      })
      .catch((e) => {
        delete dlActive[key];
        toast('下载请求失败：' + e.message, true);
      });
  }

  function pollDownload(tid, key) {
    let lastPct = -1;
    const timer = setInterval(() => {
      api('/api/download/status?task=' + encodeURIComponent(tid))
        .then((res) => {
          if (!res.ok) {
            clearInterval(timer);
            if (key) delete dlActive[key];
            return;
          }
          const j = res.job;
          if (j.status === 'running') {
            const pct = Math.floor(j.percent);
            if (pct !== lastPct) {
              lastPct = pct;
              elSideTip.textContent = '下载中 ' + pct + '%';
              toast('下载中 ' + pct + '% · ' + fmtMB(j.done) + ' / ' + fmtMB(j.total));
            }
            return;
          }
          clearInterval(timer);
          if (key) delete dlActive[key];
          if (j.status === 'done') {
            elSideTip.textContent = '已下载';
            toast('已保存：' + j.name);
          } else if (j.status === 'cancelled') {
            toast('已取消');
          } else {
            elSideTip.textContent = '下载失败';
            toast('下载失败：' + (j.error || '未知错误'), true);
          }
        })
        .catch(() => {
          clearInterval(timer);
          if (key) delete dlActive[key];
        });
    }, 350);
  }

  // 播放条上的下载按钮
  const elDlBtn = $('#dlBtn');
  if (elDlBtn) {
    elDlBtn.addEventListener('click', () => {
      if (!state.current) {
        toast('还没有在播放的歌');
        return;
      }
      downloadSong(state.current);
    });
  }

  // ---------------------------------------------------------- 已下载
  const elDlList = $('#dlList');
  const elDlMeta = $('#dlMeta');
  const elDlBadge = $('#dlBadge');
  let dlFiles = [];

  function fmtSize(n) {
    if (!n) return '';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDate(ts) {
    const d = new Date((ts || 0) * 1000);
    const p = (x) => (x < 10 ? '0' + x : x);
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function loadDownloads() {
    return api('/api/downloads')
      .then((res) => {
        dlFiles = res.items || [];
        elDlBadge.textContent = dlFiles.length;
        elDlMeta.textContent = dlFiles.length ? dlFiles.length + ' 个文件' : '';
        renderDownloads();
      })
      .catch(() => {});
  }

  function renderDownloads() {
    elDlList.innerHTML = '';
    if (!dlFiles.length) {
      const e = document.createElement('div');
      e.className = 'pl-empty';
      e.innerHTML = '<b>还没有下载过歌曲</b>' +
        '在搜索结果或播放条上点 ↓ 就能下载，会自动挑最高音质';
      elDlList.appendChild(e);
      return;
    }
    dlFiles.forEach((f, i) => elDlList.appendChild(buildDlRow(f, i)));
    paintDlPlaying();
  }

  function buildDlRow(f, i) {
    const row = document.createElement('div');
    row.className = 'dl-row';
    row.dataset.name = f.name;

    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = i + 1;

    const info = document.createElement('div');
    info.className = 'info';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = f.title || f.name;
    const a = document.createElement('div');
    a.className = 'a';
    a.textContent = f.artist || '未知歌手';
    info.appendChild(t);
    info.appendChild(a);

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = f.ext || 'mp3';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = fmtSize(f.size) + '<br>' + fmtDate(f.mtime);

    const act = document.createElement('div');
    act.className = 'act';

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = '删除文件';
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDownload(f);
    });
    act.appendChild(del);

    row.appendChild(idx);
    row.appendChild(info);
    row.appendChild(tag);
    row.appendChild(meta);
    row.appendChild(act);

    row.addEventListener('click', () => playLocal(f));
    return row;
  }

  function paintDlPlaying() {
    const cur = state.current;
    const name = cur && cur.local ? cur.local : '';
    $$('.dl-row').forEach((r) => {
      r.classList.toggle('playing', !!name && r.dataset.name === name);
    });
  }

  function playLocal(f) {
    state.queue = [];
    state.index = -1;
    state.current = {
      id: 'local:' + f.name,
      title: f.title || f.name,
      artist: f.artist || '本地文件',
      cover: '',
      lkid: '',
      source: 'local',
      local: f.name,
    };

    elNowTitle.textContent = state.current.title;
    elNowArtist.textContent = state.current.artist;
    elNowCover.removeAttribute('src');
    elNowCover.style.display = 'none';
    elSideTip.textContent = '本地播放';
    syncFavBtn();

    state.lyrics = [];
    state.lyricIdx = -1;
    elLyricList.innerHTML = '';
    elLyricEmpty.style.display = '';
    elLyricEmpty.textContent = '正在找歌词…';

    if (window.__PIPI_IOS__) {
      audio.src = 'pipilocal://local/' + encodeURIComponent(f.name);
    } else {
      audio.src = '/local/' + encodeURIComponent(f.name);
    }
    audio.play().catch(() => {});
    document.body.classList.add('playing');
    document.body.classList.add('spinning');
    elMiniEq.classList.add('on');

    paintPlaying();
    loadLocalLyric(f);
  }

  function loadLocalLyric(f) {
    if (!f.title) {
      elLyricEmpty.textContent = '这首歌暂无歌词';
      return;
    }
    const q = '/api/lyric/search?title=' + encodeURIComponent(f.title) +
              '&artist=' + encodeURIComponent(f.artist || '') +
              '&source=' + encodeURIComponent(currentSource());
    fetch(q)
      .then((r) => r.json())
      .then((res) => {
        // 期间可能已经切歌了
        if (!state.current || !state.current.local || state.current.local !== f.name) return;
        const lines = (res && res.lines) || [];
        if (!lines.length) {
          elLyricEmpty.textContent = '这首歌暂无歌词';
          return;
        }
        state.lyrics = lines;
        state.lyricIdx = -1;
        renderLyrics();
      })
      .catch(() => {
        if (!state.current || state.current.local !== f.name) return;
        elLyricEmpty.textContent = '歌词没找到';
      });
  }

  function deleteDownload(f) {
    fetch('/api/downloads', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: f.name }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '删除失败', true);
          return;
        }
        toast('已删除 ' + (f.title || f.name));
        loadDownloads();
      });
  }

  const elDlOpen = $('#dlOpenFolder');
  if (elDlOpen) {
    elDlOpen.addEventListener('click', () => {
      fetch('/api/download/open', { method: 'POST' })
        .then((r) => r.json())
        .then((res) => {
          if (!res.ok) toast('打不开文件夹', true);
        });
    });
  }

  const elDlRefresh = $('#dlRefresh');
  if (elDlRefresh) {
    elDlRefresh.addEventListener('click', () => {
      loadDownloads().then(() => toast('已刷新'));
    });
  }

  // ---------------------------------------------------------- 视图切换
  function switchView(name) {
    state.view = name;
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'fav') loadFavs();
    if (name === 'history') loadHistory();
    if (name === 'playlist') loadPlaylists();
    if (name === 'downloads') loadDownloads();
    if (name === 'top' && elTopList.children.length === 0) loadTop('new');
  }

  $$('.nav-item').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  // ---------------------------------------------------------- 列表渲染
  function placeholderCover() {
    const d = document.createElement('div');
    d.className = 'cov';
    d.innerHTML = '<svg viewBox="0 0 24 24" style="width:18px;height:18px;stroke:#4a5568">' +
                  '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/>' +
                  '<circle cx="16.5" cy="16" r="2.5"/></svg>';
    return d;
  }

  function buildRow(item, idx, opts) {
    const row = document.createElement('div');
    row.className = 'song';
    row.dataset.id = item.id;
    row.dataset.key = favKey(item);
    row.style.animationDelay = Math.min(idx * 12, 260) + 'ms';

    // 序号
    const n = document.createElement('div');
    n.className = 'idx';
    n.textContent = idx + 1;
    row.appendChild(n);

    // 封面
    let cov;
    if (item.cover) {
      cov = document.createElement('img');
      cov.className = 'cov';
      cov.src = coverURL(item.cover);
      cov.loading = 'lazy';
      cov.onerror = function () {
        const ph = placeholderCover();
        if (cov.parentNode) cov.parentNode.replaceChild(ph, cov);
      };
    } else {
      cov = placeholderCover();
    }
    row.appendChild(cov);

    // 文本
    const meta = document.createElement('div');
    meta.className = 'meta';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = item.title || item.raw || '未知歌曲';
    const a = document.createElement('div');
    a.className = 'a';
    a.innerHTML = '<span class="artist"></span><em class="dot">·</em><em class="fmt">MP3</em>';
    a.querySelector('.artist').textContent = item.artist || '未知歌手';
    meta.appendChild(t);
    meta.appendChild(a);
    row.appendChild(meta);

    // 操作
    const act = document.createElement('div');
    act.className = 'act';

    const fav = document.createElement('button');
    fav.className = 'icon-btn fav' + (isFav(item) ? ' on' : '');
    fav.title = '收藏';
    fav.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.35-7-9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7 3.5C19 15.65 12 20 12 20z"/></svg>';
    fav.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(item, fav);
    });

    const down = document.createElement('button');
    down.className = 'icon-btn dl';
    down.title = '下载（自动挑最高音质）';
    down.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>';
    down.addEventListener('click', (e) => {
      e.stopPropagation();
      downloadSong(item);
    });

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = '从列表移除';
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromCurrentView(item);
    });

    act.appendChild(fav);
    act.appendChild(down);
    if (!(opts && opts.noRemove)) act.appendChild(del);
    row.appendChild(act);

    row.addEventListener('click', () => {
      const q = opts && opts.queue ? opts.queue : state.queue;
      playItem(item, q);
    });

    return row;
  }

  function renderList(container, items, opts) {
    container.innerHTML = '';
    if (!items || items.length === 0) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = '<b>' + (opts && opts.emptyTitle ? opts.emptyTitle : '这里还是空的') + '</b>' +
                    (opts && opts.emptyHint ? opts.emptyHint : '');
      container.appendChild(e);
      return;
    }
    const frag = document.createDocumentFragment();
    items.forEach((it, i) => frag.appendChild(buildRow(it, i, opts)));
    container.appendChild(frag);
    paintPlaying();
  }

  function skeleton(container, n) {
    container.innerHTML = '';
    for (let i = 0; i < (n || 8); i++) {
      const d = document.createElement('div');
      d.className = 'sk';
      container.appendChild(d);
    }
  }

  function paintPlaying() {
    const curId = state.current ? state.current.id : '';
    $$('.song').forEach((r) => {
      r.classList.toggle('playing', !!curId && r.dataset.id === curId);
    });
    paintPlaylistPlaying();
    paintDlPlaying();
  }

  // ---------------------------------------------------------- 搜索
  function doSearch(kw) {
    kw = (kw || '').trim();
    if (!kw) { elSearch.focus(); return; }

    switchView('search');
    elHero.hidden = true;
    elSearchHead.hidden = false;
    elSearchTtl.textContent = '「' + kw + '」搜索结果';
    elSearchMeta.textContent = '搜索中…';
    skeleton(elSearchList, 9);
    elSideTip.textContent = '搜索中…';

    api('/api/search?q=' + encodeURIComponent(kw) + '&limit=80&source=' +
        encodeURIComponent(currentSource()))
      .then((res) => {
        if (!res.ok) throw new Error(res.error || '搜索失败');
        const items = res.items || [];
        state.queue = items;
        state.index = -1;
        elSearchMeta.textContent = items.length ? items.length + ' 首' : '没有结果';
        elSideTip.textContent = items.length ? '找到 ' + items.length + ' 首' : '没有结果';
        renderList(elSearchList, items, {
          queue: items,
          emptyTitle: '没有找到相关歌曲',
          emptyHint: '换个关键词，或者换个音源再试',
        });
      })
      .catch((e) => {
        elSearchMeta.textContent = '失败';
        elSearchList.innerHTML = '';
        elSideTip.textContent = '搜索失败';
        toast('搜索失败：' + e.message, true);
      });
  }

  elSearchBtn.addEventListener('click', () => doSearch(elSearch.value));
  elSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(elSearch.value);
  });

  $$('#chips button').forEach((b) => {
    b.addEventListener('click', () => {
      elSearch.value = b.dataset.kw;
      doSearch(b.dataset.kw);
    });
  });

  // ---------------------------------------------------------- 榜单
  let topWhich = 'new';

  function loadTop(which) {
    topWhich = which || 'new';
    $$('#topTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.which === topWhich));
    skeleton(elTopList, 9);
    api('/api/top?which=' + topWhich + '&source=' + encodeURIComponent(currentSource()))
      .then((res) => {
        if (!res.ok) throw new Error(res.error || '加载失败');
        const items = res.items || [];
        renderList(elTopList, items, {
          queue: items,
          emptyTitle: '榜单暂无数据',
          emptyHint: '稍后再试',
        });
      })
      .catch((e) => {
        elTopList.innerHTML = '';
        toast('榜单加载失败：' + e.message, true);
      });
  }

  $$('#topTabs .tab').forEach((t) => {
    t.addEventListener('click', () => loadTop(t.dataset.which));
  });

  // ---------------------------------------------------------- 收藏
  function loadFavs() {
    api('/api/fav')
      .then((res) => {
        state.favs = res.items || [];
        elFavCount.textContent = state.favs.length;
        elFavMeta.textContent = state.favs.length ? state.favs.length + ' 首' : '';
        renderList(elFavList, state.favs, {
          queue: state.favs,
          emptyTitle: '还没有收藏',
          emptyHint: '在歌曲右侧点 ♥ 就能收藏',
        });
        syncFavBtn();
      })
      .catch(() => {});
  }

  function toggleFav(item, btnEl) {
    const wasFav = isFav(item);
    postJSON('/api/fav', {
      id: item.id,
      title: item.title || item.raw || '',
      artist: item.artist || '',
      cover: item.cover || '',
      lkid: item.lkid || '',
      source: item.source || currentSource(),
    })
      .then((res) => {
        if (!res.ok) throw new Error(res.error || '操作失败');
        state.favs = res.items || [];
        elFavCount.textContent = state.favs.length;
        elFavMeta.textContent = state.favs.length ? state.favs.length + ' 首' : '';
        toast(wasFav ? '已取消收藏' : '已收藏');
        syncFavBtn();
        $$('.song').forEach((r) => {
          const on = state.favs.some((x) => favKey(x) === r.dataset.key);
          const b = r.querySelector('.icon-btn.fav');
          if (b) b.classList.toggle('on', on);
        });
        if (state.view === 'fav') loadFavs();
      })
      .catch((e) => toast('收藏失败：' + e.message, true));
  }

  function syncFavBtn() {
    const on = state.current && isFav(state.current);
    elFavBtn.classList.toggle('on', !!on);
  }

  elFavBtn.addEventListener('click', () => {
    if (!state.current) { toast('还没有在播放的歌'); return; }
    toggleFav(state.current);
  });

  function removeFromCurrentView(item) {
    const k = favKey(item);
    if (state.view === 'fav') {
      postJSON('/api/fav', {
        id: item.id, title: item.title, artist: item.artist,
        cover: item.cover, lkid: item.lkid,
      }, 'DELETE').then(() => loadFavs());
      return;
    }
    // 其它视图：仅从界面上的当前队列移除
    const box = state.view === 'top' ? elTopList : elSearchList;
    const row = box.querySelector('.song[data-key="' + CSS.escape(k) + '"]');
    if (row) row.remove();
    const q = state.queue.filter((x) => favKey(x) !== k);
    state.queue = q;
    if (state.view === 'top') state.queue = q;
  }

  // ---------------------------------------------------------- 历史
  function loadHistory() {
    api('/api/history')
      .then((res) => {
        const items = res.items || [];
        renderList(elHisList, items, {
          queue: items,
          noRemove: true,
          emptyTitle: '还没有播放记录',
          emptyHint: '播放过的歌会出现在这里',
        });
      })
      .catch(() => {});
  }

  $('#clearHistory').addEventListener('click', () => {
    fetch('/api/history', { method: 'DELETE' })
      .then((r) => r.json())
      .then(() => { loadHistory(); toast('已清空最近播放'); });
  });

  // ---------------------------------------------------------- 歌单导入
  const elPlList = $('#plList');
  const elPlMeta = $('#plMeta');
  const elPlCount = $('#plCount');
  const elImportText = $('#importText');
  const elImportBtn = $('#importBtn');
  const elImportErr = $('#importErr');

  const PLATFORM_LABEL = {
    qq: 'QQ音乐', kugou: '酷狗', qishui: '汽水', kuwo: '酷我', text: '文本',
  };

  function loadPlaylists() {
    api('/api/playlists')
      .then((res) => {
        const items = res.items || [];
        elPlCount.textContent = items.length;
        elPlMeta.textContent = items.length ? items.length + ' 个歌单' : '';
        renderPlaylists(items);
      })
      .catch(() => {});
  }

  function renderPlaylists(items) {
    elPlList.innerHTML = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'pl-empty';
      e.innerHTML = '<b>还没有导入歌单</b>' +
        '把 QQ音乐 / 酷狗 / 汽水 的歌单链接粘到上面，或者直接贴歌曲列表';
      elPlList.appendChild(e);
      return;
    }
    items.forEach((pl) => elPlList.appendChild(buildPlaylistCard(pl)));
    paintPlaylistPlaying();
  }

  function buildPlaylistCard(pl) {
    const card = document.createElement('div');
    card.className = 'pl-card';
    card.dataset.pid = pl.id;

    // 头部
    const head = document.createElement('div');
    head.className = 'pl-head';

    const arrow = document.createElement('div');
    arrow.className = 'pl-arrow';
    arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';

    const name = document.createElement('div');
    name.className = 'pl-name';
    name.textContent = pl.name || '未命名歌单';

    const badge = document.createElement('span');
    badge.className = 'pl-badge';
    badge.textContent = PLATFORM_LABEL[pl.platform] || (pl.platform || '导入');

    const count = document.createElement('span');
    count.className = 'pl-count';
    count.textContent = pl.count + ' 首';

    const actions = document.createElement('div');
    actions.className = 'pl-actions';

    const playAll = document.createElement('button');
    playAll.className = 'icon-btn';
    playAll.title = '播放全部';
    playAll.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5l12 7-12 7z"/></svg>';
    playAll.addEventListener('click', (e) => {
      e.stopPropagation();
      playPlaylistFrom(card, 0);
    });

    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = '删除这个歌单';
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      fetch('/api/playlists', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pl.id }),
      }).then(() => { loadPlaylists(); toast('已删除歌单'); });
    });

    actions.appendChild(playAll);
    actions.appendChild(del);

    head.appendChild(arrow);
    head.appendChild(name);
    head.appendChild(badge);
    head.appendChild(count);
    head.appendChild(actions);

    head.addEventListener('click', () => card.classList.toggle('open'));

    // 歌曲列表
    const body = document.createElement('div');
    body.className = 'pl-body';
    (pl.tracks || []).forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'pl-track';
      row.dataset.title = t.title;
      row.dataset.artist = t.artist || '';

      const n = document.createElement('div');
      n.className = 'n';
      n.textContent = i + 1;

      const ti = document.createElement('div');
      ti.className = 't';
      ti.textContent = t.title;

      const ar = document.createElement('div');
      ar.className = 'a';
      ar.textContent = t.artist || '';

      const st = document.createElement('div');
      st.className = 'st';
      st.textContent = '';

      row.appendChild(n);
      row.appendChild(ti);
      row.appendChild(ar);
      row.appendChild(st);

      row.addEventListener('click', () => playPlaylistTrack(row, card));
      body.appendChild(row);
    });

    card.appendChild(head);
    card.appendChild(body);
    return card;
  }

  // 解析歌单里的某一首（本站搜索），成功返回歌曲对象
  function resolveTrack(title, artist) {
    const q = '/api/resolve?title=' + encodeURIComponent(title) +
              '&artist=' + encodeURIComponent(artist || '') +
              '&source=' + encodeURIComponent(currentSource());
    return fetch(q).then((r) => r.json());
  }

  function playPlaylistTrack(row, card) {
    const st = row.querySelector('.st');
    const title = row.dataset.title;
    const artist = row.dataset.artist;

    // 已经解析过，直接播
    if (row.dataset.songId) {
      playItem({
        id: row.dataset.songId,
        title: row.dataset.songTitle || title,
        artist: row.dataset.songArtist || artist,
      }, []);
      return;
    }

    st.textContent = '查找中';
    st.className = 'st load';

    resolveTrack(title, artist)
      .then((res) => {
        if (!res.ok) {
          st.textContent = '没找到';
          st.className = 'st fail';
          toast('本站没搜到：' + title, true);
          return;
        }
        const s = res.song;
        row.dataset.songId = s.id;
        row.dataset.songTitle = s.title;
        row.dataset.songArtist = s.artist;
        st.textContent = '✓';
        st.className = 'st ok';
        playItem({ id: s.id, title: s.title, artist: s.artist }, []);
      })
      .catch(() => {
        st.textContent = '失败';
        st.className = 'st fail';
      });
  }

  // 播放全部：从第 index 首开始，逐首解析
  function playPlaylistFrom(card, index) {
    const rows = Array.prototype.slice.call(card.querySelectorAll('.pl-track'));
    if (!rows.length) return;
    let i = index || 0;

    function step() {
      if (i >= rows.length) {
        toast('这个歌单播完了');
        return;
      }
      const row = rows[i];
      const st = row.querySelector('.st');
      st.textContent = '查找中';
      st.className = 'st load';

      resolveTrack(row.dataset.title, row.dataset.artist)
        .then((res) => {
          if (!res.ok) {
            st.textContent = '跳过';
            st.className = 'st fail';
            i += 1;
            step();
            return;
          }
          const s = res.song;
          row.dataset.songId = s.id;
          row.dataset.songTitle = s.title;
          row.dataset.songArtist = s.artist;
          st.textContent = '✓';
          st.className = 'st ok';
          playItem({ id: s.id, title: s.title, artist: s.artist }, []);
        })
        .catch(() => {
          st.textContent = '失败';
          st.className = 'st fail';
          i += 1;
          step();
        });
    }
    step();
  }

  function paintPlaylistPlaying() {
    const cur = state.current ? state.current.id : '';
    $$('.pl-track').forEach((r) => {
      r.classList.toggle('playing', !!cur && r.dataset.songId === cur);
    });
  }

  // 导入
  function doImport() {
    const text = elImportText.value.trim();
    elImportErr.hidden = true;
    if (!text) {
      elImportText.focus();
      return;
    }

    elImportBtn.disabled = true;
    elImportBtn.textContent = '解析中…';
    elSideTip.textContent = '解析歌单…';

    postJSON('/api/import', { text: text })
      .then((res) => {
        if (!res.ok) {
          elImportErr.textContent = res.error || '导入失败';
          elImportErr.hidden = false;
          elSideTip.textContent = '导入失败';
          return;
        }
        elImportText.value = '';
        toast('已导入「' + (res.name || '歌单') + '」' + res.count + ' 首');
        elSideTip.textContent = '导入成功';
        loadPlaylists();
        // 自动展开新导入的那个
        setTimeout(() => {
          const c = elPlList.querySelector('.pl-card[data-pid="' + res.id + '"]');
          if (c) c.classList.add('open');
        }, 300);
      })
      .catch((e) => {
        elImportErr.textContent = '请求失败：' + e.message;
        elImportErr.hidden = false;
      })
      .then(() => {
        elImportBtn.disabled = false;
        elImportBtn.textContent = '导入';
      });
  }

  elImportBtn.addEventListener('click', doImport);
  elImportText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doImport();
    }
  });

  // ---------------------------------------------------------- 播放
  function playItem(item, queue) {
    if (!item) return;
    state.current = {
      id: item.id,
      title: item.title || item.raw || '未知歌曲',
      artist: item.artist || '未知歌手',
      cover: item.cover || '',
      lkid: item.lkid || '',
      source: item.source || currentSource(),
    };
    if (queue && queue.length) {
      state.queue = queue;
      state.index = queue.findIndex((x) => x.id === item.id);
    }

    elNowTitle.textContent = state.current.title;
    elNowArtist.textContent = state.current.artist;
    elSideTip.textContent = '加载中…';
    elLyricEmpty.style.display = '';
    elLyricEmpty.textContent = '歌词加载中…';
    elLyricList.innerHTML = '';

    if (state.current.cover) {
      elNowCover.src = coverURL(state.current.cover);
      elNowCover.style.display = '';
    } else {
      elNowCover.removeAttribute('src');
      elNowCover.style.display = 'none';
    }
    syncFavBtn();

    postJSON('/api/play', {
      id: state.current.id,
      title: state.current.title,
      artist: state.current.artist,
      cover: state.current.cover,
      source: state.current.source,
    })
      .then((res) => {
        if (!res.ok) {
          toast(res.error || '这首歌暂时听不了', true);
          elSideTip.textContent = '无法播放';
          elLyricEmpty.textContent = '这首歌暂时听不了';
          document.body.classList.remove('playing');
          return;
        }
        // 补齐封面
        if (res.cover) {
          state.current.cover = res.cover;
          elNowCover.src = coverURL(res.cover);
          elNowCover.style.display = '';
        }
        state.current.lkid = res.lkid || state.current.lkid;

        // 回写队列里的封面（让列表也显示图）
        patchCover(state.current.id, res.cover);
        syncFavBtn();

        audio.src = res.stream;
        audio.play().catch(() => {});
        document.body.classList.add('playing');
        document.body.classList.add('spinning');
        elMiniEq.classList.add('on');
        elSideTip.textContent = '正在播放';

        state.lyrics = res.lines || [];
        renderLyrics();
        paintPlaying();
      })
      .catch((e) => {
        toast('播放失败：' + e.message, true);
        elSideTip.textContent = '播放失败';
      });
  }

  function patchCover(id, cover) {
    if (!cover) return;
    // state.queue
    state.queue.forEach((x) => { if (x.id === id) x.cover = cover; });
    if (state.current && state.current.id === id) state.current.cover = cover;
    // 视图里的行
    $$('.song[data-id="' + CSS.escape(id) + '"]').forEach((row) => {
      const first = row.children[1];
      if (first && first.tagName !== 'IMG') {
        const img = document.createElement('img');
        img.className = 'cov';
        img.src = coverURL(cover);
        img.onerror = function () {
          const ph = placeholderCover();
          if (img.parentNode) img.parentNode.replaceChild(ph, img);
        };
        row.replaceChild(img, first);
      } else if (first) {
        first.src = coverURL(cover);
      }
    });
  }

  function nextSong(dir) {
    const q = state.queue;
    if (!q || q.length === 0) { toast('没有播放队列'); return; }
    let i = state.index;
    if (i < 0) i = 0;
    i = (i + dir + q.length) % q.length;
    state.index = i;
    playItem(q[i], q);
  }

  $('#btnPlay').addEventListener('click', () => {
    if (!audio.src) {
      if (state.queue.length) playItem(state.queue[0], state.queue);
      else toast('先搜一首歌吧');
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });

  $('#btnNext').addEventListener('click', () => nextSong(1));
  $('#btnPrev').addEventListener('click', () => {
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    nextSong(-1);
  });

  $('#btnLoop').addEventListener('click', function () {
    state.loop = !state.loop;
    this.classList.toggle('on', state.loop);
    audio.loop = state.loop;
    toast(state.loop ? '单曲循环开' : '单曲循环关');
  });

  // ---------------------------------------------------------- 歌词
  function renderLyrics() {
    elLyricList.innerHTML = '';
    if (!state.lyrics.length) {
      elLyricEmpty.style.display = '';
      elLyricEmpty.textContent = '这首歌暂无歌词';
      return;
    }
    elLyricEmpty.style.display = 'none';
    const frag = document.createDocumentFragment();
    state.lyrics.forEach((l, i) => {
      const li = document.createElement('li');
      li.textContent = l.text;
      li.dataset.t = l.t;
      li.addEventListener('click', () => {
        if (audio.duration) audio.currentTime = Math.min(l.t, audio.duration - 0.2);
      });
      frag.appendChild(li);
    });
    elLyricList.appendChild(frag);
    state.lyricIdx = -1;
    elLyricBody.scrollTop = 0;
  }

  function syncLyric(t) {
    const ls = state.lyrics;
    if (!ls.length) return;
    let idx = -1;
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].t <= t + 0.15) idx = i;
      else break;
    }
    if (idx === state.lyricIdx) return;
    state.lyricIdx = idx;

    const nodes = elLyricList.children;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove('cur', 'near');
      if (i === idx) nodes[i].classList.add('cur');
      else if (Math.abs(i - idx) === 1) nodes[i].classList.add('near');
    }
    const cur = nodes[idx];
    if (cur) {
      const target = cur.offsetTop - elLyricBody.clientHeight * 0.38;
      elLyricBody.scrollTop = Math.max(0, target);
    }
  }

  $('#lyricToggle').addEventListener('click', () => {
    // iOS 上歌词是上滑抽屉，不走「隐藏一栏」那套
    if (window.__PIPI_IOS__) {
      document.body.classList.toggle('lyric-open');
      return;
    }
    document.body.classList.toggle('no-lyrics');
    $('#lyricToggle').classList.toggle('on', !document.body.classList.contains('no-lyrics'));
  });
  $('#lyricClose').addEventListener('click', () => {
    if (window.__PIPI_IOS__) {
      document.body.classList.remove('lyric-open');
      return;
    }
    document.body.classList.add('no-lyrics');
    $('#lyricToggle').classList.remove('on');
  });

  // ---------------------------------------------------------- 音频事件
  audio.addEventListener('timeupdate', () => {
    const d = audio.duration || 0;
    const c = audio.currentTime || 0;
    const p = d ? (c / d) * 100 : 0;
    elSeekFill.style.width = p + '%';
    elSeekKnob.style.left = p + '%';
    elTCur.textContent = fmtTime(c);
    if (d) elTDur.textContent = fmtTime(d);
    syncLyric(c);
  });

  audio.addEventListener('loadedmetadata', () => {
    elTDur.textContent = fmtTime(audio.duration || 0);
  });

  audio.addEventListener('play', () => {
    document.body.classList.add('playing', 'spinning');
    elMiniEq.classList.add('on');
    elSideTip.textContent = '正在播放';
  });

  audio.addEventListener('pause', () => {
    document.body.classList.remove('playing');
    document.body.classList.remove('spinning');
    elMiniEq.classList.remove('on');
    elSideTip.textContent = '已暂停';
  });

  audio.addEventListener('ended', () => {
    if (state.loop) return;
    if (state.queue.length > 1) nextSong(1);
    else {
      document.body.classList.remove('playing', 'spinning');
      elMiniEq.classList.remove('on');
    }
  });

  // 直链有时效，过期就重新取一次源并从原位置续上
  let repairing = 0;
  audio.addEventListener('error', () => {
    if (!audio.src || !state.current) return;
    if (repairing >= 2) {
      elSideTip.textContent = '播放出错';
      document.body.classList.remove('playing', 'spinning');
      elMiniEq.classList.remove('on');
      toast('音频加载失败，可能链接已过期，重播一次试试', true);
      return;
    }
    const wasPlaying = !audio.paused;
    const pos = audio.currentTime || 0;
    repairing += 1;
    elSideTip.textContent = '重新取源…';

    postJSON('/api/play', {
      id: state.current.id,
      title: state.current.title,
      artist: state.current.artist,
      cover: state.current.cover,
      source: state.current.source,
    })
      .then((res) => {
        if (!res.ok) throw new Error(res.error || '重取失败');
        audio.src = res.stream;
        const resume = () => {
          try { audio.currentTime = pos; } catch (e) {}
          if (wasPlaying) audio.play().catch(() => {});
          elSideTip.textContent = wasPlaying ? '正在播放' : '已暂停';
        };
        audio.addEventListener('loadedmetadata', resume, { once: true });
      })
      .catch((e) => {
        elSideTip.textContent = '播放出错';
        toast('播放失败：' + e.message, true);
      })
      .then(() => {
        setTimeout(() => { if (repairing > 0) repairing -= 1; }, 4000);
      });
  });

  // ---------------------------------------------------------- 进度条拖动
  function ratioFromEvt(el, e) {
    const r = el.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    return Math.max(0, Math.min(1, x));
  }

  let seeking = false;

  function applySeek(e) {
    if (!audio.duration) return;
    const r = ratioFromEvt(elSeekBar, e);
    elSeekFill.style.width = (r * 100) + '%';
    elSeekKnob.style.left = (r * 100) + '%';
    elTCur.textContent = fmtTime(r * audio.duration);
  }

  elSeekBar.addEventListener('mousedown', (e) => {
    if (!audio.duration) return;
    seeking = true;
    applySeek(e);
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (seeking) applySeek(e);
  });

  window.addEventListener('mouseup', (e) => {
    if (!seeking) return;
    seeking = false;
    if (audio.duration) {
      const r = ratioFromEvt(elSeekBar, e);
      audio.currentTime = r * audio.duration;
    }
  });

  // ---------------------------------------------------------- 音量
  let lastVol = 0.7;

  function setVol(v) {
    v = Math.max(0, Math.min(1, v));
    audio.volume = v;
    elVolFill.style.width = (v * 100) + '%';
    elMute.classList.toggle('muted', v === 0);
  }

  audio.volume = 0.7;

  elVolBar.addEventListener('mousedown', (e) => {
    const set = (ev) => setVol(ratioFromEvt(elVolBar, ev));
    set(e);
    const mv = (ev) => set(ev);
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });

  elMute.addEventListener('click', () => {
    if (audio.volume > 0) {
      lastVol = audio.volume;
      setVol(0);
    } else {
      setVol(lastVol || 0.7);
    }
  });

  // ---------------------------------------------------------- 键盘
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (e.code === 'Space') {
      e.preventDefault();
      $('#btnPlay').click();
    } else if (e.code === 'ArrowRight') {
      if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    } else if (e.code === 'ArrowLeft') {
      if (audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (e.code === 'ArrowUp') {
      e.preventDefault();
      setVol(audio.volume + 0.05);
    } else if (e.code === 'ArrowDown') {
      e.preventDefault();
      setVol(audio.volume - 0.05);
    } else if (e.key === '/') {
      e.preventDefault();
      elSearch.focus();
    }
  });

  // ---------------------------------------------------------- 启动
  elNowCover.style.display = 'none';
  loadSources();
  loadFavs();
  loadPlaylists();
  loadDownloads();

  // 支持从外部唤起并直接搜索：index.html?q=关键词
  const q0 = new URLSearchParams(location.search).get('q');
  if (q0) {
    elSearch.value = q0;
    doSearch(q0);
  } else {
    elSearch.focus();
  }

})();
