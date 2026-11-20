const TZ = "Asia/Bangkok";
const TABLE = "/rest/v1/";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, service: "betfolio-telegram" });
    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    let update;
    try { update = await request.json(); }
    catch { return new Response("Bad JSON", { status: 400 }); }
    ctx.waitUntil(processUpdate(update, env));
    return new Response("ok");
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runRiskAlerts(env));
  }
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function thaiDate(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return p;
}
function thaiMonth(date = new Date()) { return thaiDate(date).slice(0, 7); }
function monthEnd(month) {
  const [year, mm] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}
function money(n) {
  return "฿" + Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function net(r) { return r.status === "pending" ? 0 : Number(r.payout || 0) - Number(r.stake || 0) - Number(r.fee || 0); }
function closed(rows) { return rows.filter(r => r.status !== "pending"); }
function sum(rows, fn) { return rows.reduce((a, r) => a + fn(r), 0); }
function getType(value) {
  const v = (value || "").trim().toLowerCase();
  if (["lottery", "หวย", "ลอตเตอรี่"].includes(v)) return "lottery";
  if (["betting", "bet", "เดิมพัน"].includes(v)) return "betting";
  if (["trade", "trading", "เทรด", "ลงทุน"].includes(v)) return "trade";
  return null;
}
function getStatus(value) {
  const v = (value || "").trim().toLowerCase();
  if (["won", "win", "ชนะ", "ปิดบวก"].includes(v)) return "won";
  if (["lost", "lose", "แพ้", "ปิดลบ"].includes(v)) return "lost";
  if (["pending", "รอ", "ค้าง", "รอดำเนินการ"].includes(v)) return "pending";
  return null;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function requireEnv(env, names) {
  const missing = names.filter(n => !env[n]);
  if (missing.length) throw new Error("Worker secrets/vars missing: " + missing.join(", "));
}
function supabaseServiceHeaders(env, extra = {}) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = new Headers(extra);
  headers.set("apikey", key);
  // Supabase's newer sb_secret_* keys are API keys, not JWTs: send them via
  // apikey only. Legacy service_role keys are JWTs and still use Bearer auth.
  if (key.startsWith("sb_secret_")) {
    headers.delete("Authorization");
  } else {
    headers.set("Authorization", `Bearer ${key}`);
  }
  return headers;
}
async function sb(env, path, options = {}) {
  requireEnv(env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  const headers = supabaseServiceHeaders(env, options.headers || {});
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${env.SUPABASE_URL}${path}`, { ...options, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
async function tg(env, method, payload = {}) {
  requireEnv(env, ["TELEGRAM_BOT_TOKEN"]);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || "request failed"}`);
  return data.result;
}
async function reply(env, chatId, text) {
  const clipped = String(text || "").slice(0, 3900);
  return tg(env, "sendMessage", { chat_id: chatId, text: clipped, disable_web_page_preview: true });
}
async function processUpdate(update, env) {
  const msg = update?.message;
  if (!msg?.chat?.id || !msg?.from?.id) return;
  const chatId = String(msg.chat.id), telegramUserId = String(msg.from.id);
  // Private chats only. Do not permit use in groups/supergroups.
  if (msg.chat.type !== "private") return;

  const text = (msg.text || msg.caption || "").trim();
  const command = (text.split(/\s+/)[0] || "").split("@")[0].toLowerCase();

  // Bootstrap command must work before Supabase schema/service key is configured.
  // The webhook secret is already checked in fetch(), so only Telegram webhook
  // requests carrying the configured secret can reach this handler.
  if (command === "/whoami") {
    try {
      await reply(env, chatId, `Telegram User ID ของคุณคือ: ${telegramUserId}\nนำค่านี้ไปตั้งเป็น Worker secret: ALLOWED_TELEGRAM_USER_ID`);
    } catch (e) {
      console.error("Telegram /whoami reply failed", e);
    }
    return;
  }

  // Telegram may retry webhooks; process every update_id only once.
  if (update.update_id != null) {
    try {
      const inserted = await sb(env, `${TABLE}telegram_updates?on_conflict=update_id`, {
        method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({ update_id: String(update.update_id) })
      });
      if (!inserted || inserted.length === 0) return;
    } catch (e) {
      // Fail closed if idempotency storage is unavailable; Telegram may retry later.
      console.error("Update idempotency failed", e);
      return;
    }
  }

  if (!env.ALLOWED_TELEGRAM_USER_ID) {
    await reply(env, chatId, "บอทยังไม่ถูกล็อกกับเจ้าของ กรุณาตั้งค่า ALLOWED_TELEGRAM_USER_ID ก่อนใช้งาน");
    return;
  }
  if (telegramUserId !== String(env.ALLOWED_TELEGRAM_USER_ID)) {
    await reply(env, chatId, "บัญชีนี้ไม่ได้รับอนุญาตให้ใช้งานบอทส่วนตัว");
    return;
  }

  try {
    if (msg.photo?.length) { await handlePhoto(msg, env); return; }
    if (!text) return;
    if (command === "/start" || command === "/help") { await reply(env, chatId, helpText(env)); return; }
    if (command === "/today") { await handlePeriod(chatId, env, thaiDate(), thaiDate(), "สรุปวันนี้"); return; }
    if (command === "/summary") { const m = thaiMonth(); await handlePeriod(chatId, env, `${m}-01`, monthEnd(m), `สรุปเดือน ${m}`); return; }
    if (command === "/month") {
      const month = (text.split(/\s+/)[1] || thaiMonth()).trim();
      if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) { await reply(env, chatId, "รูปแบบ: /month YYYY-MM เช่น /month 2026-11"); return; }
      await handlePeriod(chatId, env, `${month}-01`, monthEnd(month), `สรุปเดือน ${month}`); return;
    }
    if (command === "/budget") { await handleBudget(chatId, env); return; }
    if (command === "/add") { await handleAdd(chatId, env, text.slice(command.length).trim()); return; }
    await reply(env, chatId, "ไม่รู้จักคำสั่งนี้\n\n" + helpText(env));
  } catch (e) {
    console.error("Telegram handler error", e);
    await reply(env, chatId, "เกิดข้อผิดพลาดในการประมวลผล กรุณาลองใหม่ หรือตรวจสอบ Worker logs").catch(() => {});
  }
}
function helpText(env) {
  const app = env.APP_URL ? `\nเปิด Dashboard: ${env.APP_URL}` : "";
  return `Betfolio · ผู้ช่วยบันทึกและสรุปพอร์ตส่วนตัว\n\n/today — สรุปวันนี้\n/summary — สรุปเดือนนี้\n/month YYYY-MM — สรุปรายเดือน\n/budget — เช็กงบและ TP/SL\n/add — เพิ่มรายการแบบข้อความ\nส่งรูปบิล — เก็บรูปและอ่านข้อความ OCR (เมื่อตั้ง OCR API)\n/whoami — ตรวจ Telegram ID\n\nรูปแบบ /add ใช้เครื่องหมาย | คั่น 8 ช่อง:\n/add วันที่|ประเภท|ชื่อรายการ|ยอดลง|ยอดรับ|ค่าธรรมเนียม|สถานะ|หมายเหตุ\nตัวอย่าง:\n/add 2026-11-20|betting|รายการทดสอบ|100|0|0|lost|บันทึกส่วนตัว\nประเภท: หวย / betting / trade\nสถานะ: pending / won / lost\nระบบบันทึกตามข้อมูลที่คุณป้อน ไม่แนะนำการเดิมพันหรือการลงทุน${app}`;
}
async function getRecords(env, from, to) {
  const q = `?select=record_date,type,name,status,stake,payout,fee,note&record_date=gte.${encodeURIComponent(from)}&record_date=lte.${encodeURIComponent(to)}&order=record_date.asc`;
  return sb(env, `${TABLE}ledger_records${q}&user_id=eq.${encodeURIComponent(env.SUPABASE_USER_ID)}`);
}
async function handlePeriod(chatId, env, from, to, heading) {
  requireEnv(env, ["SUPABASE_USER_ID"]);
  const rows = await getRecords(env, from, to);
  const done = closed(rows), stake = sum(rows, r => Number(r.stake || 0));
  const pnl = sum(done, net), pending = sum(rows.filter(r => r.status === "pending"), r => Number(r.stake || 0));
  const wins = done.filter(r => net(r) > 0).length, losses = done.filter(r => net(r) < 0).length;
  await reply(env, chatId, `${heading}\nรายการทั้งหมด: ${rows.length}\nยอดลงรวม: ${money(stake)}\nรายการรอดำเนินการ: ${money(pending)}\nปิดแล้ว: ${done.length} (บวก ${wins} / ลบ ${losses})\nกำไร/ขาดทุนสุทธิ: ${pnl > 0 ? "+" : ""}${money(pnl)}\n\nหมายเหตุ: ไม่นับรายการ pending เป็นกำไร/ขาดทุน`);
}
async function getSettings(env) {
  const q = `?select=*&user_id=eq.${encodeURIComponent(env.SUPABASE_USER_ID)}&limit=1`;
  const rows = await sb(env, `${TABLE}user_settings${q}`);
  return rows?.[0] || { daily_budget: 0, monthly_budget: 0, daily_tp: 0, daily_sl: 0, monthly_tp: 0, monthly_sl: 0 };
}
async function handleBudget(chatId, env) {
  requireEnv(env, ["SUPABASE_USER_ID"]);
  const d = thaiDate(), m = thaiMonth(), [todayRows, monthRows, settings] = await Promise.all([
    getRecords(env, d, d), getRecords(env, `${m}-01`, monthEnd(m)), getSettings(env)
  ]);
  const dStake = sum(todayRows, r => Number(r.stake || 0)), mStake = sum(monthRows, r => Number(r.stake || 0));
  const dPnl = sum(closed(todayRows), net), mPnl = sum(closed(monthRows), net);
  await reply(env, chatId, `คุมงบและความเสี่ยง\nวันนี้: ใช้ไป ${money(dStake)} / งบ ${money(settings.daily_budget)} · P/L ${money(dPnl)}\nเดือนนี้: ใช้ไป ${money(mStake)} / งบ ${money(settings.monthly_budget)} · P/L ${money(mPnl)}\n\nDaily TP ${money(settings.daily_tp)} · Daily SL ${money(settings.daily_sl)}\nMonthly TP ${money(settings.monthly_tp)} · Monthly SL ${money(settings.monthly_sl)}\n\nการแจ้งเตือนอัตโนมัติทำงานผ่าน Cron ของ Worker เมื่อถึงเกณฑ์ที่ตั้งไว้`);
}
async function handleAdd(chatId, env, payload) {
  requireEnv(env, ["SUPABASE_USER_ID"]);
  const p = payload.split("|").map(x => x.trim());
  if (p.length < 7) { await reply(env, chatId, "รูปแบบไม่ครบ กรุณาส่ง:\n/add วันที่|ประเภท|ชื่อรายการ|ยอดลง|ยอดรับ|ค่าธรรมเนียม|สถานะ|หมายเหตุ\nตัวอย่าง:\n/add 2026-11-20|หวย|บิลตัวอย่าง|50|0|0|pending|ทดสอบ"); return; }
  const [date, rawType, name, rawStake, rawPayout, rawFee, rawStatus, note = ""] = p;
  const type = getType(rawType), status = getStatus(rawStatus);
  const parseAmount = value => Number(String(value).replace(/,/g, ""));
  const stake = parseAmount(rawStake), payout = parseAmount(rawPayout), fee = parseAmount(rawFee);
  if (!validDate(date) || !type || !status || !name || ![stake,payout,fee].every(Number.isFinite) || [stake,payout,fee].some(n => n < 0)) {
    await reply(env, chatId, "ข้อมูลไม่ถูกต้อง ตรวจวันที่ ประเภท สถานะ และจำนวนเงิน (ต้องไม่ติดลบ) แล้วส่งใหม่"); return;
  }
  // Attach the newest unreviewed Telegram photo, if one exists.
  const inboxRows = await sb(env, `${TABLE}telegram_inbox?select=id,storage_path&user_id=eq.${encodeURIComponent(env.SUPABASE_USER_ID)}&status=eq.received&created_at=gte.${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}&order=created_at.desc&limit=1`);
  const linkedPhoto = inboxRows?.[0] || null;
  const row = { id: crypto.randomUUID(), user_id: env.SUPABASE_USER_ID, record_date: date, type, name, status, stake, payout: status === "lost" ? 0 : payout, fee, note, image_path: linkedPhoto?.storage_path || null };
  await sb(env, `${TABLE}ledger_records`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  if (linkedPhoto) await sb(env, `${TABLE}telegram_inbox?id=eq.${encodeURIComponent(linkedPhoto.id)}`, { method: "PATCH", body: JSON.stringify({ status: "reviewed" }) });
  const result = net(row);
  await reply(env, chatId, `บันทึกรายการแล้ว ✓\n${date} · ${type}\n${name}\nยอดลง ${money(stake)} · ยอดรับ ${money(row.payout)}\nสถานะ ${status}\nP/L ${status === "pending" ? "ยังไม่รับรู้" : (result > 0 ? "+" : "") + money(result)}${linkedPhoto ? "\nแนบรูป Telegram ล่าสุดให้แล้ว" : ""}`);
}
async function handlePhoto(msg, env) {
  requireEnv(env, ["SUPABASE_USER_ID"]);
  const photo = [...msg.photo].sort((a,b) => (b.file_size || 0) - (a.file_size || 0))[0];
  const meta = await tg(env, "getFile", { file_id: photo.file_id });
  const download = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.file_path}`);
  if (!download.ok) throw new Error("Download Telegram photo failed");
  const buffer = await download.arrayBuffer();
  if (buffer.byteLength > 12 * 1024 * 1024) { await reply(env, msg.chat.id, "รูปใหญ่เกิน 12 MB กรุณาส่งภาพที่เล็กลง"); return; }
  const ext = (meta.file_path || "photo.jpg").toLowerCase().endsWith(".png") ? "png" : "jpg";
  const path = `${env.SUPABASE_USER_ID}/telegram-${Date.now()}-${msg.message_id}.${ext}`;
  const upload = await fetch(`${env.SUPABASE_URL}/storage/v1/object/bill-images/${path}`, {
    method: "POST", headers: supabaseServiceHeaders(env, { "Content-Type": ext === "png" ? "image/png" : "image/jpeg", "x-upsert": "true" }), body: buffer
  });
  if (!upload.ok) throw new Error(`Image storage failed: ${(await upload.text()).slice(0,300)}`);
  let ocrText = "";
  if (env.OCR_SPACE_API_KEY) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: ext === "png" ? "image/png" : "image/jpeg" }), `telegram-bill.${ext}`);
      form.append("language", "tha");
      form.append("OCREngine", "2");
      const ocrResponse = await fetch("https://api.ocr.space/parse/image", { method: "POST", headers: { apikey: env.OCR_SPACE_API_KEY }, body: form });
      const data = await ocrResponse.json();
      ocrText = (data.ParsedResults || []).map(x => x.ParsedText || "").join("\n").trim();
      if (data.IsErroredOnProcessing) ocrText = "OCR error: " + JSON.stringify(data.ErrorMessage || "processing failed");
    } catch (e) { ocrText = "OCR error: " + e.message; }
  }
  await sb(env, `${TABLE}telegram_inbox`, { method: "POST", body: JSON.stringify({ user_id: env.SUPABASE_USER_ID, telegram_user_id: String(msg.from.id), telegram_chat_id: String(msg.chat.id), telegram_file_id: photo.file_id, storage_path: path, ocr_text: ocrText }) });
  if (ocrText && !ocrText.startsWith("OCR error:")) {
    const stakeMatch = ocrText.match(/(?:ยอดแทง|ยอดลง|เดิมพัน|จำนวนเงิน|stake|amount)\s*[:：]?\s*(?:฿|บาท)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
    const payoutMatch = ocrText.match(/(?:ยอดรับ|รับเงิน|จ่าย|payout|return)\s*[:：]?\s*(?:฿|บาท)?\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
    const hints = `\n\nค่าที่ OCR พอจับได้ (ตรวจรูปก่อนใช้):\nยอดลง: ${stakeMatch ? stakeMatch[1] : "ยังแยกไม่ชัด"}\nยอดรับ: ${payoutMatch ? payoutMatch[1] : "ยังแยกไม่ชัด"}`;
    await reply(env, msg.chat.id, `ได้รับรูปและอ่านข้อความแล้ว ✓\nเก็บไฟล์ไว้ในพื้นที่ส่วนตัวเรียบร้อย${hints}\n\nข้อความ OCR:\n${ocrText.slice(0,2200)}\n\nเพื่อบันทึกเป็นรายการ ให้ตรวจยอดแล้วส่ง /add ตามรูปแบบ /help — ระบบจะไม่บันทึกตัวเลขอัตโนมัติเพื่อป้องกัน OCR อ่านยอดผิด`);
  } else if (ocrText.startsWith("OCR error:")) {
    await reply(env, msg.chat.id, `ได้รับและเก็บรูปแล้ว แต่ OCR ไม่สำเร็จ\n${ocrText.slice(0,500)}\n\nตรวจรูปและเพิ่มรายการด้วย /add หรือเปิดใน Dashboard`);
  } else {
    await reply(env, msg.chat.id, `ได้รับรูปและเก็บไว้ในพื้นที่ส่วนตัวแล้ว ✓\nยังไม่ได้ตั้ง OCR_SPACE_API_KEY จึงยังอ่านข้อความอัตโนมัติไม่ได้\n\nเพิ่มรายการด้วย /add หรือเปิด Dashboard`);
  }
}
async function runRiskAlerts(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_USER_ID || !env.ALLOWED_TELEGRAM_USER_ID) return;
  const today = thaiDate(), month = thaiMonth();
  const [todayRows, monthRows, settings] = await Promise.all([getRecords(env, today, today), getRecords(env, `${month}-01`, monthEnd(month)), getSettings(env)]);
  const dPnl = sum(closed(todayRows), net), mPnl = sum(closed(monthRows), net);
  const dStake = sum(todayRows, r => Number(r.stake || 0)), mStake = sum(monthRows, r => Number(r.stake || 0));
  const checks = [];
  const add = (key, title, detail) => checks.push({ key, title, detail });
  if (Number(settings.daily_tp) > 0 && dPnl >= Number(settings.daily_tp)) add(`daily-tp-${today}`, "Daily TP ถึงเป้าหมาย", `กำไรวันนี้ ${money(dPnl)} / TP ${money(settings.daily_tp)}`);
  if (Number(settings.daily_sl) > 0 && dPnl <= -Number(settings.daily_sl)) add(`daily-sl-${today}`, "Daily SL แตะขีดจำกัด", `ขาดทุนวันนี้ ${money(Math.abs(dPnl))} / SL ${money(settings.daily_sl)}`);
  if (Number(settings.monthly_tp) > 0 && mPnl >= Number(settings.monthly_tp)) add(`monthly-tp-${month}`, "Monthly TP ถึงเป้าหมาย", `กำไรเดือนนี้ ${money(mPnl)} / TP ${money(settings.monthly_tp)}`);
  if (Number(settings.monthly_sl) > 0 && mPnl <= -Number(settings.monthly_sl)) add(`monthly-sl-${month}`, "Monthly SL แตะขีดจำกัด", `ขาดทุนเดือนนี้ ${money(Math.abs(mPnl))} / SL ${money(settings.monthly_sl)}`);
  if (Number(settings.daily_budget) > 0 && dStake >= Number(settings.daily_budget)) add(`daily-budget-${today}`, "ใช้ถึงงบรายวัน", `ยอดลงวันนี้ ${money(dStake)} / งบ ${money(settings.daily_budget)}`);
  if (Number(settings.monthly_budget) > 0 && mStake >= Number(settings.monthly_budget)) add(`monthly-budget-${month}`, "ใช้ถึงงบรายเดือน", `ยอดลงเดือนนี้ ${money(mStake)} / งบ ${money(settings.monthly_budget)}`);
  for (const item of checks) {
    const inserted = await sb(env, `${TABLE}telegram_alerts?on_conflict=user_id,event_key`, {
      method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ user_id: env.SUPABASE_USER_ID, event_key: item.key })
    });
    if (inserted?.length) await tg(env, "sendMessage", { chat_id: env.ALLOWED_TELEGRAM_USER_ID, text: `Betfolio · Risk Alert\n${item.title}\n${item.detail}\n\nตรวจสอบยอดและหยุดตามกติกาคุมความเสี่ยงที่ตั้งไว้` });
  }
}
