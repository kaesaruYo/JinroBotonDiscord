import "dotenv/config";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  Guild,
  GuildBasedChannel,
  GuildMember,
  Interaction,
  Message,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

type RoleId =
  | "villager"
  | "werewolf"
  | "madman"
  | "seer"
  | "medium"
  | "bodyguard"
  | "baker"
  | "psycho";

type TeamId = "village" | "werewolf";
type RoomMode = "text" | "vc";
type TiePolicy = "revote" | "random" | "runoff";
type RoomStatus = "lobby" | "running" | "ended";
type RoomPhase = "lobby" | "night" | "day" | "vote" | "ended";
type LogKind = "event" | "chat";

interface RoleInfo {
  id: RoleId;
  name: string;
  team: TeamId;
  description: string;
}

interface RoomSettings {
  playerLimit: number;
  daySeconds: number;
  voteSeconds: number;
  nightSeconds: number;
  roleCounts: Partial<Record<RoleId, number>>;
  firstNightKill: boolean;
  tiePolicy: TiePolicy;
  mode: RoomMode;
}

interface PlayerState {
  id: string;
  displayName: string;
  role?: RoleId;
  alive: boolean;
  joinedAt: number;
}

interface RoomChannels {
  categoryId: string;
  mainTextId: string;
  talkId: string;
  wolfId: string;
  graveyardId: string;
}

interface LogEntry {
  at: number;
  kind: LogKind;
  text: string;
  channelName?: string;
  authorName?: string;
}

interface WaitingState {
  token: string;
  pending: Set<string>;
  resolve: () => void;
  deadlineAt: number;
}

interface NightState {
  token: string;
  biteVotes: Map<string, string>;
  seerTargets: Map<string, string>;
  guardTargets: Map<string, string>;
  mediumChecks: Set<string>;
}

interface VoteState {
  token: string;
  label: string;
  voters: Set<string>;
  eligibleTargets: Set<string>;
  votes: Map<string, string>;
}

interface RoomState {
  id: string;
  guildId: string;
  hostId: string;
  name: string;
  createdAt: number;
  status: RoomStatus;
  phase: RoomPhase;
  day: number;
  settings: RoomSettings;
  channels: RoomChannels;
  players: Map<string, PlayerState>;
  logs: LogEntry[];
  lastExecutedId?: string;
  waiting?: WaitingState;
  night?: NightState;
  vote?: VoteState;
  cleanupTimer?: NodeJS.Timeout;
}

type SendableGuildChannel = GuildBasedChannel & {
  send: (options: string | Record<string, unknown>) => Promise<Message>;
};

const ROLE_INFO: Record<RoleId, RoleInfo> = {
  villager: {
    id: "villager",
    name: "村人",
    team: "village",
    description: "特殊能力はありません。議論と投票で人狼を探します。",
  },
  werewolf: {
    id: "werewolf",
    name: "人狼",
    team: "werewolf",
    description: "夜に襲撃先へ投票します。",
  },
  madman: {
    id: "madman",
    name: "狂人",
    team: "werewolf",
    description: "人間ですが、人狼陣営の勝利で勝ちます。",
  },
  seer: {
    id: "seer",
    name: "占い師",
    team: "village",
    description: "夜に 1 人を占い、人狼かどうかを知ります。",
  },
  medium: {
    id: "medium",
    name: "霊媒師",
    team: "village",
    description: "2 日目夜以降、直近で処刑された人が人狼かどうかを知ります。",
  },
  bodyguard: {
    id: "bodyguard",
    name: "狩人",
    team: "village",
    description: "夜に 1 人を護衛します。",
  },
  baker: {
    id: "baker",
    name: "パン屋",
    team: "village",
    description: "生存中、毎朝パンが届いたログが流れます。",
  },
  psycho: {
    id: "psycho",
    name: "サイコ",
    team: "village",
    description: "夜に能力や襲撃の対象にされると、対象にした側へ事故死が発生します。",
  },
};

const ROLE_ALIASES = new Map<string, RoleId>([
  ["村人", "villager"],
  ["平民", "villager"],
  ["市民", "villager"],
  ["villager", "villager"],
  ["人狼", "werewolf"],
  ["狼", "werewolf"],
  ["werewolf", "werewolf"],
  ["wolf", "werewolf"],
  ["狂人", "madman"],
  ["狂信者", "madman"],
  ["madman", "madman"],
  ["狂", "madman"],
  ["占い師", "seer"],
  ["占い", "seer"],
  ["seer", "seer"],
  ["霊媒師", "medium"],
  ["霊能者", "medium"],
  ["霊媒", "medium"],
  ["medium", "medium"],
  ["狩人", "bodyguard"],
  ["騎士", "bodyguard"],
  ["bodyguard", "bodyguard"],
  ["guard", "bodyguard"],
  ["パン屋", "baker"],
  ["baker", "baker"],
  ["サイコ", "psycho"],
  ["サイコキラー", "psycho"],
  ["psycho", "psycho"],
]);

const discordToken = readRequiredEnv("DISCORD_TOKEN");
const applicationClientId = readRequiredEnv("CLIENT_ID");
const guildId = process.env.GUILD_ID;
const lobbyChannelName = process.env.LOBBY_CHANNEL_NAME ?? "jinro-lobby";
const roomCategoryPrefix = process.env.ROOM_CATEGORY_PREFIX ?? "jinro";
const logDir = process.env.LOG_DIR ?? "data/logs";
const maxRoomsPerGuild = readPositiveIntEnv("MAX_ROOMS_PER_GUILD", 8);
const cleanupDelayMs = 20 * 60 * 1000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const rooms = new Map<string, RoomState>();
const channelToRoom = new Map<string, string>();

void main();

async function main(): Promise<void> {
  await mkdir(logDir, { recursive: true });
  await registerCommands();

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.MessageCreate, handleMessageCreate);

  await client.login(discordToken);
}

async function registerCommands(): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName("jinro-setup")
      .setDescription("人狼ロビーを作成し、ルーム作成・参加・ログ確認パネルを投稿します。")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("jinro-rooms")
      .setDescription("現在 bot が管理している人狼ルームを表示します。"),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(discordToken);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(applicationClientId, guildId), { body: commands });
    console.log(`Registered slash commands for guild ${guildId}`);
    return;
  }

  await rest.put(Routes.applicationCommands(applicationClientId), { body: commands });
  console.log("Registered global slash commands");
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelect(interaction);
    }
  } catch (error) {
    console.error(error);
    await safeInteractionReply(interaction, "エラーが発生しました。bot のログを確認してください。");
  }
}

