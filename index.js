import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Client, GatewayIntentBits, Events } from "discord.js";
import { Player, QueueRepeatMode } from "discord-player";
import { DefaultExtractors } from "@discord-player/extractor";

const execAsync = promisify(exec);
const YOUTUBE_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)[\w\-]+/;

function isYouTubeUrl(q) { return YOUTUBE_REGEX.test(q); }

async function getYtdlpAudioUrl(url) {
  const { stdout } = await execAsync(`yt-dlp -x -f bestaudio --get-url "${url}"`);
  return stdout.trim().split("\n")[0];
}
async function getYtdlpTitle(url) {
  const { stdout } = await execAsync(`yt-dlp --get-title "${url}"`);
  return stdout.trim().split("\n")[0] ?? url;
}

const pendingSearches = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const player = new Player(client);
player.extractors.loadMulti(DefaultExtractors).catch(console.error);

client.on(Events.ClientReady, (c) => console.log(`🎵 Seni Music online as ${c.user.tag}`));

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  const args = message.content.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();

  if (cmd === "!play") {
    const query = args.slice(1).join(" ");
    if (!query) return message.reply("🔗 Give me a song name or YouTube link!\nExample: `!play Believer`");
    const member = message.guild.members.cache.get(message.author.id) ?? await message.guild.members.fetch(message.author.id);
    const channel = member.voice.channel;
    if (!channel) return message.reply("Join a voice channel first!");
    const queue = player.nodes.create(message.guild, { metadata: message.channel, leaveOnEmpty: true, leaveOnEnd: true });
    try {
      if (!queue.connection) await queue.connect(channel);
      let searchQuery = query, titleHint;
      if (isYouTubeUrl(query)) {
        await message.reply("🔍 Fetching YouTube audio...");
        [searchQuery, titleHint] = await Promise.all([getYtdlpAudioUrl(query), getYtdlpTitle(query)]);
      }
      const result = await player.search(searchQuery, { requestedBy: message.author });
      if (!result.hasTracks()) return message.reply("No results found 😢");
      const dToS = (d) => { const p = d.split(":").map(Number); return p.length === 2 ? p[0]*60+p[1] : p[0]*3600+p[1]*60+p[2]; };
      const track = (!isYouTubeUrl(query) ? result.tracks.find(t => dToS(t.duration) >= 60) : null) ?? result.tracks[0];
      if (titleHint) track.title = titleHint;
      queue.addTrack(track);
      if (!queue.isPlaying()) await queue.node.play();
      await message.reply(`🎶 Now playing: **${track.title}**`);
    } catch (err) { console.error(err); message.reply("Error playing song 😔"); }
  }

  if (cmd === "!pause") {
    const q = player.nodes.get(message.guild.id);
    if (!q?.isPlaying()) return message.reply("Nothing is playing!");
    q.node.pause(); message.reply("⏸️ Paused!");
  }

  if (cmd === "!resume") {
    const q = player.nodes.get(message.guild.id);
    if (!q) return message.reply("Nothing is playing!");
    try { q.node.resume(); message.reply("▶️ Resumed!"); } catch { message.reply("Can't resume 😔"); }
  }

  if (cmd === "!skip") {
    const q = player.nodes.get(message.guild.id);
    if (!q) return message.reply("Nothing is playing!");
    q.node.skip(); message.reply("⏭ Skipped!");
  }

  if (cmd === "!stop") {
    const q = player.nodes.get(message.guild.id);
    if (!q) return message.reply("Nothing is playing!");
    q.delete(); message.reply("⏹ Stopped!");
  }

  if (cmd === "!loop") {
    const q = player.nodes.get(message.guild.id);
    if (!q) return message.reply("Nothing is playing!");
    if (q.repeatMode === QueueRepeatMode.OFF) { q.setRepeatMode(QueueRepeatMode.TRACK); message.reply("🔂 Looping track!"); }
    else if (q.repeatMode === QueueRepeatMode.TRACK) { q.setRepeatMode(QueueRepeatMode.QUEUE); message.reply("🔁 Looping queue!"); }
    else { q.setRepeatMode(QueueRepeatMode.OFF); message.reply("➡️ Loop off!"); }
  }

  if (cmd === "!queue") {
    const q = player.nodes.get(message.guild.id);
    if (!q || q.tracks.size === 0) return message.reply("Queue is empty!");
    const list = q.tracks.toArray().slice(0, 10).map((t, i) => `${i+1}. **${t.title}** — ${t.author}`).join("\n");
    message.reply(`🎵 **Queue (${q.tracks.size} tracks):**\n${list}`);
  }

  if (cmd === "!np") {
    const q = player.nodes.get(message.guild.id);
    if (!q?.currentTrack) return message.reply("Nothing is playing!");
    message.reply(`🎶 Now playing: **${q.currentTrack.title}** by **${q.currentTrack.author}**`);
  }

  if (cmd === "!volume") {
    const q = player.nodes.get(message.guild.id);
    if (!q) return message.reply("Nothing is playing!");
    const vol = parseInt(args[1] ?? "", 10);
    if (isNaN(vol) || vol < 0 || vol > 100) return message.reply("Use a number between 0-100.");
    q.node.setVolume(vol); message.reply(`🔊 Volume: **${vol}%**`);
  }

  if (cmd === "!search") {
    const query = args.slice(1).join(" ");
    if (!query) return message.reply("Give me a search term!");
    const result = await player.search(query, { requestedBy: message.author });
    if (!result.hasTracks()) return message.reply("No results found 😢");
    const tracks = result.tracks.slice(0, 5);
    pendingSearches.set(`${message.guild.id}-${message.channel.id}`, tracks);
    const list = tracks.map((t, i) => `**${i+1}.** ${t.title} — ${t.author} \`[${t.duration}]\``).join("\n");
    message.reply(`🔎 **Results for "${query}":**\n${list}\n\nType \`!pick <number>\` to play.`);
  }

  if (cmd === "!pick") {
    const key = `${message.guild.id}-${message.channel.id}`;
    const tracks = pendingSearches.get(key);
    if (!tracks) return message.reply("No active search! Use `!search` first.");
    const num = parseInt(args[1] ?? "", 10);
    if (isNaN(num) || num < 1 || num > tracks.length) return message.reply(`Pick 1–${tracks.length}.`);
    const track = tracks[num - 1];
    pendingSearches.delete(key);
    const member = message.guild.members.cache.get(message.author.id) ?? await message.guild.members.fetch(message.author.id);
    const channel = member.voice.channel;
    if (!channel) return message.reply("Join a voice channel first!");
    const queue = player.nodes.create(message.guild, { metadata: message.channel, leaveOnEmpty: true, leaveOnEnd: true });
    try {
      if (!queue.connection) await queue.connect(channel);
      queue.addTrack(track);
      if (!queue.isPlaying()) await queue.node.play();
      message.reply(`🎶 Now playing: **${track.title}**`);
    } catch (err) { console.error(err); message.reply("Error playing song 😔"); }
  }

  if (cmd === "!help") {
    message.reply(
      "**🎵 Seni Music Commands:**\n" +
      "`!play <song or YouTube link>` — Play a song\n" +
      "`!search <song>` — Search and pick from results\n" +
      "`!pick <number>` — Pick a search result\n" +
      "`!pause` / `!resume` — Pause or resume\n" +
      "`!loop` — Toggle loop (track → queue → off)\n" +
      "`!skip` — Skip current track\n" +
      "`!stop` — Stop and clear queue\n" +
      "`!queue` — Show queue\n" +
      "`!np` — Now playing\n" +
      "`!volume <0-100>` — Set volume\n" +
      "`!help` — This message"
    );
  }
});

client.login(process.env.TOKEN);
