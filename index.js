import express from 'express';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const port = process.env.PORT || 80;
//teste
const transcriptSchema = new mongoose.Schema({
  canalId: String,
  abertoPor: String,
  assumidoPor: String,
  mensagens: [
    {
      autor: String,
      idAutor: String,
      conteudo: String,
      horario: Date,
      avatar: String
    }
  ]
});
const Transcript = mongoose.model('Transcript', transcriptSchema, 'transcripts');

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('✅ Conectado ao MongoDB Atlas!'))
.catch(err => {
  console.error('❌ Erro ao conectar no MongoDB:', err);
  process.exit(1);
});

// ✅ Cache para as imagens e vídeos (duração de 1 dia)
const mediaCache = new Map();
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 dia

app.get('/img', async (req, res) => {
  try {
    const u = req.query.u;
    if (!u) return res.status(400).send('missing u');

    // bloqueia coisa suspeita
    const url = new URL(String(u));
    if (!/^https?:$/.test(url.protocol)) return res.status(400).send('bad protocol');

    // ✅ VERIFICA CACHE PRIMEIRO
    if (mediaCache.has(u)) {
      const { contentType, buffer, timestamp } = mediaCache.get(u);
      // Se o cache não expirou, serve direto
      if (Date.now() - timestamp < CACHE_DURATION_MS) {
        res.setHeader('Content-Type', contentType);
        return res.send(buffer);
      } else {
        // Cache expirado, remove para buscar de novo
        mediaCache.delete(u);
      }
    }

    // só libera hosts conhecidos (segurança)
   const allowed = [
      'cdn.discordapp.com',
      'media.discordapp.net',
      'cdn.discord.com',
      'i.imgur.com',
      'images-ext-1.discordapp.net',
      'images-ext-2.discordapp.net',
      'c.tenor.com',
      'tenor.com',
      'lh3.googleusercontent.com'
    ];
    if (!allowed.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
      return res.status(403).send('host not allowed');
    }

    const r = await fetch(url.toString(), {
      headers: {
        // ajuda a evitar bloqueio
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://discord.com/',
        'Accept': '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
      }
    });

    if (!r.ok) {
      // ✅ Log mais detalhado do erro
      console.warn(`[Proxy] Erro ao buscar do servidor de origem ${r.status} para ${url}`);
      return res.status(r.status).send(`Upstream error: ${r.status} ${r.statusText}`);
    }

    // repassa content-type
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);

    // cache no navegador do cliente (bom pra recarregar a página)
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const buf = Buffer.from(await r.arrayBuffer());

    // ✅ ARMAZENA NO CACHE DO SERVIDOR
    mediaCache.set(u, {
      contentType: ct,
      buffer: buf,
      timestamp: Date.now()
    });

    res.send(buf);
  } catch (e) {
    console.error('Proxy /img error:', e);
    res.status(500).send('proxy error');
  }
});

// ✅ Middleware global de tratamento de erros
app.use((err, req, res, next) => {
  console.error('Erro inesperado no servidor:', err);
  if (!res.headersSent) {
    res.status(500).send('Ocorreu um erro interno no servidor.');
  }
});


