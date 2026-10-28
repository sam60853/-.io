const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();
const CARD = { EMPEROR: "EMPEROR", CITIZEN: "CITIZEN", SLAVE: "SLAVE" };

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalizeName(name, fallback = "玩家") {
  return String(name || fallback).trim() || fallback;
}

function makePlayer(id, name, fallback = "玩家") {
  return {
    id,
    name: normalizeName(name, fallback),
    role: "",
    score: 0,
    hand: [],
    played: null,
    connected: true
  };
}

function createCitizenDeck() {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `citizen-${String(index + 1).padStart(2, "0")}`,
    type: CARD.CITIZEN
  }));
}

function createHand(role) {
  const citizens = shuffle(createCitizenDeck());
  const special = role === CARD.EMPEROR
    ? { id: "emperor-01", type: CARD.EMPEROR }
    : { id: "slave-01", type: CARD.SLAVE };
  return shuffle([special, ...citizens.slice(0, 4)]);
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function resolveRound(playerType, opponentType) {
  if (playerType === opponentType) return "DRAW";
  const beats = {
    [CARD.EMPEROR]: CARD.CITIZEN,
    [CARD.CITIZEN]: CARD.SLAVE,
    [CARD.SLAVE]: CARD.EMPEROR
  };
  if (beats[playerType] === opponentType) return "PLAYER_1";
  if (beats[opponentType] === playerType) return "PLAYER_2";
  return "DRAW";
}

function getRoomState(room, socketId) {
  const myIndex = room.players.findIndex((player) => player.id === socketId);
  const bothPlayed = room.players.every((player) => player.played !== null);

  const players = room.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    role: player.role,
    score: player.score,
    hand: player.id === socketId ? player.hand : [],
    handCount: player.hand.length,
    played: bothPlayed || player.id === socketId ? player.played : null,
    isTurn: room.turnIndex === index,
    connected: player.connected,
    isOwner: room.ownerId === player.id
  }));

  return {
    id: room.id,
    phase: room.phase,
    round: room.round,
    roundLimit: room.roundLimit,
    players,
    myPlayerIndex: myIndex,
    turnIndex: room.turnIndex,
    history: room.history.slice(0, 10),
    winner: room.winner || null,
    status: room.status,
    ownerId: room.ownerId,
    isOwner: room.ownerId === socketId
  };
}

function broadcastRoom(room) {
  room.players.forEach((player) => {
    io.to(player.id).emit("room:state", getRoomState(room, player.id));
  });
}

function initializeRoomGame(room) {
  const roles = shuffle([CARD.EMPEROR, CARD.SLAVE]);
  room.phase = "playing";
  room.round = 1;
  room.roundLimit = 5;
  room.turnIndex = 0;
  room.winner = null;
  room.history = [];
  room.status = "遊戲開始";

  room.players.forEach((player, index) => {
    player.role = roles[index] || CARD.EMPEROR;
    player.hand = createHand(player.role);
    player.score = 0;
    player.played = null;
  });
}

function resetRoomForLobby(room) {
  room.phase = "lobby";
  room.round = 1;
  room.roundLimit = 5;
  room.turnIndex = 0;
  room.history = [];
  room.winner = null;
  room.status = "等待玩家加入";

  room.players.forEach((player) => {
    player.role = "";
    player.score = 0;
    player.hand = [];
    player.played = null;
  });
}

function endRound(room) {
  const [p1, p2] = room.players;
  const cardA = p1.played;
  const cardB = p2.played;
  if (!cardA || !cardB) return;

  const result = resolveRound(cardA.type, cardB.type);
  if (result === "PLAYER_1") p1.score += 1;
  if (result === "PLAYER_2") p2.score += 1;

  room.history.unshift({
    round: room.round,
    p1Name: p1.name,
    p2Name: p2.name,
    p1Card: cardA.type,
    p2Card: cardB.type,
    winner: result
  });

  p1.hand = p1.hand.filter((card) => card.id !== cardA.id);
  p2.hand = p2.hand.filter((card) => card.id !== cardB.id);
  p1.played = null;
  p2.played = null;

  room.round += 1;
  room.turnIndex = 0;

  if (room.round > room.roundLimit) {
    room.phase = "finished";
    room.status = "遊戲結束";
    const scoreA = p1.score;
    const scoreB = p2.score;
    room.winner = scoreA === scoreB ? "DRAW" : (scoreA > scoreB ? p1.name : p2.name);
    broadcastRoom(room);
    return;
  }

  room.status = `第 ${room.round} 回合`;
  broadcastRoom(room);
}

app.use(express.static(__dirname));
app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

