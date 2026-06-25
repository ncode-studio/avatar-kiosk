/**
 * Avatar Kiosk Platform - Server Node.js
 */

import 'dotenv/config';
import compression from 'compression';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import fs from 'fs';
import db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });

// Rimuove mesh piatti (shadow plane) da un GLB prodotto da assimp
async function glbRemoveFlatMeshes(glbPath) {
  try {
    const gltfPipeline = (await import('gltf-pipeline')).default;
    const glb = fs.readFileSync(glbPath);
    const { gltf } = await gltfPipeline.glbToGltf(glb);

    if (!gltf.meshes || !gltf.accessors) return;

    const meshesToRemove = new Set();
    for (let mi = 0; mi < gltf.meshes.length; mi++) {
      const mesh = gltf.meshes[mi];
      for (const prim of (mesh.primitives || [])) {
        const posIdx = prim.attributes?.POSITION;
        if (posIdx === undefined) continue;
        const acc = gltf.accessors[posIdx];
        if (!acc.min || !acc.max) continue;
        const rangeX = acc.max[0] - acc.min[0];
        const rangeY = acc.max[1] - acc.min[1];
        const rangeZ = acc.max[2] - acc.min[2];
        const flatRatio = rangeY / Math.max(rangeX, rangeZ, 0.0001);
        const isShadowName = /shadow|ground|plane|circle|disc|floor/i.test(mesh.name || '');
        if (flatRatio < 0.02 || isShadowName) {
          console.log(`[GLB] shadow mesh rimosso: "${mesh.name}" flatRatio=${flatRatio.toFixed(5)}`);
          meshesToRemove.add(mi);
        }
      }
    }
    if (meshesToRemove.size === 0) return;

    if (gltf.nodes) {
      for (const node of gltf.nodes) {
        if (node.mesh !== undefined && meshesToRemove.has(node.mesh)) delete node.mesh;
      }
    }
    meshesToRemove.forEach(i => { gltf.meshes[i].primitives = []; });

    const result = await gltfPipeline.gltfToGlb(gltf);
    fs.writeFileSync(glbPath, result.glb);
  } catch (e) {
    console.warn('[GLB] glbRemoveFlatMeshes fallito:', e.message);
  }
}

// ─── Config globale (fallback se nessun avatar specifico) ─────────────────────
const PORT         = process.env.PORT         || 3333;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const AVATAR_NAME  = process.env.AVATAR_NAME  || 'Sofia';
const DEFAULT_SYSTEM_PROMPT = process.env.AVATAR_SYSTEM_PROMPT ||
  `Sei ${AVATAR_NAME}, un'assistente virtuale professionale su un totem interattivo. Rispondi in modo chiaro, conciso e amichevole. Max 3 frasi.`;
const DEFAULT_VOICE_ID   = process.env.ELEVENLABS_VOICE_ID || '';
const DEFAULT_STT_MODEL  = process.env.STT_MODEL    || 'whisper-1';
const DEFAULT_STT_LANG   = process.env.STT_LANGUAGE || 'it';
const DEFAULT_TTS_MODEL  = process.env.TTS_MODEL    || 'eleven_multilingual_v2';
const DEFAULT_TTS_STAB   = parseFloat(process.env.TTS_STABILITY  || '0.5');
const DEFAULT_TTS_SIM    = parseFloat(process.env.TTS_SIMILARITY || '0.75');
const DEFAULT_AI_TOKENS  = parseInt(process.env.AI_MAX_TOKENS    || '512');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const sessions  = new Map();

// ─── Admin auth ───────────────────────────────────────────────────────────────
const ADMIN_USER     = process.env.ADMIN_USER     || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const adminTokens    = new Map(); // token → expiry

function genToken() { return uuidv4() + uuidv4(); }
function isAdminAuth(req) {
  const token = req.headers.cookie?.match(/admin_token=([^;]+)/)?.[1];
  if (!token) return false;
  const exp = adminTokens.get(token);
  if (!exp || Date.now() > exp) { adminTokens.delete(token); return false; }
  return true;
}
function requireAdmin(req, res, next) {
  if (isAdminAuth(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Non autorizzato' });
  res.redirect('/admin/login');
}

app.set('trust proxy', 1);
app.use(compression({ level: 6 }));
app.use(cors());
app.use(express.json({ limit: '200mb' }));
// Cache aggressiva per asset statici immutabili
app.use('/lib', express.static(join(__dirname, 'public', 'lib'), {
  maxAge: '30d', immutable: true,
}));
app.use('/models', express.static(join(__dirname, 'public', 'models'), {
  maxAge: '7d',
}));
app.use('/backgrounds', express.static(join(__dirname, 'public', 'backgrounds'), {
  maxAge: '7d',
}));
app.use('/icons', express.static(join(__dirname, 'public', 'icons'), {
  maxAge: '7d',
}));
// Blocca accesso diretto a public/admin/* senza autenticazione
app.use('/admin', (req, res, next) => {
  if (req.path === '/login') return next();
  if (isAdminAuth(req)) return next();
  res.redirect('/admin/login');
});

app.use(express.static(join(__dirname, 'public')));

// ─── WebSocket ────────────────────────────────────────────────────────────────
const clients = new Map(); // clientId → ws

wss.on('connection', ws => {
  const id = uuidv4();
  clients.set(id, { ws });
  console.log(`[ws] connected id=${id} size=${clients.size}`);
  ws.send(JSON.stringify({ type: 'connected', clientId: id }));
  ws.on('close', () => { clients.delete(id); console.log(`[ws] closed id=${id} size=${clients.size}`); });
});


function broadcastToAvatar(avatarId, payload) {
  const data = JSON.stringify(payload);
  let sent = 0;
  for (const { ws } of clients.values()) {
    try { ws.send(data); sent++; } catch {}
  }
  console.log(`[say] broadcast avatarId=${avatarId} → ${sent} client(s)`);
}

// ─── Helper: carica config avatar dal DB ──────────────────────────────────────
function getAvatarConfig(avatarId) {
  if (!avatarId) return null;
  return db.prepare('SELECT * FROM avatars WHERE id = ?').get(avatarId) || null;
}

// ─── Route: Health check ──────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/admin'));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    avatar: AVATAR_NAME,
    model:  CLAUDE_MODEL,
    tts:    !!process.env.ELEVENLABS_API_KEY,
    stt:    !!process.env.OPENAI_API_KEY,
  });
});

// ─── Route: Config avatar per kiosk ──────────────────────────────────────────
app.get('/api/avatar/:id', (req, res) => {
  const avatar = db.prepare('SELECT * FROM avatars WHERE id = ? AND published = 1').get(req.params.id);
  if (!avatar) return res.status(404).json({ error: 'Avatar non trovato o non pubblicato' });
  const { id, name, background, bg_video, model_file, idle_start, idle_end,
          speech_start, speech_end, anim_pingpong, tts_text_normalization, tts_language_normalization, avatar_scale, avatar_offset_x,
          avatar_offset_y, avatar_rot_y, camera_z, camera_y, camera_look_at_y,
          overlay_color, overlay_opacity, overlay_height, chat_height, chat_bottom, chat_max_width, chat_align, chat_hide_input,
          idle_disabled, idle_timeout, idle_icon, idle_icon_img, idle_video, idle_bg_image, idle_bg_color, idle_bg_color_alpha, idle_bg_opacity, idle_title, idle_subtitle, idle_hint, idle_font, idle_font_size,
          chat_font, chat_font_size,
          show_controls,
          mic_icon, mic_icon_disabled, mic_icon_size, mic_icon_x, mic_icon_y, mic_visible, mic_bg_color, mic_disabled_color, mic_border_color, mic_border_disabled_color,
          audio_icon, audio_icon_disabled, audio_icon_size, audio_icon_x, audio_icon_y, audio_visible, audio_bg_color, audio_disabled_color, audio_border_color, audio_border_disabled_color,
          mic_wave_color, audio_wave_color, theme, wake_word_enabled, wake_word_always, wake_words, greeting_text,
          vad_threshold, vad_silence_duration, vad_min_speech_duration, vad_min_blob_size, vad_wake_timeout,
          mic_bubble_visible, mic_bubble_text, mic_bubble_position, mic_bubble_x, mic_bubble_y,
          mic_bubble_font, mic_bubble_font_size, mic_bubble_bg_color, mic_bubble_border_color, mic_bubble_border_radius,
          mic_bubble_bg_image, mic_bubble_width, mic_bubble_height,
          touch_stop_speaking,
          ptt_enabled, ptt_icon, ptt_icon_size, ptt_icon_x, ptt_icon_y, ptt_bg_color, ptt_border_color } = avatar;
  res.json({ id, name, background, bg_video, model_file, idle_start, idle_end,
             speech_start, speech_end, anim_pingpong, tts_text_normalization, tts_language_normalization, avatar_scale, avatar_offset_x,
             avatar_offset_y, avatar_rot_y, camera_z, camera_y, camera_look_at_y,
             overlay_color, overlay_opacity, overlay_height, chat_height, chat_bottom, chat_max_width, chat_align, chat_hide_input,
             idle_disabled, idle_timeout, idle_icon, idle_icon_img, idle_video, idle_bg_image, idle_bg_color, idle_bg_color_alpha, idle_bg_opacity, idle_title, idle_subtitle, idle_hint, idle_font, idle_font_size,
             chat_font, chat_font_size,
             show_controls,
             mic_icon, mic_icon_disabled, mic_icon_size, mic_icon_x, mic_icon_y, mic_visible, mic_bg_color, mic_disabled_color, mic_border_color, mic_border_disabled_color,
             audio_icon, audio_icon_disabled, audio_icon_size, audio_icon_x, audio_icon_y, audio_visible, audio_bg_color, audio_disabled_color, audio_border_color, audio_border_disabled_color,
             mic_wave_color, audio_wave_color, theme, wake_word_enabled, wake_word_always, wake_words, greeting_text,
             vad_threshold, vad_silence_duration, vad_min_speech_duration, vad_min_blob_size, vad_wake_timeout,
             mic_bubble_visible, mic_bubble_text, mic_bubble_x, mic_bubble_y,
             mic_bubble_font, mic_bubble_font_size, mic_bubble_bg_color, mic_bubble_border_color, mic_bubble_border_radius,
             mic_bubble_bg_image, mic_bubble_width, mic_bubble_height, touch_stop_speaking,
             ptt_enabled, ptt_icon, ptt_icon_size, ptt_icon_x, ptt_icon_y, ptt_bg_color, ptt_border_color });
});

// ─── Route: Kiosk page ────────────────────────────────────────────────────────
app.get('/k/:id', (req, res) => {
  const avatar = db.prepare('SELECT * FROM avatars WHERE id = ? AND published = 1').get(req.params.id);
  if (!avatar) return res.status(404).send('<h1>Avatar non trovato o non pubblicato</h1>');
  res.sendFile(join(__dirname, 'public', 'kiosk.html'));
});

