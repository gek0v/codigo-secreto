const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const palabras = require('./palabras.json');

const dotenv = require('dotenv');
dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Servir archivos estáticos
app.use(express.static('public'));

// Almacén de partidas en memoria (en producción usar Redis o DB)
const games = new Map();

// Generar código de partida aleatorio
function generateGameCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function generateWordList() {
  const shuffled = [...palabras.palabras].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 25);
}

// Crear tablero 5x5 con palabras aleatorias
function createBoard(wordList) {
  const shuffled = [...wordList].sort(() => Math.random() - 0.5);
  const selectedWords = shuffled.slice(0, 25);
  
  // Asignar colores: 9 rojas, 8 azules, 7 neutrales, 1 asesino
  const colors = [
    ...Array(9).fill('red'),
    ...Array(8).fill('blue'), 
    ...Array(7).fill('neutral'),
    ...Array(1).fill('assassin')
  ].sort(() => Math.random() - 0.5);

  return selectedWords.map((word, index) => ({
    word,
    color: colors[index],
    revealed: false,
    position: index
  }));
}

// Estructura de una partida
function createGame(gameCode) {
  return {
    code: gameCode,
    board: createBoard(generateWordList()),
    players: new Map(),
    currentTeam: 'red', // 'red' o 'blue'
    gameState: 'waiting', // 'waiting', 'playing', 'finished'
    winner: null,
    createdAt: new Date()
  };
}

io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);

  // Crear nueva partida
  socket.on('create-game', (data) => {
    const gameCode = generateGameCode();
    const game = createGame(gameCode);
    games.set(gameCode, game);
    
    socket.join(gameCode);
    socket.emit('game-created', { 
      gameCode,
      success: true 
    });
    
    console.log(`Partida creada: ${gameCode}`);
  });

  // Unirse a partida existente
  socket.on('join-game', (data) => {
    const { gameCode, playerName, role } = data;
    const game = games.get(gameCode);
    
    if (!game) {
      socket.emit('join-error', { message: 'Partida no encontrada' });
      return;
    }

    socket.join(gameCode);
    
    // Agregar jugador a la partida
    game.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      role: role // 'spymaster' o 'player'
    });

    // Enviar datos según el rol
    if (role === 'spymaster') {
      socket.emit('game-joined', {
        gameCode,
        role,
        board: game.board, // Jefe espía ve todos los colores
        gameState: game.gameState,
        currentTeam: game.currentTeam
      });
    } else {
      socket.emit('game-joined', {
        gameCode,
        role,
        board: game.board.map(cell => ({
          ...cell,
          color: cell.revealed ? cell.color : 'hidden'
        })), // Jugadores solo ven cartas reveladas
        gameState: game.gameState,
        currentTeam: game.currentTeam
      });
    }

    // Notificar a otros jugadores
    socket.to(gameCode).emit('player-joined', {
      playerName,
      role,
      totalPlayers: game.players.size
    });

    console.log(`${playerName} (${role}) se unió a la partida ${gameCode}`);
  });

  // Iniciar partida
  socket.on('start-game', (data) => {
    const game = games.get(data.gameCode);
    if (!game) return;

    game.gameState = 'playing';
    io.to(data.gameCode).emit('game-started', {
      currentTeam: game.currentTeam
    });
  });

  // Terminar turno
  socket.on('end-turn', (data) => {
    const game = games.get(data.gameCode);
    if (!game || game.gameState !== 'playing') return;
    
    game.currentTeam = game.currentTeam === 'red' ? 'blue' : 'red';
    io.to(data.gameCode).emit('end-turn', {
      currentTeam: game.currentTeam
    });
  });

  // Seleccionar carta
  socket.on('select-card', (data) => {
    const { gameCode, cardIndex } = data;
    const game = games.get(gameCode);
    
    if (!game || game.gameState !== 'playing') return;
    
    const card = game.board[cardIndex];
    if (card.revealed) return; // Ya fue revelada

    // Revelar carta
    card.revealed = true;
    
    let switchTeam = true;
    let gameEnded = false;

    // Lógica del juego
    if (card.color === 'assassin') {
      // Carta asesino - el equipo actual pierde
      game.gameState = 'finished';
      game.winner = game.currentTeam === 'red' ? 'blue' : 'red';
      gameEnded = true;
    } else if (card.color === game.currentTeam) {
      // Carta del equipo actual - no cambia turno
      switchTeam = false;
      
      // Verificar si el equipo ganó
      const teamCards = game.board.filter(c => c.color === game.currentTeam);
      const revealedTeamCards = teamCards.filter(c => c.revealed);
      
      if (teamCards.length === revealedTeamCards.length) {
        game.gameState = 'finished';
        game.winner = game.currentTeam;
        gameEnded = true;
      }
    }
    
    // Cambiar turno si es necesario
    if (switchTeam && !gameEnded) {
      game.currentTeam = game.currentTeam === 'red' ? 'blue' : 'red';
    }

    // Enviar actualización a todos los jugadores
    game.players.forEach((player, socketId) => {
      const playerSocket = io.sockets.sockets.get(socketId);
      if (!playerSocket) return;

      if (player.role === 'spymaster') {
        playerSocket.emit('game-updated', {
          board: game.board,
          currentTeam: game.currentTeam,
          gameState: game.gameState,
          winner: game.winner
        });
      } else {
        playerSocket.emit('game-updated', {
          board: game.board.map(cell => ({
            ...cell,
            color: cell.revealed ? cell.color : 'hidden'
          })),
          currentTeam: game.currentTeam,
          gameState: game.gameState,
          winner: game.winner
        });
      }
    });

    console.log(`Carta seleccionada en ${gameCode}: ${card.word} (${card.color})`);
  });

  // Desconexión
  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
    
    // Eliminar jugador de todas las partidas
    games.forEach((game, gameCode) => {
      if (game.players.has(socket.id)) {
        const player = game.players.get(socket.id);
        game.players.delete(socket.id);
        
        socket.to(gameCode).emit('player-left', {
          playerName: player.name,
          totalPlayers: game.players.size
        });

        // Eliminar partida si no quedan jugadores
        if (game.players.size === 0) {
          games.delete(gameCode);
          console.log(`Partida ${gameCode} eliminada - sin jugadores`);
        }
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor ejecutándose en puerto ${PORT}`);
});

// Limpiar partidas antiguas cada hora
setInterval(() => {
  const now = new Date();
  games.forEach((game, gameCode) => {
    const hoursSinceCreated = (now - game.createdAt) / (1000 * 60 * 60);
    if (hoursSinceCreated > 2) { // Eliminar partidas de más de 2 horas
      games.delete(gameCode);
      console.log(`Partida ${gameCode} eliminada - expirada`);
    }
  });
}, 60 * 60 * 1000); // Cada hora