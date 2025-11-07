import { Telegraf, Markup } from "telegraf";
import express from "express";
import fs from "fs-extra";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
const PHOTO_ID = process.env.PHOTO_ID;
const OWNER_ID = Number(process.env.OWNER_ID);

// === Ensure data files exist ===
const paths = {
  users: "./data/users.json",
  deals: "./data/deals.json",
  balances: "./data/balances.json",
  logs: "./data/logs.json"
};

for (const file of Object.values(paths))
  if (!fs.existsSync(file)) fs.writeJsonSync(file, {});

// === Helpers ===
const load = async (p) => (await fs.readJson(p).catch(() => ({})));
const save = async (p, d) => await fs.writeJson(p, d, { spaces: 2 });

// === Data cache ===
let users = await load(paths.users);
let deals = await load(paths.deals);
let balances = await load(paths.balances);
let logs = await load(paths.logs);

const genDealId = () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const prefix = chars[Math.floor(Math.random() * chars.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  return `#${prefix}${num}`;
};

// === Load locales ===
const ru = await fs.readJson("./locales/ru.json");

// === Bot start ===
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  users[userId] = { lang: null, stage: "lang" };
  await save(paths.users, users);
  await ctx.replyWithPhoto(PHOTO_ID, {
    caption: ru.lang_choose,
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🇷🇺 Русский", "lang_ru")],
      [Markup.button.callback("🇬🇧 English", "lang_en")],
      [Markup.button.callback("🇸🇦 العربية", "lang_ar")]
    ])
  });
});

bot.action(/lang_(.+)/, async (ctx) => {
  const lang = ctx.match[1];
  const userId = ctx.from.id;
  users[userId] = { lang, stage: "menu" };
  await save(paths.users, users);
  await ctx.editMessageCaption({
    caption: ru.welcome.replace("{username}", ctx.from.first_name),
    parse_mode: "Markdown",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("💼 Создать сделку", "create_deal")],
      [Markup.button.callback("🛍 Войти в сделку", "join_deal")],
      [Markup.button.callback("💰 Баланс", "balance")]
    ])
  });
});

// === Create deal ===
bot.action("create_deal", async (ctx) => {
  const userId = ctx.from.id;
  users[userId].stage = "create_title";
  await save(paths.users, users);
  await ctx.editMessageCaption({
    caption: ru.seller_role,
    parse_mode: "Markdown"
  });
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const user = users[userId];
  if (!user) return;

  // === Step 1: title ===
  if (user.stage === "create_title") {
    user.title = ctx.message.text;
    user.stage = "create_desc";
    await save(paths.users, users);
    return ctx.replyWithPhoto(PHOTO_ID, {
      caption: "🖋 Теперь добавьте описание товара.",
      parse_mode: "Markdown"
    });
  }

  // === Step 2: description ===
  if (user.stage === "create_desc") {
    user.desc = ctx.message.text;
    user.stage = "create_price";
    await save(paths.users, users);
    return ctx.replyWithPhoto(PHOTO_ID, {
      caption: "💰 Введите стоимость в TON (используйте кнопки).",
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        ["1", "2", "3"].map((n) => Markup.button.callback(n, `num_${n}`)),
        ["4", "5", "6"].map((n) => Markup.button.callback(n, `num_${n}`)),
        ["7", "8", "9"].map((n) => Markup.button.callback(n, `num_${n}`)),
        [Markup.button.callback("0", "num_0"), Markup.button.callback(",", "num_dot"), Markup.button.callback("↩️", "num_done")]
      ])
    });
  }

  // === Buyer joins deal ===
  if (user.stage === "join") {
    const id = ctx.message.text.trim();
    if (!deals[id]) return ctx.reply("❌ Сделка не найдена.");
    deals[id].buyer = userId;
    await save(paths.deals, deals);
    await ctx.replyWithPhoto(PHOTO_ID, {
      caption: ru.deal_joined.replace("{id}", id),
      parse_mode: "Markdown"
    });
  }
});

// === Price buttons ===
const priceCache = {};
bot.action(/num_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const key = ctx.match[1];
  priceCache[userId] = priceCache[userId] || "";

  if (key === "done") {
    const price = priceCache[userId].replace(",", ".");
    const u = users[userId];
    const id = genDealId();
    deals[id] = {
      id,
      seller: userId,
      title: u.title,
      desc: u.desc,
      price,
      status: "open"
    };
    await save(paths.deals, deals);
    delete priceCache[userId];
    u.stage = "menu";
    await save(paths.users, users);
    return ctx.editMessageCaption({
      caption: ru.deal_created
        .replace("{id}", id)
        .replace("{title}", u.title)
        .replace("{desc}", u.desc)
        .replace("{price}", price),
      parse_mode: "Markdown"
    });
  }

  if (key === "dot") priceCache[userId] += ",";
  else priceCache[userId] += key;

  await ctx.answerCbQuery(priceCache[userId]);
});

// === Balance ===
bot.action("balance", async (ctx) => {
  const userId = ctx.from.id;
  const balance = balances[userId] || 0;
  await ctx.editMessageCaption({
    caption: ru.balance.replace("{balance}", balance),
    parse_mode: "Markdown"
  });
});

// === Join deal ===
bot.action("join_deal", async (ctx) => {
  const userId = ctx.from.id;
  users[userId].stage = "join";
  await save(paths.users, users);
  await ctx.editMessageCaption({
    caption: ru.buyer_role,
    parse_mode: "Markdown"
  });
});

// === Complete deal manually (for demo) ===
bot.command("complete", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  const id = parts[1];
  if (!deals[id]) return ctx.reply("❌ Сделка не найдена.");
  const deal = deals[id];
  deal.status = "done";
  const date = new Date().toLocaleString();
  logs[id] = { ...deal, date };
  await save(paths.logs, logs);
  await ctx.replyWithPhoto(PHOTO_ID, {
    caption: ru.deal_complete.replace("{id}", id),
    parse_mode: "Markdown"
  });
  await bot.telegram.sendMessage(
    OWNER_ID,
    ru.admin_log
      .replace("{id}", id)
      .replace("{seller}", deal.seller)
      .replace("{buyer}", deal.buyer || "❌ нет данных")
      .replace("{price}", deal.price)
      .replace("{date}", date),
    { parse_mode: "Markdown" }
  );
});

// === Web server (Render) ===
app.get("/", (req, res) => res.send("Gift Castle Bot is running"));
app.listen(process.env.PORT || 10000, () =>
  console.log("✅ Web server started")
);

bot.launch();
console.log("🤖 Gift Castle Bot is live!");