// ─── Route: Preview (anche non pubblicati, per backoffice) ────────────────────
app.get('/preview/:id', (req, res) => {
  const avatar = db.prepare('SELECT * FROM avatars WHERE id = ?').get(req.params.id);
  if (!avatar) return res.status(404).send('<h1>Avatar non trovato</h1>');
  res.sendFile(join(__dirname, 'public', 'kiosk.html'));
});

app.get('/api/preview/:id', (req, res) => {
  const avatar = db.prepare('SELECT * FROM avatars WHERE id = ?').get(req.params.id);
  if (!avatar) return res.status(404).json({ error: 'Non trovato' });
  const { id, name, background, bg_video, model_file, idle_start, idle_end,
          speech_start, speech_end, anim_pingpong, tts_text_normalization, tts_language_normalization, avatar_scale, avatar_offset_x,
          avatar_offset_y, avatar_rot_y, camera_z, camera_y, camera_look_at_y,
          overlay_color, overlay_opacity, overlay_height, chat_height, chat_bottom, chat_max_width, chat_align, chat_hide_input,
          idle_disabled, idle_timeout, idle_icon, idle_icon_img, idle_video, idle_bg_image, idle_bg_color, idle_bg_color_alpha, idle_bg_opacity, idle_title, idle_subtitle, idle_hint, idle_font, idle_font_size,
          chat_font, chat_font_size,
          show_controls,
          mic_icon, mic_icon_disabled, mic_icon_size, mic_icon_x, mic_icon_y, mic_visible, mic_bg_color, mic_disabled_color, mic_border_color, mic_border_disabled_color,
          audio_icon, audio_icon_disabled, audio_icon_size, audio_icon_x, audio_icon_y, audio_visible, audio_bg_color, audio_disabled_color, audio_border_color, audio_border_disabled_color,
          mic_wave_color, audio_wave_color, theme, wake_word_enabled, wake_word_always, wake_words, greeting_text,
          vad_threshold, vad_silence_duration, vad_min_speech_duration, vad_min_blob_size, vad_wake_timeout,
          mic_bubble_visible, mic_bubble_text, mic_bubble_position, mic_bubble_x, mic_bubble_y,
          mic_bubble_font, mic_bubble_font_size, mic_bubble_bg_color, mic_bubble_border_color, mic_bubble_border_radius,
          mic_bubble_bg_image, mic_bubble_width, mic_bubble_height,
          touch_stop_speaking,
          ptt_enabled, ptt_icon, ptt_icon_size, ptt_icon_x, ptt_icon_y, ptt_bg_color, ptt_border_color } = avatar;
  res.json({ id, name, background, bg_video, model_file, idle_start, idle_end,
             speech_start, speech_end, anim_pingpong, tts_text_normalization, tts_language_normalization, avatar_scale, avatar_offset_x,
             avatar_offset_y, avatar_rot_y, camera_z, camera_y, camera_look_at_y,
             overlay_color, overlay_opacity, overlay_height, chat_height, chat_bottom, chat_max_width, chat_align, chat_hide_input,
             idle_disabled, idle_timeout, idle_icon, idle_icon_img, idle_video, idle_bg_image, idle_bg_color, idle_bg_color_alpha, idle_bg_opacity, idle_title, idle_subtitle, idle_hint, idle_font, idle_font_size,
             chat_font, chat_font_size,
             show_controls,
             mic_icon, mic_icon_disabled, mic_icon_size, mic_icon_x, mic_icon_y, mic_visible, mic_bg_color, mic_disabled_color, mic_border_color, mic_border_disabled_color,
             audio_icon, audio_icon_disabled, audio_icon_size, audio_icon_x, audio_icon_y, audio_visible, audio_bg_color, audio_disabled_color, audio_border_color, audio_border_disabled_color,
             mic_wave_color, audio_wave_color, theme, wake_word_enabled, wake_word_always, wake_words, greeting_text,
             vad_threshold, vad_silence_duration, vad_min_speech_duration, vad_min_blob_size, vad_wake_timeout,
             mic_bubble_visible, mic_bubble_text, mic_bubble_x, mic_bubble_y,
             mic_bubble_font, mic_bubble_font_size, mic_bubble_bg_color, mic_bubble_border_color, mic_bubble_border_radius,
             mic_bubble_bg_image, mic_bubble_width, mic_bubble_height, touch_stop_speaking,
             ptt_enabled, ptt_icon, ptt_icon_size, ptt_icon_x, ptt_icon_y, ptt_bg_color, ptt_border_color });
});

// ─── Route: Admin login ───────────────────────────────────────────────────────
app.get('/admin/login', (req, res) => {
  if (isAdminAuth(req)) return res.redirect('/admin');
  res.send(`<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0a0a0f;font-family:system-ui,sans-serif;color:#e0e0e0}
  .card{background:#13131a;border:1px solid #2a2a3a;border-radius:16px;padding:40px;width:340px}
  h1{font-size:1.2rem;font-weight:700;margin-bottom:28px;color:#fff;letter-spacing:.05em}
  label{display:block;font-size:.75rem;color:#888;margin-bottom:6px}
  input{width:100%;padding:10px 14px;background:#0a0a0f;border:1px solid #2a2a3a;
        border-radius:8px;color:#e0e0e0;font-size:.95rem;margin-bottom:18px;outline:none}
  input:focus{border-color:#6c63ff}
  button{width:100%;padding:12px;background:#6c63ff;color:#fff;border:none;
         border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#857af7}
  .err{color:#f87171;font-size:.82rem;margin-top:14px;text-align:center}
</style></head><body>
<div class="card">
  <h1>🔐 Avatar Kiosk Admin</h1>
  <form method="POST" action="/admin/login">
    <label>Username</label>
    <input type="text" name="username" autocomplete="username" required autofocus/>
    <label>Password</label>
    <input type="password" name="password" autocomplete="current-password" required/>
    <button type="submit">Accedi</button>
    ${req.query.err ? '<p class="err">Credenziali non valide</p>' : ''}
  </form>
</div></body></html>`);
});

app.use(express.urlencoded({ extended: false }));

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD)
    return res.redirect('/admin/login?err=1');
  const token = genToken();
  adminTokens.set(token, Date.now() + 8 * 60 * 60 * 1000); // 8 ore
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  res.setHeader('Set-Cookie', `admin_token=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000${isHttps ? '; Secure' : ''}`);
  res.redirect('/admin');
});

app.post('/admin/logout', (req, res) => {
  const token = req.headers.cookie?.match(/admin_token=([^;]+)/)?.[1];
  if (token) adminTokens.delete(token);
  res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/admin/login');
});

// ─── Route: Admin page ────────────────────────────────────────────────────────
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(join(__dirname, 'public', 'admin', 'index.html'));
});

// ─── CRUD Avatar ──────────────────────────────────────────────────────────────
app.use('/api/admin', requireAdmin);

app.get('/api/admin/avatars', (req, res) => {
  const avatars = db.prepare('SELECT * FROM avatars ORDER BY created_at DESC').all();
  res.json(avatars);
});

app.post('/api/admin/avatars', (req, res) => {
  const id = uuidv4().split('-')[0]; // ID corto
  const { name = 'Nuovo Avatar', voice_id = '', system_prompt = DEFAULT_SYSTEM_PROMPT,
          background = '#0a0a0f' } = req.body;
  db.prepare(`INSERT INTO avatars (id, name, voice_id, system_prompt, background,
              chat_font_size, idle_font_size, mic_icon_size, audio_icon_size, chat_bottom,
              mic_icon, mic_icon_disabled, audio_icon, audio_icon_disabled,
              mic_bg_color, mic_disabled_color, mic_border_color, mic_border_disabled_color,
              audio_bg_color, audio_disabled_color, audio_border_color, audio_border_disabled_color)
              VALUES (?, ?, ?, ?, ?, 1.1, 1.1, 100, 100, 100,
              'icons/syyvs2jk_mic_icon.png', 'icons/syyvs2jk_mic_icon_disabled.png',
              'icons/syyvs2jk_audio_icon.png', 'icons/syyvs2jk_audio_icon_disabled.png',
              'rgba(250,250,250,0.70)', 'rgba(222,222,222,0.23)', 'rgba(255,255,255,0.79)', 'rgba(250,250,250,0.71)',
              'rgba(255,255,255,0.71)', 'rgba(255,255,255,0.22)', 'rgba(255,255,255,0.75)', 'rgba(255,255,255,0.71)')`).run(id, name, voice_id, system_prompt, background);
  res.json(db.prepare('SELECT * FROM avatars WHERE id = ?').get(id));
});

app.put('/api/admin/avatars/:id', (req, res) => {
  const fields = ['name','label','webhook_say_token','voice_id','system_prompt','background','idle_start','idle_end',
                  'speech_start','speech_end','avatar_scale','avatar_offset_x','avatar_offset_y',
                  'avatar_rot_y','camera_z','camera_y','camera_look_at_y',
                  'overlay_color','overlay_opacity','overlay_height','chat_height','chat_bottom','chat_max_width','chat_align','chat_hide_input',
                  'stt_api_key','stt_model','stt_language',
                  'tts_api_key','tts_model','tts_stability','tts_similarity','tts_text_normalization','tts_language_normalization','texture_quality',
                  'ai_provider','ai_max_tokens','anthropic_api_key','anthropic_model','openai_api_key','openai_model',
                  'avatar_mode','webhook_url','webhook_input_template','webhook_output_field','webhook_headers',
                  'idle_disabled','idle_timeout','idle_icon','idle_title','idle_subtitle','idle_hint','idle_font','idle_font_size','idle_bg_image','idle_bg_color','idle_bg_color_alpha','idle_bg_opacity','anim_pingpong','theme',
                  'chat_font','chat_font_size',
                  'show_controls',
                  'mic_icon_size','mic_icon_x','mic_icon_y','mic_wave_color',
                  'mic_visible','mic_bg_color','mic_disabled_color','mic_border_color','mic_border_disabled_color',
                  'audio_icon_size','audio_icon_x','audio_icon_y','audio_wave_color',
                  'audio_visible','audio_bg_color','audio_disabled_color','audio_border_color','audio_border_disabled_color',
                  'mic_icon_disabled','audio_icon_disabled',
                  'wake_word_enabled','wake_word_always','wake_words','greeting_text',
                  'vad_threshold','vad_silence_duration','vad_min_speech_duration','vad_min_blob_size','vad_wake_timeout',
                  'vad_noise_mult','stt_prompt',
                  'mcp_url','mcp_headers','mcp_tool_filter','tavily_api_key','tavily_enabled',
                  'mic_bubble_visible','mic_bubble_text','mic_bubble_x','mic_bubble_y',
                  'mic_bubble_font','mic_bubble_font_size','mic_bubble_bg_color','mic_bubble_border_color','mic_bubble_border_radius','mic_bubble_bg_image','mic_bubble_width','mic_bubble_height',
                  'rate_limit_rpm',
                  'touch_stop_speaking',
                  'ptt_enabled','ptt_icon','ptt_icon_size','ptt_icon_x','ptt_icon_y','ptt_bg_color','ptt_border_color'];
  const updates = [];
  const values  = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nessun campo da aggiornare' });
  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE avatars SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM avatars WHERE id = ?').get(req.params.id);
  // Broadcast ai kiosk connessi
  const broadcast = JSON.stringify({ type: 'config_update', avatarId: String(req.params.id), data: updated });
  for (const { ws } of clients.values()) { try { ws.send(broadcast); } catch {} }
  res.json(updated);
});

