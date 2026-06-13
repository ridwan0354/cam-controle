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
const NodeMediaServer = require('node-media-server');

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

app.get('/api/info', (req, res) => res.json({ 
  localIP: LOCAL_IP, 
  port: PORT,
  rtmpPort: 1935,
  flvPort: 8000
}));

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
      orientation: cam.orientation || 'landscape',
      type: cam.type || 'webrtc'
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
  socket.on('join-room', ({ roomId, role, camId, camName, cameras, orientation }) => {
    socket.join(roomId);
    socket.data = { roomId, role, camId };

    // Validasi Room: Hanya dashboard yang bisa membuat room baru
    if (!rooms[roomId]) {
      if (role === 'dashboard') {
        rooms[roomId] = { dashboard: null, cameras: {} };
      } else {
        socket.emit('room-not-found', { roomId });
        console.log(`[!] Percobaan gabung ke Room tidak terdaftar: ${roomId} oleh ${role}`);
        return;
      }
    }
    const room = rooms[roomId];

    if (role === 'dashboard') {
      room.dashboard = socket.id;
      console.log(`[${roomId}] Dashboard bergabung`);

      // Daftarkan ulang kamera yang dibawa oleh dashboard (misal hasil load localStorage)
      if (cameras && Array.isArray(cameras)) {
        cameras.forEach(item => {
          if (typeof item === 'object' && item !== null && item.id) {
            const id = item.id;
            if (!room.cameras[id]) {
              room.cameras[id] = { name: item.name || id, sender: null, receiver: null, orientation: item.orientation || 'landscape', type: item.type || 'webrtc' };
            } else {
              if (item.name) room.cameras[id].name = item.name;
              if (item.orientation) room.cameras[id].orientation = item.orientation;
              if (item.type) room.cameras[id].type = item.type;
            }
          } else if (typeof item === 'string') {
            const id = item;
            if (!room.cameras[id]) {
              room.cameras[id] = { name: id, sender: null, receiver: null, orientation: 'landscape', type: 'webrtc' };
            }
          }
        });
      }

    } else if (role === 'sender') {
      // Validasi Kamera: Kamera harus sudah terdaftar di dashboard terlebih dahulu
      if (!room.cameras[camId]) {
        socket.emit('camera-not-found', { camId });
        console.log(`[!] Sender mencoba gabung ke kamera tidak terdaftar: ${camId} di Room ${roomId}`);
        return;
      }

      room.cameras[camId].sender = socket.id;
      if (camName) room.cameras[camId].name = camName;
      if (orientation) room.cameras[camId].orientation = orientation;
      console.log(`[${roomId}][${camId}] Sender "${camName}" bergabung dengan orientasi: ${orientation || 'landscape'}`);

      // Jika Receiver sudah menunggu, perintahkan Sender buat Offer
      if (room.cameras[camId].receiver) {
        io.to(socket.id).emit('start-streaming', { camId });
        console.log(`[${roomId}][${camId}] Sender & Receiver siap → mulai streaming`);
      }

    } else if (role === 'receiver') {
      // Validasi Kamera: Kamera harus sudah terdaftar di dashboard terlebih dahulu
      if (!room.cameras[camId]) {
        socket.emit('camera-not-found', { camId });
        console.log(`[!] Receiver mencoba gabung ke kamera tidak terdaftar: ${camId} di Room ${roomId}`);
        return;
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
  // Add Camera — Daftarkan kamera baru dari dashboard ke server
  // ============================================================
  socket.on('add-camera', ({ roomId, camId, name, type }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.cameras[camId]) {
      room.cameras[camId] = { 
        name: name || camId, 
        sender: null, 
        receiver: null, 
        orientation: 'landscape',
        type: type || 'webrtc'
      };
    }
    broadcastStatus(roomId);
    console.log(`[+] [${roomId}][${camId}] Kamera baru didaftarkan oleh dashboard`);
  });

  // ============================================================
  // Delete Camera — Hapus kamera dari server dan beritahu klien
  // ============================================================
  socket.on('delete-camera', ({ roomId, camId }) => {
    const room = rooms[roomId];
    if (!room || !room.cameras[camId]) return;

    const { sender, receiver } = room.cameras[camId];

    if (sender) io.to(sender).emit('camera-deleted', { camId });
    if (receiver) io.to(receiver).emit('camera-deleted', { camId });

    delete room.cameras[camId];
    broadcastStatus(roomId);
    console.log(`[-] [${roomId}][${camId}] Kamera dihapus oleh dashboard`);
  });

  // ============================================================
  // Delete Room — Hapus seluruh room (untuk ganti room baru)
  // ============================================================
  socket.on('delete-room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    // Putuskan semua kamera di room ini
    for (const [camId, cam] of Object.entries(room.cameras)) {
      if (cam.sender) io.to(cam.sender).emit('camera-deleted', { camId });
      if (cam.receiver) io.to(cam.receiver).emit('camera-deleted', { camId });
    }

    delete rooms[roomId];
    console.log(`[-] Room ${roomId} dihapus total oleh dashboard`);
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
  // Update Orientasi dari HP (Auto-orientasi)
  // ============================================================
  socket.on('update-orientation', ({ roomId, camId, orientation }) => {
    const room = rooms[roomId];
    if (room && room.cameras[camId]) {
      room.cameras[camId].orientation = orientation;
      broadcastStatus(roomId);
      console.log(`[${roomId}][${camId}] Update orientasi otomatis dari HP: ${orientation}`);
    }
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
// Node-Media-Server (RTMP Ingestion Server)
// ============================================================
const NMS_HTTP_PORT = parseInt(PORT) + 1; // e.g. 3001 atau 3101

const nmsConfig = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: NMS_HTTP_PORT,
    allow_origin: '*'
  },
  logType: 1 // Hanya error/warning agar log server bersih
};

const nms = new NodeMediaServer(nmsConfig);
nms.run();

// Event Listener ketika stream RTMP mulai dipublikasi (misal dari Drone atau OBS pengirim)
nms.on('postPublish', (id, streamPath, args) => {
  if (!streamPath) return;
  console.log(`[NMS] Stream terhubung: id=${id} path=${streamPath}`);
  const parts = streamPath.split('/');
  const streamKey = parts[parts.length - 1]; // format: ROOMID_CAMID
  if (!streamKey) return;
  const underscoreIndex = streamKey.indexOf('_');
  if (underscoreIndex !== -1) {
    const roomId = streamKey.substring(0, underscoreIndex);
    const camId = streamKey.substring(underscoreIndex + 1);

    const room = rooms[roomId];
    if (room && room.cameras[camId]) {
      room.cameras[camId].sender = 'rtmp_' + id;
      room.cameras[camId].orientation = 'landscape'; // RTMP default landscape
      broadcastStatus(roomId);
      console.log(`[${roomId}][${camId}] Aliran stream RTMP Aktif`);
    }
  }
});

// Event Listener ketika stream RTMP selesai/terputus
nms.on('donePublish', (id, streamPath, args) => {
  if (!streamPath) return;
  console.log(`[NMS] Stream terputus: id=${id} path=${streamPath}`);
  const parts = streamPath.split('/');
  const streamKey = parts[parts.length - 1];
  if (!streamKey) return;
  const underscoreIndex = streamKey.indexOf('_');
  if (underscoreIndex !== -1) {
    const roomId = streamKey.substring(0, underscoreIndex);
    const camId = streamKey.substring(underscoreIndex + 1);

    const room = rooms[roomId];
    if (room && room.cameras[camId]) {
      room.cameras[camId].sender = null;
      broadcastStatus(roomId);
      console.log(`[${roomId}][${camId}] Aliran stream RTMP Berhenti`);
    }
  }
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
  console.log(`  🛸 Server RTMP          : rtmp://${LOCAL_IP}:1935/live`);
  console.log(`  📺 WebSocket-FLV Player : ws://${LOCAL_IP}:${NMS_HTTP_PORT}/live/...`);
  console.log('============================================================\n');
});
