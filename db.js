import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, 'avatars.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS avatars (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    label             TEXT DEFAULT '',
    voice_id          TEXT DEFAULT '',
    system_prompt     TEXT DEFAULT '',
    background        TEXT DEFAULT '#0a0a0f',
    model_file        TEXT DEFAULT '',
    bg_video          TEXT DEFAULT '',
    anim_pingpong     INTEGER DEFAULT 0,
    idle_start        REAL DEFAULT 0,
    idle_end          REAL DEFAULT 2,
    speech_start      REAL DEFAULT 2,
    speech_end        REAL DEFAULT 9,
    avatar_scale      REAL DEFAULT 0.75,
    avatar_offset_x   REAL DEFAULT 0,
    avatar_offset_y   REAL DEFAULT 0,
    avatar_rot_y      REAL DEFAULT 0,
    camera_z          REAL DEFAULT 3.5,
    camera_y          REAL DEFAULT 1.0,
    camera_look_at_y  REAL DEFAULT 1.0,
    stt_api_key           TEXT DEFAULT '',
    stt_model             TEXT DEFAULT '',
    stt_language          TEXT DEFAULT '',
    stt_provider          TEXT DEFAULT '',   -- '' = usa STT_PROVIDER globale
    tts_api_key           TEXT DEFAULT '',
    tts_model             TEXT DEFAULT '',
    tts_stability               REAL DEFAULT -1,
    tts_similarity              REAL DEFAULT -1,
    tts_text_normalization      TEXT DEFAULT 'auto',
    tts_language_normalization  INTEGER DEFAULT 0,
    texture_quality             INTEGER DEFAULT 85,
    ai_provider           TEXT DEFAULT 'anthropic',
    ai_max_tokens         INTEGER DEFAULT 0,
    anthropic_api_key     TEXT DEFAULT '',
    anthropic_model       TEXT DEFAULT '',
    openai_api_key        TEXT DEFAULT '',
    openai_model          TEXT DEFAULT '',
    avatar_mode           TEXT DEFAULT 'embedded',
    webhook_url           TEXT DEFAULT '',
    webhook_input_template TEXT DEFAULT '{"query":"{{query}}"}',
    webhook_output_field  TEXT DEFAULT 'response',
    webhook_headers       TEXT DEFAULT '{}',
    api_base_url          TEXT DEFAULT '',
    api_token             TEXT DEFAULT '',
    api_type              TEXT DEFAULT 'auto',
    api_spec_url          TEXT DEFAULT '',
    api_tool_filter       TEXT DEFAULT '',
    api_tools_cache       TEXT DEFAULT '',
    idle_disabled     INTEGER DEFAULT 0,
    idle_timeout      INTEGER DEFAULT 90,
    idle_icon         TEXT DEFAULT '🤖',
    idle_icon_img     TEXT DEFAULT '',
    idle_title        TEXT DEFAULT '',
    idle_subtitle     TEXT DEFAULT 'La tua assistente virtuale',
    idle_hint         TEXT DEFAULT '✨ Tocca per iniziare',
    idle_video        TEXT DEFAULT '',
    idle_bg_image     TEXT DEFAULT '',
    idle_bg_color       TEXT DEFAULT '',
    idle_bg_color_alpha REAL DEFAULT 1,
    idle_bg_opacity   REAL DEFAULT 1,
    idle_font         TEXT DEFAULT '',
    idle_font_size    REAL DEFAULT 1.1,
    idle_privacy_label TEXT DEFAULT '',
    idle_privacy_url  TEXT DEFAULT '',
    idle_privacy_text TEXT DEFAULT '',
    idle_privacy_font TEXT DEFAULT '',
    idle_privacy_font_size REAL DEFAULT 0.8,
    idle_privacy_text_font TEXT DEFAULT '',
    idle_privacy_text_font_size REAL DEFAULT 1.0,
    idle_privacy_anim TEXT DEFAULT 'down',
    overlay_color     TEXT DEFAULT '#0a0a0f',
    overlay_opacity   REAL DEFAULT 0.75,
    overlay_height    REAL DEFAULT 65,
    chat_height       INTEGER DEFAULT 65,
    chat_bottom       INTEGER DEFAULT 100,
    chat_max_width    INTEGER DEFAULT 100,
    chat_align        TEXT DEFAULT 'center',
    chat_hide_input   INTEGER DEFAULT 0,
    chat_font         TEXT DEFAULT '',
    chat_font_size    REAL DEFAULT 1.1,
    show_controls     INTEGER DEFAULT 1,
    mic_icon          TEXT DEFAULT '',
    mic_icon_size     INTEGER DEFAULT 100,
    mic_icon_x        INTEGER DEFAULT 0,
    mic_icon_y        INTEGER DEFAULT 0,
    mic_icon_disabled TEXT DEFAULT '',
    mic_visible       INTEGER DEFAULT 1,
    mic_bg_color      TEXT DEFAULT 'rgba(248,113,113,0.15)',
    mic_disabled_color TEXT DEFAULT 'rgba(248,113,113,0.15)',
    mic_border_color  TEXT DEFAULT 'rgba(34,211,160,0.5)',
    mic_border_disabled_color TEXT DEFAULT 'rgba(248,113,113,0.4)',
    audio_icon        TEXT DEFAULT '',
    audio_icon_size   INTEGER DEFAULT 100,
    audio_icon_x      INTEGER DEFAULT 0,
    audio_icon_y      INTEGER DEFAULT 0,
    audio_icon_disabled TEXT DEFAULT '',
    audio_visible     INTEGER DEFAULT 1,
    audio_bg_color    TEXT DEFAULT 'rgba(34,211,160,0.15)',
    audio_disabled_color TEXT DEFAULT 'rgba(34,211,160,0.15)',
    audio_border_color TEXT DEFAULT 'rgba(34,211,160,0.5)',
    audio_border_disabled_color TEXT DEFAULT 'rgba(248,113,113,0.4)',
    mic_wave_color    TEXT DEFAULT '#ffffff',
    audio_wave_color  TEXT DEFAULT '#ffffff',
    theme             TEXT DEFAULT 'viola',
    greeting_text           TEXT DEFAULT 'Ciao sono {{nome}}, il tuo assistente personale. Come posso aiutarti?',
    vad_threshold           REAL    DEFAULT 0.012,
    vad_silence_duration    INTEGER DEFAULT 1300,
    vad_min_speech_duration INTEGER DEFAULT 150,
    vad_min_blob_size       INTEGER DEFAULT 3000,
    vad_wake_timeout        INTEGER DEFAULT 5000,
    published         INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  )