app.delete('/api/admin/avatars/:id', (req, res) => {
  const avatar = db.prepare('SELECT * FROM avatars WHERE id = ?').get(req.params.id);
  if (!avatar) return res.status(404).json({ error: 'Non trovato' });
  // Elimina file modello solo se nessun altro avatar lo usa
  if (avatar.model_file) {
    const refs = db.prepare('SELECT COUNT(*) as n FROM avatars WHERE model_file = ? AND id != ?').get(avatar.model_file, req.params.id);
    if (refs.n === 0) { try { fs.unlinkSync(join(__dirname, 'public', avatar.model_file)); } catch {} }
  }
  db.prepare('DELETE FROM avatars WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/avatars/:id/duplicate', (req, res) => {
  const src = db.prepare('SELECT * FROM avatars WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'Non trovato' });
  const newId = Math.random().toString(36).slice(2, 10);
  const { id, created_at, updated_at, published, name, label, ...rest } = src;
  const newLabel = `${label || name} (copia)`;
  db.prepare(`INSERT INTO avatars (id, name, label, published, ${Object.keys(rest).join(',')})
              VALUES (?, ?, ?, 0, ${Object.keys(rest).map(() => '?').join(',')})`)
    .run(newId, name, newLabel, ...Object.values(rest));
  const newAvatar = db.prepare('SELECT * FROM avatars WHERE id = ?').get(newId);
  res.json(newAvatar);
});

app.post('/api/admin/avatars/:id/publish', (req, res) => {
  const avatar = db.prepare('SELECT * FROM avatars WHERE id = ?').get(req.params.id);
  if (!avatar) return res.status(404).json({ error: 'Non trovato' });
  const published = avatar.published ? 0 : 1;
  db.prepare("UPDATE avatars SET published = ?, updated_at = datetime('now') WHERE id = ?")
    .run(published, req.params.id);
  res.json({ published });
});

// ─── Upload FBX / GLB / GLTF per avatar specifico ────────────────────────────
const uploadFbx = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, 'public', 'models')),
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    cb(null, `${req.params.id}_tmp.${ext}`);
  },
}) });

app.post('/api/admin/avatars/:id/upload-model', uploadFbx.single('model'), async (req, res) => {
  const rawGlb  = join(__dirname, 'public', 'models', `${req.params.id}_raw.glb`);
  const outGlb  = join(__dirname, 'public', 'models', `${req.params.id}.glb`);
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const tmpFile = join(__dirname, 'public', 'models', req.file.filename);

    if (ext === 'fbx') {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');

      // Trova FBX2glTF (fbx2gltf npm package o sistema)
      let fbx2gltf = null;
      const _platform = process.platform; // darwin | linux | win32
      const candidates = [
        // Prima il binario della piattaforma corrente
        _platform === 'darwin'  ? join(__dirname, 'node_modules/fbx2gltf/bin/Darwin/FBX2glTF') : null,
        _platform === 'linux'   ? join(__dirname, 'node_modules/fbx2gltf/bin/Linux/FBX2glTF')  : null,
        _platform === 'win32'   ? join(__dirname, 'node_modules/fbx2gltf/bin/Windows_NT/FBX2glTF.exe') : null,
        '/usr/local/bin/FBX2glTF',
        '/opt/homebrew/bin/FBX2glTF',
        join(process.env.HOME || '', '.npm-global/lib/node_modules/fbx2gltf/bin/Darwin/FBX2glTF'),
        join(process.env.HOME || '', '.npm-global/lib/node_modules/fbx2gltf/bin/Linux/FBX2glTF'),
      ].filter(Boolean);
      for (const c of candidates) {
        try { if (fs.existsSync(c)) { fbx2gltf = c; break; } } catch {}
      }

      let converted = false;
      const _arch = process.arch; // x64 | arm64 | arm
      console.log('[FBX] piattaforma:', _platform, _arch, '| fbx2gltf:', fbx2gltf || 'no');

      // Prova FBX2glTF (solo su x64 — il binario npm non supporta ARM)
      if (fbx2gltf && _arch === 'x64') {
        try {
          fs.accessSync(fbx2gltf, fs.constants.X_OK);
          console.log('[FBX] Uso fbx2gltf:', fbx2gltf);
          const rawGlbBase = rawGlb.replace(/\.glb$/, '');
          await promisify(execFile)(fbx2gltf, ['--binary', tmpFile, '--output', rawGlbBase]);
          converted = fs.existsSync(rawGlb) && fs.statSync(rawGlb).size > 1024;
          if (converted) console.log('[FBX] fbx2gltf OK');
          else console.warn('[FBX] fbx2gltf non ha prodotto output');
        } catch (e) {
          console.warn('[FBX] fbx2gltf fallito:', e.message);
        }
      }

      // assimp (funziona bene su ARM64, rimuoviamo shadow plane dopo)
      if (!converted) {
        try {
          const { exec } = await import('child_process');
          console.log('[FBX] Provo assimp...');
          await promisify(exec)(`assimp export "${tmpFile}" "${rawGlb}"`, { timeout: 120000 });
          converted = fs.existsSync(rawGlb) && fs.statSync(rawGlb).size > 1024;
          if (converted) {
            console.log('[FBX] assimp OK — rimuovo shadow plane...');
            await glbRemoveFlatMeshes(rawGlb);
          } else {
            console.error('[FBX] assimp non ha prodotto output GLB valido');
          }
        } catch (e) {
          console.error('[FBX] assimp fallito:', e.message);
        }
      }

      // Blender (ultimo tentativo)
      if (!converted) {
        console.log('[FBX] Provo Blender...');
        const blenderScript = `
import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
fbx_path = sys.argv[-2]
glb_path = sys.argv[-1]
bpy.ops.import_scene.fbx(filepath=fbx_path, automatic_bone_orientation=True)
bpy.ops.export_scene.gltf(filepath=glb_path, export_format='GLB', use_selection=False, export_yup=True)
print("Done")
`.trim();
        const scriptFile = tmpFile + '.py';
        fs.writeFileSync(scriptFile, blenderScript);
        try {
          const { exec } = await import('child_process');
          const blenderCmd = `blender --background --python "${scriptFile}" -- "${tmpFile}" "${rawGlb.replace(/\.glb$/, '')}"`;
          await promisify(exec)(blenderCmd, { timeout: 120000 });
          const blenderOut = rawGlb.replace(/\.glb$/, '') + '.glb';
          if (fs.existsSync(blenderOut) && blenderOut !== rawGlb) fs.renameSync(blenderOut, rawGlb);
          converted = fs.existsSync(rawGlb);
          if (converted) console.log('[FBX] Blender OK');
          else console.error('[FBX] Blender non ha prodotto output GLB');
        } catch (e) {
          console.error('[FBX] Blender fallito:', e.message);
        } finally {
          try { fs.unlinkSync(scriptFile); } catch {}
        }
      }

      // Ultimo fallback: assimp (include shadow plane ma almeno converte)
      fs.unlinkSync(tmpFile);
      if (!converted) return res.status(500).json({ error: 'Conversione FBX fallita. Esporta il modello in .glb o .gltf e caricalo direttamente.' });
    } else if (ext === 'glb') {
      // GLB: usa direttamente come raw
      fs.renameSync(tmpFile, rawGlb);
    } else if (ext === 'gltf') {
      // GLTF: converti in GLB tramite gltf-pipeline
      const gltfPipeline = (await import('gltf-pipeline')).default;
      const gltfContent = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
      const result = await gltfPipeline.gltfToGlb(gltfContent, { resourceDirectory: join(__dirname, 'public', 'models') });
      fs.writeFileSync(rawGlb, result.glb);
      fs.unlinkSync(tmpFile);
    } else {
      fs.unlinkSync(tmpFile);
      return res.status(400).json({ error: 'Formato non supportato. Usa FBX, GLB o GLTF.' });
    }

    // 2. Comprimi texture PNG → JPEG nel GLB (ricostruisce il binary da zero)
    const skipCompress = req.query.skipCompress === '1';
    let originalKB, compressedKB, jsonForAnim;
    if (skipCompress) {
      fs.renameSync(rawGlb, outGlb);
      originalKB = compressedKB = Math.round(fs.statSync(outGlb).size / 1024);
      try {
        const buf = fs.readFileSync(outGlb);
        const jl = buf.readUInt32LE(12);
        jsonForAnim = JSON.parse(buf.slice(20, 20 + jl).toString());
      } catch (_) {}
    } else {
    const avatarRow = db.prepare('SELECT texture_quality FROM avatars WHERE id = ?').get(req.params.id);
    const TEX_QUALITY = Math.max(60, Math.min(100, parseInt(req.query.texQuality) || parseInt(avatarRow?.texture_quality) || 85));
    const sharp = (await import('sharp')).default;
    const rawKB = Math.round(fs.statSync(rawGlb).size / 1024);
    const glbBuf = fs.readFileSync(rawGlb);
    const jsonLen = glbBuf.readUInt32LE(12);
    const json = JSON.parse(glbBuf.slice(20, 20 + jsonLen).toString());
    const binOffset = 12 + 8 + jsonLen + 8;
    const origBin = glbBuf.slice(binOffset);

    // Raccoglie i chunk del nuovo binary: per ogni bufferView, usa dati originali o compressi
    const newChunks = [];
    let newOffset = 0;

    // Mappa bufferView → nuovo chunk (per gestire bufferView non-texture invariate)
    const bvRemap = new Map(); // bvIndex → { offset, length }

    // Prima passa: comprime le texture e raccoglie i chunk
    const imgBvSet = new Set((json.images || []).map(img => img.bufferView).filter(i => i !== undefined));

    for (let bvIdx = 0; bvIdx < (json.bufferViews || []).length; bvIdx++) {
      const bv = json.bufferViews[bvIdx];
      const data = origBin.slice(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
      let outData = data;

      if (imgBvSet.has(bvIdx)) {
        const img = (json.images || []).find(i => i.bufferView === bvIdx);
        if (img && (img.mimeType === 'image/png' || img.mimeType === 'image/jpeg')) {
          try {
            const meta = await sharp(data).metadata();
            const MAX_TEX = 2048;
            const needsResize = meta.width > MAX_TEX || meta.height > MAX_TEX;
            const pipeline = needsResize
              ? sharp(data).resize(MAX_TEX, MAX_TEX, { fit: 'inside', withoutEnlargement: true })
              : sharp(data);
            const compressed = await pipeline.jpeg({ quality: TEX_QUALITY, mozjpeg: true }).toBuffer();
            outData = compressed;
            img.mimeType = 'image/jpeg';
          } catch (e) { console.error('Sharp compress error bv'+bvIdx+':', e.message); }
        }
      }

      const aligned = Buffer.alloc(Math.ceil(outData.length / 4) * 4, 0x00);
      outData.copy(aligned);
      newChunks.push(aligned);
      bvRemap.set(bvIdx, { offset: newOffset, length: outData.length });
      newOffset += aligned.length;
    }

    // Aggiorna gli offset dei bufferViews nel JSON
    for (let bvIdx = 0; bvIdx < (json.bufferViews || []).length; bvIdx++) {
      const r = bvRemap.get(bvIdx);
      if (r) { json.bufferViews[bvIdx].byteOffset = r.offset; json.bufferViews[bvIdx].byteLength = r.length; }
    }

    const newBin = Buffer.concat(newChunks);
    json.buffers[0].byteLength = newBin.length;

    const newJsonStr = JSON.stringify(json);
    const jsonPadded = Buffer.alloc(Math.ceil(newJsonStr.length / 4) * 4, 0x20);
    Buffer.from(newJsonStr).copy(jsonPadded);
    const binPadded = Buffer.alloc(Math.ceil(newBin.length / 4) * 4, 0x00);
    newBin.copy(binPadded);
    const totalLen = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
    const header = Buffer.alloc(12); header.writeUInt32LE(0x46546C67,0); header.writeUInt32LE(2,4); header.writeUInt32LE(totalLen,8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonPadded.length,0); jh.writeUInt32LE(0x4E4F534A,4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binPadded.length,0);  bh.writeUInt32LE(0x004E4942,4);
    fs.writeFileSync(outGlb, Buffer.concat([header,jh,jsonPadded,bh,binPadded]));
    fs.unlinkSync(rawGlb);

    originalKB   = rawKB;
    compressedKB = Math.round(fs.statSync(outGlb).size / 1024);
    console.log(`Texture compress: ${originalKB}KB → ${compressedKB}KB (-${Math.round((1-compressedKB/originalKB)*100)}%)`);
    jsonForAnim = json;
    } // end else (skipCompress)

    // Calcola durata animazioni per settare idle/speech interval di default
    let animDuration = null;
    try {
      for (const anim of ((jsonForAnim || {}).animations || [])) {
        for (const sampler of (anim.samplers || [])) {
          const acc = (jsonForAnim.accessors || [])[sampler.input];
          if (acc?.max?.[0] != null) animDuration = Math.max(animDuration ?? 0, acc.max[0]);
        }
      }
    } catch (_) {}

    const modelFile = `models/${req.params.id}.glb`;
    if (animDuration != null) {
      db.prepare("UPDATE avatars SET model_file = ?, idle_start = 0, idle_end = ?, speech_start = 0, speech_end = ?, updated_at = datetime('now') WHERE id = ?")
        .run(modelFile, animDuration, animDuration, req.params.id);
    } else {
      db.prepare("UPDATE avatars SET model_file = ?, updated_at = datetime('now') WHERE id = ?")
        .run(modelFile, req.params.id);
    }
    res.json({ ok: true, model_file: modelFile, originalKB, compressedKB, animDuration });
  } catch (err) {
    console.error('Upload model error:', err);
    try { if (fs.existsSync(rawGlb)) fs.unlinkSync(rawGlb); } catch {}
    res.status(500).json({ error: 'Conversione fallita: ' + err.message });
  }
});

