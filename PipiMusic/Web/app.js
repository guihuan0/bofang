/* ============================================================
   PipiMusic — 前端逻辑
   ============================================================ */

(function () {
  'use strict';

  // ---------------------------------------------------------- DOM
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

  const audio       = window.__pipiNativePlayback ? makeNativeAudio() : $('#audio');
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
  const lyricPreview = $('#playerLyricsPreview');
  const lyricCurrent = $('#playerLyricCurrent');
  const lyricNext = $('#playerLyricNext');
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
    mode: 'sequential',
    visible: false,
    source: '33ve',
    sources: [],
  };
  let lastSearchResults = [];
  let shuffledOrder = [];
  let loadedTrack = null;
  let nextPreload = null;
  let loadingTrack = null;

  document.addEventListener('pointerdown', () => document.body.classList.add('pointer-focus'), true);
  document.addEventListener('keydown', () => document.body.classList.remove('pointer-focus'), true);

  function playbackWorkers() {
    try { return Number(localStorage.getItem('pipi_playWorkers')) || 3; } catch (_) { return 3; }
  }

  function makeNativeAudio() {
    const events = new EventTarget();
    const call = (command, value) => window.__pipiCall(command, value);
    const send = (command, value) => call(command, value).catch(() => {});
    let source = '';
    let token = 0;
    let position = 0;
    let duration = NaN;
    let paused = true;
    let loop = false;
    let volume = 1;

    window.__pipiPlaybackEvent = (event, payload) => {
      if (payload.token !== token) return;
      if (event === 'remoteNext' || event === 'remotePrev') {
        $(event === 'remoteNext' ? '#btnNext' : '#btnPrev').click();
        return;
      }
      position = payload.position;
      duration = payload.duration || NaN;
      if (event !== 'error') paused = payload.paused;
      events.dispatchEvent(new Event(event));
    };

    return {
      addEventListener: events.addEventListener.bind(events),
      get src() { return source; },
      set src(url) {
        source = url;
        position = 0;
        duration = NaN;
        paused = true;
        const requestToken = ++token;
        if (!url) {
          send('audioStop', requestToken);
          return;
        }
        const workers = playbackWorkers();
        const track = state.current;
        call('audioLoad', { token, url, workers, local: track.local || '',
                            title: track.title, artist: track.artist })
          .catch(() => {
            if (token === requestToken) events.dispatchEvent(new Event('error'));
          });
      },
      get currentTime() { return position; },
      set currentTime(value) { position = value; send('audioSeek', value); },
      get duration() { return duration; },
      get paused() { return paused; },
      get playbackRate() { return 1; },
      get loop() { return loop; },
      set loop(value) { loop = value; send('audioLoop', value); },
      get volume() { return volume; },
      set volume(value) { volume = value; send('audioVolume', value); },
      play() { paused = false; return call('audioPlay'); },
      pause() { paused = true; send('audioPause'); },
    };
  }

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
        state.source = res.default || '33ve';
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
    return state.source || '33ve';
  }

  // ---------------------------------------------------------- 下载
  const dlActive = {};

  function fmtMB(n) {
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }

  function downloadSong(item) {
    if (item?.local || String(item?.id || '').startsWith('local:')) return;
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
    elSideTip.textContent = '正在获取下载链接…';
    toast('正在获取下载链接…');

    postJSON('/api/download', {
      id: item.id,
      title: item.title || item.raw || '',
      artist: item.artist || '',
      source: item.source || currentSource(),
      cover: item.cover || '',
    })
      .then((res) => {
        if (!res.ok) {
          delete dlActive[key];
          toast(res.error || '下载失败', true);
          elSideTip.textContent = '下载失败';
          return;
        }
        toast(res.lossless ? '正在下载无损 FLAC' : '正在从 33ve 下载');
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
            loadDownloads();
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
  elDlBtn.hidden = true;
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
        '点歌曲旁的下载按钮，优先下载可用的无损 FLAC';
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
    del.title = '永久删除下载';
    del.setAttribute('aria-label', '永久删除 ' + (f.title || f.name));
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteDownload(f);
    });
    act.appendChild(del);

    if (f.cover) {
      const cover = document.createElement('img');
      cover.className = 'download-cover';
      cover.alt = '';
      cover.src = f.cover;
      cover.loading = 'lazy';
      cover.onerror = () => cover.replaceWith(idx);
      row.appendChild(cover);
    } else {
      row.appendChild(idx);
    }
    row.appendChild(info);
    row.appendChild(tag);
    row.appendChild(meta);
    row.appendChild(act);

    row.addEventListener('click', () => {
      state.queue = dlFiles.map(downloadTrack);
      state.index = state.queue.findIndex((track) => track.local === f.name);
      resetShuffle();
      playQueued(state.index);
    });
    return withPlayNextSwipe(row, downloadTrack(f));
  }

  let openSwipeRow = null;
  function withPlayNextSwipe(row, track) {
    if (!window.__PIPI_IOS__) return row;
    const wrapper = document.createElement('div');
    wrapper.className = 'swipe-song';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'play-next-action';
    action.textContent = '下一首播放';
    action.hidden = true;
    row.tabIndex = 0;
    wrapper.append(action, row);

    function close() {
      wrapper.classList.remove('swipe-open');
      action.hidden = true;
      if (openSwipeRow === close) openSwipeRow = null;
    }
    function open() {
      if (openSwipeRow && openSwipeRow !== close) openSwipeRow();
      openSwipeRow = close;
      action.hidden = false;
      wrapper.classList.add('swipe-open');
    }

    let start = null;
    let suppressClick = false;
    row.addEventListener('touchstart', (event) => {
      const touch = event.touches.length === 1 ? event.touches[0] : null;
      start = touch ? { x: touch.clientX, y: touch.clientY } : null;
      suppressClick = false;
    }, { passive: true });
    row.addEventListener('touchcancel', () => { start = null; });
    row.addEventListener('touchend', (event) => {
      if (!start || !event.changedTouches.length) return;
      const x = event.changedTouches[0].clientX - start.x;
      const y = event.changedTouches[0].clientY - start.y;
      start = null;
      if (Math.abs(x) < 45 || Math.abs(x) <= Math.abs(y) * 1.4) return;
      suppressClick = true;
      if (x < 0) open();
      else close();
    }, { passive: true });
    row.addEventListener('click', (event) => {
      if (!suppressClick && action.hidden) return;
      event.stopImmediatePropagation();
      if (!suppressClick) close();
      suppressClick = false;
    }, true);
    row.addEventListener('keydown', (event) => {
      if (event.target !== row) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        open();
        action.focus();
      } else if (event.key === 'Enter') {
        row.click();
      }
    });
    action.addEventListener('click', () => { close(); enqueueNext(track); });
    action.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || event.key === 'ArrowRight') { close(); row.focus(); }
    });
    return wrapper;
  }

  function paintDlPlaying() {
    const cur = state.current;
    const name = cur && cur.local ? cur.local : '';
    $$('.dl-row').forEach((r) => {
      r.classList.toggle('playing', !!name && r.dataset.name === name);
    });
  }

  function downloadTrack(f) {
    return {
      id: 'local:' + f.name,
      title: f.title || f.name,
      artist: f.artist || '本地文件',
      cover: f.cover || '',
      lkid: '',
      source: 'local',
      local: f.name,
    };
  }

  function playLocal(track) {
    nextPreload = null;
    loadingTrack = null;
    state.current = track;
    loadedTrack = track;
    elDlBtn.hidden = true;
    resetPlaybackProgress();

    elNowTitle.textContent = state.current.title;
    elNowArtist.textContent = state.current.artist;
    if (track.cover) {
      elNowCover.src = track.cover;
      elNowCover.style.display = '';
    } else {
      elNowCover.removeAttribute('src');
      elNowCover.style.display = 'none';
    }
    elSideTip.textContent = '本地播放';
    syncFavBtn();

    showLyricsMessage('正在找歌词…');

    if (window.__PIPI_IOS__) {
      audio.src = 'pipilocal://local/' + encodeURIComponent(track.local);
    } else {
      audio.src = '/local/' + encodeURIComponent(track.local);
    }
    audio.play().catch(() => {});
    document.body.classList.add('playing');
    document.body.classList.add('spinning');
    elMiniEq.classList.add('on');

    paintPlaying();
    renderQueue();
    loadLocalLyric({ name: track.local, title: track.title, artist: track.artist });
  }

  function loadLocalLyric(f) {
    if (!f.title) {
      showLyricsMessage('这首歌暂无歌词');
      return;
    }
    const q = '/api/lyric/search?title=' + encodeURIComponent(f.title) +
              '&artist=' + encodeURIComponent(f.artist || '') +
              '&source=' + encodeURIComponent(currentSource()) +
              '&local=' + encodeURIComponent(f.name);
    fetch(q)
      .then((r) => r.json())
      .then((res) => {
        // 期间可能已经切歌了
        if (!state.current || !state.current.local || state.current.local !== f.name) return;
        if (!state.current.cover && res.cover) {
          state.current.cover = coverURL(res.cover);
          elNowCover.src = state.current.cover;
          elNowCover.style.display = '';
        }
        const lines = (res && res.lines) || [];
        if (!lines.length) {
          showLyricsMessage('这首歌暂无歌词');
          return;
        }
        state.lyrics = lines;
        renderLyrics();
      })
      .catch(() => {
        if (!state.current || state.current.local !== f.name) return;
        showLyricsMessage('歌词没找到');
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
        const index = state.queue.findIndex((track) => track.local === f.name || track.id === 'local:' + f.name);
        if (index >= 0) {
          state.queue.splice(index, 1);
          if (index <= state.index) state.index--;
          resetShuffle();
          renderQueue();
        }
        if (state.current?.local === f.name) {
          audio.pause();
          if (window.__pipiNativePlayback) audio.src = '';
          else { audio.removeAttribute('src'); audio.load(); }
          loadedTrack = null;
          state.current = null;
          state.index = -1;
          nextPreload = null;
          resetShuffle();
          elDlBtn.hidden = true;
          elNowTitle.textContent = '未播放';
          elNowArtist.textContent = '选一首开始';
          elNowCover.removeAttribute('src');
          elNowCover.style.display = 'none';
          showLyricsMessage('播放歌曲后显示歌词');
          resetPlaybackProgress();
          syncFavBtn();
          paintPlaying();
          renderQueue();
        }
        loadDownloads();
      })
      .catch((error) => toast('删除失败：' + error.message, true));
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
    $('#app').dataset.view = name;
    $('#mediaSettings').open = false;
    const titles = { search: '皮皮音乐', top: '榜单', fav: '我的收藏', playlist: '歌单', history: '最近播放', downloads: '已下载' };
    $('#screenTitle').textContent = titles[name];
    $$('.nav-item').forEach((b) => {
      const active = b.dataset.view === name;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
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
    row.dataset.source = item.source || currentSource();
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
    if (!item.cover && item.id && coverObserver) coverObserver.observe(row);

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
    down.title = '下载歌曲';
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

    return opts?.playNext ? withPlayNextSwipe(row, item) : row;
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
  const searchHistory = $('#searchHistory');
  const searchHistoryList = $('#searchHistoryList');
  const searchHistoryKey = 'pipi.searchHistory';
  let recentSearches = [];

  if (window.__PIPI_IOS__) {
    try {
      const saved = JSON.parse(localStorage.getItem(searchHistoryKey));
      if (Array.isArray(saved)) recentSearches = saved.filter((kw) => typeof kw === 'string' && kw.trim()).slice(0, 12);
    } catch (_) {}
    renderSearchHistory();
  }

  function renderSearchHistory() {
    searchHistory.hidden = recentSearches.length === 0;
    searchHistoryList.textContent = '';
    recentSearches.forEach((kw) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = kw;
      button.addEventListener('click', () => {
        elSearch.value = kw;
        doSearch(kw);
      });
      searchHistoryList.appendChild(button);
    });
  }

  function doSearch(kw) {
    kw = (kw || '').trim();
    if (!kw) { elSearch.focus(); return; }

    if (window.__PIPI_IOS__ && recentSearches[0] !== kw) {
      recentSearches = [kw, ...recentSearches.filter((item) => item !== kw)].slice(0, 12);
      try { localStorage.setItem(searchHistoryKey, JSON.stringify(recentSearches)); } catch (_) {}
      renderSearchHistory();
    }

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
        lastSearchResults = items;
        renderQueue();
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
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) doSearch(elSearch.value);
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
        renderQueue();
        elFavCount.textContent = state.favs.length;
        elFavMeta.textContent = state.favs.length ? state.favs.length + ' 首' : '';
        renderList(elFavList, state.favs, {
          queue: state.favs,
          playNext: true,
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
        renderQueue();
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
    // 浏览列表的操作不改变已经开始播放的队列。
    const box = state.view === 'top' ? elTopList : elSearchList;
    const row = box.querySelector('.song[data-key="' + CSS.escape(k) + '"]');
    if (row) row.remove();
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
    const rows = Array.from(card.querySelectorAll('.pl-track'));
    playPlaylistFrom(card, rows.indexOf(row));
  }

  function playPlaylistFrom(card, index) {
    const tracks = Array.from(card.querySelectorAll('.pl-track'), (row) => ({
      title: row.dataset.title,
      artist: row.dataset.artist,
      source: currentSource(),
    }));
    if (tracks[index]) playItem(tracks[index], tracks, true);
  }

  function paintPlaylistPlaying() {
    $$('.pl-track').forEach((r) => {
      r.classList.toggle('playing', !!state.current &&
        r.dataset.title === state.current.title && r.dataset.artist === state.current.artist);
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
  async function resolvePlaybackItem(item) {
    if (!item.id && item.title) {
      const resolved = await resolveTrack(item.title, item.artist);
      if (!resolved.ok || !resolved.song) return { ok: false, error: '音源没有找到这首歌' };
      item = resolved.song;
    }
    return postJSON('/api/play', {
      id: item.id, title: item.title, artist: item.artist,
      cover: item.cover, source: item.source || currentSource(),
    });
  }

  function playItem(item, queue, useExactQueue = false) {
    if (!item) return;
    if (queue !== undefined) {
      const tracks = !useExactQueue && state.favs.length ? state.favs : queue;
      state.queue = tracks.slice();
      state.index = state.queue.findIndex((song) => favKey(song) === favKey(item));
      if (state.index === -1) {
        state.queue.unshift(item);
        state.index = 0;
      }
      resetShuffle();
    }
    const localName = item.local || (item.id && item.id.startsWith('local:') ? item.id.slice(6) : '');
    if (localName) {
      playLocal({ ...item, local: localName, source: 'local' });
      return;
    }
    state.current = {
      id: item.id,
      title: item.title || item.raw || '未知歌曲',
      artist: item.artist || '未知歌手',
      cover: item.cover || '',
      lkid: item.lkid || '',
      source: item.source || currentSource(),
    };
    const track = state.current;
    loadingTrack = track;
    audio.pause();
    elDlBtn.hidden = false;
    resetPlaybackProgress();
    renderQueue();

    elNowTitle.textContent = state.current.title;
    elNowArtist.textContent = state.current.artist;
    elSideTip.textContent = '加载中…';
    showLyricsMessage('歌词加载中…');

    if (state.current.cover) {
      elNowCover.src = coverURL(state.current.cover);
      elNowCover.style.display = '';
    } else {
      elNowCover.removeAttribute('src');
      elNowCover.style.display = 'none';
    }
    syncFavBtn();

    const ready = nextPreload && nextPreload.item === item && Date.now() - nextPreload.started < 45000
      ? nextPreload.result : null;
    nextPreload = null;
    (ready ? ready.then((result) => result?.ok ? result : resolvePlaybackItem(item)) : resolvePlaybackItem(item))
      .then((res) => {
        if (state.current !== track) return;
        if (!res.ok) {
          toast(res.error || '这首歌暂时听不了', true);
          elSideTip.textContent = '无法播放';
          showLyricsMessage('这首歌暂时听不了');
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
        patchCover(track.id, track.source, res.cover);
        syncFavBtn();

        loadedTrack = track;
        audio.src = res.stream;
        audio.play().catch(() => {});
        document.body.classList.add('playing');
        document.body.classList.add('spinning');
        elMiniEq.classList.add('on');
        elSideTip.textContent = '正在播放';

        paintPlaying();
        postJSON('/api/lyric', { lkid: res.lkid, source: res.source, lrc: res.lrc })
          .then((lyrics) => {
            if (state.current !== track) return;
            state.lyrics = lyrics.lines || [];
            renderLyrics();
          })
          .catch(() => {
            if (state.current === track) showLyricsMessage('歌词加载失败');
          });
      })
      .catch((e) => {
        if (state.current !== track) return;
        showLyricsMessage('歌词加载失败');
        toast('播放失败：' + e.message, true);
        elSideTip.textContent = '播放失败';
      })
      .finally(() => {
        if (loadingTrack === track) loadingTrack = null;
      });
  }

  const coverCache = new Map();
  const coverPending = new Map();
  let coverRequests = 0;
  const coverObserver = window.__PIPI_IOS__ && window.IntersectionObserver ? new IntersectionObserver((entries) => {
    entries.forEach(({target, isIntersecting}) => {
      const {id, source} = target.dataset;
      const key = JSON.stringify([source, id]);
      if (isIntersecting) {
        if (coverCache.has(key)) {
          coverObserver.unobserve(target);
          patchCover(id, source, coverCache.get(key));
        } else if (!coverPending.has(key)) {
          coverPending.set(key, target);
        }
      } else if (coverPending.get(key) === target && !target.dataset.coverLoading) {
        coverPending.delete(key);
      }
    });
    loadVisibleCovers();
  }, {rootMargin: '120px'}) : null;

  function loadVisibleCovers() {
    for (const [key, row] of coverPending) {
      if (coverRequests >= 2) return;
      if (row.dataset.coverLoading) continue;
      if (!row.isConnected) { coverPending.delete(key); continue; }
      const {id, source} = row.dataset;
      row.dataset.coverLoading = 'true';
      coverObserver.unobserve(row);
      coverRequests++;
      api('/api/cover?id=' + encodeURIComponent(id) + '&source=' + encodeURIComponent(source))
        .then((result) => {
          if (coverCache.size >= 300) coverCache.delete(coverCache.keys().next().value);
          coverCache.set(key, result.cover || '');
          patchCover(id, source, result.cover);
        })
        .catch(() => {})
        .finally(() => {
          coverRequests--;
          coverPending.delete(key);
          loadVisibleCovers();
        });
    }
  }

  function patchCover(id, source, cover) {
    if (!cover) return;
    // state.queue
    state.queue.forEach((x) => { if (x.id === id && (x.source || source) === source) x.cover = cover; });
    // 视图里的行
    $$('.song[data-id="' + CSS.escape(id) + '"]').forEach((row) => {
      if (row.dataset.source !== source) return;
      const first = row.querySelector('.cov');
      if (first && first.tagName !== 'IMG') {
        const img = document.createElement('img');
        img.className = 'cov';
        img.alt = '';
        img.loading = 'lazy';
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

  function resetShuffle() {
    shuffledOrder = state.queue.map((_, index) => index).filter((index) => index !== state.index);
    for (let i = shuffledOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffledOrder[i], shuffledOrder[j]] = [shuffledOrder[j], shuffledOrder[i]];
    }
    if (state.index >= 0) shuffledOrder.unshift(state.index);
  }

  function enqueueNext(track) {
    const playing = state.queue[state.index];
    const key = favKey(track);
    if (playing && favKey(playing) === key) {
      toast('这首歌正在播放');
      return;
    }
    const shuffled = state.mode === 'shuffle' ? shuffledOrder.map((index) => state.queue[index]) : [];
    const queue = (state.queue.length ? state.queue : state.favs).filter((item) => favKey(item) !== key);
    state.index = queue.indexOf(playing);
    queue.splice(state.index + 1, 0, track);
    state.queue = queue;
    nextPreload = null;
    if (state.mode === 'repeatOne') setPlayMode('sequential');
    if (state.mode === 'shuffle') {
      const ordered = shuffled.filter((item) => item && favKey(item) !== key);
      if (ordered.length === 0) ordered.push(...queue.filter((item) => item !== track));
      ordered.splice(ordered.indexOf(playing) + 1, 0, track);
      shuffledOrder = ordered.map((item) => queue.indexOf(item));
    }
    renderQueue();
    toast('已设为下一首');
  }

  function playQueued(index) {
    if (!state.queue[index]) return;
    state.index = index;
    playItem(state.queue[index]);
  }

  function nextSong(dir, automatic = false) {
    const q = state.queue;
    if (!q.length) {
      if (!automatic) toast('没有播放队列');
      return;
    }
    const order = state.mode === 'shuffle' ? shuffledOrder : q.map((_, index) => index);
    const position = order.indexOf(state.index) + dir;
    if (state.mode !== 'repeatAll' && state.mode !== 'shuffle' &&
        (position < 0 || position >= order.length)) {
      if (!automatic) toast(dir > 0 ? '已经是最后一首' : '已经是第一首');
      return;
    }
    if (automatic && state.mode === 'shuffle' && order.length === 1) return;
    playQueued(order[(position + order.length) % order.length]);
  }

  function preloadNextSong() {
    if (state.mode === 'repeatOne' || state.queue.length < 2 || state.current !== loadedTrack) return;
    const order = state.mode === 'shuffle' ? shuffledOrder : state.queue.map((_, index) => index);
    const position = order.indexOf(state.index) + 1;
    if (position >= order.length && state.mode === 'sequential') return;
    const item = state.queue[order[position % order.length]];
    if (!item || item.local || String(item.id || '').startsWith('local:') || nextPreload?.item === item) return;
    const preload = { item, started: Date.now(), result: resolvePlaybackItem(item).catch(() => null) };
    nextPreload = preload;
    preload.result.then((result) => {
      if (nextPreload === preload && result?.ok && window.__pipiNativePlayback) {
        window.__pipiCall('audioPrepare', { url: result.stream, workers: playbackWorkers() }).catch(() => {});
      }
    });
  }

  $('#btnPlay').addEventListener('click', () => {
    if (loadingTrack) return;
    if (state.current && state.current !== loadedTrack) {
      playItem(state.queue[state.index] || state.current);
      return;
    }
    if (!audio.src) {
      if (state.queue.length) {
        playQueued(0);
        return;
      }
      const tracks = state.favs.length ? state.favs : lastSearchResults;
      if (tracks.length) playItem(tracks[0], tracks);
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

  const playModes = {
    sequential: '顺序播放',
    repeatAll: '列表循环',
    shuffle: '随机播放',
    repeatOne: '单曲循环',
  };
  const modeButton = $('#btnLoop');
  const modeKey = 'pipi.playMode';
  try {
    const saved = localStorage.getItem(modeKey);
    if (Object.keys(playModes).includes(saved)) state.mode = saved;
  } catch (_) {}

  function paintMode() {
    audio.loop = state.mode === 'repeatOne';
    $('#playModeLabel').textContent = playModes[state.mode];
    modeButton.classList.toggle('on', state.mode !== 'sequential');
    modeButton.setAttribute('aria-label', playModes[state.mode] + '，点击切换播放模式');
  }

  paintMode();
  function setPlayMode(mode) {
    state.mode = mode;
    try { localStorage.setItem(modeKey, state.mode); } catch (_) {}
    if (state.mode === 'shuffle') resetShuffle();
    paintMode();
    renderQueue();
  }
  modeButton.addEventListener('click', () => {
    const modes = Object.keys(playModes);
    setPlayMode(modes[(modes.indexOf(state.mode) + 1) % modes.length]);
  });

  // ---------------------------------------------------------- 歌词
  function showLyricsMessage(message) {
    state.lyrics = [];
    state.lyricIdx = -1;
    elLyricList.textContent = '';
    elLyricEmpty.style.display = '';
    elLyricEmpty.textContent = message;
    lyricCurrent.textContent = message;
    lyricNext.hidden = true;
    lyricPreview.disabled = true;
  }

  function renderLyrics() {
    elLyricList.innerHTML = '';
    if (!state.lyrics.length) {
      showLyricsMessage('这首歌暂无歌词');
      return;
    }
    elLyricEmpty.style.display = 'none';
    const frag = document.createDocumentFragment();
    state.lyrics.forEach((l) => {
      const li = document.createElement('li');
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'lyric-line';
      line.textContent = l.text;
      line.addEventListener('click', () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(l.t)) return;
        audio.currentTime = Math.max(0, Math.min(l.t, audio.duration));
        syncLyric(audio.currentTime);
      });
      li.appendChild(line);
      frag.appendChild(li);
    });
    elLyricList.appendChild(frag);
    elLyricBody.scrollTop = 0;
    lyricPreview.disabled = false;
    state.lyricIdx = null;
    syncLyric(audio.currentTime);
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
    lyricCurrent.textContent = idx >= 0 ? ls[idx].text : '即将开始';
    const next = ls[idx + 1];
    lyricNext.textContent = next ? next.text : '';
    lyricNext.hidden = !next;

    const nodes = elLyricList.children;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].classList.remove('cur', 'near');
      if (i === idx) nodes[i].classList.add('cur');
      else if (Math.abs(i - idx) === 1) nodes[i].classList.add('near');
    }
    const cur = nodes[idx];
    if (cur && elLyricBody.clientHeight) {
      const target = cur.offsetTop - elLyricBody.clientHeight * 0.38;
      elLyricBody.scrollTop = Math.max(0, target);
    }
  }

  $('#lyricToggle').addEventListener('click', () => {
    document.body.classList.toggle('no-lyrics');
    $('#lyricToggle').classList.toggle('on', !document.body.classList.contains('no-lyrics'));
  });
  $('#lyricClose').addEventListener('click', () => {
    document.body.classList.add('no-lyrics');
    $('#lyricToggle').classList.remove('on');
  });

  // ---------------------------------------------------------- 音频事件
  function resetPlaybackProgress() {
    $('#playbar').style.setProperty('--play-progress', '0%');
    elSeekFill.style.width = '0%';
    elSeekKnob.style.left = '0%';
    elTCur.textContent = '0:00';
    elTDur.textContent = '0:00';
  }

  const mediaSession = window.__pipiNativePlayback ? null : navigator.mediaSession;
  if (mediaSession) {
    const actions = {
      play: () => audio.play().catch(() => {}),
      pause: () => audio.pause(),
      previoustrack: () => $('#btnPrev').click(),
      nexttrack: () => $('#btnNext').click(),
      seekto: ({seekTime}) => {
        if (Number.isFinite(seekTime)) audio.currentTime = seekTime;
      },
    };
    Object.entries(actions).forEach(([action, handler]) => {
      try { mediaSession.setActionHandler(action, handler); } catch (_) {}
    });
  }

  function updateSystemPlayback(playing) {
    if (!mediaSession) return;
    try {
      mediaSession.playbackState = playing ? 'playing' : 'paused';
      if (playing && state.current && window.MediaMetadata) {
        const track = state.current;
        const artwork = window.__pipiSystemArtwork || new URL('AppIcon60x60@3x.png', location.href).href;
        mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          artwork: [{ src: artwork, sizes: '180x180', type: 'image/png' }],
        });
      }
    } catch (_) {}
  }

  audio.addEventListener('timeupdate', () => {
    if (!state.current || state.current !== loadedTrack) return;
    const d = audio.duration || 0;
    const c = audio.currentTime || 0;
    const p = d ? (c / d) * 100 : 0;
    $('#playbar').style.setProperty('--play-progress', p + '%');
    elSeekFill.style.width = p + '%';
    elSeekKnob.style.left = p + '%';
    elTCur.textContent = fmtTime(c);
    if (d) elTDur.textContent = fmtTime(d);
    syncLyric(c);
    if (d > 0 && d - c <= 30 && !audio.paused) preloadNextSong();
  });

  audio.addEventListener('loadedmetadata', () => {
    if (!state.current || state.current !== loadedTrack) return;
    elTDur.textContent = fmtTime(audio.duration || 0);
    if (!audio.paused) updateSystemPlayback(true);
  });
  audio.addEventListener('seeked', () => updateSystemPlayback(!audio.paused));

  audio.addEventListener('play', () => {
    updateSystemPlayback(true);
    document.body.classList.add('playing', 'spinning');
    elMiniEq.classList.add('on');
    elSideTip.textContent = '正在播放';
  });

  audio.addEventListener('pause', () => {
    updateSystemPlayback(false);
    document.body.classList.remove('playing');
    document.body.classList.remove('spinning');
    elMiniEq.classList.remove('on');
    elSideTip.textContent = '已暂停';
  });

  audio.addEventListener('ended', () => {
    if (state.current !== loadedTrack) return;
    updateSystemPlayback(false);
    document.body.classList.remove('playing', 'spinning');
    elMiniEq.classList.remove('on');
    if (!audio.loop) nextSong(1, true);
  });

  // 直链有时效，过期就重新取一次源并从原位置续上
  let repairing = 0;
  audio.addEventListener('error', () => {
    const track = state.current;
    if (!audio.src || !track || track !== loadedTrack) return;
    if (track.local) {
      audio.pause();
      elSideTip.textContent = '本地文件播放失败';
      toast('无法播放本地文件，文件可能已删除或损坏', true);
      return;
    }
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
        if (state.current !== track) return;
        if (!res.ok) throw new Error(res.error || '重取失败');
        audio.src = res.stream;
        const resume = () => {
          if (state.current !== track) return;
          try { audio.currentTime = pos; } catch (e) {}
          if (wasPlaying) audio.play().catch(() => {});
          elSideTip.textContent = wasPlaying ? '正在播放' : '已暂停';
        };
        audio.addEventListener('loadedmetadata', resume, { once: true });
      })
      .catch((e) => {
        if (state.current !== track) return;
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

  const openPlayer = $('#openPlayer');
  const closePlayer = $('#closePlayer');
  const playerLyrics = $('#playerLyrics');
  const playerQueue = $('#playerQueue');
  const queueToggle = $('#queueToggle');
  const queueTracks = $('#queueTracks');
  const queueEmpty = $('#queueEmpty');
  const playFavorites = $('#playFavorites');

  if (window.__PIPI_IOS__) {
    playerLyrics.appendChild(elLyricBody);
    $('#playbar').after($('.sidebar'));
  }

  function setFullLyrics(expanded, focus = true) {
    playerLyrics.hidden = !expanded;
    lyricPreview.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      setQueueVisible(false, false);
      state.lyricIdx = null;
      syncLyric(audio.currentTime);
    }
    if (focus) (expanded ? playerLyrics : lyricPreview.disabled ? closePlayer : lyricPreview).focus();
  }

  function renderQueue() {
    if (playerQueue.hidden) return;
    const active = state.queue.length > 0;
    const tracks = active ? state.queue : state.favs.length ? state.favs : lastSearchResults;
    const order = active && state.mode === 'shuffle' ? shuffledOrder : tracks.map((_, index) => index);
    const rows = document.createDocumentFragment();
    order.forEach((index) => {
      const track = tracks[index];
      const row = document.createElement('li');
      row.dataset.queueIndex = index;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = [track.title || track.raw, track.artist].filter(Boolean).join(' · ');
      if (active && index === state.index) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => {
        if (active) playQueued(index);
        else playItem(track, tracks);
        queueTracks.querySelector('[aria-current]')?.focus({ preventScroll: true });
      });
      row.appendChild(button);
      if (tracks.length > 1) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'queue-handle';
        handle.setAttribute('aria-label', '调整「' + (track.title || track.raw) + '」的顺序，键盘使用上下方向键');
        handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12M6 12h12M6 17h12"/></svg>';
        handle.addEventListener('pointerdown', (event) => beginQueueDrag(event, row, tracks, order));
        handle.addEventListener('keydown', (event) => {
          const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
          if (!direction) return;
          event.preventDefault();
          const to = order[order.indexOf(index) + direction];
          if (to === undefined) return;
          const moved = moveQueueTrack(tracks, order, index, to);
          queueTracks.querySelector('[data-queue-index="' + moved + '"] .queue-handle')?.focus({ preventScroll: true });
        });
        row.appendChild(handle);
      }
      rows.appendChild(row);
    });
    queueTracks.textContent = '';
    queueTracks.appendChild(rows);
    queueEmpty.hidden = order.length > 0;
    playFavorites.disabled = !state.favs.length;
  }

  function moveQueueTrack(tracks, order, from, to) {
    const current = state.queue[state.index];
    const sorted = order.map((index) => tracks[index]);
    const destination = order.indexOf(to);
    sorted.splice(order.indexOf(from), 1);
    sorted.splice(destination, 0, tracks[from]);
    state.queue = sorted;
    state.index = sorted.indexOf(current);
    nextPreload = null;
    if (state.mode === 'shuffle' || state.mode === 'repeatOne') setPlayMode('sequential');
    else renderQueue();
    return destination;
  }

  function beginQueueDrag(event, row, tracks, order) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const from = Number(row.dataset.queueIndex);
    let target = row;
    let y = event.clientY;
    let frame;
    handle.setPointerCapture(pointer);
    row.classList.add('queue-dragging');
    const move = (e) => { if (e.pointerId === pointer) y = e.clientY; };
    function update() {
      if (!row.isConnected || playerQueue.hidden) {
        finish({ pointerId: pointer, type: 'pointercancel' });
        return;
      }
      const bounds = queueTracks.getBoundingClientRect();
      if (y < bounds.top + 24) queueTracks.scrollTop -= 8;
      else if (y > bounds.bottom - 24) queueTracks.scrollTop += 8;
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2,
        Math.max(bounds.top + 1, Math.min(y, bounds.bottom - 1)))?.closest('[data-queue-index]');
      if (hit && queueTracks.contains(hit) && target !== hit) {
        target.classList.remove('queue-drop-target');
        target = hit;
        if (target !== row) target.classList.add('queue-drop-target');
      }
      frame = requestAnimationFrame(update);
    }
    function finish(e) {
      if (e.pointerId !== pointer) return;
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      row.classList.remove('queue-dragging');
      target.classList.remove('queue-drop-target');
      if (e.type === 'pointerup' && target !== row && row.isConnected) {
        moveQueueTrack(tracks, order, from, Number(target.dataset.queueIndex));
      }
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    frame = requestAnimationFrame(update);
  }

  function setQueueVisible(expanded, focus = true) {
    playerQueue.hidden = !expanded;
    queueToggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) {
      setFullLyrics(false, false);
      renderQueue();
      queueTracks.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    }
    if (focus) (expanded ? playerQueue : queueToggle).focus({ preventScroll: true });
  }

  queueToggle.addEventListener('click', () => setQueueVisible(playerQueue.hidden));
  playFavorites.addEventListener('click', () => playItem(state.favs[0], state.favs));
  lyricPreview.addEventListener('click', () => setFullLyrics(true));
  playerLyrics.addEventListener('click', (e) => {
    if (!e.target.closest('.lyric-line')) setFullLyrics(false);
  });

  function setPlayerExpanded(expanded) {
    document.body.classList.toggle('player-expanded', expanded);
    openPlayer.setAttribute('aria-expanded', String(expanded));
    openPlayer.disabled = expanded;
    if (!expanded) {
      setFullLyrics(false, false);
      setQueueVisible(false, false);
    }
    (expanded ? closePlayer : openPlayer).focus();
  }

  openPlayer.addEventListener('click', () => setPlayerExpanded(true));
  closePlayer.addEventListener('click', () => setPlayerExpanded(false));
  const immersive = $('#playbar');
  let swipeStart = null;
  immersive.addEventListener('touchstart', (event) => {
    if (!document.body.classList.contains('player-expanded') || event.touches.length !== 1 ||
        event.target.closest('button:not(#openPlayer), #seekBar, #playerLyrics, #playerQueue')) {
      swipeStart = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY, scroll: immersive.scrollTop };
  }, { passive: true });
  immersive.addEventListener('touchcancel', () => { swipeStart = null; });
  immersive.addEventListener('touchend', (event) => {
    if (!swipeStart || !event.changedTouches.length) return;
    const start = swipeStart;
    swipeStart = null;
    const x = event.changedTouches[0].clientX - start.x;
    const y = event.changedTouches[0].clientY - start.y;
    if ((x >= 70 && x > Math.abs(y) * 1.35) ||
        (start.scroll === 0 && y >= 70 && y > Math.abs(x) * 1.35)) {
      setPlayerExpanded(false);
    }
  }, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('player-expanded')) {
      if (!playerQueue.hidden) setQueueVisible(false);
      else if (!playerLyrics.hidden) setFullLyrics(false);
      else setPlayerExpanded(false);
    }
  });

  let seeking = false;

  function applySeek(e) {
    if (!audio.duration) return;
    const r = ratioFromEvt(elSeekBar, e);
    elSeekFill.style.width = (r * 100) + '%';
    elSeekKnob.style.left = (r * 100) + '%';
    elTCur.textContent = fmtTime(r * audio.duration);
  }

  elSeekBar.addEventListener('pointerdown', (e) => {
    if (!audio.duration || !e.isPrimary || e.button !== 0) return;
    seeking = true;
    elSeekBar.setPointerCapture(e.pointerId);
    applySeek(e);
    e.preventDefault();
  });

  elSeekBar.addEventListener('pointermove', (e) => {
    if (seeking && elSeekBar.hasPointerCapture(e.pointerId)) applySeek(e);
  });

  elSeekBar.addEventListener('pointerup', (e) => {
    if (!seeking || !elSeekBar.hasPointerCapture(e.pointerId)) return;
    seeking = false;
    if (audio.duration) {
      const r = ratioFromEvt(elSeekBar, e);
      audio.currentTime = r * audio.duration;
    }
  });
  elSeekBar.addEventListener('lostpointercapture', () => { seeking = false; });

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
    if (e.defaultPrevented || ['input', 'textarea', 'select'].includes(tag)) return;
    if (e.code === 'Space' && tag === 'button') return;

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
      if (state.view !== 'search') switchView('search');
      elSearch.focus();
    }
  });

  // ---------------------------------------------------------- 启动
  elNowCover.style.display = 'none';
  if (window.__PIPI_IOS__) {
    $('#mediaSettings').hidden = false;
    const appearance = $('#appearanceMode');
    appearance.value = window.__pipiAppearance || 'system';
    appearance.addEventListener('change', () => {
      window.__pipiCall('appearance', appearance.value).catch(() => {});
    });
    [['playWorkers', '3'], ['downloadWorkers', '4']].forEach(([id, fallback]) => {
      const select = $('#' + id);
      const key = 'pipi_' + id;
      let value = fallback;
      try { value = localStorage.getItem(key) || fallback; } catch (_) {}
      select.value = Array.from(select.options).some((option) => option.value === value) ? value : fallback;
      select.addEventListener('change', () => {
        try { localStorage.setItem(key, select.value); } catch (_) {}
      });
    });
  }
  loadSources();
  loadFavs();
  loadPlaylists();
  loadDownloads();

  // 支持从外部唤起并直接搜索：index.html?q=关键词
  const q0 = new URLSearchParams(location.search).get('q');
  if (q0) {
    elSearch.value = q0;
    doSearch(q0);
  } else if (!window.__PIPI_IOS__) {
    elSearch.focus();
  }

})();
