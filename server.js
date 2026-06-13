/**
 * ============================================================
 * Mobile Camera to OBS - Signaling Server
 * ============================================================
 * Fungsi server ini HANYA sebagai "jembatan" pertukaran sinyal
 * WebRTC (SDP Offer/Answer & ICE Candidates) antara HP (Sender)
 * dan OBS (Receiver). Setelah koneksi P2P terbentuk, server ini
 * tidak lagi terlibat dalam aliran video/audio.
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
  cors: {
    origin: '*', // Izinkan semua origin untuk kemudahan akses dari HP
    methods: ['GET', 'POST'],
  },
});

// Sajikan folder 'public' sebagai file statis
app.use(express.static(path.join(__dirname, 'public')));

// Halaman utama redirect ke dashboard
app.get('/', (req, res) => {
  res.redirect('/dashboard.html');
});

// ============================================================
// API: Kirim info IP jaringan lokal ke Dashboard
// Dashboard akan menggunakan IP ini untuk membuat QR Code & link
// yang bisa diakses oleh HP di jaringan yang sama.
// ============================================================
app.get('/api/info', (req, res) => {
  res.json({
    localIP: LOCAL_IP,
    port: PORT,
  });
});

// ============================================================
// Manajemen Room (Sesi Streaming)
// ============================================================
// Setiap room memiliki struktur:
// rooms[roomId] = { dashboard: socketId, sender: socketId, receiver: socketId }
const rooms = {};

/**
 * Mendapatkan IP lokal mesin (untuk tampil di dashboard)
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const PORT = process.env.PORT || 3000;

// ============================================================
// Socket.io Event Handling
// ============================================================
io.on('connection', (socket) => {
  console.log(`[+] Client terhubung: ${socket.id}`);

  // --- Bergabung ke Room ---
  // Event ini dipanggil oleh Dashboard, HP (Sender), dan OBS (Receiver)
  socket.on('join-room', ({ roomId, role }) => {
    socket.join(roomId);

    // Inisialisasi room jika belum ada
    if (!rooms[roomId]) {
      rooms[roomId] = { dashboard: null, sender: null, receiver: null };
    }

    // Simpan socket ID berdasarkan peran
    rooms[roomId][role] = socket.id;
    socket.data.roomId = roomId;
    socket.data.role = role;

    console.log(`[Room: ${roomId}] ${role} bergabung (Socket: ${socket.id})`);

    // Beritahu semua anggota room tentang status terkini
    io.to(roomId).emit('room-status', {
      room: roomId,
      members: {
        dashboard: !!rooms[roomId].dashboard,
        sender: !!rooms[roomId].sender,
        receiver: !!rooms[roomId].receiver,
      },
    });

    // Jika Sender dan Receiver sudah ada, perintahkan Sender untuk membuat Offer
    if (rooms[roomId].sender && rooms[roomId].receiver) {
      console.log(`[Room: ${roomId}] Sender & Receiver siap. Memulai signaling WebRTC...`);
      io.to(rooms[roomId].sender).emit('start-streaming');
    }
  });

  // ============================================================
  // WebRTC Signaling: Meneruskan SDP Offer dari Sender ke Receiver
  // ============================================================
  socket.on('webrtc-offer', ({ roomId, offer }) => {
    console.log(`[Room: ${roomId}] Meneruskan SDP Offer ke Receiver...`);
    if (rooms[roomId]?.receiver) {
      io.to(rooms[roomId].receiver).emit('webrtc-offer', { offer });
    }
  });

  // Meneruskan SDP Answer dari Receiver ke Sender
  socket.on('webrtc-answer', ({ roomId, answer }) => {
    console.log(`[Room: ${roomId}] Meneruskan SDP Answer ke Sender...`);
    if (rooms[roomId]?.sender) {
      io.to(rooms[roomId].sender).emit('webrtc-answer', { answer });
    }
  });

  // Meneruskan ICE Candidate antara Sender dan Receiver (dua arah)
  socket.on('webrtc-ice-candidate', ({ roomId, candidate, targetRole }) => {
    const targetSocket = rooms[roomId]?.[targetRole];
    if (targetSocket) {
      io.to(targetSocket).emit('webrtc-ice-candidate', { candidate });
    }
  });

  // ============================================================
  // Remote Control: Meneruskan perintah dari Dashboard ke HP (Sender)
  // ============================================================
  socket.on('remote-command', ({ roomId, command, value }) => {
    console.log(`[Room: ${roomId}] Perintah remote dari Dashboard: ${command}`, value);
    if (rooms[roomId]?.sender) {
      io.to(rooms[roomId].sender).emit('remote-command', { command, value });
    }
  });

  // ============================================================
  // Menangani Disconnect
  // ============================================================
  socket.on('disconnect', () => {
    const { roomId, role } = socket.data;
    if (roomId && rooms[roomId]) {
      console.log(`[-] ${role} (${socket.id}) keluar dari room: ${roomId}`);
      rooms[roomId][role] = null;

      // Beritahu semua anggota room tentang perubahan status
      io.to(roomId).emit('room-status', {
        room: roomId,
        members: {
          dashboard: !!rooms[roomId].dashboard,
          sender: !!rooms[roomId].sender,
          receiver: !!rooms[roomId].receiver,
        },
      });

      // Beritahu receiver jika sender disconnect
      if (role === 'sender' && rooms[roomId].receiver) {
        io.to(rooms[roomId].receiver).emit('sender-disconnected');
      }
    }
    console.log(`[-] Client terputus: ${socket.id}`);
  });
});

// ============================================================
// Mulai Server
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n============================================================');
  console.log('  📡 Mobile Camera to OBS - Signaling Server AKTIF!');
  console.log('============================================================');
  console.log(`  🖥️  Dashboard (Lokal)   : http://localhost:${PORT}/dashboard.html`);
  console.log(`  🌐 Dashboard (Jaringan) : http://${LOCAL_IP}:${PORT}/dashboard.html`);
  console.log(`  📱 Halaman HP           : http://${LOCAL_IP}:${PORT}/kamera.html`);
  console.log(`  🎬 Halaman OBS          : http://${LOCAL_IP}:${PORT}/obs.html`);
  console.log('============================================================\n');
});