// ─── Upload sfondo per avatar ─────────────────────────────────────────────────
const uploadBg = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, 'public', 'backgrounds')),
  filename:    (req, file, cb) => cb(null, `${req.params.id}${extname(file.originalname)}`),
}) });

app.post('/api/admin/avatars/:id/upload-background', uploadBg.single('background'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  const bgFile = `backgrounds/${req.file.filename}`;
  db.prepare("UPDATE avatars SET background = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bgFile, req.params.id);
  res.json({ ok: true, background: bgFile });
});

// ─── Route: Upload video sfondo avatar ───────────────────────────────────────
fs.mkdirSync(join(__dirname, 'public', 'bg-videos'), { recursive: true });
app.use('/bg-videos', express.static(join(__dirname, 'public', 'bg-videos')));

const uploadBgVideo = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, 'public', 'bg-videos')),
  filename:    (req, file, cb) => cb(null, `${req.params.id}${extname(file.originalname)}`),
}) });

app.post('/api/admin/avatars/:id/upload-bg-video', uploadBgVideo.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  const videoFile = `bg-videos/${req.file.filename}`;
  db.prepare("UPDATE avatars SET bg_video = ?, updated_at = datetime('now') WHERE id = ?")
    .run(videoFile, req.params.id);
  res.json({ ok: true, bg_video: videoFile });
});

app.delete('/api/admin/avatars/:id/bg-video', (req, res) => {
  const avatar = db.prepare('SELECT bg_video FROM avatars WHERE id = ?').get(req.params.id);
  if (avatar?.bg_video) { try { fs.unlinkSync(join(__dirname, 'public', avatar.bg_video)); } catch {} }
  db.prepare("UPDATE avatars SET bg_video = '', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─── Route: Upload video standby ─────────────────────────────────────────────
fs.mkdirSync(join(__dirname, 'public', 'idle-videos'), { recursive: true });
app.use('/idle-videos', express.static(join(__dirname, 'public', 'idle-videos')));

const uploadIdleVideo = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, 'public', 'idle-videos')),
  filename:    (req, file, cb) => cb(null, `${req.params.id}${extname(file.originalname)}`),
}) });

app.post('/api/admin/avatars/:id/upload-idle-video', uploadIdleVideo.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  const videoFile = `idle-videos/${req.file.filename}`;
  db.prepare("UPDATE avatars SET idle_video = ?, updated_at = datetime('now') WHERE id = ?")
    .run(videoFile, req.params.id);
  res.json({ ok: true, idle_video: videoFile });
});

app.delete('/api/admin/avatars/:id/idle-video', (req, res) => {
  const avatar = db.prepare('SELECT idle_video FROM avatars WHERE id = ?').get(req.params.id);
  if (avatar?.idle_video) { try { fs.unlinkSync(join(__dirname, 'public', avatar.idle_video)); } catch {} }
  db.prepare("UPDATE avatars SET idle_video = '', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─── Route: Upload immagine sfondo idle ──────────────────────────────────────
fs.mkdirSync(join(__dirname, 'public', 'idle-bg'), { recursive: true });
app.use('/idle-bg', express.static(join(__dirname, 'public', 'idle-bg')));

const uploadIdleBg = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, 'public', 'idle-bg')),
  filename:    (req, file, cb) => cb(null, `${req.params.id}${extname(file.originalname)}`),
}) });

app.post('/api/admin/avatars/:id/upload-idle-bg', uploadIdleBg.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  const bgFile = `idle-bg/${req.file.filename}`;
  db.prepare("UPDATE avatars SET idle_bg_image = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bgFile, req.params.id);
  res.json({ ok: true, idle_bg_image: bgFile });
});

app.delete('/api/admin/avatars/:id/idle-bg', (req, res) => {
  const avatar = db.prepare('SELECT idle_bg_image FROM avatars WHERE id = ?').get(req.params.id);
  if (avatar?.idle_bg_image) { try { fs.unlinkSync(join(__dirname, 'public', avatar.idle_bg_image)); } catch {} }
  db.prepare("UPDATE avatars SET idle_bg_image = '', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─── Route: Upload icone mic/audio ───────────────────────────────────────────
fs.mkdirSync(join(__dirname, 'public', 'icons'), { recursive: true });

const uploadIcon = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, join(__dirname, 'public', 'icons')),
  filename:    (req, file, cb) => cb(null, `${req.params.id}-${req.params.type}${extname(file.originalname)}`),
}) });

