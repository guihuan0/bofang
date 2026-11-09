/* iOS 适配层：拦截 /api/ 请求，改走原生 bridge。
   桌面版靠本地 HTTP 服务，iOS 上没有那层，这里是替身。
   加载顺序必须在 app.js 之前。 */
(function () {
  var ios = window.webkit && window.webkit.messageHandlers &&
            window.webkit.messageHandlers.pipi;
  if (!ios) return;
  document.body.classList.add('ios');

  window.__PIPI_IOS__ = true;

  // ---------------------------------------------------------------- bridge
  var seq = 0;
  var pending = {};

  window.__pipiResolve = function (id, ok, data) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    if (ok) p.resolve(data);
    else p.reject(new Error(typeof data === 'string' ? data : '请求失败'));
  };

  function call(cmd) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      try {
        ios.postMessage({ id: id, cmd: cmd, args: args });
      } catch (e) {
        delete pending[id];
        reject(e);
        return;
      }
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          reject(new Error('请求超时'));
        }
      }, 90000);
    });
  }
  window.__pipiCall = call;

  // ------------------------------------------------------- 本地存储后端
  var P = 'pipi_';
  function lsGet(k, d) {
    try {
      var v = localStorage.getItem(P + k);
      return v ? JSON.parse(v) : d;
    } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(P + k, JSON.stringify(v)); } catch (e) {}
  }

  function favKey(o) {
    return (o.id || '') + '|' + (o.title || '') + '|' + (o.artist || '');
  }

  // ------------------------------------------------------------ 业务分发
  function handleFav(method, body) {
    var list = lsGet('favs', []);
    if (method === 'GET') return { ok: true, items: list };

    if (method === 'POST') {
      var k = favKey(body);
      var i = -1;
      for (var n = 0; n < list.length; n++) {
        if (favKey(list[n]) === k) { i = n; break; }
      }
      var added;
      if (i >= 0) {
        list.splice(i, 1);
        added = false;
      } else {
        list.unshift({
          id: body.id || '',
          title: body.title || '',
          artist: body.artist || '',
          cover: body.cover || '',
          lkid: body.lkid || '',
          source: body.source || 'vipp3',
          added: Date.now() / 1000
        });
        added = true;
      }
      lsSet('favs', list);
      return { ok: true, items: list, added: added, fav: added };
    }

    if (method === 'DELETE') {
      var kk = favKey(body);
      list = list.filter(function (x) { return favKey(x) !== kk; });
      lsSet('favs', list);
      return { ok: true, items: list };
    }
    return { ok: false, error: 'unsupported' };
  }

  function handleHistory(method, body) {
    var list = lsGet('history', []);
    if (method === 'GET') return { ok: true, items: list };

    if (method === 'POST') {
      var k = favKey(body);
      list = list.filter(function (x) { return favKey(x) !== k; });
      list.unshift({
        id: body.id || '',
        title: body.title || '',
        artist: body.artist || '',
        cover: body.cover || '',
        lkid: body.lkid || '',
        source: body.source || 'vipp3',
        played: Date.now() / 1000
      });
      if (list.length > 200) list = list.slice(0, 200);
      lsSet('history', list);
      return { ok: true };
    }

    if (method === 'DELETE') {
      lsSet('history', []);
      return { ok: true };
    }
    return { ok: false, error: 'unsupported' };
  }

  function handlePlaylists(method, body) {
    var list = lsGet('playlists', []);

    if (method === 'GET') {
      return {
        ok: true,
        items: list.map(function (p) {
          return {
            id: p.id, name: p.name, platform: p.platform,
            count: (p.tracks || []).length,
            created: p.created,
            tracks: p.tracks || []
          };
        })
      };
    }

    if (method === 'POST') {
      var pid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var rec = {
        id: pid,
        name: (body.name || '导入的歌单').slice(0, 80),
        platform: body.platform || '',
        tracks: body.tracks || [],
        created: Date.now() / 1000
      };
      list.unshift(rec);
      lsSet('playlists', list);
      return {
        ok: true, id: pid, count: rec.tracks.length,
        items: list.map(function (p) {
          return { id: p.id, name: p.name, platform: p.platform,
                   count: (p.tracks || []).length, created: p.created };
        })
      };
    }

    if (method === 'DELETE') {
      list = list.filter(function (p) { return p.id !== body.id; });
      lsSet('playlists', list);
      return { ok: true, items: list };
    }
    return { ok: false, error: 'unsupported' };
  }

  function importText(text) {
    var lines = (text || '').replace(/\r/g, '\n').split('\n');
    var tracks = [];
    var seen = {};

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (/^(分享|复制|打开|http)/.test(line)) continue;

      line = line.replace(/^\s*\d+[.、)]\s*/, '');
      var title = '', artist = '';
      var m = line.match(/^(.+?)\s*[-–—]\s*(.+)$/) ||
              line.match(/^(.+?)\s+by\s+(.+)$/i) ||
              line.match(/^(.+?)\s+\/\s+(.+)$/) || line.match(/^(.+?)\t+(.+)$/);
      if (m) { title = m[1].trim(); artist = m[2].trim(); }
      else { title = line; }

      if (!title) continue;
      var k = (title + '|' + artist).toLowerCase();
      if (seen[k]) continue;
      seen[k] = 1;
      tracks.push({ title: title, artist: artist });
    }

    return saveImportedPlaylist('导入的歌单', 'text', tracks);
  }

  function saveImportedPlaylist(name, platform, tracks) {
    const unique = new Map();
    tracks.forEach(({title, artist}) => {
      title = String(title || '').trim();
      artist = String(artist || '').trim();
      if (title) unique.set(JSON.stringify([title, artist]), {title, artist});
    });
    tracks = Array.from(unique.values());
    if (!tracks.length) return {ok: false, error: '没有找到歌曲。请确认歌单公开，或粘贴每行一首的文本。'};
    const id = 'p' + Date.now().toString(36);
    const list = lsGet('playlists', []);
    list.unshift({id, name, platform, tracks, created: Date.now() / 1000});
    lsSet('playlists', list);
    return {ok: true, id, name, platform, count: tracks.length};
  }

  function readEmbeddedJSON(html, start) {
    if (start < 0) return null;
    const open = html[start];
    const close = open === '[' ? ']' : '}';
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
    return null;
  }

  async function importKuwo(id) {
    const tracks = [];
    let name = '';
    const pageSize = 1000;
    const clean = (text) => String(text || '').replace(/<[^>]+>/g, '').trim();
    for (let pn = 0; ; pn++) {
      const url = new URL('https://nplserver.kuwo.cn/pl.svc');
      url.search = new URLSearchParams({
        op: 'getlistinfo', pid: id, pn, rn: pageSize, encode: 'utf8',
        keyset: 'pl2012', identity: 'kuwo', pcmp4: 1, vipver: 'MUSIC_9.1.0', newver: 1,
      }).toString();
      const response = await call('playlistPage', url.href);
      let data;
      try { data = JSON.parse(response.html); } catch (_) {
        throw new Error('酷我接口返回了无效的歌单数据');
      }
      if (!data || (data.result != null && data.result !== 'ok')) {
        throw new Error('酷我歌单不存在或无法访问');
      }
      name = name || clean(data.title);
      const page = data.musiclist || [];
      if (!Array.isArray(page)) throw new Error('酷我接口返回了无效的歌曲列表');
      for (const item of page) {
        tracks.push({
          title: clean(item?.name || item?.SONGNAME),
          artist: clean(item?.artist || item?.FARTIST).replace(/\s*&\s*/g, ' / '),
        });
      }
      if (page.length < pageSize || (Number(data.total) > 0 && tracks.length >= Number(data.total))) break;
    }
    return saveImportedPlaylist(name || ('酷我歌单 ' + id), 'kuwo', tracks);
  }

  async function importLink(link) {
    let url = new URL(link);
    if (url.hostname === 'kuwo.cn' || url.hostname.endsWith('.kuwo.cn')) {
      const pathId = url.pathname.match(/^\/(?:newh5app\/)?playlist_detail\/(\d+)(?:\/|$)/)?.[1];
      const pid = url.searchParams.get('pid');
      const queryId = url.searchParams.get('id');
      const id = pathId || (/^\d+$/.test(pid || '') && pid) || (/^\d{6,}$/.test(queryId || '') && queryId);
      if (!id) throw new Error('链接里找不到酷我歌单 ID');
      return importKuwo(id);
    }
    if (url.hostname === 'y.qq.com') {
      const id = url.pathname.match(/\/playlist\/(\d+)/)?.[1] || url.searchParams.get('disstid');
      if (id && /^\d+$/.test(id)) url = new URL('https://y.qq.com/n/ryqq/playlist/' + id);
    }
    let result = await call('playlistPage', url.href);
    let html = result.html;
    const host = new URL(result.url).hostname;
    if (host === 'qishui.douyin.com' && !html.includes('_ROUTER_DATA')) {
      const id = html.match(/playlist_id=(\d+)/)?.[1];
      if (id) {
        result = await call('playlistPage', 'https://music.douyin.com/qishui/share/playlist?playlist_id=' + id);
        html = result.html;
      }
    }
    const page = new DOMParser().parseFromString(html, 'text/html');
    if (host === 'y.qq.com' || host === 'c.y.qq.com') {
      const tracks = Array.from(page.querySelectorAll('.songlist__item'), row => {
        const link = row.querySelector('.songlist__songname_txt a');
        return {
          title: link?.getAttribute('title') || link?.textContent,
          artist: Array.from(row.querySelectorAll('.songlist__artist a'), a => a.textContent.trim()).join(' / '),
        };
      });
      return saveImportedPlaylist(page.querySelector('.data__name, .playlist__name')?.textContent.trim() || 'QQ音乐歌单', 'qq', tracks);
    }
    if (host === 'www.kugou.com') {
      const match = /var\s+data\s*=\s*\[/.exec(html);
      const rows = match ? readEmbeddedJSON(html, match.index + match[0].length - 1) || [] : [];
      const tracks = rows.map(row => ({
        title: row.songname || row.song_name,
        artist: row.singername || (row.authors || []).map(a => a.author_name).filter(Boolean).join(' / '),
      }));
      return saveImportedPlaylist(page.title.split(/[_-]/)[0].trim() || '酷狗歌单', 'kugou', tracks);
    }
    const marker = html.indexOf('_ROUTER_DATA');
    const data = marker >= 0 ? readEmbeddedJSON(html, html.indexOf('{', marker)) : null;
    const playlist = data?.loaderData?.playlist_page;
    const tracks = (playlist?.medias || []).map(row => {
      const track = row.entity?.track || row;
      const artists = track.artists || track.artist || '';
      return {
        title: track.name || track.title,
        artist: Array.isArray(artists)
          ? artists.map(a => typeof a === 'string' ? a : a?.name || a?.artistName).filter(Boolean).join(' / ')
          : artists,
      };
    });
    return saveImportedPlaylist(playlist?.playlistInfo?.title || '汽水音乐歌单', 'qishui', tracks);
  }

  function dispatch(path, q, method, body) {
    // --- 音源 / 搜索 / 榜单 ---
    if (path === '/api/sources') return call('sources');

    if (path === '/api/search') {
      return call('search', q.q || '', q.source || 'vipp3', parseInt(q.limit || '60', 10))
        .then(function (r) {
          return { ok: true, items: r.items || [], keyword: q.q, source: q.source };
        });
    }

    if (path === '/api/top') {
      return call('top', q.which || 'new', q.source || 'vipp3')
        .then(function (r) {
          return { ok: true, items: r.items || [], which: q.which };
        });
    }

    // --- 播放 ---
    if (path === '/api/play') {
      return call('play', body.id || '', body.source || 'vipp3', body.title || '', body.artist || '').then(function (r) {
        if (!r.ok) {
          return {
            ok: false, error: r.error || '这首歌暂时听不了',
            cover: r.cover || '', title: body.title, artist: body.artist
          };
        }
        return {
          ok: true,
          id: r.id || body.id,
          stream: r.url,          // app.js 用 stream 这个字段名
          url: r.url,
          cover: r.cover || '',
          lkid: r.lkid || '',
          title: body.title || '',
          artist: body.artist || '',
          source: r.source || body.source || 'vipp3',
          lrc: r.lrc || '',
          lines: r.lines || []
        };
      });
    }

    if (path === '/api/cover') {
      return call('cover', q.id || '', q.source || 'vipp3');
    }

    if (path === '/api/lyric') {
      return call('lyric', body.lkid || q.lkid || '', body.source || q.source || 'vipp3', body.lrc || '')
        .then(function (r) { return { ok: true, lines: r.lines || [] }; });
    }

    if (path === '/api/lyric/search') {
      return call('lyricSearch', q.title || '', q.artist || '', q.source || 'vipp3', q.local || '');
    }

    if (path === '/api/resolve') {
      return call('resolve', q.title || '', q.artist || '', q.source || 'vipp3');
    }

    // --- 收藏 / 历史 / 歌单 ---
    if (path === '/api/fav') return Promise.resolve(handleFav(method, body));
    if (path === '/api/history') return Promise.resolve(handleHistory(method, body));
    if (path === '/api/playlists') return Promise.resolve(handlePlaylists(method, body));

    if (path === '/api/import') {
      var text = (body.text || '').trim();
      if (!text) return Promise.resolve({ ok: false, error: '先贴点东西进来' });
      const link = text.match(/https?:\/\/[^\s，。；、<>]+/i)?.[0];
      const task = link ? importLink(link) : (/^[0-9]{8,}$/.test(text) ? importKuwo(text) : null);
      if (task) return task.catch(error => ({ok: false, error: error.message || '歌单导入失败'}));
      return Promise.resolve(importText(text));
    }

    // --- 下载 ---
    if (path === '/api/download') {
      return call('download', body.id || '', body.title || '',
                  body.artist || '', body.source || 'vipp3', lsGet('downloadWorkers', 4), body.cover || '');
    }

    if (path === '/api/download/status') {
      return call('dlStatus', q.task || '').then(function (r) {
        return { ok: true, job: r.job || { status: 'error', error: '任务不存在' } };
      });
    }

    if (path === '/api/downloads') {
      if (method === 'DELETE') {
        return call('deleteDownload', body.name || '').then(function (r) {
          return { ok: true, items: r.items || [] };
        });
      }
      return call('downloads').then(function (r) {
        var items = r.items || [];
        return { ok: true, items: items, count: items.length, dir: 'App/Downloads' };
      });
    }

    if (path === '/api/download/open') {
      return Promise.resolve({ ok: false, error: 'iOS 没有文件夹概念' });
    }

    if (path === '/api/status') {
      return Promise.resolve({ ok: true, verified: true });
    }

    return Promise.resolve({ ok: false, error: 'iOS 版不支持的接口: ' + path });
  }

  // ------------------------------------------------------------ 拦截 fetch
  var origFetch = window.fetch;

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') !== 0) {
      return origFetch.apply(window, arguments);
    }

    var qi = url.indexOf('?');
    var pathname = qi >= 0 ? url.slice(0, qi) : url;
    var q = {};
    if (qi >= 0) {
      url.slice(qi + 1).split('&').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf('=');
        var k = decodeURIComponent(i >= 0 ? kv.slice(0, i) : kv);
        var v = i >= 0 ? kv.slice(i + 1) : '';
        try { q[k] = decodeURIComponent(v); } catch (e) { q[k] = v; }
      });
    }

    var method = ((init && init.method) || 'GET').toUpperCase();
    var body = {};
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (e) { body = {}; }
    }

    return dispatch(pathname, q, method, body).then(function (data) {
      return {
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(data); },
        text: function () { return Promise.resolve(JSON.stringify(data)); }
      };
    });
  };
})();
