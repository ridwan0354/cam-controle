/**
 * ============================================================
 * Mobile Camera to OBS — Signaling Server (Multi-Camera)
 * ============================================================
 * Mendukung banyak kamera dalam 1 Room.
 * Setiap kamera (camId) punya koneksi WebRTC P2P sendiri.
 * ============================================================
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/dashboard.html'));

// ============================================================
// API: Kembalikan IP LAN & Port ke Dashboard
// ============================================================
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const PORT = process.env.PORT || 3000;

app.get('/api/info', (req, res) => res.json({ localIP: LOCAL_IP, port: PORT }));

// ============================================================
// Manajemen Room Multi-Kamera
// ============================================================
// Struktur:
// rooms[roomId] = {
//   dashboard: socketId | null,
//   cameras: {
//     [camId]: { name, sender: socketId|null, receiver: socketId|null }
//   }
// }
const rooms = {};

function broadcastStatus(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const cameras = {};
  for (const [camId, cam] of Object.entries(room.cameras)) {
    cameras[camId] = { 
      name: cam.name, 
      sender: !!cam.sender, 
      receiver: !!cam.receiver,
      orientation: cam.orientation || 'landscape'
    };
  }

  io.to(roomId).emit('room-status', { roomId, hasDashboard: !!room.dashboard, cameras });
}

io.on('connection', (socket) => {
  console.log(`[+] Socket: ${socket.id}`);

  // ---- Bergabung ke Room ----
  // role: 'dashboard' | 'sender' | 'receiver'
  // camId: diperlukan untuk sender & receiver
  // camName: nama kamera (hanya dari sender)
  socket.on('join-room', ({ roomId, role, camId, camName }) => {
    socket.join(roomId);
    socket.data = { roomId, role, camId };

    if (!rooms[roomId]) rooms[roomId] = { dashboard: null, cameras: {} };
    const room = rooms[roomId];

    if (role === 'dashboard') {
      room.dashboard = socket.id;
      console.log(`[${roomId}] Dashboard bergabung`);

    } else if (role === 'sender') {
      if (!room.cameras[camId]) {
        room.cameras[camId] = { name: camName || camId, sender: null, receiver: null, orientation: 'landscape' };
      }
      room.cameras[camId].sender = socket.id;
      if (camName) room.cameras[camId].name = camName;
      console.log(`[${roomId}][${camId}] Sender "${camName}" bergabung`);

      // Jika Receiver sudah menunggu, perintahkan Sender buat Offer
      if (room.cameras[camId].receiver) {
        io.to(socket.id).emit('start-streaming', { camId });
        console.log(`[${roomId}][${camId}] Sender & Receiver siap → mulai streaming`);
      }

    } else if (role === 'receiver') {
      if (!room.cameras[camId]) {
        room.cameras[camId] = { name: camId, sender: null, receiver: null, orientation: 'landscape' };
      }
      room.cameras[camId].receiver = socket.id;
      console.log(`[${roomId}][${camId}] Receiver bergabung`);

      // Jika Sender sudah ada, perintahkan Sender buat Offer
      if (room.cameras[camId].sender) {
        io.to(room.cameras[camId].sender).emit('start-streaming', { camId });
        console.log(`[${roomId}][${camId}] Sender & Receiver siap → mulai streaming`);
      }
    }

    broadcastStatus(roomId);
  });

  // ============================================================
  // WebRTC Signaling — Per CamId
  // ============================================================
  socket.on('webrtc-offer', ({ roomId, camId, offer }) => {
    const receiver = rooms[roomId]?.cameras[camId]?.receiver;
    if (receiver) io.to(receiver).emit('webrtc-offer', { camId, offer });
  });

  socket.on('webrtc-answer', ({ roomId, camId, answer }) => {
    const sender = rooms[roomId]?.cameras[camId]?.sender;
    if (sender) io.to(sender).emit('webrtc-answer', { camId, answer });
  });

  socket.on('webrtc-ice-candidate', ({ roomId, camId, candidate, targetRole }) => {
    const target = rooms[roomId]?.cameras[camId]?.[targetRole];
    if (target) io.to(target).emit('webrtc-ice-candidate', { camId, candidate });
  });

  // ============================================================
  // Remote Control — dari Dashboard ke HP tertentu (camId)
  // ============================================================
  socket.on('remote-command', ({ roomId, camId, command, value }) => {
    // Simpan perubahan orientasi ke state server
    if (command === 'change-orientation' && rooms[roomId]?.cameras[camId]) {
      rooms[roomId].cameras[camId].orientation = value;
      broadcastStatus(roomId);
    }

    const sender = rooms[roomId]?.cameras[camId]?.sender;
    if (sender) io.to(sender).emit('remote-command', { command, value });
    console.log(`[${roomId}][${camId}] Remote: ${command}${value ? ' → ' + value : ''}`);
  });

  // ============================================================
  // Disconnect
  // ============================================================
  socket.on('disconnect', () => {
    const { roomId, role, camId } = socket.data || {};
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];

    if (role === 'dashboard') {
      room.dashboard = null;
    } else if (role === 'sender' && camId && room.cameras[camId]) {
      room.cameras[camId].sender = null;
      const receiver = room.cameras[camId].receiver;
      if (receiver) io.to(receiver).emit('sender-disconnected', { camId });
    } else if (role === 'receiver' && camId && room.cameras[camId]) {
      room.cameras[camId].receiver = null;
    }

    broadcastStatus(roomId);
    console.log(`[-] ${role}${camId ? ' [' + camId + ']' : ''} keluar dari room ${roomId}`);
  });
});

// ============================================================
// Mulai Server
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n============================================================');
  console.log('  📡 Mobile Camera to OBS — Multi-Camera Server AKTIF!');
  console.log('============================================================');
  console.log(`  🖥️  Dashboard (Lokal)   : http://localhost:${PORT}/dashboard.html`);
  console.log(`  🌐 Dashboard (Jaringan) : http://${LOCAL_IP}:${PORT}/dashboard.html`);
  console.log('============================================================\n');
});