app.post('/api/admin/avatars/:id/upload-icon/:type', uploadIcon.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file ricevuto' });
  const type = req.params.type; // 'mic' | 'audio' | 'idle' | 'ptt'
  if (!['mic', 'mic-disabled', 'audio', 'audio-disabled', 'idle', 'mic-bubble', 'ptt'].includes(type)) return res.status(400).json({ error: 'Tipo non valido' });
  const iconFile = `icons/${req.file.filename}`;
  const col = type === 'mic' ? 'mic_icon' : type === 'mic-disabled' ? 'mic_icon_disabled'
            : type === 'audio' ? 'audio_icon' : type === 'audio-disabled' ? 'audio_icon_disabled'
            : type === 'mic-bubble' ? 'mic_bubble_bg_image'
            : type === 'ptt' ? 'ptt_icon' : 'idle_icon_img';
  db.prepare(`UPDATE avatars SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(iconFile, req.params.id);
  res.json({ ok: true, [col]: iconFile });
});

// ─── Route: STT ──────────────────────────────────────────────────────────────
app.post('/api/stt', multer({ storage: multer.memoryStorage() }).single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nessun file audio ricevuto' });
    const rl = checkRateLimit(req, req.body?.avatarId);
    if (!rl.allowed) {
      logRequest(req.body?.avatarId, 'stt', rl.ip || getClientIp(req), true, 0, 0);
      return res.status(429).json({ error: 'Troppe richieste. Riprova tra poco.' });
    }
    const avatar   = getAvatarConfig(req.body?.avatarId);
    const sttKey    = avatar?.stt_api_key  || process.env.OPENAI_API_KEY;
    const sttModel  = avatar?.stt_model    || DEFAULT_STT_MODEL;
    const sttLang   = avatar?.stt_language || DEFAULT_STT_LANG;
    const sttPrompt = avatar?.stt_prompt   || '';
    const formData = new FormData();
    formData.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' }), 'audio.webm');
    formData.append('model', sttModel);
    formData.append('language', sttLang);
    formData.append('temperature', '0');
    formData.append('response_format', 'verbose_json');
    if (sttPrompt) formData.append('prompt', sttPrompt);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sttKey}` },
      body: formData,
    });
    if (!response.ok) throw new Error(`Whisper error: ${await response.text()}`);
    const data = await response.json();
    const sttSeconds = Math.ceil(data.duration || 0);
    logRequest(req.body?.avatarId, 'stt', rl.ip || getClientIp(req), false, sttSeconds, 0);
    const WHISPER_HALLUCINATIONS = [
      'sottotitoli e revisione a cura di qtss',
      'sottotitoli a cura di qtss',
      'sub ita by qtss',
      'sottotitoli creati dalla comunità di amara.org',
      'amara.org',
      'grazie per aver guardato',
      'grazie per la visione',
      'iscriviti al canale',
    ];
    const transcript = data.text || '';
    const isHallucination = WHISPER_HALLUCINATIONS.some(h => transcript.toLowerCase().includes(h));
    res.json({ transcript: isHallucination ? '' : transcript });
  } catch (error) {
    console.error('STT error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Route: Fetch modelli (admin) ────────────────────────────────────────────
app.post('/api/admin/fetch-models', async (req, res) => {
  try {
    const { provider, apiKey } = req.body;
    if (!provider || !apiKey) return res.status(400).json({ error: 'provider e apiKey obbligatori' });

    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) throw new Error(`OpenAI: ${await r.text()}`);
      const data = await r.json();
      const models = data.data
        .filter(m => m.id.includes('whisper') || m.id.includes('transcri'))
        .map(m => ({ id: m.id, name: m.id }))
        .sort((a,b) => a.id.localeCompare(b.id));
      return res.json({ models });
    }

    if (provider === 'openai-gpt') {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) throw new Error(`OpenAI: ${await r.text()}`);
      const data = await r.json();
      const models = data.data
        .filter(m => m.id.startsWith('gpt') || m.id.startsWith('o1') || m.id.startsWith('o3'))
        .map(m => ({ id: m.id, name: m.id }))
        .sort((a,b) => a.id.localeCompare(b.id));
      return res.json({ models });
    }

    if (provider === 'elevenlabs-models') {
      const r = await fetch('https://api.elevenlabs.io/v1/models', {
        headers: { 'xi-api-key': apiKey },
      });
      const raw = await r.text();
      if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${raw.slice(0,200)}`);
      let data; try { data = JSON.parse(raw); } catch { throw new Error(`Risposta non JSON: ${raw.slice(0,200)}`); }
      if (!Array.isArray(data)) throw new Error(`Formato inatteso: ${JSON.stringify(data).slice(0,200)}`);
      const models = data.map(m => ({ id: m.model_id, name: m.name }));
      return res.json({ models });
    }

    if (provider === 'elevenlabs-voices') {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });
      const raw = await r.text();
      if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${raw.slice(0,200)}`);
      let data; try { data = JSON.parse(raw); } catch { throw new Error(`Risposta non JSON: ${raw.slice(0,200)}`); }
      if (!data.voices) throw new Error(`Campo 'voices' mancante: ${JSON.stringify(data).slice(0,200)}`);
      const models = data.voices.map(v => ({
        id: v.voice_id,
        name: v.name,
        preview_url: v.preview_url || '',
        accent: v.labels?.accent || '',
        language: v.labels?.language || v.fine_tuning?.language || '',
        gender: v.labels?.gender || '',
        age: v.labels?.age || '',
        use_case: v.labels?.use_case || '',
      }));
      return res.json({ models });
    }

    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      const raw = await r.text();
      if (!r.ok) throw new Error(`Anthropic ${r.status}: ${raw.slice(0,200)}`);
      let data; try { data = JSON.parse(raw); } catch { throw new Error(`Risposta non JSON: ${raw.slice(0,200)}`); }
      if (!data.data) throw new Error(`Formato inatteso: ${JSON.stringify(data).slice(0,200)}`);
      const models = data.data.map(m => ({ id: m.id, name: m.display_name || m.id }));
      return res.json({ models });
    }

    res.status(400).json({ error: `Provider '${provider}' non supportato` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Route: TTS preview (admin) ──────────────────────────────────────────────
app.post('/api/admin/tts-preview', async (req, res) => {
  try {
    const { text, voiceId, apiKey, model, stability, similarity, textNorm, langNorm, languageCode } = req.body;
    if (!text)    return res.status(400).json({ error: 'Testo mancante' });
    if (!voiceId) return res.status(400).json({ error: 'Voice ID mancante' });
    const key = apiKey || process.env.ELEVENLABS_API_KEY;
    if (!key)     return res.status(400).json({ error: 'API Key mancante' });

    const buildBody = (withLangNorm) => JSON.stringify({
      text,
      model_id: model || DEFAULT_TTS_MODEL,
      voice_settings: {
        stability:        stability  >= 0 ? stability  : DEFAULT_TTS_STAB,
        similarity_boost: similarity >= 0 ? similarity : DEFAULT_TTS_SIM,
      },
      apply_text_normalization: textNorm || 'auto',
      ...(withLangNorm && languageCode ? { apply_language_text_normalization: true, language_code: languageCode } : {}),
    });
    let r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: buildBody(langNorm),
    });
    if (!r.ok && langNorm) {
      const raw = await r.text();
      const parsed = (() => { try { return JSON.parse(raw); } catch { return null; } })();
      if (parsed?.detail?.status === 'language_text_normalization_not_supported') {
        r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
          body: buildBody(false),
        });
        res.set('x-lang-norm-warning', 'not_supported');
        res.set('Access-Control-Expose-Headers', 'x-lang-norm-warning');
      } else {
        throw new Error(parsed?.detail?.message || raw.slice(0, 300));
      }
    }
    if (!r.ok) { const t = await r.text(); throw new Error(JSON.parse(t)?.detail?.message || t.slice(0, 300)); }
    const buf = await r.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Route: Test webhook (admin) ─────────────────────────────────────────────
app.post('/api/admin/webhook-test', async (req, res) => {
  try {
    const { url, inputTemplate, outputField, headers: extraHdrs, message } = req.body;
    if (!url) return res.status(400).json({ error: 'URL mancante' });
    const testMsg   = message || 'test';
    const template  = inputTemplate || '{"query":"{{query}}"}';
    const sid       = uuidv4();
    const timestamp = new Date().toISOString();
    const esc = s => s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    const jsonStr = template
      .replace(/\{\{query\}\}/g,      esc(testMsg))
      .replace(/\{\{session_id\}\}/g, esc(sid))
      .replace(/\{\{user_id\}\}/g,    esc(uuidv4()))
      .replace(/\{\{timestamp\}\}/g,  esc(timestamp))
      .replace(/\{\{temp_id\}\}/g,    `temp_test_${Date.now()}`);
    let body;
    try { body = JSON.parse(jsonStr); } catch { return res.status(400).json({ error: 'Template JSON non valido' }); }
    let extraHeaders = {};
    try { extraHeaders = typeof extraHdrs === 'string' ? JSON.parse(extraHdrs) : (extraHdrs || {}); } catch {}
    const whRes = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
    if (!whRes.ok) throw new Error(`HTTP ${whRes.status}: ${await whRes.text()}`);
    const rawText = await whRes.text();
    if (!rawText?.trim()) throw new Error('Body vuoto — aggiungi un nodo "Respond to Webhook" nel workflow n8n');
    let data;
    try { data = JSON.parse(rawText); } catch { throw new Error(`Risposta non è JSON valido: ${rawText.slice(0,200)}`); }
    const reply = getNestedField(data, outputField || 'response');
    if (reply == null) throw new Error(`Campo '${outputField}' non trovato.\nRisposta ricevuta:\n${JSON.stringify(data, null, 2)}`);
    res.json({ reply: String(reply), raw: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Helper: client MCP universale (SSE + JSON-RPC + REST) ───────────────────
// Rilevamento automatico del trasporto:
//   1. Se l'URL termina con /sse o risponde con text/event-stream → protocollo SSE
//   2. Altrimenti prova JSON-RPC diretto (POST al root)
//   3. Fallback REST (GET /tools, POST /call)
async function mcpDetectTransport(url, headers) {
  if (/\/sse$|\/sse\/|mcp_server/.test(url)) return 'sse';
  try {
    const r = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(3000) });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) return 'sse';
  } catch {}
  // Prova initialize per rilevare Streamable HTTP (MCP 2025)
  try {
    const streamHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers };
    const r = await fetch(url, {
      method: 'POST', headers: streamHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'avatar-kiosk', version: '1.0' },
      }}),
      signal: AbortSignal.timeout(5000),
    });
    // Streamable HTTP: il server può essere stateful (header mcp-session-id)
    // oppure stateless (risponde in SSE senza session-id, es. pip-chat).
    const ct = r.headers.get('content-type') || '';
    if (r.ok && (r.headers.get('mcp-session-id') || ct.includes('text/event-stream'))) return 'streamable';
  } catch {}
  return 'jsonrpc';
}

// Legge la prima risposta JSON-RPC da uno stream SSE (per Streamable HTTP)
async function mcpReadSseBody(response) {
  const text = await response.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      try { return JSON.parse(line.slice(5).trim()); } catch {}
    }
  }
  throw new Error('Nessun dato JSON nella risposta SSE');
}

async function mcpSseCall(url, headers, method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP SSE timeout')), timeoutMs);
    let buffer = '';
    let epUrl = null;
    // ID fissi per i due messaggi: 1=initialize, 2=metodo target
    const INIT_ID = 1;
    const CALL_ID = 2;
    let initialized = false;

    const post = (body) => fetch(epUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    (async () => {
      const sseRes = await fetch(url, {
        headers: { Accept: 'text/event-stream', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!sseRes.ok) throw new Error(`SSE connect failed: ${sseRes.status} ${await sseRes.text()}`);

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let eventType = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.replace(/\r$/, '');
          if (trimmed.startsWith('event:')) {
            eventType = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            const data = trimmed.slice(5).trim();
            if (eventType === 'endpoint') {
              const base = new URL(url);
              epUrl = data.startsWith('http') ? data : `${base.protocol}//${base.host}${data}`;
              // Fase 1: initialize
              await post({ jsonrpc: '2.0', id: INIT_ID, method: 'initialize', params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'avatar-kiosk', version: '1.0' },
              }});
            } else if (eventType === 'message') {
              try {
                const msg = JSON.parse(data);
                if (msg.id === INIT_ID && !initialized) {
                  initialized = true;
                  // Fase 2: invia il metodo richiesto
                  await post({ jsonrpc: '2.0', id: CALL_ID, method, params: params || {} });
                } else if (msg.id === CALL_ID) {
                  clearTimeout(timer);
                  reader.cancel();
                  if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                  else resolve(msg.result);
                  return;
                }
              } catch {}
            }
          } else if (trimmed === '') {
            eventType = null;
          }
        }
      }
      reject(new Error('SSE stream ended without response'));
    })().catch(e => { clearTimeout(timer); reject(e); });
  });
}