`);

// Migrazione: aggiunge colonne mancanti su DB esistenti
const existing = db.prepare("PRAGMA table_info(avatars)").all().map(c => c.name);
if (!existing.includes('stt_api_key'))     db.exec("ALTER TABLE avatars ADD COLUMN stt_api_key TEXT DEFAULT ''");
if (!existing.includes('stt_model'))       db.exec("ALTER TABLE avatars ADD COLUMN stt_model TEXT DEFAULT ''");
if (!existing.includes('stt_language'))    db.exec("ALTER TABLE avatars ADD COLUMN stt_language TEXT DEFAULT ''");
if (!existing.includes('stt_provider'))    db.exec("ALTER TABLE avatars ADD COLUMN stt_provider TEXT DEFAULT ''");
if (!existing.includes('tts_api_key'))     db.exec("ALTER TABLE avatars ADD COLUMN tts_api_key TEXT DEFAULT ''");
if (!existing.includes('tts_model'))       db.exec("ALTER TABLE avatars ADD COLUMN tts_model TEXT DEFAULT ''");
if (!existing.includes('tts_stability'))   db.exec("ALTER TABLE avatars ADD COLUMN tts_stability REAL DEFAULT -1");
if (!existing.includes('tts_similarity'))             db.exec("ALTER TABLE avatars ADD COLUMN tts_similarity REAL DEFAULT -1");
if (!existing.includes('tts_text_normalization'))     db.exec("ALTER TABLE avatars ADD COLUMN tts_text_normalization TEXT DEFAULT 'auto'");
if (!existing.includes('tts_language_normalization')) db.exec("ALTER TABLE avatars ADD COLUMN tts_language_normalization INTEGER DEFAULT 0");
if (!existing.includes('texture_quality'))            db.exec("ALTER TABLE avatars ADD COLUMN texture_quality INTEGER DEFAULT 85");
if (!existing.includes('ai_provider'))      db.exec("ALTER TABLE avatars ADD COLUMN ai_provider TEXT DEFAULT 'anthropic'");
if (!existing.includes('ai_max_tokens'))    db.exec("ALTER TABLE avatars ADD COLUMN ai_max_tokens INTEGER DEFAULT 0");
if (!existing.includes('anthropic_api_key')) db.exec("ALTER TABLE avatars ADD COLUMN anthropic_api_key TEXT DEFAULT ''");
if (!existing.includes('anthropic_model'))   db.exec("ALTER TABLE avatars ADD COLUMN anthropic_model TEXT DEFAULT ''");
if (!existing.includes('openai_api_key'))    db.exec("ALTER TABLE avatars ADD COLUMN openai_api_key TEXT DEFAULT ''");
if (!existing.includes('openai_model'))      db.exec("ALTER TABLE avatars ADD COLUMN openai_model TEXT DEFAULT ''");
// Migra vecchi campi ai_api_key/ai_model se presenti
if (existing.includes('ai_api_key')) {
  db.exec("UPDATE avatars SET anthropic_api_key = ai_api_key WHERE anthropic_api_key = '' AND ai_api_key != ''");
  db.exec("UPDATE avatars SET anthropic_api_key = ai_api_key WHERE anthropic_api_key = '' AND ai_api_key != '' AND ai_provider = 'anthropic'");
  db.exec("UPDATE avatars SET anthropic_model = ai_model WHERE anthropic_model = '' AND ai_model != '' AND ai_provider = 'anthropic'");
  // Non migrare il modello OpenAI se contiene un nome Anthropic
  db.exec("UPDATE avatars SET openai_api_key = ai_api_key WHERE openai_api_key = '' AND ai_api_key != '' AND ai_provider = 'openai' AND ai_api_key NOT LIKE 'sk-ant-%'");
  db.exec("UPDATE avatars SET openai_model = ai_model WHERE openai_model = '' AND ai_model != '' AND ai_provider = 'openai' AND ai_model NOT LIKE 'claude-%'");
}
if (!existing.includes('avatar_mode'))
  db.exec("ALTER TABLE avatars ADD COLUMN avatar_mode TEXT DEFAULT 'embedded'");
if (!existing.includes('webhook_url'))
  db.exec("ALTER TABLE avatars ADD COLUMN webhook_url TEXT DEFAULT ''");
if (!existing.includes('webhook_input_template'))
  db.exec(`ALTER TABLE avatars ADD COLUMN webhook_input_template TEXT DEFAULT '{"query":"{{query}}"}'`);
if (!existing.includes('webhook_output_field'))
  db.exec("ALTER TABLE avatars ADD COLUMN webhook_output_field TEXT DEFAULT 'response'");
if (!existing.includes('webhook_headers'))
  db.exec("ALTER TABLE avatars ADD COLUMN webhook_headers TEXT DEFAULT '{}'");
if (!existing.includes('idle_timeout'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_timeout INTEGER DEFAULT 90");
if (!existing.includes('chat_height'))
  db.exec("ALTER TABLE avatars ADD COLUMN chat_height INTEGER DEFAULT 65");
if (!existing.includes('chat_bottom'))
  db.exec("ALTER TABLE avatars ADD COLUMN chat_bottom INTEGER DEFAULT 100");
if (!existing.includes('chat_max_width'))
  db.exec("ALTER TABLE avatars ADD COLUMN chat_max_width INTEGER DEFAULT 100");
if (!existing.includes('chat_align'))
  db.exec("ALTER TABLE avatars ADD COLUMN chat_align TEXT DEFAULT 'center'");
if (!existing.includes('chat_hide_input'))
  db.exec("ALTER TABLE avatars ADD COLUMN chat_hide_input INTEGER DEFAULT 0");
if (!existing.includes('chat_font'))
  db.exec("ALTER TABLE avatars ADD COLUMN chat_font TEXT DEFAULT ''");
if (!existing.includes('chat_font_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN chat_font_size REAL DEFAULT 1.1");
if (!existing.includes('show_controls'))
  db.exec("ALTER TABLE avatars ADD COLUMN show_controls INTEGER DEFAULT 1");
if (!existing.includes('mic_icon'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_icon TEXT DEFAULT ''");
if (!existing.includes('mic_icon_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_icon_size INTEGER DEFAULT 100");
if (!existing.includes('mic_icon_x'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_icon_x INTEGER DEFAULT 0");
if (!existing.includes('mic_icon_y'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_icon_y INTEGER DEFAULT 0");
if (!existing.includes('mic_visible'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_visible INTEGER DEFAULT 1");
if (!existing.includes('mic_bg_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bg_color TEXT DEFAULT 'rgba(248,113,113,0.15)'");
if (!existing.includes('mic_disabled_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_disabled_color TEXT DEFAULT 'rgba(248,113,113,0.15)'");
if (!existing.includes('audio_icon'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_icon TEXT DEFAULT ''");
if (!existing.includes('audio_icon_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_icon_size INTEGER DEFAULT 100");
if (!existing.includes('audio_icon_x'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_icon_x INTEGER DEFAULT 0");
if (!existing.includes('audio_icon_y'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_icon_y INTEGER DEFAULT 0");
if (!existing.includes('audio_visible'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_visible INTEGER DEFAULT 1");
if (!existing.includes('audio_bg_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_bg_color TEXT DEFAULT 'rgba(34,211,160,0.15)'");
if (!existing.includes('audio_disabled_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_disabled_color TEXT DEFAULT 'rgba(34,211,160,0.15)'");
if (!existing.includes('mic_icon_disabled'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_icon_disabled TEXT DEFAULT ''");
if (!existing.includes('audio_icon_disabled'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_icon_disabled TEXT DEFAULT ''");
if (!existing.includes('mic_border_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_border_color TEXT DEFAULT 'rgba(34,211,160,0.5)'");
if (!existing.includes('mic_border_disabled_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_border_disabled_color TEXT DEFAULT 'rgba(248,113,113,0.4)'");
if (!existing.includes('audio_border_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_border_color TEXT DEFAULT 'rgba(34,211,160,0.5)'");
if (!existing.includes('audio_border_disabled_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_border_disabled_color TEXT DEFAULT 'rgba(248,113,113,0.4)'");
if (!existing.includes('mic_wave_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_wave_color TEXT DEFAULT '#ffffff'");
if (!existing.includes('mic_bubble_visible'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_visible INTEGER DEFAULT 1");
if (!existing.includes('mic_bubble_text'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_text TEXT DEFAULT ''");
if (!existing.includes('mic_bubble_position'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_position TEXT DEFAULT 'top'");
if (!existing.includes('mic_bubble_x'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_x INTEGER DEFAULT 0");
if (!existing.includes('mic_bubble_y'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_y INTEGER DEFAULT -80");
if (!existing.includes('mic_bubble_font'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_font TEXT DEFAULT ''");
if (!existing.includes('mic_bubble_font_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_font_size INTEGER DEFAULT 13");
if (!existing.includes('mic_bubble_bg_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_bg_color TEXT DEFAULT 'rgba(255,255,255,0.95)'");
if (!existing.includes('mic_bubble_border_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_border_color TEXT DEFAULT 'transparent'");
if (!existing.includes('mic_bubble_border_radius'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_border_radius INTEGER DEFAULT 12");
if (!existing.includes('mic_bubble_bg_image'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_bg_image TEXT DEFAULT ''");
if (!existing.includes('mic_bubble_width'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_width INTEGER DEFAULT 0");
if (!existing.includes('mic_bubble_height'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_height INTEGER DEFAULT 0");
if (!existing.includes('mic_bubble_bounce'))
  db.exec("ALTER TABLE avatars ADD COLUMN mic_bubble_bounce INTEGER DEFAULT 0");
if (!existing.includes('touch_stop_speaking'))
  db.exec("ALTER TABLE avatars ADD COLUMN touch_stop_speaking INTEGER DEFAULT 0");
if (!existing.includes('ptt_enabled'))
  db.exec("ALTER TABLE avatars ADD COLUMN ptt_enabled INTEGER DEFAULT 0");
if (!existing.includes('ptt_icon'))
  db.exec("ALTER TABLE avatars ADD COLUMN ptt_icon TEXT DEFAULT ''");
if (!existing.includes('ptt_icon_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN ptt_icon_size INTEGER DEFAULT 80");
if (!existing.includes('ptt_icon_x'))
  db.exec("ALTER TABLE avatars ADD COLUMN ptt_icon_x INTEGER DEFAULT 0");
if (!existing.includes('ptt_icon_y'))
  db.exec("ALTER TABLE avatars ADD COLUMN ptt_icon_y INTEGER DEFAULT 0");
// Reset valori estremi di ptt_icon_x/y impostati accidentalmente durante il testing
db.exec("UPDATE avatars SET ptt_icon_x = 0 WHERE ABS(ptt_icon_x) > 300");
db.exec("UPDATE avatars SET ptt_icon_y = 0 WHERE ABS(ptt_icon_y) > 300");
if (!existing.includes('ptt_bg_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN ptt_bg_color TEXT DEFAULT 'rgba(248,113,113,0.15)'");
if (!existing.includes('ptt_border_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN ptt_border_color TEXT DEFAULT 'rgba(248,113,113,0.5)'");
if (!existing.includes('audio_wave_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN audio_wave_color TEXT DEFAULT '#ffffff'");
if (!existing.includes('idle_icon_img'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_icon_img TEXT DEFAULT ''");
if (!existing.includes('idle_video'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_video TEXT DEFAULT ''")
if (!existing.includes('idle_bg_image'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_bg_image TEXT DEFAULT ''")
if (!existing.includes('idle_bg_color'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_bg_color TEXT DEFAULT ''")
if (!existing.includes('idle_bg_color_alpha'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_bg_color_alpha REAL DEFAULT 1")
if (!existing.includes('idle_disabled'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_disabled INTEGER DEFAULT 0")
if (!existing.includes('anim_pingpong'))
  db.exec("ALTER TABLE avatars ADD COLUMN anim_pingpong INTEGER DEFAULT 0")
if (!existing.includes('idle_bg_opacity'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_bg_opacity REAL DEFAULT 1")
if (!existing.includes('bg_video'))
  db.exec("ALTER TABLE avatars ADD COLUMN bg_video TEXT DEFAULT ''")
if (!existing.includes('idle_font'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_font TEXT DEFAULT ''");
if (!existing.includes('idle_font_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_font_size REAL DEFAULT 1.1");
if (!existing.includes('idle_privacy_label'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_label TEXT DEFAULT ''");
if (!existing.includes('idle_privacy_url'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_url TEXT DEFAULT ''");
if (!existing.includes('idle_privacy_text'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_text TEXT DEFAULT ''");
if (!existing.includes('idle_privacy_font'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_font TEXT DEFAULT ''");
if (!existing.includes('idle_privacy_font_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_font_size REAL DEFAULT 0.8");
if (!existing.includes('idle_privacy_text_font'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_text_font TEXT DEFAULT ''");
if (!existing.includes('idle_privacy_text_font_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_text_font_size REAL DEFAULT 1.0");
if (!existing.includes('idle_privacy_anim'))
  db.exec("ALTER TABLE avatars ADD COLUMN idle_privacy_anim TEXT DEFAULT 'down'");
if (!existing.includes('theme'))
  db.exec("ALTER TABLE avatars ADD COLUMN theme TEXT DEFAULT 'viola'");
if (!existing.includes('model_hash'))
  db.exec("ALTER TABLE avatars ADD COLUMN model_hash TEXT DEFAULT ''");
if (!existing.includes('wake_word_enabled'))
  db.exec("ALTER TABLE avatars ADD COLUMN wake_word_enabled INTEGER DEFAULT 0");
if (!existing.includes('wake_word_always'))
  db.exec("ALTER TABLE avatars ADD COLUMN wake_word_always INTEGER DEFAULT 0");
if (!existing.includes('greeting_text'))
  db.exec("ALTER TABLE avatars ADD COLUMN greeting_text TEXT DEFAULT ''")
if (!existing.includes('vad_threshold'))
  db.exec("ALTER TABLE avatars ADD COLUMN vad_threshold REAL DEFAULT 0.012")
if (!existing.includes('vad_silence_duration'))
  db.exec("ALTER TABLE avatars ADD COLUMN vad_silence_duration INTEGER DEFAULT 1300")
if (!existing.includes('vad_min_speech_duration'))
  db.exec("ALTER TABLE avatars ADD COLUMN vad_min_speech_duration INTEGER DEFAULT 150")
if (!existing.includes('vad_min_blob_size'))
  db.exec("ALTER TABLE avatars ADD COLUMN vad_min_blob_size INTEGER DEFAULT 3000")
if (!existing.includes('vad_wake_timeout'))
  db.exec("ALTER TABLE avatars ADD COLUMN vad_wake_timeout INTEGER DEFAULT 5000")
if (!existing.includes('vad_noise_mult'))
  db.exec("ALTER TABLE avatars ADD COLUMN vad_noise_mult REAL DEFAULT 2.8")
if (!existing.includes('stt_prompt'))
  db.exec("ALTER TABLE avatars ADD COLUMN stt_prompt TEXT DEFAULT ''")
if (!existing.includes('wake_words'))
  db.exec("ALTER TABLE avatars ADD COLUMN wake_words TEXT DEFAULT ''")
if (!existing.includes('mcp_url'))
  db.exec("ALTER TABLE avatars ADD COLUMN mcp_url TEXT DEFAULT ''")
if (!existing.includes('mcp_headers'))
  db.exec("ALTER TABLE avatars ADD COLUMN mcp_headers TEXT DEFAULT '{}'")
if (!existing.includes('mcp_tool_filter'))
  db.exec("ALTER TABLE avatars ADD COLUMN mcp_tool_filter TEXT DEFAULT ''")
if (!existing.includes('mcp_skip_rewrite'))
  db.exec("ALTER TABLE avatars ADD COLUMN mcp_skip_rewrite INTEGER DEFAULT 0")
if (!existing.includes('rate_limit_rpm'))
  db.exec("ALTER TABLE avatars ADD COLUMN rate_limit_rpm INTEGER DEFAULT 0")
if (!existing.includes('label'))
  db.exec("ALTER TABLE avatars ADD COLUMN label TEXT DEFAULT ''")
if (!existing.includes('webhook_say_token'))
  db.exec("ALTER TABLE avatars ADD COLUMN webhook_say_token TEXT DEFAULT ''")
if (!existing.includes('tavily_api_key'))
  db.exec("ALTER TABLE avatars ADD COLUMN tavily_api_key TEXT DEFAULT ''")
if (!existing.includes('tavily_enabled'))
  db.exec("ALTER TABLE avatars ADD COLUMN tavily_enabled INTEGER DEFAULT 0")
// Azione all'avvio: chiama un tool MCP o una API HTTP e usa il risultato come frase di presentazione
if (!existing.includes('startup_action'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_action TEXT DEFAULT 'none'")        // none | mcp | api
if (!existing.includes('startup_mcp_tool'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_mcp_tool TEXT DEFAULT ''")
if (!existing.includes('startup_mcp_args'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_mcp_args TEXT DEFAULT '{}'")
if (!existing.includes('startup_api_url'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_api_url TEXT DEFAULT ''")
if (!existing.includes('startup_api_method'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_api_method TEXT DEFAULT 'GET'")
if (!existing.includes('startup_api_headers'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_api_headers TEXT DEFAULT '{}'")
if (!existing.includes('startup_api_body'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_api_body TEXT DEFAULT ''")
if (!existing.includes('startup_api_output_field'))
  db.exec("ALTER TABLE avatars ADD COLUMN startup_api_output_field TEXT DEFAULT ''")

// Modalità 'api': istanza REST con discovery OpenAPI/Swagger, usata come tool dall'AI
if (!existing.includes('api_base_url'))
  db.exec("ALTER TABLE avatars ADD COLUMN api_base_url TEXT DEFAULT ''")
if (!existing.includes('api_token'))
  db.exec("ALTER TABLE avatars ADD COLUMN api_token TEXT DEFAULT ''")
if (!existing.includes('api_type'))
  db.exec("ALTER TABLE avatars ADD COLUMN api_type TEXT DEFAULT 'auto'")
if (!existing.includes('api_spec_url'))
  db.exec("ALTER TABLE avatars ADD COLUMN api_spec_url TEXT DEFAULT ''")
if (!existing.includes('api_tool_filter'))
  db.exec("ALTER TABLE avatars ADD COLUMN api_tool_filter TEXT DEFAULT ''")
if (!existing.includes('api_tools_cache'))
  db.exec("ALTER TABLE avatars ADD COLUMN api_tools_cache TEXT DEFAULT ''")

// Tabella log richieste
db.exec(`
  CREATE TABLE IF NOT EXISTS request_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    avatar_id  TEXT,
    type       TEXT,
    ip         TEXT,
    blocked    INTEGER DEFAULT 0,
    tokens_in  INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
// Migrazione colonne token su DB esistenti
const existingLogs = db.prepare("PRAGMA table_info(request_logs)").all().map(c => c.name);
if (!existingLogs.includes('tokens_in'))  db.exec("ALTER TABLE request_logs ADD COLUMN tokens_in  INTEGER DEFAULT 0");
if (!existingLogs.includes('tokens_out')) db.exec("ALTER TABLE request_logs ADD COLUMN tokens_out INTEGER DEFAULT 0");
// Indice per query veloci
db.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_request_logs_avatar  ON request_logs(avatar_id, created_at)`);

export default db;