async function handleChatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "jinro-setup") {
    const channel = await ensureLobbyChannel(interaction.guild);
    await channel.send({
      content:
        "人狼ロビーです。ルームを作成するか、既存ルームへ参加してください。試合後のログもここから確認できます。",
      components: lobbyRows(),
    });
    await interaction.reply({
      content: `<#${channel.id}> に人狼パネルを投稿しました。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === "jinro-rooms") {
    const guildRooms = [...rooms.values()].filter((room) => room.guildId === interaction.guildId);
    if (guildRooms.length === 0) {
      await interaction.reply({ content: "現在管理中のルームはありません。", flags: MessageFlags.Ephemeral });
      return;
    }

    const lines = guildRooms.map((room) => {
      const alive = alivePlayers(room).length;
      return `- ${room.name} (${room.status}/${room.phase}) 参加 ${room.players.size}/${room.settings.playerLimit} 生存 ${alive}`;
    });
    await interaction.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const [prefix, action, roomId] = interaction.customId.split(":");
  if (prefix !== "jw") {
    return;
  }

  if (action === "create") {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
      return;
    }

    if (activeRoomCount(interaction.guildId) >= maxRoomsPerGuild) {
      await interaction.reply({
        content: `同時に使えるルーム数は ${maxRoomsPerGuild} までです。待機中または進行中のルームを終了してから作成してください。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.showModal(createRoomModal());
    return;
  }

  if (action === "join") {
    await showJoinMenu(interaction);
    return;
  }

  if (action === "logs") {
    await showLogMenu(interaction);
    return;
  }

  if (action === "start" && roomId) {
    await startRoomFromButton(interaction, roomId);
    return;
  }

  if (action === "cancel" && roomId) {
    await cancelRoomFromButton(interaction, roomId);
  }
}

async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (interaction.customId !== "jw:create-modal") {
    return;
  }

  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const hostMember = interaction.member instanceof GuildMember ? interaction.member : await interaction.guild.members.fetch(interaction.user.id);
  const roomName = interaction.fields.getTextInputValue("room-name").trim() || "room";
  const basicInput = interaction.fields.getTextInputValue("basic-settings");
  const roleInput = interaction.fields.getTextInputValue("role-settings");
  const ruleInput = interaction.fields.getTextInputValue("rule-settings");

  let settings: RoomSettings;
  try {
    settings = parseSettings(basicInput, roleInput, ruleInput);
  } catch (error) {
    await interaction.reply({
      content: error instanceof Error ? error.message : "設定を読み取れませんでした。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (activeRoomCount(interaction.guild.id) >= maxRoomsPerGuild) {
    await interaction.reply({
      content: `同時に使えるルーム数は ${maxRoomsPerGuild} までです。待機中または進行中のルームを終了してから作成してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const room = await createRoom(interaction.guild, hostMember, roomName, settings);
  rooms.set(room.id, room);
  indexRoomChannels(room);

  const mainChannel = await getSendableChannel(interaction.guild, room.channels.mainTextId);
  await mainChannel?.send({
    content:
      `${hostMember} がルームを作成しました。\n` +
      `人数が集まったらホストが「開始する」を押してください。\n\n${settingsSummary(room.settings)}`,
    components: hostRows(room),
  });
  appendEvent(room, `ルームを作成しました: ${room.name}`);

  await interaction.editReply({
    content: `ルーム「${room.name}」を作成しました。進行チャンネル: <#${room.channels.mainTextId}>`,
  });
}

async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const [prefix, action, roomId, tokenValue, kind] = interaction.customId.split(":");
  if (prefix !== "jw") {
    return;
  }

  if (action === "join-room") {
    await joinSelectedRoom(interaction);
    return;
  }

  if (action === "log-select") {
    await sendSelectedLog(interaction);
    return;
  }

  if (action === "night" && roomId && tokenValue && kind) {
    await handleNightActionSelect(interaction, roomId, tokenValue, kind);
    return;
  }

  if (action === "vote" && roomId && tokenValue) {
    await handleVoteSelect(interaction, roomId, tokenValue);
  }
}

async function ensureLobbyChannel(guild: Guild): Promise<TextChannel> {
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name === lobbyChannelName,
  );
  if (existing && existing.type === ChannelType.GuildText) {
    return existing;
  }

  return guild.channels.create({
    name: lobbyChannelName,
    type: ChannelType.GuildText,
    reason: "Create Jinro lobby channel",
  });
}

function lobbyRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("jw:create").setLabel("ルーム作成").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("jw:join").setLabel("ルーム参加").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("jw:logs").setLabel("ログ確認").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function hostRows(room: RoomState): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`jw:start:${room.id}`).setLabel("開始する").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`jw:cancel:${room.id}`).setLabel("ルーム削除").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function createRoomModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("jw:create-modal")
    .setTitle("人狼ルーム作成")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("room-name")
          .setLabel("ルーム名")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40)
          .setValue("room"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("basic-settings")
          .setLabel("人数と時間")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue("人数=8, 昼=300, 投票=60, 夜=90"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("role-settings")
          .setLabel("役職数")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue("人狼=2, 占い師=1, 霊媒師=1, 狩人=1, 狂人=1, パン屋=1"),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("rule-settings")
          .setLabel("ルール")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue("初日噛み=false, 同票=revote, モード=text"),
      ),
    );
}

function parseSettings(basicInput: string, roleInput: string, ruleInput: string): RoomSettings {
  const playerLimit = parseNumberSetting(basicInput, ["人数", "players", "player"], 8);
  const daySeconds = parseNumberSetting(basicInput, ["昼", "議論", "day"], 300);
  const voteSeconds = parseNumberSetting(basicInput, ["投票", "vote"], 60);
  const nightSeconds = parseNumberSetting(basicInput, ["夜", "night"], 90);
  const roleCounts = parseRoleCounts(roleInput);
  const firstNightKill = parseBooleanSetting(ruleInput, ["初日噛み", "初日嚙み", "firstNightKill"], false);
  const tiePolicy = parseTiePolicy(ruleInput);
  const mode = parseRoomMode(ruleInput);

  if (playerLimit < 4 || playerLimit > 20) {
    throw new Error("人数は 4 から 20 の範囲で設定してください。");
  }

  if (daySeconds < 30 || voteSeconds < 15 || nightSeconds < 15) {
    throw new Error("時間は 昼 30 秒以上、投票 15 秒以上、夜 15 秒以上にしてください。");
  }

  const explicitRoleTotal = sumRoleCounts(roleCounts);
  if (explicitRoleTotal > playerLimit) {
    throw new Error(`役職数の合計が人数を超えています。役職合計=${explicitRoleTotal}, 人数=${playerLimit}`);
  }

  if ((roleCounts.werewolf ?? 0) <= 0) {
    throw new Error("人狼は 1 人以上必要です。例: 人狼=2");
  }

  const villagersAfterFill = (roleCounts.villager ?? 0) + (playerLimit - explicitRoleTotal);
  if (villagersAfterFill <= 0) {
    throw new Error("村人/平民は 1 人以上必要です。役職数を減らすか、村人=1 を入れてください。");
  }

  return {
    playerLimit,
    daySeconds,
    voteSeconds,
    nightSeconds,
    roleCounts,
    firstNightKill,
    tiePolicy,
    mode,
  };
}

function parseNumberSetting(input: string, keys: string[], fallback: number): number {
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    const match = input.match(new RegExp(`${escaped}\\s*[=:：]\\s*(\\d+)`, "i"));
    if (match?.[1]) {
      return Number.parseInt(match[1], 10);
    }
  }
  return fallback;
}