async function mcpListTools(url, headers) {
  const transport = await mcpDetectTransport(url, headers);
  const baseUrl = url.replace(/\/$/, '');
  const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

  if (transport === 'sse') {
    const result = await mcpSseCall(url, headers, 'tools/list', {});
    return result?.tools || [];
  }

  if (transport === 'streamable') {
    const session = await mcpOpenSession(url, headers);
    return session.listTools();
  }

  // JSON-RPC diretto — initialize + tools/list
  try {
    const post = async (body) => {
      const r = await fetch(url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(text);
    };
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'avatar-kiosk', version: '1.0' },
    }});
    const d = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (d.result?.tools) return d.result.tools;
  } catch {}

  // REST fallback
  const r2 = await fetch(`${baseUrl}/tools`, { headers: jsonHeaders });
  if (!r2.ok) throw new Error(`HTTP ${r2.status}: ${await r2.text()}`);
  const d = await r2.json();
  return Array.isArray(d) ? d : (d.tools || []);
}

async function mcpCallTool(url, headers, name, args) {
  const transport = await mcpDetectTransport(url, headers);
  const baseUrl = url.replace(/\/$/, '');
  const jsonHeaders = { 'Content-Type': 'application/json', ...headers };

  if (transport === 'sse') {
    const result = await mcpSseCall(url, headers, 'tools/call', { name, arguments: args });
    const content = result?.content;
    if (Array.isArray(content)) return content.map(c => c.text ?? JSON.stringify(c)).join('\n');
    return JSON.stringify(result);
  }

  // JSON-RPC diretto — initialize (con session), poi tools/call
  const postJson = async (body, extraHeaders = {}) => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...jsonHeaders, ...extraHeaders },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`MCP HTTP ${r.status}: ${text.slice(0, 300)}`);
    return { data: JSON.parse(text), sessionId: r.headers.get('mcp-session-id') };
  };

  try {
    const initRes = await postJson({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'avatar-kiosk', version: '1.0' },
    }});
    const sessionHeaders = initRes.sessionId ? { 'mcp-session-id': initRes.sessionId } : {};

    const callRes = await postJson(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
      sessionHeaders
    );
    const d = callRes.data;
    if (d.error) throw new Error(`MCP error: ${JSON.stringify(d.error)}`);
    const content = d.result?.content;
    if (Array.isArray(content)) return content.map(c => c.text ?? JSON.stringify(c)).join('\n');
    return JSON.stringify(d.result);
  } catch (e) {
    throw new Error(`MCP tool call failed: ${e.message}`);
  }
}

// Crea una sessione MCP persistente (un solo initialize, tutte le call condividono la sessione)
// Supporta sia JSON-RPC puro (2024) che Streamable HTTP / SSE (MCP 2025)
async function mcpOpenSession(url, headers) {
  const streamHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...headers,
  };
  let callId = 1;
  let transportSessionId = null;

  const post = async (body) => {
    const h = transportSessionId ? { ...streamHeaders, 'mcp-session-id': transportSessionId } : streamHeaders;
    const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`MCP HTTP ${r.status}: ${text.slice(0, 300)}`);
    // Aggiorna session ID se il server lo manda
    const sid = r.headers.get('mcp-session-id');
    if (sid) transportSessionId = sid;
    const ct = r.headers.get('content-type') || '';
    // Risposta SSE: estrai il JSON dalla riga "data: ..."
    if (ct.includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          try { return JSON.parse(line.slice(5).trim()); } catch {}
        }
      }
      throw new Error('Nessun dato JSON nella risposta SSE');
    }
    return JSON.parse(text);
  };

  await post({ jsonrpc: '2.0', id: callId++, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'avatar-kiosk', version: '1.0' },
  }});

  return {
    async listTools() {
      const d = await post({ jsonrpc: '2.0', id: callId++, method: 'tools/list', params: {} });
      return d.result?.tools || [];
    },
    async callTool(name, args) {
      const d = await post(
        { jsonrpc: '2.0', id: callId++, method: 'tools/call', params: { name, arguments: args } },
      );
      if (d.error) throw new Error(`MCP error: ${JSON.stringify(d.error)}`);
      const content = d.result?.content;
      if (Array.isArray(content)) return content.map(c => c.text ?? JSON.stringify(c)).join('\n');
      return JSON.stringify(d.result);
    },
  };
}