const escapeHtml = (unsafe) => {
  if (typeof unsafe !== 'string') return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

function generateMessagesHtml(mensagens) {
  if (!mensagens || mensagens.length === 0) {
    return '<div class="vazio" style="padding: 20px 0;">Nenhuma mensagem encontrada.</div>';
  }

  let lastDay = '';
  const tz = { timeZone: 'America/Sao_Paulo' };

  return mensagens.map((msg) => {
    const d = new Date(msg.horario);
    const dayKey = d.toLocaleDateString('pt-BR', { ...tz, day: '2-digit', month: 'long', year: 'numeric' });

    const dayDivider = (dayKey !== lastDay)
      ? `<div class="day-divider"><span>${dayKey}</span></div>`
      : '';

    lastDay = dayKey;

    const avatar = msg.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';

    function proxifyHtmlImages(html) {
  if (typeof html !== "string" || !html.trim()) return html;

  // troca qualquer <img ... src="https://..." ...> por <img ... src="/img?u=ENCODE(...)" ...>
  // mantém query (IMPORTANTE pra links assinados)
  return html.replace(
    /<img([^>]*?)\s+src="([^"]+)"([^>]*)>/gi,
    (full, pre, src, post) => {
      const s = String(src).trim();

      // já proxificado
      if (s.startsWith("/img?u=")) return full;

      // normaliza //cdn... -> https://cdn...
      const normalized = s.startsWith("//") ? `https:${s}` : s;

      // só proxifica http/https (não inventa)
      if (!/^https?:\/\//i.test(normalized)) return full;

      // mantém tudo, só muda o src
      const encoded = encodeURIComponent(normalized);
      return `<img${pre} src="/img?u=${encoded}"${post}>`;
    }
  ).replace(
    /<video([^>]*?)\s+src="([^"]+)"([^>]*)>/gi,
    (full, pre, src, post) => {
      const s = String(src).trim();
      if (s.startsWith("/img?u=")) return full;
      const normalized = s.startsWith("//") ? `https:${s}` : s;
      if (!/^https?:\/\//i.test(normalized)) return full;
      
      // Usa o mesmo proxy de imagem para vídeo (funciona pois é stream de bytes)
      const encoded = encodeURIComponent(normalized);
      return `<video${pre} src="/img?u=${encoded}"${post}>`;
    }
  );
}

function forceNoReferrerAndLazy(html) {
  if (typeof html !== "string" || !html.trim()) return html;

  // garante referrerpolicy + loading sem duplicar
  return html.replace(/<img([^>]*)>/gi, (m, attrs) => {
    let a = attrs;

    if (!/referrerpolicy=/i.test(a)) a += ` referrerpolicy="no-referrer"`;
    if (!/loading=/i.test(a)) a += ` loading="lazy"`;

    return `<img${a}>`;
  });
}

    // O bot (`entrevistasTickets.js`) já gera o HTML final para o conteúdo.
    // Aqui, apenas garantimos que todas as mídias (imagens/vídeos) passem pelo nosso proxy
    // e tenham os atributos corretos para o lazy-loading e o script de fallback.
    let content = msg.conteudo || '';
    content = proxifyHtmlImages(content);
    content = forceNoReferrerAndLazy(content);

    return `
      ${dayDivider}
      <div class="msg">
        <img src="/img?u=${encodeURIComponent(avatar)}" alt="Avatar" loading="lazy" referrerpolicy="no-referrer">
        <div class="msg-body">
          <div class="top-row">
            <span class="autor">${escapeHtml(msg.autor)}</span>
            <span class="hora">${d.toLocaleTimeString('pt-BR', { ...tz, hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <div class="conteudo">${content}</div>
        </div>
      </div>
    `;
  }).join('');
}