function parseBooleanSetting(input: string, keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const escaped = escapeRegExp(key);
    const match = input.match(new RegExp(`${escaped}\\s*[=:：]\\s*([^,、\\s]+)`, "i"));
    if (match?.[1]) {
      const value = match[1].toLowerCase();
      if (["true", "on", "yes", "y", "1", "有効", "あり", "はい"].includes(value)) {
        return true;
      }
      if (["false", "off", "no", "n", "0", "無効", "なし", "いいえ"].includes(value)) {
        return false;
      }
    }
  }
  return fallback;
}

function parseTiePolicy(input: string): TiePolicy {
  const match = input.match(/(?:同票|tie)\s*[=:：]\s*([^,、\s]+)/i);
  const value = match?.[1]?.toLowerCase() ?? "revote";
  if (["revote", "再投票"].includes(value)) {
    return "revote";
  }
  if (["random", "ランダム"].includes(value)) {
    return "random";
  }
  if (["runoff", "決選", "決選投票"].includes(value)) {
    return "runoff";
  }
  throw new Error("同票処理は revote / random / runoff のいずれかで指定してください。");
}

function parseRoomMode(input: string): RoomMode {
  const match = input.match(/(?:モード|mode)\s*[=:：]\s*([^,、\s]+)/i);
  const value = match?.[1]?.toLowerCase() ?? "text";
  if (["text", "テキスト"].includes(value)) {
    return "text";
  }
  if (["vc", "voice", "ボイス"].includes(value)) {
    return "vc";
  }
  throw new Error("モードは text または vc で指定してください。");
}

function parseRoleCounts(input: string): Partial<Record<RoleId, number>> {
  const counts: Partial<Record<RoleId, number>> = {};
  const parts = input
    .split(/[,\n、]/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const match = part.match(/^(.+?)\s*[=:：]\s*(\d+)$/);
    if (!match?.[1] || !match[2]) {
      throw new Error(`役職設定「${part}」を読み取れません。例: 人狼=2`);
    }

    const roleName = match[1].trim();
    const role = ROLE_ALIASES.get(roleName) ?? ROLE_ALIASES.get(roleName.toLowerCase());
    if (!role) {
      throw new Error(`未対応の役職です: ${roleName}`);
    }

    counts[role] = (counts[role] ?? 0) + Number.parseInt(match[2], 10);
  }

  if (Object.keys(counts).length === 0) {
    counts.werewolf = 1;
  }

  return counts;
}

async function createRoom(guild: Guild, hostMember: GuildMember, requestedName: string, settings: RoomSettings): Promise<RoomState> {
  const id = randomUUID().slice(0, 8);
  const roomName = normalizeRoomName(requestedName, id);
  const botId = client.user?.id;
  if (!botId) {
    throw new Error("Bot user is not ready.");
  }

  const category = await guild.channels.create({
    name: `${roomCategoryPrefix}-${roomName}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: botId, allow: botPermissionBits() },
    ],
    reason: "Create Jinro room category",
  });

  const hiddenOverwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botId, allow: botPermissionBits() },
  ];
  const hostVisibleOverwrites = [
    ...hiddenOverwrites,
    { id: hostMember.id, allow: activePermissionBits() },
  ];

  const mainText = await guild.channels.create({
    name: settings.mode === "text" ? "01-normal" : "01-progress",
    type: ChannelType.GuildText,
    parent: category.id,
    topic: buildChannelTopic(settings),
    permissionOverwrites: hostVisibleOverwrites,
    reason: "Create Jinro main text channel",
  });

  let talkId = mainText.id;
  let wolfId: string;
  let graveyardId: string;

  if (settings.mode === "text") {
    const wolf = await guild.channels.create({
      name: "02-wolves",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: hiddenOverwrites,
      reason: "Create Jinro wolf text channel",
    });
    const graveyard = await guild.channels.create({
      name: "03-graveyard",
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: hiddenOverwrites,
      reason: "Create Jinro graveyard text channel",
    });
    wolfId = wolf.id;
    graveyardId = graveyard.id;
  } else {
    const talk = await guild.channels.create({
      name: "01-normal-vc",
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: hostVisibleOverwrites,
      reason: "Create Jinro main voice channel",
    });
    const wolf = await guild.channels.create({
      name: "02-wolves-vc",
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: hiddenOverwrites,
      reason: "Create Jinro wolf voice channel",
    });
    const graveyard = await guild.channels.create({
      name: "03-graveyard-vc",
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: hiddenOverwrites,
      reason: "Create Jinro graveyard voice channel",
    });
    talkId = talk.id;
    wolfId = wolf.id;
    graveyardId = graveyard.id;
  }

  const hostPlayer: PlayerState = {
    id: hostMember.id,
    displayName: hostMember.displayName,
    alive: true,
    joinedAt: Date.now(),
  };

  return {
    id,
    guildId: guild.id,
    hostId: hostMember.id,
    name: roomName,
    createdAt: Date.now(),
    status: "lobby",
    phase: "lobby",
    day: 0,
    settings,
    channels: {
      categoryId: category.id,
      mainTextId: mainText.id,
      talkId,
      wolfId,
      graveyardId,
    },
    players: new Map([[hostMember.id, hostPlayer]]),
    logs: [],
  };
}

async function showJoinMenu(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const openRooms = [...rooms.values()].filter((room) => room.guildId === interaction.guildId && room.status === "lobby");
  if (openRooms.length === 0) {
    await interaction.reply({ content: "現在、参加できるルームはありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("jw:join-room")
    .setPlaceholder("参加するルームを選択")
    .addOptions(
      openRooms.slice(0, 25).map((room) => ({
        label: `${room.name} (${room.players.size}/${room.settings.playerLimit})`,
        description: `${room.settings.mode.toUpperCase()} / ${tiePolicyLabel(room.settings.tiePolicy)}`,
        value: room.id,
      })),
    );

  await interaction.reply({
    content: "参加するルームを選んでください。",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

function activeRoomCount(guildIdToCount: string): number {
  return [...rooms.values()].filter((room) => room.guildId === guildIdToCount && room.status !== "ended").length;
}

async function joinSelectedRoom(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const roomId = interaction.values[0];
  const room = roomId ? rooms.get(roomId) : undefined;
  if (!room || room.status !== "lobby") {
    await interaction.reply({ content: "このルームには参加できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (room.players.has(interaction.user.id)) {
    await interaction.reply({ content: "すでに参加しています。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (room.players.size >= room.settings.playerLimit) {
    await interaction.reply({ content: "このルームは満員です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const member = interaction.member instanceof GuildMember ? interaction.member : await interaction.guild.members.fetch(interaction.user.id);
  room.players.set(member.id, {
    id: member.id,
    displayName: member.displayName,
    alive: true,
    joinedAt: Date.now(),
  });

  await allowActivePlayer(room, interaction.guild, member.id);
  await sendMain(room, `${member} が参加しました。現在 ${room.players.size}/${room.settings.playerLimit} 人です。`);
  appendEvent(room, `${member.displayName} が参加しました。`);

  await interaction.reply({
    content: `ルーム「${room.name}」に参加しました。進行チャンネル: <#${room.channels.mainTextId}>`,
    flags: MessageFlags.Ephemeral,
  });
}