io.on("connection", (socket) => {
  socket.on("room:create", ({ name } = {}) => {
    let roomId = randomRoomId();
    while (rooms.has(roomId)) {
      roomId = randomRoomId();
    }

    const room = {
      id: roomId,
      ownerId: socket.id,
      players: [makePlayer(socket.id, name, "玩家 1")],
      phase: "lobby",
      round: 1,
      roundLimit: 5,
      turnIndex: 0,
      status: "等待玩家加入",
      winner: null,
      history: []
    };

    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit("room:joined", {
      roomId,
      isOwner: true,
      state: getRoomState(room, socket.id)
    });

    broadcastRoom(room);
  });

  socket.on("room:join", ({ roomId, name } = {}) => {
    const normalizedId = (roomId || "").trim().toUpperCase();
    const room = rooms.get(normalizedId);
    if (!room) {
      socket.emit("room:error", "找不到這個房間，請確認房間碼是否正確。");
      return;
    }

    if (room.players.length >= 2) {
      socket.emit("room:error", "這個房間已滿，請選擇其他房間。");
      return;
    }

    if (room.phase !== "lobby") {
      socket.emit("room:error", "這個房間已經開始遊戲，請稍後再試。");
      return;
    }

    const joinPlayer = makePlayer(socket.id, name, "玩家 2");
    room.players.push(joinPlayer);
    socket.join(normalizedId);
    socket.data.roomId = normalizedId;

    socket.emit("room:joined", {
      roomId: normalizedId,
      isOwner: false,
      state: getRoomState(room, socket.id)
    });

    io.to(normalizedId).emit("room:player-joined", { name: joinPlayer.name });
    broadcastRoom(room);
  });

  socket.on("room:start", ({ roomId } = {}) => {
    const targetRoomId = (roomId || socket.data.roomId || "").trim().toUpperCase();
    const room = rooms.get(targetRoomId);
    if (!room) return;

    if (room.ownerId !== socket.id) {
      socket.emit("room:error", "只有房主才能開始遊戲。");
      return;
    }

    if (room.players.length < 2) {
      socket.emit("room:error", "至少需要兩位玩家才能開始遊戲。");
      return;
    }

    initializeRoomGame(room);
    broadcastRoom(room);
  });

  socket.on("room:leave", ({ roomId } = {}) => {
    const targetRoomId = (roomId || socket.data.roomId || "").trim().toUpperCase();
    const room = rooms.get(targetRoomId);
    if (!room) return;

    const leavingIndex = room.players.findIndex((player) => player.id === socket.id);
    if (leavingIndex >= 0) room.players.splice(leavingIndex, 1);

    if (room.players.length === 0) {
      rooms.delete(targetRoomId);
      socket.data.roomId = null;
      return;
    }

    if (room.ownerId === socket.id) {
      room.ownerId = room.players[0].id;
    }

    resetRoomForLobby(room);
    socket.leave(targetRoomId);
    socket.data.roomId = null;
    broadcastRoom(room);
  });

  socket.on("game:playCard", ({ roomId, cardId } = {}) => {
    const targetRoomId = (roomId || socket.data.roomId || "").trim().toUpperCase();
    const room = rooms.get(targetRoomId);
    if (!room) return;

    const playerIndex = room.players.findIndex((player) => player.id === socket.id);
    if (playerIndex === -1 || room.phase !== "playing") return;

    if (room.turnIndex !== playerIndex) {
      socket.emit("room:error", "現在不是你的回合。");
      return;
    }

    const player = room.players[playerIndex];
    const card = player.hand.find((item) => item.id === cardId);
    if (!card) {
      socket.emit("room:error", "這張牌不在你的手牌中。");
      return;
    }

    player.played = card;
    room.turnIndex = 1 - playerIndex;

    if (room.players.every((entry) => entry.played !== null)) {
      endRound(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on("disconnect", () => {
    for (const [roomId, room] of rooms.entries()) {
      const index = room.players.findIndex((player) => player.id === socket.id);
      if (index === -1) continue;

      room.players.splice(index, 1);

      if (room.players.length === 0) {
        rooms.delete(roomId);
        continue;
      }

      if (room.ownerId === socket.id) {
        room.ownerId = room.players[0].id;
      }

      if (room.phase === "playing") {
        room.phase = "lobby";
        room.status = "對手離線，等待新玩家加入";
      } else {
        resetRoomForLobby(room);
      }

      room.turnIndex = 0;
      room.history = [];
      room.winner = null;
      broadcastRoom(room);
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`皇帝牌多人模式伺服器已啟動，網址：http://localhost:${port}`);
});

module.exports = { app, server, io, rooms };