// ─── Route: Test connessione MCP ──────────────────────────────────────────────
app.post('/api/admin/mcp-test', requireAdmin, async (req, res) => {
  try {
    const { url, headers: extraHdrs } = req.body;
    if (!url) return res.status(400).json({ error: 'URL mancante' });
    let extraHeaders = {};
    try { extraHeaders = typeof extraHdrs === 'string' ? JSON.parse(extraHdrs) : (extraHdrs || {}); } catch {}
    const tools = await mcpListTools(url, extraHeaders);
    res.json({ tools });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Route: Webhook "say" — inietta frase nell'avatar ────────────────────────
app.post('/api/avatar/:id/say', (req, res) => {
  const { text, token } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Campo "text" mancante' });
  if (!token)        return res.status(401).json({ error: 'Campo "token" mancante' });

  const avatar = db.prepare('SELECT webhook_say_token FROM avatars WHERE id = ?').get(req.params.id);
  if (!avatar)                           return res.status(404).json({ error: 'Avatar non trovato' });
  if (!avatar.webhook_say_token)         return res.status(403).json({ error: 'Webhook say non configurato per questo avatar' });
  if (avatar.webhook_say_token !== token) return res.status(403).json({ error: 'Token non valido' });

  broadcastToAvatar(req.params.id, { type: 'say', avatarId: req.params.id, text: text.trim() });
  res.json({ ok: true });
});

// ─── Route: Statistiche monitoraggio ─────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const todayStart = today + ' 00:00:00';

    const totalsRow = db.prepare(`
      SELECT
        COUNT(*)            AS total,
        SUM(blocked)        AS blocked,
        SUM(tokens_in)      AS tokens_in,
        SUM(tokens_out)     AS tokens_out,
        SUM(CASE WHEN type='tts' THEN tokens_in ELSE 0 END) AS tts_chars,
        SUM(CASE WHEN type='stt' THEN tokens_in ELSE 0 END) AS stt_seconds
      FROM request_logs WHERE created_at >= ?
    `).get(todayStart);

    const perAvatar = db.prepare(`
      SELECT
        rl.avatar_id,
        COUNT(*)        AS total,
        SUM(rl.blocked) AS blocked,
        SUM(CASE WHEN rl.type='chat' THEN rl.tokens_in  ELSE 0 END) AS ai_tokens_in,
        SUM(CASE WHEN rl.type='chat' THEN rl.tokens_out ELSE 0 END) AS ai_tokens_out,
        SUM(CASE WHEN rl.type='tts'  THEN rl.tokens_in  ELSE 0 END) AS tts_chars,
        SUM(CASE WHEN rl.type='stt'  THEN rl.tokens_in  ELSE 0 END) AS stt_seconds,
        a.ai_provider,
        a.anthropic_model,
        a.openai_model
      FROM request_logs rl
      LEFT JOIN avatars a ON a.id = rl.avatar_id
      WHERE rl.created_at >= ?
      GROUP BY rl.avatar_id
    `).all(todayStart);

    const recentBlocked = db.prepare(`
      SELECT ip, avatar_id, type, created_at
      FROM request_logs WHERE blocked = 1
      ORDER BY created_at DESC LIMIT 20
    `).all();

    res.json({
      today: {
        total:      totalsRow.total      || 0,
        blocked:    totalsRow.blocked    || 0,
        tokens_in:  totalsRow.tokens_in  || 0,
        tokens_out: totalsRow.tokens_out || 0,
        tts_chars:   totalsRow.tts_chars   || 0,
        stt_seconds: totalsRow.stt_seconds || 0,
      },
      perAvatar,
      recentBlocked,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Helper: estrae valore da oggetto con dot-notation (es. "output.text") ─────
function getNestedField(obj, path) {
  return path.split('.').reduce((cur, k) => {
    if (cur == null) return undefined;
    // Se il valore corrente è una stringa JSON, la parsa automaticamente
    if (typeof cur === 'string') {
      try { cur = JSON.parse(cur); } catch { return undefined; }
    }
    const idx = Number(k);
    return Array.isArray(cur) && !isNaN(idx) ? cur[idx] : cur[k];
  }, obj);
}

// ─── Rate limiting ────────────────────────────────────────────────────────────
const _rateBuckets = new Map(); // key: `${ip}:${avatarId}` → [timestamp, ...]

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function checkRateLimit(req, avatarId) {
  const avatar  = getAvatarConfig(avatarId);
  const rpm     = avatar?.rate_limit_rpm ?? 0;
  if (!rpm) return { allowed: true };
  const ip      = getClientIp(req);
  const key     = `${ip}:${avatarId}`;
  const now     = Date.now();
  const window  = 60_000;
  const bucket  = (_rateBuckets.get(key) || []).filter(t => now - t < window);
  if (bucket.length >= rpm) {
    _rateBuckets.set(key, bucket);
    return { allowed: false, ip };
  }
  bucket.push(now);
  _rateBuckets.set(key, bucket);
  return { allowed: true, ip };
}

// Pulisce bucket vecchi ogni 5 minuti
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateBuckets) {
    if (!v.some(t => now - t < 60_000)) _rateBuckets.delete(k);
  }
}, 300_000);

// Log richiesta su DB
const _logRequest = db.prepare(`INSERT INTO request_logs (avatar_id, type, ip, blocked, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?)`);
function logRequest(avatarId, type, ip, blocked, tokensIn = 0, tokensOut = 0) {
  try { _logRequest.run(avatarId || null, type, ip, blocked ? 1 : 0, tokensIn || 0, tokensOut || 0); } catch {}
}

// ─── Route: Chat (embedded o webhook) ────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId, avatarId, kioskSessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Messaggio mancante' });

    const rl = checkRateLimit(req, avatarId);
    const chatIp = rl.ip || getClientIp(req);
    if (!rl.allowed) {
      logRequest(avatarId, 'chat', chatIp, true, 0, 0);
      return res.status(429).json({ error: 'Troppe richieste. Riprova tra poco.' });
    }

    const avatar = getAvatarConfig(avatarId);

    // ── Modalità Webhook ──────────────────────────────────────────────────────
    if (avatar?.avatar_mode === 'webhook') {
      const url      = avatar.webhook_url;
      const template = avatar.webhook_input_template || '{"query":"{{query}}"}';
      const outField = avatar.webhook_output_field   || 'response';
      if (!url) return res.status(400).json({ error: 'Webhook URL non configurato' });

      const sid       = sessionId || uuidv4();
      const userId    = uuidv4();
      const timestamp = new Date().toISOString();
      const tempId    = `temp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

      const whBaseName     = avatar?.name || AVATAR_NAME;
      const whSystemPrompt = (avatar?.system_prompt || DEFAULT_SYSTEM_PROMPT)
        .replace(/\{\{nome\}\}/gi, whBaseName)
        .replace(/\{\{sessionID\}\}/gi, kioskSessionId || sid);

      const esc = s => s.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
      const jsonStr = template
        .replace(/\{\{query\}\}/g,         esc(message))
        .replace(/\{\{session_id\}\}/g,    esc(sid))
        .replace(/\{\{user_id\}\}/g,       esc(userId))
        .replace(/\{\{timestamp\}\}/g,     esc(timestamp))
        .replace(/\{\{temp_id\}\}/g,       esc(tempId))
        .replace(/\{\{sessionID\}\}/gi,    esc(kioskSessionId || sid))
        .replace(/\{\{system_prompt\}\}/g, esc(whSystemPrompt))
        .replace(/\{\{avatar_name\}\}/g,   esc(whBaseName));

      let body;
      try { body = JSON.parse(jsonStr); }
      catch { return res.status(400).json({ error: 'Template JSON non valido' }); }

      let extraHeaders = {};
      try { extraHeaders = JSON.parse(avatar.webhook_headers || '{}'); } catch {}

      const whRes = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body:    JSON.stringify(body),
      });
      if (!whRes.ok) throw new Error(`Webhook error ${whRes.status}: ${await whRes.text()}`);
      const rawText = await whRes.text();
      if (!rawText?.trim()) throw new Error('Il webhook ha risposto con body vuoto — assicurati che il workflow n8n abbia un nodo "Respond to Webhook"');
      let whData;
      try { whData = JSON.parse(rawText); } catch { throw new Error(`Risposta non è JSON valido: ${rawText.slice(0,200)}`); }
      const reply  = getNestedField(whData, outField);
      if (reply == null) throw new Error(`Campo '${outField}' non trovato. Risposta: ${JSON.stringify(whData)}`);
      return res.json({ reply: String(reply), sessionId: sid });
    }

    // ── Modalità Embedded (Claude) ────────────────────────────────────────────
    const baseName   = avatar?.name || AVATAR_NAME;
    const basePrompt = (avatar?.system_prompt || DEFAULT_SYSTEM_PROMPT)
      .replace(/\{\{nome\}\}/gi, baseName)
      .replace(/\{\{sessionID\}\}/gi, kioskSessionId || sid);
    const mcpToolPrefix = (avatar?.avatar_mode === 'mcp' && avatar?.mcp_url?.trim())
      ? `Hai accesso a strumenti esterni (tool) che DEVI usare per rispondere alle domande dell'utente. Non rispondere mai basandoti sulla tua conoscenza interna: usa sempre i tool disponibili per recuperare le informazioni richieste. Se nessun tool è appropriato, dillo esplicitamente.\n\n`
      : '';
    const systemPrompt = `Il tuo nome è ${baseName}. Non presentarti ad ogni risposta.\n\n${mcpToolPrefix}${basePrompt}`;

    const sid = sessionId || uuidv4();
    if (!sessions.has(sid)) sessions.set(sid, []);
    const history = sessions.get(sid);
    history.push({ role: 'user', content: message });
    if (history.length > 10) history.splice(0, history.length - 10);

    const aiProvider = avatar?.ai_provider || 'anthropic';
    const aiTokens   = avatar?.ai_max_tokens > 0 ? avatar.ai_max_tokens : DEFAULT_AI_TOKENS;

    // ── Recupera tool MCP se configurato ─────────────────────────────────────
    const mcpUrl    = avatar?.mcp_url?.trim();
    let mcpTools    = [];
    let mcpHeaders  = {};
    let mcpSession  = null;  // sessione persistente (un solo initialize per tutta la richiesta)
    try { mcpHeaders = JSON.parse(avatar?.mcp_headers || '{}'); } catch {}
    const mcpFilter = (avatar?.mcp_tool_filter || '').split(',').map(s => s.trim()).filter(Boolean);

    if (mcpUrl && avatar?.avatar_mode === 'mcp') {
      try {
        const transport = await mcpDetectTransport(mcpUrl, mcpHeaders);

        if (transport === 'sse') {
          // SSE: ogni call è già indipendente, usa il percorso legacy
          const allTools = await mcpListTools(mcpUrl, mcpHeaders);
          const authTool = allTools.find(t => t.name === 'authenticate');
          if (authTool) {
            const bearerToken = (mcpHeaders['Authorization'] || mcpHeaders['authorization'] || '')
              .replace(/^Bearer\s+/i, '').trim();
            try { await mcpCallTool(mcpUrl, mcpHeaders, 'authenticate', { token: bearerToken }); }
            catch (e) { console.warn('[MCP-CHAT] SSE authenticate failed:', e.message); }
          }
          const filtered = allTools.filter(t => t.name !== 'authenticate');
          mcpTools = mcpFilter.length === 0 ? filtered : filtered.filter(t => mcpFilter.includes(t.name));
        } else {
          // JSON-RPC o Streamable HTTP: apri UNA sessione e riusa per tutte le call
          mcpSession = await mcpOpenSession(mcpUrl, mcpHeaders);
          const allTools = await mcpSession.listTools();

          const authTool = allTools.find(t => t.name === 'authenticate');
          let mcpAppSessionId = null;
          if (authTool) {
            const bearerToken = (mcpHeaders['Authorization'] || mcpHeaders['authorization'] || '')
              .replace(/^Bearer\s+/i, '').trim();
            try {
              const authResult = await mcpSession.callTool('authenticate', { token: bearerToken });
              const m = String(authResult).match(/session_id[:\s"']+([a-f0-9-]{36})/i);
              if (m) mcpAppSessionId = m[1];
              console.log('[MCP-CHAT] authenticate OK | app session_id:', mcpAppSessionId);
              console.log('[MCP-CHAT] authenticate risposta completa:', String(authResult).slice(0, 400));
            } catch (e) {
              console.warn('[MCP-CHAT] authenticate failed:', e.message);
            }
          }
          // Chiudi e riapri nel closure del helper
          mcpSession._appSessionId = mcpAppSessionId;

          const filtered = allTools.filter(t => t.name !== 'authenticate');
          mcpTools = mcpFilter.length === 0 ? filtered : filtered.filter(t => mcpFilter.includes(t.name));
        }
      } catch (e) {
        console.warn('[MCP-CHAT] setup FAILED:', e.message);
      }
    }

    // ── Helper: esegui tool call MCP ─────────────────────────────────────────
    async function callMcpTool(name, args) {
      if (mcpSession) {
        console.log('[MCP-CALL] tool:', name, '| args:', JSON.stringify(args));
        const result = await mcpSession.callTool(name, args);
        console.log('[MCP-CALL] result:', String(result).slice(0, 300));
        return result;
      }
      return await mcpCallTool(mcpUrl, mcpHeaders, name, args);
    }

    // ── Tavily web search (opzionale) ────────────────────────────────────────
    const tavilyKey = (avatar?.tavily_enabled && avatar?.tavily_api_key?.trim()) ? avatar.tavily_api_key.trim() : '';
    async function tavilySearch(query) {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5, search_depth: 'basic' }),
      });
      if (!r.ok) throw new Error(`Tavily: ${await r.text()}`);
      const data = await r.json();
      return data.results?.map(x => `[${x.title}](${x.url})\n${x.content}`).join('\n\n') || 'Nessun risultato trovato.';
    }
    const TAVILY_TOOL_DEF_CLAUDE = tavilyKey ? [{
      name: 'search_web',
      description: 'Cerca informazioni aggiornate su internet. Usa questo tool quando la domanda riguarda eventi recenti, notizie, prezzi, orari o qualsiasi informazione che potrebbe essere cambiata nel tempo.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'La query di ricerca' } }, required: ['query'] },
    }] : [];
    const TAVILY_TOOL_DEF_OAI = tavilyKey ? [{
      type: 'function',
      function: { name: 'search_web', description: TAVILY_TOOL_DEF_CLAUDE[0]?.description || '', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    }] : [];

    // Modalità MCP: AI Agent usa tutti i tool (no filtro) o solo quelli filtrati

    let reply;
    let chatTokensIn = 0, chatTokensOut = 0;

    if (aiProvider === 'openai') {
      const aiKey   = avatar?.openai_api_key || process.env.OPENAI_API_KEY;
      const aiModel = avatar?.openai_model   || 'gpt-4o-mini';
      const msgs    = [{ role: 'system', content: systemPrompt }, ...history];
      const oaiTools = [
        ...mcpTools.map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } })),
        ...TAVILY_TOOL_DEF_OAI,
      ];
      let iterMsgs = [...msgs];
      for (let i = 0; i < 3; i++) {
        const body = { model: aiModel, max_tokens: aiTokens, messages: iterMsgs };
        if (oaiTools.length) {
          body.tools = oaiTools;
          if (i === 0 && avatar?.avatar_mode === 'mcp') body.tool_choice = 'required';
        }
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${aiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`OpenAI: ${await r.text()}`);
        const data    = await r.json();
        chatTokensIn  += data.usage?.prompt_tokens     || 0;
        chatTokensOut += data.usage?.completion_tokens || 0;
        const choice  = data.choices[0];
        const msg     = choice.message;
        iterMsgs.push(msg);
        if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
          reply = msg.content;
          break;
        }
        const toolResults = [];
        for (const tc of msg.tool_calls) {
          let result;
          try {
            const args = JSON.parse(tc.function.arguments || '{}');
            result = tc.function.name === 'search_web'
              ? await tavilySearch(args.query)
              : await callMcpTool(tc.function.name, args);
          } catch (e) { result = `Errore: ${e.message}`; }
          toolResults.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        iterMsgs.push(...toolResults);
      }
      if (!reply) reply = 'Non sono riuscito a elaborare una risposta.';
    } else {
      const aiKey   = avatar?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
      const aiModel = avatar?.anthropic_model   || CLAUDE_MODEL;
      const aiClient = aiKey !== process.env.ANTHROPIC_API_KEY
        ? new Anthropic({ apiKey: aiKey }) : anthropic;
      const claudeTools = [
        ...mcpTools.map(t => ({ name: t.name, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } })),
        ...TAVILY_TOOL_DEF_CLAUDE,
      ];
      let iterMsgs = [...history];
      for (let i = 0; i < 3; i++) {
        const params = { model: aiModel, max_tokens: aiTokens, system: systemPrompt, messages: iterMsgs };
        if (claudeTools.length) {
          params.tools = claudeTools;
          // In modalità MCP, forza l'uso dei tool al primo turno
          if (i === 0 && avatar?.avatar_mode === 'mcp') params.tool_choice = { type: 'any' };
        }
        const response = await aiClient.messages.create(params);
        chatTokensIn  += response.usage?.input_tokens  || 0;
        chatTokensOut += response.usage?.output_tokens || 0;
        if (response.stop_reason !== 'tool_use') {
          reply = response.content.find(b => b.type === 'text')?.text || '';
          break;
        }
        iterMsgs.push({ role: 'assistant', content: response.content });
        const toolResults = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          let result;
          try {
            result = block.name === 'search_web'
              ? await tavilySearch(block.input.query)
              : await callMcpTool(block.name, block.input);
          } catch (e) { result = `Errore: ${e.message}`; }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
        iterMsgs.push({ role: 'user', content: toolResults });
      }
      if (!reply) reply = 'Non sono riuscito a elaborare una risposta.';
    }
    logRequest(avatarId, 'chat', chatIp, false, chatTokensIn, chatTokensOut);
    console.log(`[TOKENS] avatar=${avatarId} provider=${aiProvider} model=${avatar?.openai_model || avatar?.anthropic_model || 'default'} in=${chatTokensIn} out=${chatTokensOut}`);
    history.push({ role: 'assistant', content: reply });
    res.json({ reply, sessionId: sid });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Route: TTS (con supporto avatar specifico) ───────────────────────────────