function generatePageHtml(transcript) {
  const messagesHtml = generateMessagesHtml(transcript.mensagens);
  const logoUrl = 'https://i.imgur.com/52IVmai.png';

  return `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Cauã Macedo - SantaCreators</title>

  <!-- importante pra não quebrar hotlink em Discord/Imgur -->
  <meta name="referrer" content="no-referrer">

  <style>
    body {
      background: #2b2d31;
      color: #fff;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      padding: 30px;
      margin: 0;
    }
    .header { margin-bottom: 24px; }
    .title { font-size: 2em; font-weight: bold; }
    .channel { color: #b5bac1; font-size: 0.95em; margin-top: 4px; }

    .box {
      background-color: #313338;
      border-left: 4px solid #ff009a;
      padding: 16px;
      border-radius: 8px;
      margin-bottom: 24px;
      display: block;
      max-width: 920px;
    }
    .box img { width: 100px; height: 100px; border-radius: 16px; }
    .box strong { color: #ffb0ea; }

    .btn-row {
      margin-top: 16px;
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: 8px;
      overflow: visible;
    }
    .btn {
      padding: 6px 10px;
      font-weight: bold;
      border: none;
      border-radius: 6px;
      font-size: 0.85em;
      cursor: pointer;
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .btn-yellow { background-color: #fcd34d; color: #000; }
    .btn-red    { background-color: #ef4444; color: #fff; }
    .btn-dark   { background-color: #1f2937; color: #fff; }
    .btn-green  { background-color: #22c55e; color: #fff; }

    .btn-group { display: inline-flex; flex-wrap: nowrap; gap: 10px; }

    .day-divider {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 24px 0 12px;
      color: #b5bac1;
      font-size: 0.85em;
    }
    .day-divider::before, .day-divider::after {
      content: "";
      height: 1px;
      background: #3a3f45;
      flex: 1;
      opacity: 0.8;
    }
    .day-divider span {
      padding: 2px 10px;
      background: #2b2d31;
      border: 1px solid #3a3f45;
      border-radius: 999px;
    }

    .msg {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 0;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .msg:first-of-type { border-top: none; }

    .msg img { width: 40px; height: 40px; border-radius: 50%; }

    .msg-body {
      background-color: #2f3136;
      padding: 12px 16px;
      border-radius: 10px;
      max-width: 820px;
      border: 1px solid #3b3f4a;
      box-shadow: 0 1px 0 rgba(0,0,0,0.2);
    }

    .top-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
    .autor { font-weight: 700; color: #ff73fa; }
    .hora  { font-size: 0.8em; color: #b5bac1; }

    .conteudo { white-space: pre-wrap; margin-top: 4px; word-wrap: break-word; }
    .conteudo img {
      max-width: 100%; /* Não estica imagens pequenas */
      width: auto;     /* Mantém proporção original */
      height: auto;
      border-radius: 8px;
      margin-top: 6px;
      display: block;
      object-fit: contain;
    }
    .conteudo a > img.attachment-img {
      /* Remove a borda azul de link em volta da imagem */
      text-decoration: none;
      display: block;
      object-fit: contain;
    }
    /* Estilos para Embeds do Discord */
    .conteudo .embed {
      background-color: #2f3136;
      border-left: 4px solid #202225; /* Cor padrão */
      border-radius: 4px;
      max-width: 520px;
      margin-top: 8px;
      display: block;
    }
    .conteudo .embed-body {
      display: flex;
      padding: 8px 16px;
      gap: 16px;
    }
    .conteudo .embed-content {
      flex: 1;
      min-width: 0; /* Permite quebra de texto */
    }
    .conteudo .embed-author {
      display: flex;
      align-items: center;
      font-size: 0.875rem;
      margin-bottom: 8px;
    }
    .conteudo .embed-author-icon { width: 24px; height: 24px; border-radius: 50%; margin-right: 8px; }
    .conteudo .embed-author a, .conteudo .embed-author span { color: #fff; font-weight: 600; text-decoration: none; }
    .conteudo .embed-author a:hover { text-decoration: underline; }

    .conteudo .embed-title {
      font-weight: 700;
      color: #fff;
      margin-bottom: 4px;
    }
    .conteudo .embed-title a { color: #00a8fc; text-decoration: none; }
    .conteudo .embed-title a:hover { text-decoration: underline; }

    .conteudo .embed-description {
      font-size: 0.9rem;
      color: #dcddde;
      line-height: 1.4;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .conteudo .embed-fields {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .conteudo .embed-field { font-size: 0.9rem; flex: 1 1 100%; min-width: 0; }
    .conteudo .embed-field.inline { flex: 1 1 30%; }
    .conteudo .embed-field-name { font-weight: 700; color: #b5bac1; margin-bottom: 2px; }
    .conteudo .embed-field-value { color: #dcddde; line-height: 1.3; }

    .conteudo .embed-image-container {
      padding: 0 16px 16px;
      margin-top: 16px;
    }
    .conteudo .embed-image {
      max-width: 100%;
      border-radius: 4px;
    }

    .conteudo .embed-thumbnail {
      max-width: 128px;
      max-height: 128px;
      border-radius: 4px;
      object-fit: contain;
      flex-shrink: 0;
    }
    .conteudo .embed-footer {
      display: flex;
      align-items: center;
      font-size: 0.75rem;
      color: #c7c9cb;
      padding: 0 16px 8px;
    }    
    .conteudo .embed-footer-icon { width: 20px; height: 20px; border-radius: 50%; margin-right: 6px; }
    
    /* Botões e Componentes do Discord */
    .discord-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 16px;
      border-radius: 3px;
      font-size: 14px;
      font-weight: 500;
      color: #fff;
      border: none;
      cursor: not-allowed;
      text-decoration: none;
      transition: background-color 0.17s ease;
      opacity: 0.9;
    }
    .discord-btn.btn-primary { background-color: #5865f2; }
    .discord-btn.btn-secondary { background-color: #4f545c; }
    .discord-btn.btn-success { background-color: #2d7d46; }
    .discord-btn.btn-danger { background-color: #ed4245; }
    .discord-btn.btn-link { background-color: #4f545c; cursor: pointer; opacity: 1; }
    .discord-btn.btn-link:hover { background-color: #686d73; }
    
    .discord-select {
      background-color: #2b2d31;
      border: 1px solid #1e1f22;
      border-radius: 4px;
      padding: 8px 12px;
      color: #dbdee1;
      font-size: 14px;
      width: 100%;
      max-width: 400px;
      box-sizing: border-box;
      cursor: not-allowed;
    }

    /* Estilos para Menções e Timestamps */
    .mention {
      background: rgba(88, 101, 242, 0.3);
      color: #dee0fc;
      padding: 0 2px;
      border-radius: 3px;
      font-weight: 500;
    }
    .timestamp {
      background: #4f545c;
      color: #dcddde;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 0.9em;
      font-weight: 500;
    }

    .sticker-image {
      width: 160px;
      height: 160px;
      margin-top: 5px;
      margin-bottom: 5px;
    }

    .conteudo .emoji {
      width: 1.375em;
      height: 1.375em;
      vertical-align: bottom;
      display: inline-block;
      margin: 0 0.1em;
    }
    .attachment-img, .attachment-video {
      max-width: 400px;
      width: auto;
      height: auto;
      border-radius: 8px;
      margin-top: 8px;
      display: block;
      background-color: #000;
    }
    code {
      font-family: Consolas, monospace;
      font-size: 0.85em;
      background-color: #1e1f22;
      padding: 2px 4px;
      border-radius: 3px;
    }
    blockquote {
      border-left: 4px solid #4e5058;
      margin: 8px 0;
      padding-left: 12px;
      color: #b5bac1;
    }

    .vazio { color: #888; font-style: italic; }
    /* Classes para substituir estilos inline */
    .box-header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .box-header-title { font-weight: bold; color: #ff73fa; font-size: 1.1em; }
    .box-header-info {
      margin-top: 10px;
      color: #e0e0e0;
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
    }
    .info-line { margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
    .info-label { color: #b5bac1; font-weight: bold; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Cauã Macedo - SantaCreators</div>
    <div class="channel">#📁 ❖ entrevistas-${transcript.canalId}</div>
  </div>

  <div class="box">
    <div class="box-header">
      <img src="/img?u=${encodeURIComponent(logoUrl)}" alt="Logo SantaCreators">
      <div>
        <div class="box-header-title">✨ Bot Creators</div>
        <div class="box-header-info">
          <div class="info-line">
            <strong class="info-label">📨 Aberto por:</strong>
            <span class="mention">@${escapeHtml(transcript.abertoPor || 'Desconhecido')}</span>
          </div>
          <div class="info-line">
            <strong class="info-label">👑 Assumido por:</strong>
            <span class="mention">@${escapeHtml(transcript.assumidoPor || 'Ninguém')}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-yellow">📋 Assumir Ticket</button>
      <button class="btn btn-red">👑 Assumir Resp</button>
      <button class="btn btn-dark">❌ Fechar Ticket</button>
      <div class="btn-group">
        <button class="btn btn-green">➕ Adicionar Usuário</button>
        <button class="btn btn-red">➖ Remover Usuário</button>
      </div>
    </div>
  </div>

  ${messagesHtml}

  <!-- Patch pros attachments/embeds -->
  <script>
  (function () {
    // Garante que todas as imagens tentem carregar sem enviar 'referrer',
    // o que aumenta a chance de sucesso com CDNs como o do Discord.
    function setNoRef(img) {
      if (!img.hasAttribute('referrerpolicy'))
        img.setAttribute('referrerpolicy', 'no-referrer');
    }

    function getOriginalUrl(src) {
      if (!src) return null;
      // Se for proxy, extrai o original
      if (src.indexOf('/img?u=') !== -1) {
        try {
          return decodeURIComponent(src.split('?u=')[1]);
        } catch (e) { return null; }
      }
      // Se não for proxy, assume que já é o original
      return src;
    }

    function getVariations(url) {
      var list = [url];
      // Tenta variações cdn <-> media
      if (url.indexOf('cdn.discordapp.com') !== -1) {
        list.push(url.replace('cdn.discordapp.com', 'media.discordapp.net'));
      } else if (url.indexOf('media.discordapp.net') !== -1) {
        list.push(url.replace('media.discordapp.net', 'cdn.discordapp.com'));
      }
      return list;
    }

    function attach(img) {
      setNoRef(img);
      if (img.__patched) return;
      img.__patched = true;

      var initialSrc = img.getAttribute('src');
      if (!initialSrc) return; // não faz nada se não tiver src

      // Guarda o que já tentamos para não entrar em loop
      var tried = [initialSrc];

      var onErr = function() {
        // Passo 1: Descobrir a URL original da imagem que falhou.
        var currentSrc = img.getAttribute('src');
        var original = getOriginalUrl(currentSrc) || getOriginalUrl(initialSrc);
        
        if (!original) {
          // Se não há URL original, não há mais o que fazer.
          img.removeEventListener('error', onErr);
          return;
        }

        // Passo 2: Gerar variações da URL (cdn vs media.discordapp).
        var variations = getVariations(original);
        var candidates = [];

        // Passo 3: Montar uma lista de URLs para tentar, em ordem de prioridade.
        // Prioridade 1: Variações através do nosso proxy.
        variations.forEach(function(v) { candidates.push('/img?u=' + encodeURIComponent(v)); });
        // Prioridade 2: Variações com link direto (fallback se o proxy falhar).
        variations.forEach(function(v) { candidates.push(v); });

        // Passo 4: Tentar carregar o próximo candidato da lista que ainda não foi tentado.
        for (var i = 0; i < candidates.length; i++) {
          var cand = candidates[i];
          if (tried.indexOf(cand) === -1) {
            tried.push(cand);
            img.src = cand;
            return; // Tenta este candidato e para. Se falhar, onErr será chamado de novo.
          }
        }
        // Se chegou até aqui, todas as tentativas falharam.
        img.removeEventListener('error', onErr);
        // Mostra uma imagem padrão de "não encontrado" para melhorar a experiência.
        img.src = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjgiIGhlaWdodD0iMTI4IiB2aWV3Qm94PSIwIDAgMjQgMjQiPjxwYXRoIGZpbGw9IiM0ZjU0NWMiIGQ9Ik0yMCA0SDhjLTQuNDIgMC04IDMuNTgtOCA4djRhNCA0IDAgMCAwIDQgNGg0di00aC0yYTMuOTkgMy45OSAwIDAgMS0uNDEtLjc4bDEuNTgtMS41OGExIDEgMCAxIDEgMS40MiAxLjQyTDEwLjggMTQuNEExLjk5IDEuOTkgMCAwIDAgMTIgMTRoOHY0aDJhMiAyIDAgMCAwIDItMlY2YzAtMS4xLS45LTItMi0ybS00IDhjLTIuMjEgMC00LTEuNzktNC00czEuNzktNCA0LTQgNCAxLjc5IDQgNGE0LjAwNSA0LjAwNSAwIDAgMS00IDRabS0uMDEtNmMtMS4xIDAtMiAuOS0yIDJzLjkgMiAyIDIgMi0uOSAyLTJzLS45LTItMi0yWiIvPjxwYXRoIGZpbGw9IiM0ZjU0NWMiIGQ9Ik02IDJjLTEuMSAwLTIgLjktMiAydjJoNFYyem0wIDhjMCAxLjEuOSAyIDIgMmg0di00SDhDNi45IDEwIDYgMTAuOSA2IDEyIi8+PC9zdmc+';
        img.style.objectFit = 'cover';
        img.style.filter = 'grayscale(80%)';
        img.style.opacity = '0.4';
      };
      img.addEventListener('error', onErr);
    }

    function attachVideo(video) {
      if (video.__patched) return;
      video.__patched = true;

      var initialSrc = video.getAttribute('src');
      if (!initialSrc) return;

      var tried = [initialSrc];

      var onVidErr = function() {
        var currentSrc = video.getAttribute('src');
        var original = getOriginalUrl(currentSrc) || getOriginalUrl(initialSrc);
        
        if (!original) {
          video.removeEventListener('error', onVidErr);
          return;
        }

        var variations = getVariations(original);
        var candidates = [];

        // Prioridade 1: Variações através do nosso proxy.
        variations.forEach(function(v) { candidates.push('/img?u=' + encodeURIComponent(v)); });
        // Prioridade 2: Variações com link direto (fallback se o proxy falhar).
        variations.forEach(function(v) { candidates.push(v); });

        for (var i = 0; i < candidates.length; i++) {
          var cand = candidates[i];
          if (tried.indexOf(cand) === -1) {
            tried.push(cand);
            video.src = cand;
            return;
          }
        }
        video.removeEventListener('error', onVidErr);
      };
      video.addEventListener('error', onVidErr);
    }

    function applyAll() {
      // Aplica em todas as imagens (conteúdo e avatares)
      document.querySelectorAll('img').forEach(attach);
      // Aplica em todos os vídeos
      document.querySelectorAll('video').forEach(attachVideo);
    }

    applyAll();
    // ✅ Observador agora também procura por novos vídeos
    const obs = new MutationObserver((mutations) => {
      applyAll();
    });
    obs.observe(document.body, { subtree: true, childList: true });
  })();
  </script>
</body>
</html>
  `;
}

app.get('/transcript/:canalId', async (req, res) => {
  try {
    const { canalId } = req.params;
    const transcript = await Transcript.findOne({ canalId });

    if (!transcript) {
      return res.status(404).send('<h2 style="color: white; background-color: black; padding: 20px;">Transcript não encontrado.</h2>');
    }

    const html = generatePageHtml(transcript);
    res.send(html);
  } catch (error) {
    console.error(`Erro ao buscar transcript para ${req.params.canalId}:`, error);
    res.status(500).send('Erro interno ao gerar o transcript.');
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`🧾 Servidor de transcripts rodando na porta ${port}`);
});
