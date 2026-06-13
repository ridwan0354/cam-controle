# 📡 Mobile Camera to OBS — Cam Controller

Sistem **WebRTC P2P** untuk menggunakan smartphone sebagai kamera eksternal OBS Studio dengan delay sangat rendah.

## ✨ Fitur
- 📱 Kamera HP → 🎬 OBS via WebRTC (delay < 100ms)
- 🔐 Room-based session (multi user aman)
- 🎮 Remote Control dari Dashboard (flip, mute, flash, resolusi)
- 📊 QR Code otomatis untuk akses HP
- 🌐 Support Localhost & VPS

## 🚀 Quick Start (Lokal)

```bash
git clone https://github.com/ridwan0354/cam-controle.git
cd cam-controle
npm install
node server.js
```

Buka: `http://localhost:3000`

## 🖥️ Deploy ke VPS (Satu Perintah)

```bash
# SSH ke VPS sebagai root
ssh root@IP_VPS

# Download & jalankan script deploy
curl -fsSL https://raw.githubusercontent.com/ridwan0354/cam-controle/main/deploy.sh | bash
```

**Domain:** https://cam.galipatsistem.com

## 🛠️ Tech Stack
- **Backend:** Node.js, Express, Socket.io
- **Frontend:** HTML5, Vanilla JS, WebRTC API
- **Deploy:** PM2, Nginx, Certbot SSL