app.post('/api/tts', async (req, res) => {
  try {
    const { text, avatarId } = req.body;
    if (!text) return res.status(400).json({ error: 'Testo mancante' });

    const avatar     = getAvatarConfig(avatarId);
    const voiceId    = avatar?.voice_id    || DEFAULT_VOICE_ID;
    const ttsKey     = avatar?.tts_api_key || process.env.ELEVENLABS_API_KEY;
    const ttsModel   = avatar?.tts_model   || DEFAULT_TTS_MODEL;
    const ttsStab    = (avatar?.tts_stability  >= 0) ? avatar.tts_stability  : DEFAULT_TTS_STAB;
    const ttsSim     = (avatar?.tts_similarity >= 0) ? avatar.tts_similarity : DEFAULT_TTS_SIM;
    const ttsTextNorm = avatar?.tts_text_normalization || 'auto';
    const ttsLangNorm = !!avatar?.tts_language_normalization;
    const ttsLangCode = avatar?.stt_language?.split('-')[0] || '';
    if (!voiceId) return res.status(400).json({ error: 'Voice ID non configurato' });

    const spokenText = text
      .replace(/#{1,6}\s*/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/_(.+?)_/g, '$1')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\n+/g, ' ')
      .trim();

    const buildTtsBody = (withLangNorm) => JSON.stringify({
      text: spokenText, model_id: ttsModel,
      voice_settings: { stability: ttsStab, similarity_boost: ttsSim },
      apply_text_normalization: ttsTextNorm,
      ...(withLangNorm && ttsLangCode ? { apply_language_text_normalization: true, language_code: ttsLangCode } : {}),
    });
    let response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
      { method: 'POST', headers: { 'xi-api-key': ttsKey, 'Content-Type': 'application/json' }, body: buildTtsBody(ttsLangNorm) }
    );
    if (!response.ok && ttsLangNorm) {
      const raw = await response.text();
      let parsed; try { parsed = JSON.parse(raw); } catch(_) {}
      if (parsed?.detail?.status === 'language_text_normalization_not_supported') {
        response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
          { method: 'POST', headers: { 'xi-api-key': ttsKey, 'Content-Type': 'application/json' }, body: buildTtsBody(false) }
        );
      } else {
        const status = parsed?.detail?.status;
        if (status === 'quota_exceeded') throw new Error('quota_exceeded');
        throw new Error(`ElevenLabs error: ${raw}`);
      }
    }
    if (!response.ok) {
      const raw = await response.text();
      let parsed; try { parsed = JSON.parse(raw); } catch(_) {}
      const status = parsed?.detail?.status;
      if (status === 'quota_exceeded') throw new Error('quota_exceeded');
      throw new Error(`ElevenLabs error: ${raw}`);
    }
    const data = await response.json();
    logRequest(avatarId, 'tts', getClientIp(req), false, spokenText.length, 0);
    res.json({ audio: data.audio_base64, alignment: data.alignment });
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Route: Reset sessione ────────────────────────────────────────────────────
app.delete('/api/session/:id', (req, res) => {
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

// ─── Export/Import configurazione avatar ──────────────────────────────────────

app.get('/api/admin/avatars/:id/export', requireAdmin, (req, res) => {
  const avatar = db.prepare('SELECT * FROM avatars WHERE id = ?').get(req.params.id);
  if (!avatar) return res.status(404).json({ error: 'Non trovato' });

  const FILE_FIELDS = ['model_file', 'bg_video', 'idle_video', 'idle_bg_image', 'idle_icon_img', 'mic_icon', 'mic_icon_disabled', 'audio_icon', 'audio_icon_disabled', 'ptt_icon'];
  const files = {};
  for (const field of FILE_FIELDS) {
    const rel = avatar[field];
    if (!rel) continue;
    const abs = join(__dirname, 'public', rel);
    if (!fs.existsSync(abs)) continue;
    const data = fs.readFileSync(abs).toString('base64');
    const name = rel.split('/').pop();
    files[field] = { name, data };
  }

  const { id, created_at, updated_at, published, ...params } = avatar;
  const bundle = { version: 1, name: avatar.name, params, files };

  const slug = avatar.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  res.setHeader('Content-Disposition', `attachment; filename="avatar_${slug}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(bundle, null, 2));
});

app.post('/api/admin/avatars/import', requireAdmin, express.json({ limit: '200mb' }), async (req, res) => {
  const bundle = req.body;
  if (!bundle?.version || !bundle?.params) return res.status(400).json({ error: 'File non valido' });

  const newId = uuidv4().split('-')[0];
  const FILE_FIELDS = ['model_file', 'bg_video', 'idle_video', 'idle_bg_image', 'idle_icon_img', 'mic_icon', 'mic_icon_disabled', 'audio_icon', 'audio_icon_disabled', 'ptt_icon'];

  // Ripristina file binari
  const remapped = { ...bundle.params };
  for (const field of FILE_FIELDS) {
    const f = bundle.files?.[field];
    if (!f?.data || !f?.name) { remapped[field] = ''; continue; }
    // Determina sottocartella in base al campo
    const subdir = field === 'model_file'   ? 'models'
      : field === 'bg_video'               ? 'bg-videos'
      : field === 'idle_video'             ? 'idle-videos'
      : field === 'idle_bg_image'          ? 'idle-bgs'
      : 'icons'; // idle_icon_img, mic_icon, mic_icon_disabled, audio_icon, audio_icon_disabled
    const dir = join(__dirname, 'public', subdir);
    fs.mkdirSync(dir, { recursive: true });
    const ext  = f.name.split('.').pop();
    const dest = `${subdir}/${newId}_${field}.${ext}`;
    fs.writeFileSync(join(__dirname, 'public', dest), Buffer.from(f.data, 'base64'));
    remapped[field] = dest;
  }

  // Colonne valide del DB
  const cols = db.prepare("PRAGMA table_info(avatars)").all().map(c => c.name);
  const allowed = cols.filter(c => !['id','created_at','updated_at','published'].includes(c));
  const fields = allowed.filter(c => remapped[c] !== undefined);
  const placeholders = fields.map(c => `${c} = ?`).join(', ');
  const values = fields.map(c => remapped[c]);

  db.prepare(`INSERT INTO avatars (id, name) VALUES (?, ?)`).run(newId, bundle.name || 'Importato');
  if (fields.length) db.prepare(`UPDATE avatars SET ${placeholders} WHERE id = ?`).run(...values, newId);

  res.json({ ok: true, id: newId });
});

// ─── Avvio server ─────────────────────────────────────────────────────────────
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERRORE] Porta ${PORT} già in uso.`);
    console.error(`  Controlla con: sudo lsof -i :${PORT}`);
    console.error(`  Oppure ferma il servizio: sudo systemctl stop avatar-kiosk\n`);
    process.exit(1);
  } else {
    throw err;
  }
});

// ─── Seed: crea avatar Sofia al primo avvio se il DB è vuoto ─────────────────
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM avatars').get().n;
  if (count > 0) return;

  try {
    const seedCfg = JSON.parse(fs.readFileSync(join(__dirname, 'seed', 'sofia.json'), 'utf8'));
    const seedId  = Math.random().toString(36).slice(2, 10);

    // [file sorgente seed, cartella pubblica destinazione, campo DB]
    const assets = [
      ['seed/models/sofia.glb',               `public/models/${seedId}_model_file.glb`,        'model_file',        `models/${seedId}_model_file.glb`],
      ['seed/bg-videos/sofia_bg.mp4',         `public/bg-videos/${seedId}_bg_video.mp4`,       'bg_video',          `bg-videos/${seedId}_bg_video.mp4`],
      ['seed/icons/sofia_mic.png',            `public/icons/${seedId}_mic_icon.png`,            'mic_icon',          `icons/${seedId}_mic_icon.png`],
      ['seed/icons/sofia_mic_disabled.png',   `public/icons/${seedId}_mic_icon_disabled.png`,   'mic_icon_disabled', `icons/${seedId}_mic_icon_disabled.png`],
      ['seed/icons/sofia_audio.png',          `public/icons/${seedId}_audio_icon.png`,          'audio_icon',        `icons/${seedId}_audio_icon.png`],
      ['seed/icons/sofia_audio_disabled.png', `public/icons/${seedId}_audio_icon_disabled.png`, 'audio_icon_disabled',`icons/${seedId}_audio_icon_disabled.png`],
      ['seed/icons/sofia_idle.png',           `public/icons/${seedId}_idle_icon_img.png`,       'idle_icon_img',     `icons/${seedId}_idle_icon_img.png`],
    ];

    for (const [src, dst, cfgKey, dbPath] of assets) {
      const srcPath = join(__dirname, src);
      const dstPath = join(__dirname, dst);
      if (fs.existsSync(srcPath)) {
        fs.mkdirSync(dirname(dstPath), { recursive: true });
        fs.copyFileSync(srcPath, dstPath);
        seedCfg[cfgKey] = dbPath;
      }
    }

    const cols = Object.keys(seedCfg);
    db.prepare(`INSERT INTO avatars (id, ${cols.join(',')}) VALUES (?, ${cols.map(()=>'?').join(',')})`)
      .run(seedId, ...Object.values(seedCfg));

    console.log(`[seed] Avatar Sofia creato con id=${seedId}`);
  } catch (e) {
    console.warn('[seed] Errore durante il seed:', e.message);
  }
}
seedIfEmpty();

server.listen(PORT, () => {
  console.log(`\n🤖 Avatar Kiosk Platform`);
  console.log(`   → Kiosk:    http://localhost:${PORT}/k/{id}`);
  console.log(`   → Admin:    http://localhost:${PORT}/admin`);
  console.log(`   → Modello AI: ${CLAUDE_MODEL}\n`);
});