async function startRoomFromButton(interaction: ButtonInteraction, roomId: string): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.guildId !== interaction.guild.id) {
    await interaction.reply({ content: "ルームが見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== room.hostId) {
    await interaction.reply({ content: "開始できるのはルームホストだけです。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (room.status !== "lobby") {
    await interaction.reply({ content: "このルームはすでに開始済みです。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (room.players.size !== room.settings.playerLimit) {
    await interaction.reply({
      content: `人数が揃っていません。現在 ${room.players.size}/${room.settings.playerLimit} 人です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({ content: "ゲームを開始します。", flags: MessageFlags.Ephemeral });
  await startGame(room, interaction.guild);
}

async function cancelRoomFromButton(interaction: ButtonInteraction, roomId: string): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const room = rooms.get(roomId);
  if (!room || room.guildId !== interaction.guild.id) {
    await interaction.reply({ content: "ルームが見つかりません。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.user.id !== room.hostId) {
    await interaction.reply({ content: "削除できるのはルームホストだけです。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content: "ルームを削除します。", flags: MessageFlags.Ephemeral });
  appendEvent(room, "ホストがルームを削除しました。");
  await archiveAndDeleteRoom(room, interaction.guild, "cancelled");
}

async function startGame(room: RoomState, guild: Guild): Promise<void> {
  room.status = "running";
  room.phase = "night";
  room.day = 0;
  assignRoles(room);
  appendEvent(room, "ゲームを開始しました。");

  const wolvesAndMadmen = playersByRoles(room, ["werewolf", "madman"]);
  for (const player of wolvesAndMadmen) {
    await allowWolfPlayer(room, guild, player.id);
  }

  for (const player of room.players.values()) {
    await sendRoleDm(room, player);
  }

  await sendMain(
    room,
    "役職を DM で配布しました。10 秒後に初日夜を開始します。DM が届かない場合はサーバーからの DM 許可を確認してください。",
  );

  await sleep(10_000);
  void runNight(room, guild);
}

function assignRoles(room: RoomState): void {
  const deck: RoleId[] = [];
  for (const [role, count] of Object.entries(room.settings.roleCounts) as [RoleId, number][]) {
    for (let i = 0; i < count; i += 1) {
      deck.push(role);
    }
  }

  while (deck.length < room.settings.playerLimit) {
    deck.push("villager");
  }

  const shuffledDeck = shuffle(deck);
  const shuffledPlayers = shuffle([...room.players.values()]);
  for (const [index, player] of shuffledPlayers.entries()) {
    player.role = shuffledDeck[index] ?? "villager";
    player.alive = true;
  }
}

async function sendRoleDm(room: RoomState, player: PlayerState): Promise<void> {
  const role = player.role ?? "villager";
  const roleInfo = ROLE_INFO[role];
  const user = await client.users.fetch(player.id);

  const wolfNames = playersByRoles(room, ["werewolf", "madman"])
    .map((teamPlayer) => `- ${teamPlayer.displayName}: ${roleName(teamPlayer.role)}`)
    .join("\n");

  let content =
    `あなたの役職は **${roleInfo.name}** です。\n` +
    `陣営: ${teamName(roleInfo.team)}\n` +
    `${roleInfo.description}`;

  if (role === "werewolf" || role === "madman") {
    content += `\n\n人狼・狂人陣営:\n${wolfNames}`;
  }

  try {
    await user.send(content);
    appendEvent(room, `${player.displayName} に役職 DM を送信しました。`);
  } catch {
    appendEvent(room, `${player.displayName} への役職 DM に失敗しました。`);
    await sendMain(room, `<@${player.id}> への役職 DM に失敗しました。サーバーからの DM 許可を確認してください。`);
  }
}

async function runNight(room: RoomState, guild: Guild): Promise<void> {
  if (room.status !== "running") {
    return;
  }

  room.phase = "night";
  const tokenValue = randomUUID().slice(0, 8);
  const pending = new Set<string>();
  room.night = {
    token: tokenValue,
    biteVotes: new Map(),
    seerTargets: new Map(),
    guardTargets: new Map(),
    mediumChecks: new Set(),
  };

  await sendMain(room, room.day === 0 ? "初日夜です。" : `${room.day} 日目の夜です。`);
  appendEvent(room, room.day === 0 ? "初日夜を開始しました。" : `${room.day} 日目の夜を開始しました。`);

  const alive = alivePlayers(room);
  const aliveWolves = alive.filter((player) => player.role === "werewolf");
  const biteEnabled = room.day > 0 || room.settings.firstNightKill;

  if (biteEnabled && aliveWolves.length > 0) {
    const biteOptions = alive.filter((player) => player.role !== "werewolf");
    if (biteOptions.length > 0) {
      const biteRow = targetSelectRow(`jw:night:${room.id}:${tokenValue}:bite`, "襲撃先を選択", biteOptions);
      const wolfChannel = await getSendableChannel(guild, room.channels.wolfId);
      const prompt =
        "人狼は襲撃先に投票してください。投票内容は公開されません。時間切れの場合は集まった票で処理します。";
      if (wolfChannel) {
        await wolfChannel.send({ content: prompt, components: [biteRow] });
      } else {
        for (const wolf of aliveWolves) {
          await sendDmWithComponents(wolf.id, prompt, [biteRow]);
        }
      }
      for (const wolf of aliveWolves) {
        pending.add(`bite:${wolf.id}`);
      }
    }
  } else if (aliveWolves.length > 0) {
    await sendWolf(room, "初日噛みが無効のため、この夜は襲撃しません。");
  }

  for (const player of alive) {
    if (player.role === "seer") {
      const options = alive.filter((target) => target.id !== player.id);
      if (options.length > 0) {
        pending.add(`seer:${player.id}`);
        await sendDmWithComponents(
          player.id,
          "占い先を選択してください。",
          [targetSelectRow(`jw:night:${room.id}:${tokenValue}:seer`, "占い先を選択", options)],
        );
      }
      continue;
    }

    if (player.role === "bodyguard") {
      const options = alive.filter((target) => target.id !== player.id);
      if (options.length > 0) {
        pending.add(`guard:${player.id}`);
        await sendDmWithComponents(
          player.id,
          "護衛先を選択してください。",
          [targetSelectRow(`jw:night:${room.id}:${tokenValue}:guard`, "護衛先を選択", options)],
        );
      }
      continue;
    }

    if (player.role === "medium" && room.lastExecutedId) {
      pending.add(`medium:${player.id}`);
      const executed = room.players.get(room.lastExecutedId);
      await sendDmWithComponents(
        player.id,
        `霊媒結果を確認できます。直近の処刑者: ${executed?.displayName ?? "不明"}`,
        [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(`jw:night:${room.id}:${tokenValue}:medium`)
              .setPlaceholder("霊媒結果を確認")
              .addOptions({ label: "霊媒結果を見る", value: room.lastExecutedId }),
          ),
        ],
      );
      continue;
    }

    if (!["werewolf"].includes(player.role ?? "")) {
      await sendSimpleDm(player.id, "夜行動のある役職が行動中です。朝までお待ちください。");
    }
  }

  await waitForPending(room, tokenValue, pending, room.settings.nightSeconds);
  await resolveNight(room, guild);
}

async function handleNightActionSelect(
  interaction: StringSelectMenuInteraction,
  roomId: string,
  tokenValue: string,
  kind: string,
): Promise<void> {
  const room = rooms.get(roomId);
  if (!room || room.status !== "running" || room.phase !== "night" || room.night?.token !== tokenValue) {
    await interaction.reply({ content: "この夜行動は現在有効ではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const actor = room.players.get(interaction.user.id);
  if (!actor || !actor.alive) {
    await interaction.reply({ content: "生存中の参加者だけが行動できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  const targetId = interaction.values[0];
  if (!targetId) {
    await interaction.reply({ content: "対象を選択してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (kind === "bite") {
    if (actor.role !== "werewolf") {
      await interaction.reply({ content: "襲撃投票は人狼だけが行えます。", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = room.players.get(targetId);
    if (!target?.alive || target.role === "werewolf") {
      await interaction.reply({ content: "その対象は襲撃できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    room.night.biteVotes.set(actor.id, targetId);
    completePending(room, `bite:${actor.id}`);
    appendEvent(room, `${actor.displayName} が襲撃投票を行いました: ${target.displayName}`);
    await interaction.reply({ content: `${target.displayName} に襲撃投票しました。`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (kind === "seer") {
    if (actor.role !== "seer") {
      await interaction.reply({ content: "占い師だけが占えます。", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = room.players.get(targetId);
    if (!target?.alive || target.id === actor.id) {
      await interaction.reply({ content: "その対象は占えません。", flags: MessageFlags.Ephemeral });
      return;
    }
    room.night.seerTargets.set(actor.id, target.id);
    completePending(room, `seer:${actor.id}`);
    const result = target.role === "werewolf" ? "人狼です" : "人狼ではありません";
    await sendSimpleDm(actor.id, `占い結果: ${target.displayName} は ${result}。`);
    appendEvent(room, `${actor.displayName} が ${target.displayName} を占いました: ${result}`);
    await interaction.reply({ content: "占い結果を DM に送りました。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (kind === "guard") {
    if (actor.role !== "bodyguard") {
      await interaction.reply({ content: "狩人だけが護衛できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = room.players.get(targetId);
    if (!target?.alive || target.id === actor.id) {
      await interaction.reply({ content: "その対象は護衛できません。", flags: MessageFlags.Ephemeral });
      return;
    }
    room.night.guardTargets.set(actor.id, target.id);
    completePending(room, `guard:${actor.id}`);
    appendEvent(room, `${actor.displayName} が ${target.displayName} を護衛しました。`);
    await interaction.reply({ content: `${target.displayName} を護衛しました。`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (kind === "medium") {
    if (actor.role !== "medium" || targetId !== room.lastExecutedId) {
      await interaction.reply({ content: "霊媒師だけが直近の処刑者を判定できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = room.players.get(targetId);
    const result = target?.role === "werewolf" ? "人狼です" : "人狼ではありません";
    room.night.mediumChecks.add(actor.id);
    completePending(room, `medium:${actor.id}`);
    await sendSimpleDm(actor.id, `霊媒結果: ${target?.displayName ?? "不明"} は ${result}。`);
    appendEvent(room, `${actor.displayName} が ${target?.displayName ?? "不明"} を霊媒しました: ${result}`);
    await interaction.reply({ content: "霊媒結果を DM に送りました。", flags: MessageFlags.Ephemeral });
  }
}

async function resolveNight(room: RoomState, guild: Guild): Promise<void> {
  const night = room.night;
  if (!night) {
    return;
  }

  const protectedIds = new Set(night.guardTargets.values());
  const deaths = new Set<string>();
  const biteTargetId = chooseByVotes(night.biteVotes, room.settings.tiePolicy);
  const psychoAccidentDeaths = new Set<string>();

  if (biteTargetId) {
    const biteTarget = room.players.get(biteTargetId);
    if (biteTarget?.alive && !protectedIds.has(biteTargetId)) {
      deaths.add(biteTargetId);
    }
    if (biteTarget?.role === "psycho") {
      const wolfVictim = chooseRandom(
        [...night.biteVotes.entries()]
          .filter(([, targetId]) => targetId === biteTargetId)
          .map(([wolfId]) => wolfId)
          .filter((wolfId) => room.players.get(wolfId)?.alive),
      ) ?? chooseRandom(alivePlayers(room).filter((player) => player.role === "werewolf").map((player) => player.id));
      if (wolfVictim) {
        psychoAccidentDeaths.add(wolfVictim);
      }
    }
  }

  for (const [seerId, targetId] of night.seerTargets.entries()) {
    if (room.players.get(targetId)?.role === "psycho" && room.players.get(seerId)?.alive) {
      psychoAccidentDeaths.add(seerId);
    }
  }

  for (const [guardId, targetId] of night.guardTargets.entries()) {
    if (room.players.get(targetId)?.role === "psycho" && room.players.get(guardId)?.alive) {
      psychoAccidentDeaths.add(guardId);
    }
  }

  for (const deadId of psychoAccidentDeaths) {
    deaths.add(deadId);
  }

  for (const deadId of deaths) {
    await markDead(room, guild, deadId, "night");
  }

  room.night = undefined;
  room.waiting = undefined;
  room.day += 1;
  room.phase = "day";

  const bakerAlive = alivePlayers(room).some((player) => player.role === "baker");
  if (bakerAlive) {
    await sendMain(room, "朝です。パン屋から焼きたてのパンが届きました。");
  } else {
    await sendMain(room, "朝です。");
  }

  if (deaths.size === 0) {
    await sendMain(room, "昨夜の犠牲者はいませんでした。");
  } else {
    const deathLines = [...deaths].map((id) => `- ${room.players.get(id)?.displayName ?? id}`);
    await sendMain(room, `昨夜の犠牲者:\n${deathLines.join("\n")}`);
  }

  const winner = checkWinner(room);
  if (winner) {
    await finishGame(room, guild, winner);
    return;
  }

  await runDayDiscussion(room, guild);
}

async function runDayDiscussion(room: RoomState, guild: Guild): Promise<void> {
  if (room.status !== "running") {
    return;
  }

  room.phase = "day";
  await sendMain(room, `${room.day} 日目の昼議論を開始します。制限時間は ${room.settings.daySeconds} 秒です。`);
  appendEvent(room, `${room.day} 日目の昼議論を開始しました。`);

  scheduleDayReminders(room);
  await sleep(room.settings.daySeconds * 1000);

  if (room.status !== "running" || room.phase !== "day") {
    return;
  }

  await runExecutionVote(room, guild);
}

function scheduleDayReminders(room: RoomState): void {
  const reminders = [
    { remaining: 300, label: "5 分" },
    { remaining: 180, label: "3 分" },
    { remaining: 60, label: "1 分" },
    { remaining: 30, label: "30 秒" },
  ];

  for (const reminder of reminders) {
    const delaySeconds = room.settings.daySeconds - reminder.remaining;
    if (delaySeconds <= 0) {
      continue;
    }
    setTimeout(() => {
      if (room.status === "running" && room.phase === "day") {
        void sendMain(room, `昼議論終了まで残り ${reminder.label} です。`);
      }
    }, delaySeconds * 1000);
  }
}

async function runExecutionVote(room: RoomState, guild: Guild): Promise<void> {
  room.phase = "vote";
  appendEvent(room, `${room.day} 日目の処刑投票を開始しました。`);
  const aliveIds = alivePlayers(room).map((player) => player.id);
  const votes = await conductVote(room, "処刑投票", aliveIds, aliveIds, room.settings.voteSeconds);
  let executedId = resolveExecutionTarget(votes, room.settings.tiePolicy);

  if (!executedId) {
    executedId = chooseRandom(aliveIds);
  }

  const tiedIds = tiedVoteTargets(votes);
  if (tiedIds.length > 1 && room.settings.tiePolicy === "revote") {
    await sendMain(room, `同票のため再投票します。対象: ${namesForPlayers(room, tiedIds).join("、")}`);
    const revote = await conductVote(room, "再投票", aliveIds, aliveIds, room.settings.voteSeconds);
    executedId = resolveExecutionTarget(revote, "random") ?? chooseRandom(tiedVoteTargets(revote)) ?? executedId;
  }

  if (tiedIds.length > 1 && room.settings.tiePolicy === "runoff") {
    await sendMain(room, `同票のため決選投票を行います。対象: ${namesForPlayers(room, tiedIds).join("、")}`);
    const runoff = await conductVote(room, "決選投票", aliveIds, tiedIds, room.settings.voteSeconds);
    executedId = resolveExecutionTarget(runoff, "random") ?? chooseRandom(tiedIds) ?? executedId;
  }

  if (!executedId) {
    await sendMain(room, "処刑対象を決定できませんでした。この日は処刑なしで進行します。");
    appendEvent(room, "処刑なし。");
  } else {
    const executed = room.players.get(executedId);
    await markDead(room, guild, executedId, "execution");
    room.lastExecutedId = executedId;
    await sendMain(room, `${executed?.displayName ?? "不明"} が処刑されました。`);
    appendEvent(room, `${executed?.displayName ?? "不明"} が処刑されました。`);
  }

  const winner = checkWinner(room);
  if (winner) {
    await finishGame(room, guild, winner);
    return;
  }

  await runNight(room, guild);
}

async function conductVote(
  room: RoomState,
  label: string,
  voterIds: string[],
  eligibleTargetIds: string[],
  seconds: number,
): Promise<Map<string, string>> {
  const tokenValue = randomUUID().slice(0, 8);
  const pending = new Set(voterIds.map((voterId) => `vote:${voterId}`));
  room.vote = {
    token: tokenValue,
    label,
    voters: new Set(voterIds),
    eligibleTargets: new Set(eligibleTargetIds),
    votes: new Map(),
  };

  const options = eligibleTargetIds
    .map((targetId) => room.players.get(targetId))
    .filter((player): player is PlayerState => Boolean(player))
    .map((player) => ({
      label: player.displayName.slice(0, 100),
      value: player.id,
      description: "投票先",
    }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`jw:vote:${room.id}:${tokenValue}`)
    .setPlaceholder(`${label}: 投票先を選択`)
    .addOptions(options);

  await sendMain(room, `${label}を開始します。投票内容は公開されません。`, [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
  ]);

  await waitForPending(room, tokenValue, pending, seconds);
  const votes = new Map(room.vote?.votes ?? []);
  room.vote = undefined;
  room.waiting = undefined;
  appendEvent(room, `${label}を締め切りました。`);
  return votes;
}

async function handleVoteSelect(interaction: StringSelectMenuInteraction, roomId: string, tokenValue: string): Promise<void> {
  const room = rooms.get(roomId);
  if (!room || room.status !== "running" || room.phase !== "vote" || room.vote?.token !== tokenValue) {
    await interaction.reply({ content: "この投票は現在有効ではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const voter = room.players.get(interaction.user.id);
  if (!voter?.alive || !room.vote.voters.has(voter.id)) {
    await interaction.reply({ content: "この投票には参加できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const targetId = interaction.values[0];
  if (!targetId || !room.vote.eligibleTargets.has(targetId)) {
    await interaction.reply({ content: "その対象には投票できません。", flags: MessageFlags.Ephemeral });
    return;
  }

  room.vote.votes.set(voter.id, targetId);
  completePending(room, `vote:${voter.id}`);
  appendEvent(room, `${voter.displayName} が投票しました: ${room.players.get(targetId)?.displayName ?? targetId}`);
  await interaction.reply({
    content: `${room.players.get(targetId)?.displayName ?? "選択した対象"} に投票しました。`,
    flags: MessageFlags.Ephemeral,
  });
}

function resolveExecutionTarget(votes: Map<string, string>, tiePolicy: TiePolicy): string | undefined {
  if (votes.size === 0) {
    return undefined;
  }

  const counts = countVotes(votes);
  const highest = Math.max(...counts.values());
  const tied = [...counts.entries()].filter(([, count]) => count === highest).map(([targetId]) => targetId);
  if (tied.length === 1) {
    return tied[0];
  }

  if (tiePolicy === "random") {
    return chooseRandom(tied);
  }

  return undefined;
}

function tiedVoteTargets(votes: Map<string, string>): string[] {
  if (votes.size === 0) {
    return [];
  }

  const counts = countVotes(votes);
  const highest = Math.max(...counts.values());
  return [...counts.entries()].filter(([, count]) => count === highest).map(([targetId]) => targetId);
}

function chooseByVotes(votes: Map<string, string>, tiePolicy: TiePolicy): string | undefined {
  if (votes.size === 0) {
    return undefined;
  }

  const counts = countVotes(votes);
  const highest = Math.max(...counts.values());
  const tied = [...counts.entries()].filter(([, count]) => count === highest).map(([targetId]) => targetId);
  if (tied.length === 1) {
    return tied[0];
  }

  if (tiePolicy === "random" || tiePolicy === "runoff" || tiePolicy === "revote") {
    return chooseRandom(tied);
  }

  return chooseRandom(tied);
}

function countVotes(votes: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const targetId of votes.values()) {
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  return counts;
}

async function waitForPending(room: RoomState, tokenValue: string, pending: Set<string>, seconds: number): Promise<void> {
  if (pending.size === 0) {
    return;
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      room.waiting = {
        token: tokenValue,
        pending,
        resolve,
        deadlineAt: Date.now() + seconds * 1000,
      };
    }),
    sleep(seconds * 1000),
  ]);
}

function completePending(room: RoomState, key: string): void {
  if (!room.waiting?.pending.has(key)) {
    return;
  }

  room.waiting.pending.delete(key);
  if (room.waiting.pending.size === 0) {
    room.waiting.resolve();
  }
}

async function markDead(room: RoomState, guild: Guild, playerId: string, reason: "night" | "execution"): Promise<void> {
  const player = room.players.get(playerId);
  if (!player || !player.alive) {
    return;
  }

  player.alive = false;
  await setDeadPermissions(room, guild, playerId);
  await moveToGraveyardIfNeeded(room, guild, playerId);
  appendEvent(room, `${player.displayName} が死亡しました。理由: ${reason}`);
}

async function setDeadPermissions(room: RoomState, guild: Guild, playerId: string): Promise<void> {
  const allRoomChannels = unique([room.channels.mainTextId, room.channels.talkId, room.channels.wolfId, room.channels.graveyardId]);
  for (const channelId of allRoomChannels) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      continue;
    }

    if (channelId === room.channels.graveyardId) {
      await editChannelPermissions(channel, playerId, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: true,
        Connect: true,
        Speak: true,
      });
      continue;
    }

    await editChannelPermissions(channel, playerId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      Speak: false,
      Connect: channel.type === ChannelType.GuildVoice ? false : null,
    });
  }
}

async function moveToGraveyardIfNeeded(room: RoomState, guild: Guild, playerId: string): Promise<void> {
  if (room.settings.mode !== "vc") {
    return;
  }

  const member = await guild.members.fetch(playerId).catch(() => null);
  if (!member?.voice.channelId) {
    return;
  }

  if ([room.channels.talkId, room.channels.wolfId].includes(member.voice.channelId)) {
    await member.voice.setChannel(room.channels.graveyardId).catch(() => undefined);
  }
}

function checkWinner(room: RoomState): TeamId | undefined {
  const alive = alivePlayers(room);
  const wolfCount = alive.filter((player) => player.role === "werewolf").length;
  const nonWolfCount = alive.length - wolfCount;

  if (wolfCount === 0) {
    return "village";
  }

  if (wolfCount >= nonWolfCount) {
    return "werewolf";
  }

  return undefined;
}

async function finishGame(room: RoomState, guild: Guild, winner: TeamId): Promise<void> {
  room.status = "ended";
  room.phase = "ended";
  room.waiting = undefined;
  room.night = undefined;
  room.vote = undefined;
  appendEvent(room, `ゲーム終了。勝利陣営: ${teamName(winner)}`);

  await revealRoom(room, guild);
  const roleLines = [...room.players.values()]
    .map((player) => `- ${player.displayName}: ${roleName(player.role)} ${player.alive ? "(生存)" : "(死亡)"}`)
    .join("\n");

  await sendMain(room, `ゲーム終了です。勝利陣営: **${teamName(winner)}**\n\n役職一覧:\n${roleLines}`);
  await sendMain(room, "このルームは 20 分後にログ化され、チャンネルは削除されます。ログは人狼ロビーから確認できます。");

  room.cleanupTimer = setTimeout(() => {
    void archiveAndDeleteRoom(room, guild, "finished");
  }, cleanupDelayMs);
}

async function revealRoom(room: RoomState, guild: Guild): Promise<void> {
  const allChannelIds = unique([room.channels.mainTextId, room.channels.talkId, room.channels.wolfId, room.channels.graveyardId]);
  for (const player of room.players.values()) {
    for (const channelId of allChannelIds) {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (!channel) {
        continue;
      }

      const canSend = channelId === room.channels.mainTextId || (room.settings.mode === "text" && channelId === room.channels.talkId);
      await editChannelPermissions(channel, player.id, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: canSend,
        Connect: true,
        Speak: true,
      });
    }
  }
}

async function archiveAndDeleteRoom(room: RoomState, guild: Guild, reason: "finished" | "cancelled"): Promise<void> {
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = undefined;
  }

  const fileName = `${formatJstLogName(new Date())}-${room.name}-${reason}.txt`;
  const safeName = fileName.replace(/[<>:"/\\|?*]/g, "_");
  const fullPath = path.join(logDir, safeName);
  await writeFile(fullPath, renderLog(room), "utf8");

  const lobby = await findLobbyChannel(guild);
  if (lobby) {
    await lobby.send({
      content: `人狼ルーム「${room.name}」のログを保存しました: ${safeName}`,
      files: [new AttachmentBuilder(fullPath)],
    });
  }

  rooms.delete(room.id);
  for (const channelId of roomChannelIds(room)) {
    channelToRoom.delete(channelId);
  }

  const channelIds = unique([room.channels.mainTextId, room.channels.talkId, room.channels.wolfId, room.channels.graveyardId]);
  for (const channelId of channelIds) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    await deleteGuildChannel(channel, `Archive Jinro room: ${reason}`);
  }

  const category = await guild.channels.fetch(room.channels.categoryId).catch(() => null);
  await deleteGuildChannel(category, `Archive Jinro room category: ${reason}`);
}

async function showLogMenu(interaction: ButtonInteraction): Promise<void> {
  const files = (await readdir(logDir).catch(() => []))
    .filter((file) => file.endsWith(".txt"))
    .sort()
    .reverse()
    .slice(0, 25);

  if (files.length === 0) {
    await interaction.reply({ content: "保存済みログはまだありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId("jw:log-select")
    .setPlaceholder("確認するログを選択")
    .addOptions(files.map((file) => ({ label: file.slice(0, 100), value: file })));

  await interaction.reply({
    content: "ログを選択してください。",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

async function sendSelectedLog(interaction: StringSelectMenuInteraction): Promise<void> {
  const fileName = interaction.values[0];
  if (!fileName || fileName.includes("..") || /[<>:"/\\|?*]/.test(fileName)) {
    await interaction.reply({ content: "ログファイル名が不正です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const fullPath = path.join(logDir, fileName);
  await interaction.reply({
    content: `ログ: ${fileName}`,
    files: [new AttachmentBuilder(fullPath)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleMessageCreate(message: Message): Promise<void> {
  if (!message.guild || message.author.bot) {
    return;
  }

  const roomId = channelToRoom.get(message.channelId);
  if (!roomId) {
    return;
  }

  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  const attachments = message.attachments.map((attachment) => attachment.url);
  const attachmentText = attachments.length > 0 ? ` 添付: ${attachments.join(", ")}` : "";
  appendLog(room, {
    at: message.createdTimestamp,
    kind: "chat",
    channelName: "name" in message.channel && typeof message.channel.name === "string" ? message.channel.name : message.channelId,
    authorName: message.member?.displayName ?? message.author.username,
    text: `${message.content}${attachmentText}`,
  });
}

async function allowActivePlayer(room: RoomState, guild: Guild, playerId: string): Promise<void> {
  for (const channelId of unique([room.channels.mainTextId, room.channels.talkId])) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      continue;
    }
    await editChannelPermissions(channel, playerId, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      Connect: true,
      Speak: true,
    });
  }
}

async function allowWolfPlayer(room: RoomState, guild: Guild, playerId: string): Promise<void> {
  const channel = await guild.channels.fetch(room.channels.wolfId).catch(() => null);
  if (!channel) {
    return;
  }

  await editChannelPermissions(channel, playerId, {
    ViewChannel: true,
    ReadMessageHistory: true,
    SendMessages: true,
    Connect: true,
    Speak: true,
  });
}

async function sendMain(
  room: RoomState,
  content: string,
  components?: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[],
): Promise<Message | undefined> {
  const guild = client.guilds.cache.get(room.guildId) ?? (await client.guilds.fetch(room.guildId).catch(() => null));
  if (!guild) {
    return undefined;
  }

  const channel = await getSendableChannel(guild, room.channels.mainTextId);
  appendEvent(room, content, "main");
  return channel?.send({ content, components });
}

async function sendWolf(room: RoomState, content: string): Promise<Message | undefined> {
  const guild = client.guilds.cache.get(room.guildId) ?? (await client.guilds.fetch(room.guildId).catch(() => null));
  if (!guild) {
    return undefined;
  }

  const channel = await getSendableChannel(guild, room.channels.wolfId);
  appendEvent(room, content, "wolves");
  return channel?.send({ content });
}

async function getSendableChannel(guild: Guild, channelId: string): Promise<SendableGuildChannel | undefined> {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    return undefined;
  }
  return channel as SendableGuildChannel;
}

async function findLobbyChannel(guild: Guild): Promise<TextChannel | undefined> {
  const channel = guild.channels.cache.find(
    (candidate) => candidate.type === ChannelType.GuildText && candidate.name === lobbyChannelName,
  );
  return channel?.type === ChannelType.GuildText ? channel : undefined;
}

function targetSelectRow(customId: string, placeholder: string, players: PlayerState[]): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      players.slice(0, 25).map((player) => ({
        label: player.displayName.slice(0, 100),
        value: player.id,
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function sendDmWithComponents(
  userId: string,
  content: string,
  components: ActionRowBuilder<StringSelectMenuBuilder>[],
): Promise<void> {
  const user = await client.users.fetch(userId);
  await user.send({ content, components }).catch(() => undefined);
}

async function sendSimpleDm(userId: string, content: string): Promise<void> {
  const user = await client.users.fetch(userId);
  await user.send(content).catch(() => undefined);
}

function appendEvent(room: RoomState, text: string, channelName?: string): void {
  appendLog(room, {
    at: Date.now(),
    kind: "event",
    channelName,
    text,
  });
}

function appendLog(room: RoomState, entry: LogEntry): void {
  room.logs.push(entry);
}

function renderLog(room: RoomState): string {
  const header = [
    `Room: ${room.name}`,
    `Created: ${formatJstReadable(new Date(room.createdAt))}`,
    `Settings: ${settingsSummary(room.settings).replace(/\n/g, " / ")}`,
    "",
    "Players:",
    ...[...room.players.values()].map((player) => `- ${player.displayName}: ${roleName(player.role)} ${player.alive ? "(alive)" : "(dead)"}`),
    "",
    "Timeline:",
  ];

  const timeline = [...room.logs]
    .sort((a, b) => a.at - b.at)
    .map((entry) => {
      const time = formatJstReadable(new Date(entry.at));
      if (entry.kind === "chat") {
        return `[${time}] [${entry.channelName ?? "channel"}] ${entry.authorName ?? "unknown"}: ${entry.text}`;
      }
      return `[${time}] [event${entry.channelName ? `/${entry.channelName}` : ""}] ${entry.text}`;
    });

  return [...header, ...timeline, ""].join("\n");
}

function indexRoomChannels(room: RoomState): void {
  for (const channelId of roomChannelIds(room)) {
    channelToRoom.set(channelId, room.id);
  }
}

function roomChannelIds(room: RoomState): string[] {
  return unique([room.channels.categoryId, room.channels.mainTextId, room.channels.talkId, room.channels.wolfId, room.channels.graveyardId]);
}

function alivePlayers(room: RoomState): PlayerState[] {
  return [...room.players.values()].filter((player) => player.alive);
}

function playersByRoles(room: RoomState, rolesToFind: RoleId[]): PlayerState[] {
  return [...room.players.values()].filter((player) => player.role && rolesToFind.includes(player.role));
}

function namesForPlayers(room: RoomState, ids: string[]): string[] {
  return ids.map((id) => room.players.get(id)?.displayName ?? id);
}

function settingsSummary(settings: RoomSettings): string {
  const roleText = roleCountsSummary(settings.roleCounts, settings.playerLimit);
  return [
    `人数: ${settings.playerLimit}`,
    `時間: 昼 ${settings.daySeconds} 秒 / 投票 ${settings.voteSeconds} 秒 / 夜 ${settings.nightSeconds} 秒`,
    `モード: ${settings.mode}`,
    `初日噛み: ${settings.firstNightKill ? "有効" : "無効"}`,
    `同票処理: ${tiePolicyLabel(settings.tiePolicy)}`,
    `役職: ${roleText}`,
  ].join("\n");
}

function roleCountsSummary(roleCounts: Partial<Record<RoleId, number>>, playerLimit: number): string {
  const parts: string[] = [];
  const explicitTotal = sumRoleCounts(roleCounts);
  const villagerFill = Math.max(0, playerLimit - explicitTotal);

  for (const role of Object.keys(ROLE_INFO) as RoleId[]) {
    const count = (roleCounts[role] ?? 0) + (role === "villager" ? villagerFill : 0);
    if (count > 0) {
      parts.push(`${ROLE_INFO[role].name}=${count}`);
    }
  }

  return parts.join(", ");
}

function buildChannelTopic(settings: RoomSettings): string {
  return settingsSummary(settings).slice(0, 1024);
}

function sumRoleCounts(roleCounts: Partial<Record<RoleId, number>>): number {
  return Object.values(roleCounts).reduce((sum, count) => sum + (count ?? 0), 0);
}

function roleName(role?: RoleId): string {
  return role ? ROLE_INFO[role].name : "未割当";
}

function teamName(team: TeamId): string {
  return team === "village" ? "村人陣営" : "人狼陣営";
}

function tiePolicyLabel(policy: TiePolicy): string {
  if (policy === "random") {
    return "同票者からランダム";
  }
  if (policy === "runoff") {
    return "決選投票";
  }
  return "再投票";
}

function activePermissionBits(): bigint[] {
  return [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
  ];
}

function botPermissionBits(): bigint[] {
  return [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.Connect,
    PermissionFlagsBits.Speak,
    PermissionFlagsBits.MoveMembers,
  ];
}

async function editChannelPermissions(
  channel: GuildBasedChannel | null,
  targetId: string,
  permissions: Record<string, boolean | null>,
): Promise<void> {
  if (!channel || !("permissionOverwrites" in channel)) {
    return;
  }

  await channel.permissionOverwrites.edit(targetId, permissions);
}

async function deleteGuildChannel(channel: GuildBasedChannel | null, reason: string): Promise<void> {
  if (!channel) {
    return;
  }

  await channel.delete(reason).catch(() => undefined);
}

function normalizeRoomName(input: string, fallbackId: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[<>:"/\\|?*#]/g, "")
    .slice(0, 32);

  return normalized || `room-${fallbackId}`;
}

function formatJstLogName(date: Date): string {
  const parts = jstParts(date);
  return `${parts.year.slice(-2)}${parts.month}${parts.day}${parts.hour}${parts.minute}`;
}

function formatJstReadable(date: Date): string {
  const parts = jstParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
}

function jstParts(date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[target]] = [copy[target] as T, copy[index] as T];
  }
  return copy;
}

function chooseRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  return items[Math.floor(Math.random() * items.length)];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is required. Copy .env.example to .env first.`);
  }
  return value;
}

function readPositiveIntEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function safeInteractionReply(interaction: Interaction, content: string): Promise<void> {
  if (!interaction.isRepliable()) {
    return;
  }

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined);
}
