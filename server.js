const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const rooms = new Map();
const CARD = { EMPEROR: "EMPEROR", CITIZEN: "CITIZEN", SLAVE: "SLAVE" };

function shuffle(array){
  const copy = [...array];
  for(let i = copy.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createCitizenDeck(){
  return Array.from({ length: 8 }, (_, i) => ({ id: `citizen-${String(i + 1).padStart(2, "0")}`, type: CARD.CITIZEN }));
}

function createHand(role){
  const citizens = shuffle(createCitizenDeck());
  const special = role === "EMPEROR"
    ? { id: "emperor-01", type: CARD.EMPEROR }
    : { id: "slave-01", type: CARD.SLAVE };
  return shuffle([special, ...citizens.slice(0, 4)]);
}

function randomRoomId(){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for(let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function resolveRound(playerType, opponentType){
  if(playerType === opponentType) return "DRAW";
  const beats = { [CARD.EMPEROR]: CARD.CITIZEN, [CARD.CITIZEN]: CARD.SLAVE, [CARD.SLAVE]: CARD.EMPEROR };
  if(beats[playerType] === opponentType) return "PLAYER_1";
  if(beats[opponentType] === playerType) return "PLAYER_2";
  return "DRAW";
}

function getRoomState(room, socketId){
  const myIndex = room.players.findIndex(player => player.id === socketId);
  const players = room.players.map((player, index) => ({
    id: player.id,
    name: player.name,
    role: player.role,
    score: player.score,
    hand: player.id === socketId ? player.hand : [],
    handCount: player.hand.length,
    played: player.played,
    isTurn: room.turnIndex === index,
    connected: true
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
    status: room.status
  };
}

function broadcastRoom(room){
  room.players.forEach(player => {
    io.to(player.id).emit("room:state", getRoomState(room, player.id));
  });
}

function initializeRoomGame(room){
  const roles = shuffle(["EMPEROR", "SLAVE"]);
  room.phase = "playing";
  room.round = 1;
  room.roundLimit = 5;
  room.turnIndex = 0;
  room.winner = null;
  room.history = [];
  room.status = "已開始";

  room.players.forEach((player, index) => {
    player.role = roles[index];
    player.hand = createHand(player.role);
    player.score = 0;
    player.played = null;
  });
}

function endRound(room){
  const [p1, p2] = room.players;
  const cardA = p1.played;
  const cardB = p2.played;
  if(!cardA || !cardB) return;

  const result = resolveRound(cardA.type, cardB.type);
  if(result === "PLAYER_1"){ p1.score += 1; }
  if(result === "PLAYER_2"){ p2.score += 1; }

  room.history.unshift({
    round: room.round,
    p1Name: p1.name,
    p2Name: p2.name,
    p1Card: cardA.type,
    p2Card: cardB.type,
    winner: result
  });

  p1.hand = p1.hand.filter(card => card.id !== cardA.id);
  p2.hand = p2.hand.filter(card => card.id !== cardB.id);
  p1.played = null;
  p2.played = null;

  room.round += 1;
  room.turnIndex = 0;

  if(room.round > room.roundLimit){
    room.phase = "finished";
    room.status = "已結束";
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

io.on("connection", socket => {
  socket.on("room:create", ({ name } = {}) => {
    let roomId = randomRoomId();
    while(rooms.has(roomId)) roomId = randomRoomId();

    const room = {
      id: roomId,
      players: [{ id: socket.id, name: (name || "玩家 1").trim() || "玩家 1", role: "", score: 0, hand: [], played: null }],
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
    socket.emit("room:joined", { roomId, isOwner: true });
    broadcastRoom(room);
  });

  socket.on("room:join", ({ roomId, name } = {}) => {
    const normalizedId = (roomId || "").trim().toUpperCase();
    const room = rooms.get(normalizedId);
    if(!room){
      socket.emit("room:error", "找不到這個房間，請確認代碼是否正確。");
      return;
    }

    if(room.players.length >= 2){
      socket.emit("room:error", "這個房間已滿，請選擇其他房間。 ");
      return;
    }

    room.players.push({
      id: socket.id,
      name: (name || "玩家 2").trim() || "玩家 2",
      role: "",
      score: 0,
      hand: [],
      played: null
    });

    socket.join(normalizedId);
    socket.data.roomId = normalizedId;
    io.to(normalizedId).emit("room:player-joined", { name: (name || "玩家 2").trim() || "玩家 2" });
    initializeRoomGame(room);
    broadcastRoom(room);
  });

  socket.on("room:leave", ({ roomId } = {}) => {
    const targetRoomId = (roomId || socket.data.roomId || "").trim().toUpperCase();
    const room = rooms.get(targetRoomId);
    if(!room) return;

    const leavingPlayerIndex = room.players.findIndex(player => player.id === socket.id);
    if(leavingPlayerIndex >= 0) room.players.splice(leavingPlayerIndex, 1);

    if(room.players.length === 0){
      rooms.delete(targetRoomId);
      return;
    }

    room.phase = "lobby";
    room.status = "等待玩家加入";
    room.round = 1;
    room.turnIndex = 0;
    room.history = [];
    room.winner = null;
    broadcastRoom(room);
  });

  socket.on("game:playCard", ({ roomId, cardId } = {}) => {
    const targetRoomId = (roomId || socket.data.roomId || "").trim().toUpperCase();
    const room = rooms.get(targetRoomId);
    if(!room) return;

    const playerIndex = room.players.findIndex(player => player.id === socket.id);
    if(playerIndex === -1 || room.phase !== "playing") return;
    if(room.turnIndex !== playerIndex) {
      socket.emit("room:error", "現在不是你的回合。");
      return;
    }

    const player = room.players[playerIndex];
    const card = player.hand.find(item => item.id === cardId);
    if(!card) {
      socket.emit("room:error", "這張牌不在你的手牌中。");
      return;
    }

    player.played = card;
    room.turnIndex = 1 - playerIndex;

    if(room.players.every(p => p.played)) {
      endRound(room);
    } else {
      broadcastRoom(room);
    }
  });

  socket.on("disconnect", () => {
    for(const [roomId, room] of rooms.entries()){
      const index = room.players.findIndex(player => player.id === socket.id);
      if(index === -1) continue;
      room.players.splice(index, 1);
      if(room.players.length === 0){
        rooms.delete(roomId);
      } else {
        room.phase = "lobby";
        room.status = "等待玩家加入";
        room.round = 1;
        room.turnIndex = 0;
        room.history = [];
        room.winner = null;
        broadcastRoom(room);
      }
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`E-CARD multiplayer server running on http://localhost:${port}`);
});

module.exports = { app, server, io, rooms };
